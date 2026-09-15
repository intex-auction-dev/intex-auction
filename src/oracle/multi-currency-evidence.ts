import { iso4217Currency } from '../domain/iso-4217';
import { ORACLE_RATE_SCALE, PRICE_SCALE } from '../domain/protocol-constants';
import { formatCurrencyMinor18, formatOracleRate18, formatPriceMinor9 } from '../ui/display-format';
import type { OracleConversions } from './oracle-conversions';
import { liveOracleCrossRate } from './oracle-conversions';

export { formatCurrencyMinor18, formatOracleRate18, formatPriceMinor9 };

const PROMIS_SCALE = 10n ** 18n;

const FIRST_RUN_ISSUANCE_CURRENCY = 949;

const requireNonNegative = (value: bigint, label: string): void => {
  if (value < 0n) throw new RangeError(`${label} must be non-negative.`);
};

export interface ContractCurrencyTerms {
  readonly issuanceCurrency: number;
  readonly issuanceEntryPriceMinor: bigint;
  readonly strikeAmountMinor: bigint | null;
  readonly referenceStrikeAmountMinor: bigint | null;
  readonly oraclePairId?: number;
}

interface CurrencyTermsInput {
  readonly issuanceCurrencies: readonly number[];
  readonly issuanceEntryPrices: readonly bigint[];
  readonly strikeAmountsMinor: readonly bigint[];
  readonly oraclePairIds?: readonly number[];
  readonly issuanceCurrency: number;
  readonly referenceCurrency?: number;
  readonly referenceEntryPriceMinor?: bigint;
  readonly promisLoadMinor?: bigint;
  readonly conversions?: OracleConversions | null;
}

const issuanceEntryPrice = (input: CurrencyTermsInput): bigint | null => {
  const refEntry = input.referenceEntryPriceMinor;
  if (refEntry === undefined || refEntry <= 0n || input.referenceCurrency === undefined) return null;
  if (input.issuanceCurrency === input.referenceCurrency) return refEntry;
  if (!input.conversions) return null;
  const crossRate = liveOracleCrossRate(input.conversions, input.referenceCurrency, input.issuanceCurrency);
  return crossRate === null || crossRate <= 0n ? null : (refEntry * crossRate) / ORACLE_RATE_SCALE;
};

export const contractCurrencyTerms = (input: CurrencyTermsInput): ContractCurrencyTerms | null => {
  if (!input.issuanceCurrencies.includes(input.issuanceCurrency)) return null;
  const refEntry = input.referenceEntryPriceMinor;
  const promisLoad = input.promisLoadMinor;
  const pricedLoad = promisLoad !== undefined && promisLoad > 0n ? promisLoad : null;
  const referenceStrikeAmountMinor =
    refEntry !== undefined && refEntry > 0n && pricedLoad !== null
      ? deriveStrikeAmountMinor(refEntry, pricedLoad)
      : null;

  const index = input.issuanceCurrencies.indexOf(input.issuanceCurrency);
  const storedEntry = input.issuanceEntryPrices[index];
  const storedStrike = input.strikeAmountsMinor[index];
  if (storedEntry !== undefined && storedEntry > 0n && storedStrike !== undefined && storedStrike > 0n) {
    const oraclePairId = input.oraclePairIds?.[index];
    return {
      issuanceCurrency: input.issuanceCurrency,
      issuanceEntryPriceMinor: storedEntry,
      strikeAmountMinor: storedStrike,
      referenceStrikeAmountMinor,
      ...(oraclePairId === undefined || oraclePairId <= 0 ? {} : { oraclePairId }),
    };
  }

  const projectedEntry = issuanceEntryPrice(input);
  return {
    issuanceCurrency: input.issuanceCurrency,
    issuanceEntryPriceMinor: projectedEntry ?? 0n,
    strikeAmountMinor:
      projectedEntry === null || pricedLoad === null ? null : deriveStrikeAmountMinor(projectedEntry, pricedLoad),
    referenceStrikeAmountMinor,
  };
};

