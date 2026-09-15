import { describe, expect, it } from 'vitest';
import { liveOracleCrossRate, loadOracleConversions } from '@/oracle/oracle-conversions';

const adapter = (overrides: Partial<Record<'readSettlementCurrencies' | 'readCoenExchangeRate', unknown>> = {}) => ({
  readSettlementCurrencies: async () => [
    { isoCode: 840, denomination: 'USD' },
    { isoCode: 949, denomination: 'TRY' },
  ],
  readCoenExchangeRate: async (isoCode: number) => (isoCode === 949 ? 15n * 10n ** 18n : 10n ** 18n),
  ...overrides,
});

describe('Oracle conversion adapter', () => {
  it('preserves independent rates per reference currency', async () => {
    const result = await loadOracleConversions(adapter() as never, [840, 949]);
    expect(result.byIsoCode.get(840)).toMatchObject({
      kind: 'available',
      rate: 10n ** 18n,
      sourceBlock: null,
      sourceTimestamp: null,
    });
    expect(result.byIsoCode.get(949)).toMatchObject({
      kind: 'available',
      rate: 15n * 10n ** 18n,
      sourceBlock: null,
      sourceTimestamp: null,
    });
  });

  it('does not fabricate block or epoch-0 timestamp provenance from the rate-only read', async () => {
    const result = await loadOracleConversions(adapter() as never, [840, 949]);
    const available = [...result.byIsoCode.values()].filter((entry) => entry.kind === 'available');
    expect(available).toHaveLength(2);
    available.forEach((entry) => {
      if (entry.kind !== 'available') return;
      expect(entry.sourceBlock).toBeNull();
      expect(entry.sourceTimestamp).toBeNull();
      expect(entry.sourceBlock).not.toBe(0n);
    });
  });

  it('keeps one failed currency independent', async () => {
    const base = adapter();
    const result = await loadOracleConversions(
      {
        ...base,
        readCoenExchangeRate: async (isoCode: number) => {
          if (isoCode === 949) throw new Error('pair failed');
          return 10n ** 18n;
        },
      } as never,
      [840, 949],
    );
    expect(result.byIsoCode.get(840)?.kind).toBe('available');
    expect(result.byIsoCode.get(949)).toMatchObject({ kind: 'unavailable', reason: 'pair failed' });
  });

  it('rejects zero-rate evidence', async () => {
    const zero = await loadOracleConversions(
      adapter({
        readCoenExchangeRate: async () => 0n,
      }) as never,
      [840],
    );
    expect(zero.byIsoCode.get(840)?.kind).toBe('unavailable');
  });

  it('derives a live issuance cross-rate from independent pair observations', async () => {
    const conversions = await loadOracleConversions(
      adapter({
        readCoenExchangeRate: async (isoCode: number) => (isoCode === 949 ? 75n * 10n ** 18n : 2n * 10n ** 18n),
      }) as never,
      [840, 949],
    );
    expect(liveOracleCrossRate(conversions, 840, 949)).toBe(37_500_000_000_000_000_000n);
  });

  it('loads every Oracle-registered currency, not only the requested ones', async () => {
    const result = await loadOracleConversions(adapter() as never, [840]);
    expect(result.byIsoCode.get(949)).toMatchObject({ kind: 'available', rate: 15n * 10n ** 18n });
    expect(liveOracleCrossRate(result, 840, 949)).toBe(15n * 10n ** 18n);
  });

  it('returns null for a live cross when either currency observation is unusable', async () => {
    const unregistered = await loadOracleConversions(
      adapter({
        readSettlementCurrencies: async () => [{ isoCode: 840, denomination: 'USD' }],
      }) as never,
      [840, 949],
    );
    expect(unregistered.byIsoCode.get(949)).toMatchObject({ kind: 'unavailable' });
    expect(liveOracleCrossRate(unregistered, 840, 949)).toBeNull();
    const broken = await loadOracleConversions(
      adapter({
        readCoenExchangeRate: async (isoCode: number) => {
          if (isoCode === 949) throw new Error('pair failed');
          return 2n * 10n ** 18n;
        },
      }) as never,
      [840, 949],
    );
    expect(liveOracleCrossRate(broken, 840, 949)).toBeNull();
  });
});
