import { describe, expect, it } from 'vitest';
import { buildOracleChartModel, formatOracleRate, oracleRateToChartNumber } from '@/oracle/oracle-chart-model';
import { toDurationSeconds, toUtcTimestamp } from '@/domain/protocol-time';
import type { OraclePriceHistory, VenueAuctionSnapshot } from '@/protocol/profile-types';

const COEN = '0x0000000000000000000000000000000000000000';
const USD_QUOTE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_BASE = '0xcccccccccccccccccccccccccccccccccccccccc';

const history: OraclePriceHistory = {
  pair: { base: COEN, quote: USD_QUOTE },
  requestedCount: 90,
  pointsNewestFirst: [
    { timestamp: toUtcTimestamp(300n), rate: 3_000_000_000_000_000_000n, volume: 3n },
    { timestamp: toUtcTimestamp(200n), rate: 2_000_000_000_000_000_000n, volume: 2n },
    { timestamp: toUtcTimestamp(100n), rate: 1_500_000_000_000_000_000n, volume: 1n },
  ],
};

const venue: VenueAuctionSnapshot = {
  worldwideDay: '20260804' as VenueAuctionSnapshot['worldwideDay'],
  stage: 'completed',
  dayType: 'green',
  paymentToken: '0x1111111111111111111111111111111111111111',
  schedule: { commitEnd: toUtcTimestamp(1n), revealEnd: toUtcTimestamp(2n), issuanceEnd: toUtcTimestamp(3n) },
  params: {
    issuanceCurrency: 840,
    referenceCurrency: 840,
    promisLoadMinor: 1n,
    minIntexBidRate: 1,
    minIntexBidQuantity: 1,
    entryPriceMinor: 2_000_000_000_000_000_000n,
    floorPriceMinor: 1_800_000_000_000_000_000n,
    callPriceMinor: 4_000_000_000_000_000_000n,
    commitBondMinor: 0n,
    callTrigger: { windowDays: 1, thresholdDays: 1, intexCallPeriod: toDurationSeconds(1n) },
  },
  runningCounts: { committedBids: 0, revealedBids: 0 },
  result: { auctionClearingRate: 0n, wonBidsCount: 0, issuedIntexCount: 0, issuedIntexLoadedPromis: 0n },
};

describe('Oracle chart model', () => {
  it('reverses a copy to chronological order and keeps raw integers', () => {
    const original = [...history.pointsNewestFirst];
    const model = buildOracleChartModel(history, venue);
    expect(model.points.map((point) => point.time)).toEqual([100, 200, 300]);
    expect(model.points.map((point) => point.rawRate)).toEqual([
      1_500_000_000_000_000_000n,
      2_000_000_000_000_000_000n,
      3_000_000_000_000_000_000n,
    ]);
    expect(history.pointsNewestFirst).toEqual(original);
    expect(model.levels.map((level) => level.label)).toEqual(['Entry', 'Floor', 'Call']);
  });

  it('withholds overlays when the reference currency is not ISO-840', () => {
    const model = buildOracleChartModel(history, { ...venue, params: { ...venue.params, referenceCurrency: 949 } });
    expect(model.levels).toEqual([]);
  });

  it('shows Entry, Floor and Call overlays for any configured pair when the reference currency is ISO-840', () => {
    const nonCoenBase: OraclePriceHistory = {
      ...history,
      pair: { base: OTHER_BASE, quote: USD_QUOTE },
    };
    const model = buildOracleChartModel(nonCoenBase, venue);
    expect(model.levels.map((level) => level.label)).toEqual(['Entry', 'Floor', 'Call']);
    expect(model.levels.map((level) => level.rawValue)).toEqual([
      2_000_000_000_000_000_000n,
      1_800_000_000_000_000_000n,
      4_000_000_000_000_000_000n,
    ]);
  });

  it('formats exact fixed-point source values and rejects unsafe chart values', () => {
    expect(oracleRateToChartNumber(1_500_000_000_000_000_000n)).toBe(1.5);
    expect(formatOracleRate(1_500_000_000_000_000_000n)).toBe('1.5');
    expect(() => oracleRateToChartNumber((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1_000_000_000_000_000_000n)).toThrow(
      'safe-number',
    );
  });
});