export const referenceEntryPrice = (
  referenceCurrencies: readonly number[] | undefined,
  referenceEntryPrices: readonly bigint[] | undefined,
  isoCode: number,
  fallback: bigint,
): bigint => {
  const index = referenceCurrencies?.indexOf(isoCode) ?? -1;
  const price = index < 0 ? undefined : referenceEntryPrices?.[index];
  return price !== undefined && price > 0n ? price : fallback;
};

export const deriveStrikeAmountMinor = (issuanceEntryPriceMinor: bigint, promisLoadMinor: bigint): bigint =>
  (issuanceEntryPriceMinor * promisLoadMinor) / PROMIS_SCALE;

/**
 * Default issuance currency for the bid form: the bidder's stored preference when the auction offers
 * it, then TRY, then the priced reference currency, then the first option.
 */
export const preferredIssuanceCurrency = (
  issuanceCurrencies: readonly number[],
  referenceCurrency: number,
  storedPreference: number | null,
): number | null => {
  if (storedPreference !== null && issuanceCurrencies.includes(storedPreference)) return storedPreference;
  if (issuanceCurrencies.includes(FIRST_RUN_ISSUANCE_CURRENCY)) return FIRST_RUN_ISSUANCE_CURRENCY;
  if (issuanceCurrencies.includes(referenceCurrency)) return referenceCurrency;
  return issuanceCurrencies[0] ?? null;
};

export const convertCoenMinorAtRate = (coenMinor: bigint, quotePerCoenRate: bigint): bigint => {
  requireNonNegative(coenMinor, 'COEN amount');
  requireNonNegative(quotePerCoenRate, 'Oracle rate');
  return (coenMinor * quotePerCoenRate) / ORACLE_RATE_SCALE;
};

export const coenToQuoteRate = (
  conversions: OracleConversions | null | undefined,
  isoCode: number,
  contractFallback: bigint | null,
): bigint | null => {
  const live = conversions?.byIsoCode.get(isoCode);
  if (live?.kind === 'available' && live.rate > 0n) return live.rate;
  if (contractFallback === null || contractFallback <= 0n) return null;
  return contractFallback * (ORACLE_RATE_SCALE / PRICE_SCALE);
};

export const formatCoenCurrency = (
  amountCoenMinor: bigint,
  isoCode: number,
  conversions: OracleConversions | null | undefined,
  contractFallback: bigint | null,
): string => {
  const rate = coenToQuoteRate(conversions, isoCode, contractFallback);
  if (rate === null) return 'Conversion unavailable';
  return `${formatCurrencyMinor18(convertCoenMinorAtRate(amountCoenMinor, rate))} ${iso4217Currency(isoCode)?.alphaCode ?? `ISO ${isoCode}`}`;
};

export const formatCoenCurrencyLine = (
  amountCoenMinor: bigint,
  conversions: OracleConversions | null | undefined,
  entries: ReadonlyArray<{ readonly isoCode: number; readonly contractFallback: bigint | null }>,
): string => {
  const parts: string[] = [];
  for (const { isoCode, contractFallback } of entries) {
    const part = formatCoenCurrency(amountCoenMinor, isoCode, conversions, contractFallback);
    if (part !== 'Conversion unavailable') parts.push(part);
  }
  return parts.length === 0 ? 'Conversion unavailable' : parts.join(' · ');
};

export const formatCurrencyCross = (
  amountMinor: bigint,
  fromIsoCode: number,
  toIsoCode: number,
  conversions: OracleConversions | null | undefined,
  fromContractFallback: bigint | null,
  toContractFallback: bigint | null,
): string | null => {
  const fromRate = coenToQuoteRate(conversions, fromIsoCode, fromContractFallback);
  const toRate = coenToQuoteRate(conversions, toIsoCode, toContractFallback);
  if (fromRate === null || toRate === null) return null;
  const cross = (toRate * ORACLE_RATE_SCALE) / fromRate;
  return `${formatCurrencyMinor18((amountMinor * cross) / ORACLE_RATE_SCALE)} ${iso4217Currency(toIsoCode)?.alphaCode ?? `ISO ${toIsoCode}`}`;
};
