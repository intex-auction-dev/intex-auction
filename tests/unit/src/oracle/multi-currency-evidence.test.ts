import { describe, expect, it } from 'vitest';
import {
  contractCurrencyTerms,
  convertCoenMinorAtRate,
  coenToQuoteRate,
  deriveStrikeAmountMinor,
  formatCoenCurrency,
  formatCoenCurrencyLine,
  formatCurrencyCross,
  formatCurrencyMinor18,
  formatOracleRate18,
  formatPriceMinor9,
  preferredIssuanceCurrency,
  referenceEntryPrice,
} from '@/oracle/multi-currency-evidence';
import type { OracleConversions } from '@/oracle/oracle-conversions';

const PRICE = 10n ** 9n; // 1e9 price scale (entry/floor/call, strike amounts)
const RATE = 10n ** 18n; // 1e18 Oracle rate / COEN minor scale

describe('multi-currency bid evidence', () => {
  it('pins the auction price scale to 1e9, distinct from the 1e18 Oracle rate scale', () => {
    expect(formatPriceMinor9(1_000_000_000n)).toBe('1.00');
    expect(formatPriceMinor9(1_080_000_000n)).toBe('1.08');
    expect(formatPriceMinor9(2_280_000_000n)).toBe('2.28');
    expect(formatOracleRate18(1_000_000_000n)).toBe('0.00');
    expect(formatPriceMinor9(1_000_000_000_000_000_000n)).toBe('1,000,000,000.00');
  });

  it('prefers a stored selection, then TRY (949), then the reference currency, then first', () => {
    expect(preferredIssuanceCurrency([840, 949, 978], 840, null)).toBe(949);
    expect(preferredIssuanceCurrency([949, 978], 840, null)).toBe(949);
    expect(preferredIssuanceCurrency([840], 840, null)).toBe(840);
    expect(preferredIssuanceCurrency([840, 978], 840, null)).toBe(840);
    expect(preferredIssuanceCurrency([978], 840, null)).toBe(978);
    expect(preferredIssuanceCurrency([], 840, null)).toBeNull();

    expect(preferredIssuanceCurrency([840, 949, 978], 840, 978)).toBe(978);
    expect(preferredIssuanceCurrency([840, 949, 978], 840, 840)).toBe(840);
    expect(preferredIssuanceCurrency([840, 949], 840, 392)).toBe(949);
    expect(preferredIssuanceCurrency([], 840, 978)).toBeNull();
  });

  it('uses stored per-issuance arrays when available', () => {
    expect(
      contractCurrencyTerms({
        issuanceCurrencies: [840, 949],
        issuanceEntryPrices: [1n, 15n],
        strikeAmountsMinor: [100n, 1_500n],
        oraclePairIds: [1, 2],
        issuanceCurrency: 949,
      }),
    ).toEqual({
      issuanceCurrency: 949,
      issuanceEntryPriceMinor: 15n,
      strikeAmountMinor: 1_500n,
      referenceStrikeAmountMinor: null,
      oraclePairId: 2,
    });
  });

  it('returns null when issuance currency is not in the allowed list', () => {
    expect(
      contractCurrencyTerms({
        issuanceCurrencies: [840],
        issuanceEntryPrices: [1n],
        strikeAmountsMinor: [100n],
        issuanceCurrency: 949,
      }),
    ).toBeNull();
  });

  it('derives strike from reference-currency data when issuance == reference', () => {
    expect(
      contractCurrencyTerms({
        issuanceCurrencies: [840, 949],
        issuanceEntryPrices: [],
        strikeAmountsMinor: [],
        issuanceCurrency: 840,
        referenceCurrency: 840,
        referenceEntryPriceMinor: 2n * PRICE,
        promisLoadMinor: 50_000n * RATE,
      }),
    ).toEqual({
      issuanceCurrency: 840,
      issuanceEntryPriceMinor: 2n * PRICE,
      strikeAmountMinor: 100_000n * PRICE,
      referenceStrikeAmountMinor: 100_000n * PRICE,
    });
  });

  it('keeps the reference strike authoritative when no issuance conversion is observable', () => {
    expect(
      contractCurrencyTerms({
        issuanceCurrencies: [840, 949],
        issuanceEntryPrices: [],
        strikeAmountsMinor: [],
        issuanceCurrency: 949,
        referenceCurrency: 840,
        referenceEntryPriceMinor: 2n * PRICE,
        promisLoadMinor: 50_000n * RATE,
      }),
    ).toEqual({
      issuanceCurrency: 949,
      issuanceEntryPriceMinor: 0n,
      strikeAmountMinor: null,
      referenceStrikeAmountMinor: 100_000n * PRICE,
    });
  });

  it('resolves the entry price of a selected reference-currency row', () => {
    const codes = [840, 949, 978];
    const prices = [1n * PRICE, 15n * PRICE, (92n * PRICE) / 100n];
    expect(referenceEntryPrice(codes, prices, 949, 1n * PRICE)).toBe(15n * PRICE);
    expect(referenceEntryPrice(codes, prices, 978, 1n * PRICE)).toBe((92n * PRICE) / 100n);
    expect(referenceEntryPrice(codes, prices, 392, 1n * PRICE)).toBe(1n * PRICE);
    expect(referenceEntryPrice(undefined, undefined, 949, 7n)).toBe(7n);
  });

  it('returns unavailable strike when issuance != reference and no stored terms or conversions', () => {
    expect(
      contractCurrencyTerms({
        issuanceCurrencies: [840, 949],
        issuanceEntryPrices: [],
        strikeAmountsMinor: [],
        issuanceCurrency: 949,
        referenceCurrency: 840,
        referenceEntryPriceMinor: 2n * PRICE,
        promisLoadMinor: 50_000n * RATE,
      }),
    ).toEqual({
      issuanceCurrency: 949,
      issuanceEntryPriceMinor: 0n,
      strikeAmountMinor: null,
      referenceStrikeAmountMinor: 100_000n * PRICE,
    });
  });

  it('derives strike via Oracle cross-rate when issuance != reference and conversions are provided', () => {
    const conversions: OracleConversions = {
      byIsoCode: new Map([
        [
          840,
          {
            kind: 'available',
            isoCode: 840,
            denomination: 'USD',
            rate: 2n * RATE,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
        [
          949,
          {
            kind: 'available',
            isoCode: 949,
            denomination: 'TRY',
            rate: 30n * RATE,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
      ]),
    };
    const result = contractCurrencyTerms({
      issuanceCurrencies: [840, 949],
      issuanceEntryPrices: [],
      strikeAmountsMinor: [],
      issuanceCurrency: 949,
      referenceCurrency: 840,
      referenceEntryPriceMinor: 2n * PRICE,
      promisLoadMinor: 50_000n * RATE,
      conversions,
    });
    expect(result).toEqual({
      issuanceCurrency: 949,
      issuanceEntryPriceMinor: 30n * PRICE,
      strikeAmountMinor: 1_500_000n * PRICE,
      referenceStrikeAmountMinor: 100_000n * PRICE,
    });
  });

  it('derives the 1e9 cost of one Intex from a 1e9 entry price and 1e18 promis load', () => {
    expect(deriveStrikeAmountMinor(1n * PRICE, 100_000n * RATE)).toBe(100_000n * PRICE);
    expect(deriveStrikeAmountMinor(15n * PRICE, 100_000n * RATE)).toBe(1_500_000n * PRICE);
    expect(deriveStrikeAmountMinor((92n * PRICE) / 100n, 100_000n * RATE)).toBe(92_000n * PRICE);
  });

  it('converts COEN equivalents without floating point', () => {
    const coenMinor = 5n * RATE;
    expect(convertCoenMinorAtRate(coenMinor, 2_000_000_000_000_000n)).toBe(10_000_000_000_000_000n);
  });

  it('formats fixed-point evidence without number coercion', () => {
    expect(formatOracleRate18(1_234_500_000_000_000_000n)).toBe('1.23');
    expect(formatOracleRate18(1_235_600_000_000_000_000n)).toBe('1.24');
    expect(formatCurrencyMinor18(20_000_001_000_000_000_000n)).toBe('20.00');
    expect(formatCurrencyMinor18(1_234_560_000_000_000_000n)).toBe('1.23');
    expect(formatCurrencyMinor18(1_235_600_000_000_000_000n)).toBe('1.24');
    expect(formatPriceMinor9(1_234_500_000n)).toBe('1.23');
    expect(formatPriceMinor9(1_235_600_000n)).toBe('1.24');
  });

  it('resolves the live oracle rate, else lifts the 1e9 price fallback to the 1e18 rate scale', () => {
    const conversions: OracleConversions = {
      byIsoCode: new Map([
        [
          840,
          {
            kind: 'available',
            isoCode: 840,
            denomination: 'USD',
            rate: 2n * RATE,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
        [949, { kind: 'unavailable', isoCode: 949, denomination: 'TRY', reason: 'Oracle observation is incomplete.' }],
      ]),
    };

    expect(coenToQuoteRate(conversions, 840, 3n * PRICE)).toBe(2n * RATE);
    expect(coenToQuoteRate(conversions, 949, 7n * PRICE)).toBe(7n * RATE);
    expect(coenToQuoteRate(null, 840, 5n * PRICE)).toBe(5n * RATE);
    expect(coenToQuoteRate(null, 840, null)).toBeNull();
  });

  it('formats COEN conversions to a currency using the live rate and returns Conversion unavailable otherwise', () => {
    const conversions: OracleConversions = {
      byIsoCode: new Map([
        [
          840,
          {
            kind: 'available',
            isoCode: 840,
            denomination: 'USD',
            rate: 2n * RATE,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
      ]),
    };
    expect(formatCoenCurrency(5_000n * RATE, 840, conversions, 1n * PRICE)).toBe('10,000.00 USD');
    expect(formatCoenCurrency(5_000n * RATE, 949, conversions, null)).toBe('Conversion unavailable');
  });

  it('joins a COEN amount across currencies into one line with the 1e9 price fallback', () => {
    const conversions: OracleConversions = {
      byIsoCode: new Map([
        [
          840,
          {
            kind: 'available',
            isoCode: 840,
            denomination: 'USD',
            rate: 2n * RATE,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
        [949, { kind: 'unavailable', isoCode: 949, denomination: 'TRY', reason: 'Oracle observation is incomplete.' }],
      ]),
    };
    const amount = 5_000n * RATE;
    expect(
      formatCoenCurrencyLine(amount, conversions, [
        { isoCode: 949, contractFallback: null },
        { isoCode: 840, contractFallback: 1n * PRICE },
      ]),
    ).toBe('10,000.00 USD');
    expect(formatCoenCurrencyLine(amount, null, [{ isoCode: 840, contractFallback: null }])).toBe(
      'Conversion unavailable',
    );
    expect(
      formatCoenCurrencyLine(amount, conversions, [
        { isoCode: 840, contractFallback: 2n * PRICE },
        { isoCode: 949, contractFallback: 1_500_000_000n },
      ]),
    ).toBe('10,000.00 USD · 7,500.00 TRY');
  });

  it('converts a frozen currency amount to a reference at the live cross rate', () => {
    const conversions: OracleConversions = {
      byIsoCode: new Map([
        [
          840,
          {
            kind: 'available',
            isoCode: 840,
            denomination: 'USD',
            rate: 2n * RATE,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
        [
          949,
          {
            kind: 'available',
            isoCode: 949,
            denomination: 'TRY',
            rate: 30n * RATE,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
      ]),
    };
    expect(formatCurrencyCross(1_500_000n * RATE, 949, 840, conversions, null, null)).toBe('100,000.00 USD');
    expect(formatCurrencyCross(1_500_000n * RATE, 949, 840, null, null, null)).toBeNull();
    const withFallback: OracleConversions = {
      byIsoCode: new Map([
        [949, { kind: 'unavailable', isoCode: 949, denomination: 'TRY', reason: 'Oracle observation is incomplete.' }],
        [
          840,
          {
            kind: 'available',
            isoCode: 840,
            denomination: 'USD',
            rate: 2n * RATE,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
      ]),
    };
    expect(formatCurrencyCross(1_500_000n * RATE, 949, 840, withFallback, 30_000_000_000n, null)).toBe(
      '100,000.00 USD',
    );
  });
});
