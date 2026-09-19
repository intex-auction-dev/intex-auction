import { describe, expect, it } from 'vitest';
import {
  currencyCode,
  fixedPointRoundedTo2,
  fixedPointTruncated,
  formatCompletionPromis,
  formatCurrencyMinor18,
  formatLadderPromis,
  formatOracleRate,
  formatOracleRate18,
  formatPaymentTokenAmount,
  formatPrice,
  formatPriceMinor9,
  formatPromisAmount,
  formatRecoveryTokenAmount,
  formatWorldwideDayDisplay,
  groupedTokenAmount,
  integer,
  intexUnit,
  intexUnitBig,
  titleCase,
} from '@/ui/display-format';
import { ORACLE_RATE_SCALE, PRICE_SCALE } from '@/domain/protocol-constants';

describe('display-format grouping idiom', () => {
  it('groups the whole part and trims trailing-zero fractions', () => {
    expect(groupedTokenAmount(1_234_500_000_000_000_000_000n, 18, 12)).toBe('1,234.5');
    expect(groupedTokenAmount(0n, 18, 12)).toBe('0');
    expect(groupedTokenAmount(1_000_000_000_000_000_000n, 18, 12)).toBe('1');
  });

  it('truncates the fraction to the requested significant-digit count', () => {
    // 0.123456789012345 at 18 decimals, trimmed to 12 → 0.123456789012
    expect(groupedTokenAmount(123_456_789_012_345_000n, 18, 12)).toBe('0.123456789012');
    // Same value trimmed to 4 → 0.1234
    expect(groupedTokenAmount(123_456_789_012_345_000n, 18, 4)).toBe('0.1234');
  });

  it('applies wCOEN → Œ symbol treatment and preserves the ERC-20 decimals guard', () => {
    expect(formatPaymentTokenAmount(1_500_000_000_000_000_000n, 18, 'wCOEN')).toBe('Œ1.5');
    expect(formatPaymentTokenAmount(1_500_000n, 6, 'USDC')).toBe('1.5 USDC');
    expect(() => formatPaymentTokenAmount(1n, 256, 'USDC')).toThrow('ERC-20 range');
    expect(() => formatPaymentTokenAmount(1n, -1, 'USDC')).toThrow('ERC-20 range');
  });

  it('formats recovery amounts with a raw trailing symbol and a minor-units fallback', () => {
    expect(formatRecoveryTokenAmount(2_000_000_000_000_000_000n, 18, 'wCOEN')).toBe('2 wCOEN');
    expect(formatRecoveryTokenAmount(5n, null, null)).toBe('5 token minor units');
    expect(formatRecoveryTokenAmount(5n, 18, null)).toBe('5 token minor units');
  });

  it('formats promis at the 1e6 scale and trims the ladder to 4 fraction digits', () => {
    expect(formatPromisAmount(1_234_567n)).toBe('1.234567');
    expect(formatCompletionPromis(1_234_567n)).toBe('1.234567');
    expect(formatLadderPromis(1_123_456_789_012_345_678n, 18)).toBe('1.1234');
  });

  it('pins promis formatting to the chain 1e6 scale (fails if 18 decimals returns)', () => {
    expect(formatPromisAmount(1_000_000n)).toBe('1');
    expect(formatCompletionPromis(1_000_000n)).toBe('1');
  });
});

describe('display-format scalars', () => {
  it('groups integers from bigint and number', () => {
    expect(integer(1_234_567n)).toBe('1,234,567');
    expect(integer(1_234_567)).toBe('1,234,567');
  });

  it('pluralises Intex for number and bigint quantities', () => {
    expect(intexUnit(1)).toBe('Intex');
    expect(intexUnit(0)).toBe('Intexes');
    expect(intexUnit(2)).toBe('Intexes');
    expect(intexUnitBig(1n)).toBe('Intex');
    expect(intexUnitBig(2n)).toBe('Intexes');
  });

  it('renders ISO-4217 codes with a numeric fallback', () => {
    expect(currencyCode(840)).toBe('USD');
    expect(currencyCode(999_999)).toBe('ISO 999999');
  });

  it('title-cases hyphenated tokens, including the empty string', () => {
    expect(titleCase('green-day')).toBe('Green Day');
    expect(titleCase('completed')).toBe('Completed');
    expect(titleCase('')).toBe('');
  });

  it('spaces a WorldwideDay key', () => {
    expect(formatWorldwideDayDisplay('20260804')).toBe('2026 08 04');
  });
});

/**
 * The rounding rule is the defect this step fixes, so its boundary cases are pinned here. Two policies
 * coexist because the shipped tests require both output shapes and no pinned string may change.
 */
describe('display-format fixed-point rounding', () => {
  const LARGEST_REALISTIC = 10n ** 30n; // 1e12 whole units at 1e18 scale — well past any real balance

  it('fixedPointTruncated: truncates, strips trailing zeros, does not group', () => {
    expect(formatOracleRate(1_500_000_000_000_000_000n)).toBe('1.5'); // pinned: oracle-chart-model.test.ts
    expect(formatOracleRate(0n)).toBe('0');
    expect(formatOracleRate(1_000_000_000_000_000_000n)).toBe('1');
    // half-way at the 18th decimal is truncated downward, never rounded up
    expect(fixedPointTruncated(1_500_000_000_000_000_005n, ORACLE_RATE_SCALE, 18)).toBe('1.500000000000000005');
    expect(fixedPointTruncated(1_999_999_999n, PRICE_SCALE, 6)).toBe('1999.999999');
    expect(formatPrice(2_280_000n)).toBe('2.28');
    expect(fixedPointTruncated(LARGEST_REALISTIC, ORACLE_RATE_SCALE, 18)).toBe('1000000000000');
  });

  it('fixedPointRoundedTo2: rounds half-up to two grouped decimals', () => {
    expect(formatPriceMinor9(1_000_000n)).toBe('1.00'); // pinned: multi-currency-evidence.test.ts
    expect(formatPriceMinor9(1_080_000n)).toBe('1.08');
    expect(formatPriceMinor9(2_280_000n)).toBe('2.28');
    expect(formatPriceMinor9(1_000_000_000_000_000_000n)).toBe('1,000,000,000,000.00');
    expect(formatOracleRate18(1_000_000_000n)).toBe('0.00');
    // half-way at the hundredth rounds up: 1.005 → 1.01 (bigint, no float)
    expect(fixedPointRoundedTo2(1_005_000n, PRICE_SCALE)).toBe('1.01');
    // just below half-way stays down: 1.00499… → 1.00
    expect(fixedPointRoundedTo2(1_004_999n, PRICE_SCALE)).toBe('1.00');
    expect(fixedPointRoundedTo2(0n, PRICE_SCALE)).toBe('0.00');
    expect(formatCurrencyMinor18(LARGEST_REALISTIC)).toBe('1,000,000,000,000.00');
    expect(() => fixedPointRoundedTo2(-1n, PRICE_SCALE)).toThrow('non-negative');
  });
});
