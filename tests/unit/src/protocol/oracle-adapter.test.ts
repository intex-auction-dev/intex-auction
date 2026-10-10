import { describe, expect, it } from 'vitest';
import { OracleAdapter } from '@/protocol/oracle-adapter';
import { CHART_WINDOW_POINTS } from '@/domain/protocol-constants';
import { COEN, FakeClient, ORACLE, USD_QUOTE, key, outbeProfile } from './adapter-fixtures';

describe('Oracle adapter', () => {
  it('reads configured Oracle history as exact newest-first integers', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [
          key(ORACLE, 'getPriceSnapshotHistory'),
          [
            [300n, 200n, 200n, 100n],
            [30_000_000_000_000_000_000n, 20n, 999n, 10n],
            [3n, 2n, 99n, 1n],
          ],
        ],
      ]),
    );

    await expect(
      new OracleAdapter(client, outbeProfile()).readPriceSnapshotHistory(COEN, USD_QUOTE, 500),
    ).resolves.toEqual({
      pair: { base: COEN, quote: USD_QUOTE },
      requestedCount: CHART_WINDOW_POINTS,
      pointsNewestFirst: [
        { timestamp: 300n, rate: 30_000_000_000_000_000_000n, volume: 3n },
        { timestamp: 200n, rate: 20n, volume: 2n },
        { timestamp: 100n, rate: 10n, volume: 1n },
      ],
    });
  });

  it('rejects malformed Oracle arrays and non-newest-first output', async () => {
    const mismatched = new FakeClient(
      31337,
      new Map<string, unknown>([[key(ORACLE, 'getPriceSnapshotHistory'), [[2n], [20n, 10n], [1n]]]]),
    );
    await expect(
      new OracleAdapter(mismatched, outbeProfile()).readPriceSnapshotHistory(COEN, USD_QUOTE, 90),
    ).rejects.toThrow('identical lengths');

    const wrongOrder = new FakeClient(
      31337,
      new Map<string, unknown>([
        [
          key(ORACLE, 'getPriceSnapshotHistory'),
          [
            [100n, 200n],
            [10n, 20n],
            [1n, 2n],
          ],
        ],
      ]),
    );
    await expect(
      new OracleAdapter(wrongOrder, outbeProfile()).readPriceSnapshotHistory(COEN, USD_QUOTE, 90),
    ).rejects.toThrow('newest-first');
  });
});
