import type { UtcTimestamp } from '../domain/protocol-time';
import type { VenueAuctionStage } from '../protocol/read-model';

export const VENUE_REVEAL_POLL_INTERVAL_MS = 15_000;
export const AUCTION_READ_POLL_INTERVAL_MS = 15_000;
export const COMPLETION_POLL_INTERVAL_MS = 15_000;
export const ORACLE_HISTORY_POLL_INTERVAL_MS = 5_000;
export const SCHEDULE_APPROACH_MS = 60_000;
export const SCHEDULE_APPROACH_POLL_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface VenuePollingActivity {
  isActive(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface SequentialVenuePollingOptions<T> {
  request(signal: AbortSignal): Promise<T>;
  nextDelay(result: T): number | null;
  onResult(result: T): void;
  onError(error: unknown): void;
  activity: VenuePollingActivity;
  repeatOnError?: boolean;
  intervalMs?: number;
}

export interface SequentialVenuePollingController {
  refresh(): void;
  stop(): void;
}

const checkedDelay = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError('Venue polling delay must be a non-negative safe timer duration.');
  }
  return value;
};

const remainingMilliseconds = (deadline: UtcTimestamp, nowMilliseconds: number): number => {
  const deadlineMilliseconds = Number(deadline) * 1000;
  if (!Number.isSafeInteger(deadlineMilliseconds) || !Number.isSafeInteger(nowMilliseconds)) {
    throw new RangeError('Venue auction schedule must fit safe integer milliseconds.');
  }
  return deadlineMilliseconds - nowMilliseconds;
};

const scheduleAwareDelay = (
  deadline: UtcTimestamp | undefined,
  nowMilliseconds: number,
  intervalMs: number,
): number => {
  if (deadline === undefined) return intervalMs;
  const remaining = remainingMilliseconds(deadline, nowMilliseconds);
  if (remaining > 0 && remaining <= SCHEDULE_APPROACH_MS) return SCHEDULE_APPROACH_POLL_MS;
  return intervalMs;
};

export const venueDemandNextPollDelay = (
  stage: VenueAuctionStage,
  commitEnd: UtcTimestamp,
  nowMilliseconds = Date.now(),
): number | null => {
  if (stage === 'issuance' || stage === 'revealing-bids') return VENUE_REVEAL_POLL_INTERVAL_MS;
  if (stage !== 'committing-bids') return null;
  return scheduleAwareDelay(commitEnd, nowMilliseconds, VENUE_REVEAL_POLL_INTERVAL_MS);
};

export const auctionReadNextPollDelay = (
  stage: VenueAuctionStage,
  commitEnd: UtcTimestamp,
  nowMilliseconds = Date.now(),
  revealEnd?: UtcTimestamp,
): number | null => {
  switch (stage) {
    case 'revealing-bids':
      return scheduleAwareDelay(revealEnd, nowMilliseconds, AUCTION_READ_POLL_INTERVAL_MS);
    case 'issuance':
      return AUCTION_READ_POLL_INTERVAL_MS;
    case 'committing-bids':
      return scheduleAwareDelay(commitEnd, nowMilliseconds, AUCTION_READ_POLL_INTERVAL_MS);
    case 'completed':
    case 'cancelled':
      return null;
  }
};

export const browserPollingActivity = (): VenuePollingActivity => ({
  isActive: () => document.visibilityState === 'visible',
  subscribe(listener) {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
});

export const startSequentialVenuePolling = <T>({
  request,
  nextDelay,
  onResult,
  onError,
  activity,
  repeatOnError = true,
  intervalMs = VENUE_REVEAL_POLL_INTERVAL_MS,
}: SequentialVenuePollingOptions<T>): SequentialVenuePollingController => {
  let stopped = false;
  let running = false;
  let refreshPending = false;
  let scheduledDelay: number | null = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  const retryDelay = checkedDelay(intervalMs);

  const clearScheduled = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const execute = async (): Promise<void> => {
    if (stopped || running || scheduledDelay === null || !activity.isActive()) return;
    running = true;
    controller = new AbortController();
    try {
      const result = await request(controller.signal);
      if (stopped) return;
      const delay = nextDelay(result);
      scheduledDelay = delay === null ? null : checkedDelay(delay);
      onResult(result);
    } catch (error) {
      scheduledDelay = repeatOnError ? retryDelay : null;
      if (!stopped) onError(error);
    } finally {
      running = false;
      controller = null;
    }
    if (stopped) return;
    if (refreshPending) {
      refreshPending = false;
      scheduledDelay = 0;
      if (activity.isActive()) void execute();
      return;
    }
    if (scheduledDelay !== null && activity.isActive()) {
      timer = setTimeout(() => {
        timer = null;
        void execute();
      }, scheduledDelay);
    }
  };

  const unsubscribe = activity.subscribe(() => {
    if (stopped) return;
    if (!activity.isActive()) {
      clearScheduled();
      return;
    }
    if (refreshPending && !running) {
      refreshPending = false;
      scheduledDelay = 0;
    }
    if (scheduledDelay !== null && !running && timer === null) void execute();
  });

  void execute();
  return {
    refresh() {
      if (stopped) return;
      clearScheduled();
      if (running) {
        refreshPending = true;
        return;
      }
      refreshPending = false;
      scheduledDelay = 0;
      if (activity.isActive()) void execute();
    },
    stop() {
      stopped = true;
      refreshPending = false;
      scheduledDelay = null;
      clearScheduled();
      controller?.abort();
      unsubscribe();
    },
  };
};
