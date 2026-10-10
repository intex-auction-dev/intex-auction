import type { OraclePriceHistory, VenueAuctionSnapshot } from '../protocol/profile-types';
import { ORACLE_RATE_SCALE, PRICE_SCALE, USD_REFERENCE_CURRENCY } from '../domain/protocol-constants';

export { ORACLE_RATE_SCALE, PRICE_SCALE };
export { formatOracleRate, formatPrice } from '../ui/display-format';

export type UnixTimestamp = number;

export interface OracleChartPoint {
  time: UnixTimestamp;
  value: number;
  rawRate: bigint;
  rawVolume: bigint;
}

export interface OracleChartLevel {
  label: 'Entry' | 'Floor' | 'Call';
  value: number;
  rawValue: bigint;
}

export interface OracleChartModel {
  pair: { base: string; quote: string };
  points: readonly OracleChartPoint[];
  latest: OracleChartPoint | null;
  levels: readonly OracleChartLevel[];
  retainedCount: number;
}

const safeTimestamp = (value: bigint): UnixTimestamp => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Oracle chart timestamp exceeds the JavaScript safe-integer range.');
  }
  return Number(value);
};

const fixedPointToChartNumber = (value: bigint, scale: bigint, decimals: number): number => {
  if (value < 0n) throw new RangeError('Oracle chart value must be unsigned.');
  const whole = value / scale;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Oracle chart value exceeds the JavaScript safe-number range.');
  }
  const fraction = (value % scale).toString().padStart(decimals, '0');
  const result = Number(`${whole}.${fraction}`);
  if (!Number.isFinite(result)) throw new RangeError('Oracle chart value is not finite.');
  return result;
};

export const oracleRateToChartNumber = (value: bigint): number => fixedPointToChartNumber(value, ORACLE_RATE_SCALE, 18);

export const priceToChartNumber = (value: bigint): number => fixedPointToChartNumber(value, PRICE_SCALE, 6);

const compatibleLevels = (venue: VenueAuctionSnapshot | null): readonly OracleChartLevel[] => {
  if (!venue || venue.params.referenceCurrency !== USD_REFERENCE_CURRENCY) {
    return [];
  }
  return [
    ['Entry', venue.params.entryPriceMinor],
    ['Floor', venue.params.floorPriceMinor],
    ['Call', venue.params.callPriceMinor],
  ].map(([label, rawValue]) => ({
    label: label as OracleChartLevel['label'],
    rawValue: rawValue as bigint,
    value: priceToChartNumber(rawValue as bigint),
  }));
};

export const buildOracleChartModel = (
  history: OraclePriceHistory,
  venue: VenueAuctionSnapshot | null,
): OracleChartModel => {
  const points = [...history.pointsNewestFirst].reverse().map(
    (point): OracleChartPoint => ({
      time: safeTimestamp(point.timestamp),
      value: oracleRateToChartNumber(point.rate),
      rawRate: point.rate,
      rawVolume: point.volume,
    }),
  );
  return {
    pair: history.pair,
    points,
    latest: points.at(-1) ?? null,
    levels: compatibleLevels(venue),
    retainedCount: points.length,
  };
};
