import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toUtcTimestamp } from '@/domain/protocol-time';
import type { VenueAuctionStage } from '@/protocol/read-model';
import {
  auctionReadNextPollDelay,
  AUCTION_READ_POLL_INTERVAL_MS,
  COMPLETION_POLL_INTERVAL_MS,
  ORACLE_HISTORY_POLL_INTERVAL_MS,
  SCHEDULE_APPROACH_POLL_MS,
  startSequentialVenuePolling,
  venueDemandNextPollDelay,
  VENUE_REVEAL_POLL_INTERVAL_MS,
  type VenuePollingActivity,
} from '@/demand/venue-ladder-polling';

class Activity implements VenuePollingActivity {
  active = true;
  listener: (() => void) | null = null;
  isActive(): boolean {
    return this.active;
  }
  subscribe(listener: () => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  setActive(active: boolean): void {
    this.active = active;
    this.listener?.();
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('sequential venue polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never overlaps scans and schedules the next poll only after completion', async () => {
    const activity = new Activity();
    const first = deferred<'revealing-bids'>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('revealing-bids');
    const controller = startSequentialVenuePolling({
      request,
      nextDelay: () => VENUE_REVEAL_POLL_INTERVAL_MS,
      onResult: () => undefined,
      onError: () => undefined,
      activity,
    });
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(VENUE_REVEAL_POLL_INTERVAL_MS * 2);
    expect(request).toHaveBeenCalledTimes(1);
    first.resolve('revealing-bids');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(VENUE_REVEAL_POLL_INTERVAL_MS);
    expect(request).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('queues one immediate refresh without overlapping an active request', async () => {
    const activity = new Activity();
    const first = deferred<'revealing-bids'>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('revealing-bids');
    const controller = startSequentialVenuePolling({
      request,
      nextDelay: () => VENUE_REVEAL_POLL_INTERVAL_MS,
      onResult: () => undefined,
      onError: () => undefined,
      activity,
    });

    controller.refresh();
    controller.refresh();
    expect(request).toHaveBeenCalledTimes(1);

    first.resolve('revealing-bids');
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it('polls throughout commit and continues through reveal', async () => {
    vi.setSystemTime(new Date('2026-08-03T10:00:00Z'));
    const commitEnd = toUtcTimestamp(BigInt(Math.floor(Date.now() / 1000) + 30));
    const activity = new Activity();
    const request = vi.fn(async (_signal: AbortSignal): Promise<VenueAuctionStage> => 'revealing-bids');
    request.mockResolvedValueOnce('committing-bids');
    const controller = startSequentialVenuePolling({
      request,
      nextDelay: (stage) => venueDemandNextPollDelay(stage, commitEnd),
      onResult: () => undefined,
      onError: () => undefined,
      activity,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(SCHEDULE_APPROACH_POLL_MS - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(VENUE_REVEAL_POLL_INTERVAL_MS);
    expect(request).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it('uses the active interval through commit, reveal and issuance and stops after terminal stages', () => {
    const farEnd = toUtcTimestamp(1_000_000n);
    expect(venueDemandNextPollDelay('committing-bids', farEnd, 0)).toBe(VENUE_REVEAL_POLL_INTERVAL_MS);
    expect(venueDemandNextPollDelay('revealing-bids', farEnd, 0)).toBe(VENUE_REVEAL_POLL_INTERVAL_MS);
    expect(venueDemandNextPollDelay('issuance', farEnd, 0)).toBe(VENUE_REVEAL_POLL_INTERVAL_MS);
    expect(venueDemandNextPollDelay('completed', farEnd, 0)).toBeNull();
    expect(venueDemandNextPollDelay('cancelled', farEnd, 0)).toBeNull();
  });

  it('accelerates the venue demand poll as commit approaches and uses the schedule deadline', () => {
    const commitEnd = toUtcTimestamp(60n);
    expect(venueDemandNextPollDelay('committing-bids', commitEnd, 0)).toBe(SCHEDULE_APPROACH_POLL_MS);
    expect(venueDemandNextPollDelay('committing-bids', commitEnd, 59_999)).toBe(SCHEDULE_APPROACH_POLL_MS);
    expect(venueDemandNextPollDelay('committing-bids', commitEnd, 60_000)).toBe(VENUE_REVEAL_POLL_INTERVAL_MS);
    expect(venueDemandNextPollDelay('committing-bids', commitEnd, 10_000_000)).toBe(VENUE_REVEAL_POLL_INTERVAL_MS);
    expect(venueDemandNextPollDelay('committing-bids', toUtcTimestamp(1_000_000n), 0)).toBe(
      VENUE_REVEAL_POLL_INTERVAL_MS,
    );
  });

  it('polls the auction read throughout every active venue stage', () => {
    const farEnd = toUtcTimestamp(1_000_000n);
    expect(auctionReadNextPollDelay('committing-bids', farEnd, 0)).toBe(AUCTION_READ_POLL_INTERVAL_MS);
    expect(auctionReadNextPollDelay('committing-bids', farEnd, AUCTION_READ_POLL_INTERVAL_MS)).toBe(
      AUCTION_READ_POLL_INTERVAL_MS,
    );
    expect(auctionReadNextPollDelay('revealing-bids', farEnd, 0, toUtcTimestamp(1_000_000n))).toBe(
      AUCTION_READ_POLL_INTERVAL_MS,
    );
    expect(auctionReadNextPollDelay('issuance', farEnd, 0)).toBe(AUCTION_READ_POLL_INTERVAL_MS);
    expect(auctionReadNextPollDelay('completed', farEnd, 0)).toBeNull();
    expect(auctionReadNextPollDelay('cancelled', farEnd, 0)).toBeNull();
  });

  it('accelerates the auction read toward commit and reveal deadlines', () => {
    const commitEnd = toUtcTimestamp(30n);
    const revealEnd = toUtcTimestamp(45n);
    expect(auctionReadNextPollDelay('committing-bids', commitEnd, 0)).toBe(SCHEDULE_APPROACH_POLL_MS);
    expect(auctionReadNextPollDelay('committing-bids', commitEnd, 35_000)).toBe(AUCTION_READ_POLL_INTERVAL_MS);
    expect(auctionReadNextPollDelay('revealing-bids', commitEnd, 0, revealEnd)).toBe(SCHEDULE_APPROACH_POLL_MS);
    expect(auctionReadNextPollDelay('revealing-bids', commitEnd, 0)).toBe(AUCTION_READ_POLL_INTERVAL_MS);
    expect(auctionReadNextPollDelay('revealing-bids', commitEnd, 50_000, revealEnd)).toBe(
      AUCTION_READ_POLL_INTERVAL_MS,
    );
  });

  it('keeps the oracle history poll interval at 5 seconds', () => {
    expect(ORACLE_HISTORY_POLL_INTERVAL_MS).toBe(5_000);
    expect(Number.isSafeInteger(ORACLE_HISTORY_POLL_INTERVAL_MS)).toBe(true);
  });

  it('keeps the completion poll interval within the checked timer range', () => {
    expect(COMPLETION_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(Number.isSafeInteger(COMPLETION_POLL_INTERVAL_MS)).toBe(true);
  });

  it('stops when the result has no next poll', async () => {
    const activity = new Activity();
    const request = vi.fn().mockResolvedValue('completed');
    const controller = startSequentialVenuePolling({
      request,
      nextDelay: () => null,
      onResult: () => undefined,
      onError: () => undefined,
      activity,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(VENUE_REVEAL_POLL_INTERVAL_MS * 2);
    expect(request).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('pauses while the page is inactive and resumes on activation', async () => {
    const activity = new Activity();
    activity.active = false;
    const request = vi.fn().mockResolvedValue('revealing-bids');
    const controller = startSequentialVenuePolling({
      request,
      nextDelay: () => VENUE_REVEAL_POLL_INTERVAL_MS,
      onResult: () => undefined,
      onError: () => undefined,
      activity,
    });
    expect(request).not.toHaveBeenCalled();
    activity.setActive(true);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('aborts and ignores a late result after route change', async () => {
    const activity = new Activity();
    const pending = deferred<string>();
    const onResult = vi.fn();
    const request = vi.fn((_signal: AbortSignal) => pending.promise);
    const controller = startSequentialVenuePolling({
      request,
      nextDelay: () => VENUE_REVEAL_POLL_INTERVAL_MS,
      onResult,
      onError: () => undefined,
      activity,
    });
    const signal = request.mock.calls[0]?.[0] as AbortSignal;
    controller.stop();
    expect(signal.aborted).toBe(true);
    pending.resolve('late');
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
  });
});
