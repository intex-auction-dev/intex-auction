import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { toUtcTimestamp, type WorldwideDayKey } from '@/domain/protocol-time';
import type { VenueBidRevealRecord, VenueDemandEvidence, VenueLiveBidRecord } from '@/demand/venue-bid-history';
import { buildVenueDemandModel, formatBidRate, shortenPublicAddress } from '@/demand/venue-demand-model';

const DAY = '20260804' as WorldwideDayKey;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const hash = (value: string): Hex => `0x${value.repeat(64)}` as Hex;

const log = (
  bidder: Address,
  quantity: number,
  bidRate: number,
  timestamp: bigint,
  index: number,
): VenueBidRevealRecord => ({
  worldwideDay: DAY,
  bidder,
  quantity,
  bidRate,
  blockNumber: 10n + BigInt(index),
  blockHash: hash('1'),
  transactionHash: index === 0 ? hash('a') : hash('b'),
  transactionIndex: index,
  logIndex: index,
  timestamp: toUtcTimestamp(timestamp),
});

const live = (record: VenueBidRevealRecord, index: number): VenueLiveBidRecord => ({
  bidder: record.bidder,
  quantity: record.quantity,
  bidRate: record.bidRate,
  timestamp: record.timestamp,
  insertionIndex: index,
});

const evidence = (
  logs: readonly VenueBidRevealRecord[],
  liveBids: readonly VenueLiveBidRecord[],
  overrides: Partial<VenueDemandEvidence> = {},
): VenueDemandEvidence => ({
  logs: {
    confirmedThroughBlock: 20n,
    bidReveals: logs,
    reaps: [],
    reapStatus: 'not-observed',
    cacheStatus: { BidRevealed: 'cold-scan', AuctionReaped: 'cold-scan' },
  },
  live: {
    stage: 'revealing-bids',
    bids: liveBids,
    authoritativeClearingRate: null,
  },
  ...overrides,
});

