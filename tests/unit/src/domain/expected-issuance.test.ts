import { describe, expect, it } from 'vitest';
import { expectedIssuanceWindow, expectedSeriesLabel } from '@/domain/expected-issuance';

describe('expectedIssuanceWindow', () => {
  it('derives the origin series window from the fan-in timeout', () => {
    const window = expectedIssuanceWindow(1_000_000n, 1_086_400n, 43_200);

    expect(window).toEqual({
      originSeriesEarliest: 1_000_000n,
      originSeriesLatest: 1_043_200n,
      issuanceStageEnd: 1_086_400n,
      targetDeliveryGuaranteed: false,
    });
  });

  it('returns null for a zero or negative timeout', () => {
    expect(expectedIssuanceWindow(1_000_000n, 1_086_400n, 0)).toBeNull();
    expect(expectedIssuanceWindow(1_000_000n, 1_086_400n, -1)).toBeNull();
  });

  it('returns null when revealEnd precedes the window start', () => {
    expect(expectedIssuanceWindow(0n, 86_400n, 43_200)).toBeNull();
  });

  it('returns null when issuanceEnd does not follow revealEnd', () => {
    expect(expectedIssuanceWindow(86_400n, 86_400n, 43_200)).toBeNull();
  });
});

describe('expectedSeriesLabel', () => {
  it('formats the worldwide day, issuance alpha code and reference-currency character', () => {
    expect(expectedSeriesLabel('20260526', 949, 840)).toBe('2026-05-26-TRY-U');
  });

  it('uses the first letter of the reference alpha code for each permitted reference currency', () => {
    expect(expectedSeriesLabel('20260526', 949, 840)).toBe('2026-05-26-TRY-U'); // USD
    expect(expectedSeriesLabel('20260526', 949, 978)).toBe('2026-05-26-TRY-E'); // EUR
    expect(expectedSeriesLabel('20260526', 949, 826)).toBe('2026-05-26-TRY-G'); // GBP
    expect(expectedSeriesLabel('20260526', 949, 156)).toBe('2026-05-26-TRY-C'); // CNY
    expect(expectedSeriesLabel('20260526', 949, 392)).toBe('2026-05-26-TRY-J'); // JPY
    expect(expectedSeriesLabel('20260526', 949, 344)).toBe('2026-05-26-TRY-H'); // HKD
  });

  it('returns null for an unknown issuance currency', () => {
    expect(expectedSeriesLabel('20260526', 0, 840)).toBeNull();
  });

  it('returns null for an unknown reference currency', () => {
    expect(expectedSeriesLabel('20260526', 949, 0)).toBeNull();
  });

  it('returns null for a malformed worldwide day', () => {
    expect(expectedSeriesLabel('2026', 949, 840)).toBeNull();
  });
});
