import type { Address } from 'viem';
import type { OracleAdapter } from '../protocol/oracle-adapter';
import type { OraclePriceHistory } from '../protocol/profile-types';

export const ORACLE_HISTORY_HEAD_REFRESH_COUNT = 1;

type OracleHistoryAdapter = Pick<OracleAdapter, 'readPriceSnapshotHistory'>;
type OracleHistoryPair = { base: Address; quote: Address };

const sameAddress = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const assertSamePair = (left: OraclePriceHistory['pair'], right: OraclePriceHistory['pair']): void => {
  if (!sameAddress(left.base, right.base) || !sameAddress(left.quote, right.quote)) {
    throw new TypeError('Oracle history refresh returned a different pair.');
  }
};

export const mergeOraclePriceHistory = (
  current: OraclePriceHistory,
  head: OraclePriceHistory,
  retainedCount: number,
): OraclePriceHistory => {
  assertSamePair(current.pair, head.pair);
  if (!Number.isSafeInteger(retainedCount) || retainedCount < 0) {
    throw new RangeError('Oracle history retained count must be a non-negative safe integer.');
  }
  if (head.pointsNewestFirst.length === 0) return current;
  const newestByTimestamp = new Map<bigint, OraclePriceHistory['pointsNewestFirst'][number]>();
  for (const point of head.pointsNewestFirst) newestByTimestamp.set(point.timestamp, point);
  for (const point of current.pointsNewestFirst) {
    if (!newestByTimestamp.has(point.timestamp)) newestByTimestamp.set(point.timestamp, point);
  }
  return {
    pair: current.pair,
    requestedCount: current.requestedCount,
    pointsNewestFirst: [...newestByTimestamp.values()]
      .sort((left, right) => (left.timestamp === right.timestamp ? 0 : left.timestamp > right.timestamp ? -1 : 1))
      .slice(0, retainedCount),
  };
};

export const loadOraclePriceHistory = async (
  adapter: OracleHistoryAdapter,
  pair: OracleHistoryPair,
  current: OraclePriceHistory | null,
  retainedCount: number,
): Promise<OraclePriceHistory> => {
  if (current === null) {
    return adapter.readPriceSnapshotHistory(pair.base, pair.quote, retainedCount);
  }
  const head = await adapter.readPriceSnapshotHistory(pair.base, pair.quote, ORACLE_HISTORY_HEAD_REFRESH_COUNT);
  return mergeOraclePriceHistory(current, head, retainedCount);
};