describe('active-venue demand model', () => {
  it('reconciles live insertion order and sorts the visual ladder by reviewed auction order', () => {
    const first = log(A, 2, 700_000, 100n, 0);
    const second = log(B, 3, 800_000, 101n, 1);
    const model = buildVenueDemandModel(evidence([first, second], [live(first, 0), live(second, 1)]));
    expect(model.state).toBe('live-reconciled');
    expect(model.eventOrder.map((record) => record.bidder)).toEqual([A, B]);
    expect(model.rows.map((row) => row.bidder)).toEqual([B, A]);
    expect(model.rows.map((row) => row.cumulativeQuantity)).toEqual([3, 5]);
  });

  it('uses timestamp then durable event order for equal-rate ties', () => {
    const first = log(A, 2, 800_000, 101n, 0);
    const second = log(B, 3, 800_000, 100n, 1);
    const model = buildVenueDemandModel(evidence([first, second], [live(first, 0), live(second, 1)]));
    expect(model.rows.map((row) => row.bidder)).toEqual([B, A]);
    expect(model.rows.map((row) => row.provenance.originalEventIndex)).toEqual([1, 0]);
  });

  it('treats a matching live suffix beyond the confirmed log frontier as pending, not incompatible', () => {
    const confirmed = log(A, 2, 800_000, 100n, 0);
    const pending = log(B, 3, 700_000, 101n, 1);
    const model = buildVenueDemandModel(evidence([confirmed], [live(confirmed, 0), live(pending, 1)]));
    expect(model.state).toBe('live-confirmation-pending');
    expect(model.unconfirmedLiveCount).toBe(1);
    expect(model.rows).toHaveLength(1);
    expect(model.issues).toEqual([]);
  });

  it('treats a terminal live suffix beyond confirmed logs as pending, not incompatible', () => {
    const confirmed = log(A, 2, 800_000, 100n, 0);
    const pending = log(B, 3, 700_000, 101n, 1);
    const model = buildVenueDemandModel(
      evidence([confirmed], [live(confirmed, 0), live(pending, 1)], {
        live: { stage: 'completed', bids: [live(confirmed, 0), live(pending, 1)], authoritativeClearingRate: null },
      }),
    );
    expect(model.state).toBe('live-confirmation-pending');
    expect(model.confirmationPending).toBe('reveals');
    expect(model.issues).toEqual([]);
  });

  it('treats a matching terminal prefix after an unconfirmed reap as pending', () => {
    const first = log(A, 2, 800_000, 100n, 0);
    const second = log(B, 3, 700_000, 101n, 1);
    const model = buildVenueDemandModel(
      evidence([first, second], [live(first, 0)], {
        live: { stage: 'completed', bids: [live(first, 0)], authoritativeClearingRate: null },
      }),
    );
    expect(model.state).toBe('live-confirmation-pending');
    expect(model.confirmationPending).toBe('reap');
    expect(model.rows).toHaveLength(2);
    expect(model.issues).toEqual([]);
  });

  it('surfaces incompatible live-array evidence instead of replacing durable logs', () => {
    const record = log(A, 2, 800_000, 100n, 0);
    const mismatch = { ...live(record, 0), bidRate: 700_000 };
    const model = buildVenueDemandModel(evidence([record], [mismatch]));
    expect(model.state).toBe('incompatible-evidence');
    expect(model.issues).toContain('Live bid 0 disagrees with durable BidRevealed evidence.');
    expect(model.rows[0]?.bidRate).toBe(800_000);
  });

  it('reconstructs a fully reaped historical ladder from durable logs', () => {
    const record = log(A, 2, 800_000, 100n, 0);
    const model = buildVenueDemandModel(
      evidence([record], [], {
        logs: {
          confirmedThroughBlock: 30n,
          bidReveals: [record],
          reaps: [
            {
              worldwideDay: DAY,
              remaining: 0n,
              blockNumber: 20n,
              blockHash: hash('2'),
              transactionHash: hash('c'),
              transactionIndex: 0,
              logIndex: 0,
            },
          ],
          reapStatus: 'complete',
          cacheStatus: { BidRevealed: 'cache-hit', AuctionReaped: 'cache-hit' },
        },
        live: { stage: 'completed', bids: [], authoritativeClearingRate: 750_000n },
      }),
    );
    expect(model.state).toBe('reaped-reconstructed');
    expect(model.rows).toHaveLength(1);
    expect(model.authoritativeClearingRate).toBe(750_000n);
  });

  it('reconciles partial reaping as the retained prefix of durable event order', () => {
    const first = log(A, 2, 700_000, 100n, 0);
    const second = log(B, 3, 800_000, 101n, 1);
    const model = buildVenueDemandModel(
      evidence([first, second], [live(first, 0)], {
        logs: {
          confirmedThroughBlock: 30n,
          bidReveals: [first, second],
          reaps: [
            {
              worldwideDay: DAY,
              remaining: 1n,
              blockNumber: 20n,
              blockHash: hash('2'),
              transactionHash: hash('c'),
              transactionIndex: 0,
              logIndex: 0,
            },
          ],
          reapStatus: 'partial',
          cacheStatus: { BidRevealed: 'cache-hit', AuctionReaped: 'cache-hit' },
        },
        live: { stage: 'completed', bids: [live(first, 0)], authoritativeClearingRate: null },
      }),
    );
    expect(model.state).toBe('partially-reaped-reconciled');
    expect(model.issues).toEqual([]);
  });

  it('distinguishes active empty, empty unreaped, and reaped empty auctions', () => {
    expect(buildVenueDemandModel(evidence([], [])).state).toBe('active-empty');
    expect(
      buildVenueDemandModel(
        evidence([], [], {
          live: { stage: 'completed', bids: [], authoritativeClearingRate: null },
        }),
      ).state,
    ).toBe('empty-unreaped');
    expect(
      buildVenueDemandModel(
        evidence([], [], {
          logs: {
            confirmedThroughBlock: 30n,
            bidReveals: [],
            reaps: [
              {
                worldwideDay: DAY,
                remaining: 0n,
                blockNumber: 20n,
                blockHash: hash('2'),
                transactionHash: hash('c'),
                transactionIndex: 0,
                logIndex: 0,
              },
            ],
            reapStatus: 'complete',
            cacheStatus: { BidRevealed: 'cache-hit', AuctionReaped: 'cache-hit' },
          },
          live: { stage: 'completed', bids: [], authoritativeClearingRate: null },
        }),
      ).state,
    ).toBe('reaped-empty');
  });

  it('uses local-only bid-rate and public-address formatting without strike claims', () => {
    expect(formatBidRate(800_000)).toBe('80.0000%');
    expect(shortenPublicAddress(A)).toBe('0xaaaa…aaaa');
    expect(() => formatBidRate(1_000_001)).toThrow('1e6');
  });
});
