import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { OraclePriceHistory } from '@/protocol/profile-types';
import { loadOraclePriceHistory } from '@/oracle/oracle-history-refresh';
import { toUtcTimestamp } from '@/domain/protocol-time';

const COEN = `0x${'1'.repeat(40)}` as Address;
const USD = `0x${'2'.repeat(40)}` as Address;
const pair = { base: COEN, quote: USD };

const history = (
  pointsNewestFirst: OraclePriceHistory['pointsNewestFirst'],
  requestedCount = 365,
): OraclePriceHistory => ({
  pair,
  requestedCount,
  pointsNewestFirst,
});

describe('Oracle history refresh', () => {
  it('loads the full chart window once, then refreshes only the newest observation', async () => {
    const requestedCounts: number[] = [];
    const adapter = {
      async readPriceSnapshotHistory(_base: Address, _quote: Address, count: number) {
        requestedCounts.push(count);
        return requestedCounts.length === 1
          ? history(
              [
                { timestamp: toUtcTimestamp(300n), rate: 30n, volume: 3n },
                { timestamp: toUtcTimestamp(200n), rate: 20n, volume: 2n },
              ],
              count,
            )
          : history([{ timestamp: toUtcTimestamp(400n), rate: 40n, volume: 4n }], count);
      },
    };

    const full = await loadOraclePriceHistory(adapter, pair, null, 365);
    const refreshed = await loadOraclePriceHistory(adapter, pair, full, 365);

    expect(requestedCounts).toEqual([365, 1]);
    expect(refreshed.pointsNewestFirst).toEqual([
      { timestamp: toUtcTimestamp(400n), rate: 40n, volume: 4n },
      { timestamp: toUtcTimestamp(300n), rate: 30n, volume: 3n },
      { timestamp: toUtcTimestamp(200n), rate: 20n, volume: 2n },
    ]);
    expect(refreshed.requestedCount).toBe(365);
  });

  it('replaces a changed newest observation without refetching retained history', async () => {
    const adapter = {
      async readPriceSnapshotHistory(_base: Address, _quote: Address, count: number) {
        expect(count).toBe(1);
        return history([{ timestamp: toUtcTimestamp(300n), rate: 31n, volume: 5n }], count);
      },
    };
    const current = history([
      { timestamp: toUtcTimestamp(300n), rate: 30n, volume: 3n },
      { timestamp: toUtcTimestamp(200n), rate: 20n, volume: 2n },
    ]);

    await expect(loadOraclePriceHistory(adapter, pair, current, 365)).resolves.toEqual(
      history([
        { timestamp: toUtcTimestamp(300n), rate: 31n, volume: 5n },
        { timestamp: toUtcTimestamp(200n), rate: 20n, volume: 2n },
      ]),
    );
  });
});
