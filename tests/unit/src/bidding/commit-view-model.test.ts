import { describe, expect, it } from 'vitest';
import { strikeAmountRows, strikeCalculationCopy, strikeFxRate } from '@/bidding/commit-view-model';

// Pure strike/FX derivation hoisted out of the commit panel body. These pin the exact
// customer-facing strings the panel renders, independent of React.
describe('commit view model strike derivation', () => {
  it('projects the per-Intex and total strike with reference detail', () => {
    expect(
      strikeAmountRows({
        quantity: 3n,
        issuanceCurrency: 'EUR',
        referenceCurrency: 'USD',
        strikePerIntex: 100_000n * 10n ** 6n,
        referenceStrikePerIntexMinor: 108_000n * 10n ** 6n,
      }),
    ).toEqual({
      perIntexValue: '100,000.00 EUR',
      perIntexDetail: '108,000.00 USD · per Intex',
      totalValue: '300,000.00 EUR',
      totalDetail: '324,000.00 USD',
    });
  });

  it('falls back to the reference value when no issuance projection is available', () => {
    const rows = strikeAmountRows({
      quantity: null,
      issuanceCurrency: 'EUR',
      referenceCurrency: 'USD',
      strikePerIntex: null,
      referenceStrikePerIntexMinor: 108_000n * 10n ** 6n,
    });
    expect(rows.perIntexValue).toBe('108,000.00 USD');
    expect(rows.totalValue).toBe('—');
  });

  it('computes the frozen FX rate and null-guards a non-positive reference', () => {
    // Entry prices are at the chain 1e6 scale; the FX rate is a scale-invariant ratio at 1e18.
    expect(strikeFxRate(34n * 10n ** 6n, 1n * 10n ** 6n)).toBe(34n * 10n ** 18n);
    expect(strikeFxRate(34n, 0n)).toBeNull();
    expect(strikeFxRate(null, 1n)).toBeNull();
  });

  it('renders the strike calculation copy without a rounding note when exact', () => {
    const copy = strikeCalculationCopy({
      strikePerIntex: 1_000n * 10n ** 6n,
      issuanceEntryPriceMinor: 1n * 10n ** 6n,
      referenceEntryPriceMinor: 1n * 10n ** 6n,
      promisLoadMinor: 1_000n * 10n ** 6n,
      issuanceCurrency: 'USD',
      referenceCurrency: 'USD',
    });
    expect(copy).not.toBeNull();
    expect(copy).toContain('Entry Price');
    expect(copy).toContain('= 1,000.00 USD.');
    expect(copy).not.toContain('rounded up');
    expect(
      strikeCalculationCopy({
        strikePerIntex: null,
        issuanceEntryPriceMinor: null,
        referenceEntryPriceMinor: 1n,
        promisLoadMinor: 1n,
        issuanceCurrency: 'USD',
        referenceCurrency: 'USD',
      }),
    ).toBeNull();
  });
});
