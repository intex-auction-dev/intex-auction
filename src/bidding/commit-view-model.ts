import { deriveStrikeAmountMinor } from '../oracle/multi-currency-evidence';
import { formatOracleRate18, formatPriceMinor9, formatPromisAmount } from '../ui/display-format';

const strikeMoney = (minor: bigint, code: string): string => `${formatPriceMinor9(minor)} ${code}`;

export interface StrikeAmountRowsInput {
  readonly quantity: bigint | null;
  readonly issuanceCurrency: string;
  readonly referenceCurrency: string;
  readonly strikePerIntex: bigint | null;
  readonly referenceStrikePerIntexMinor: bigint | null;
}

export interface StrikeAmountRows {
  readonly perIntexValue: string;
  readonly perIntexDetail: string | undefined;
  readonly totalValue: string;
  readonly totalDetail: string | undefined;
}

export const strikeAmountRows = (input: StrikeAmountRowsInput): StrikeAmountRows => {
  const projected = input.strikePerIntex !== null;
  const primary = input.strikePerIntex ?? input.referenceStrikePerIntexMinor;
  const primaryCode = projected ? input.issuanceCurrency : input.referenceCurrency;
  const reference = input.referenceStrikePerIntexMinor;
  const perIntexDetail =
    primary === null
      ? undefined
      : projected && reference !== null
        ? `${strikeMoney(reference, input.referenceCurrency)} · per Intex`
        : projected
          ? 'per Intex'
          : `${input.issuanceCurrency} conversion unavailable · per Intex`;
  const totalDetail =
    primary === null || input.quantity === null
      ? undefined
      : projected && reference !== null
        ? strikeMoney(reference * input.quantity, input.referenceCurrency)
        : undefined;
  return {
    perIntexValue: primary === null ? '—' : strikeMoney(primary, primaryCode),
    perIntexDetail,
    totalValue: primary === null || input.quantity === null ? '—' : strikeMoney(primary * input.quantity, primaryCode),
    totalDetail,
  };
};

/**
 * The frozen reference→issuance FX rate used to explain a stored strike. Returns null when
 * no issuance terms are known or the reference entry price is non-positive.
 */
export const strikeFxRate = (
  issuanceEntryPriceMinor: bigint | null,
  referenceEntryPriceMinor: bigint,
): bigint | null =>
  issuanceEntryPriceMinor === null || referenceEntryPriceMinor <= 0n
    ? null
    : (issuanceEntryPriceMinor * 10n ** 18n) / referenceEntryPriceMinor;

/**
 * Human-readable derivation of the stored per-Intex strike from entry price, Intex size and
 * FX, matching the reviewed rounding behaviour. Returns null when the projection is unknown.
 */
export const strikeCalculationCopy = (input: {
  readonly strikePerIntex: bigint | null;
  readonly issuanceEntryPriceMinor: bigint | null;
  readonly referenceEntryPriceMinor: bigint;
  readonly promisLoadMinor: bigint;
  readonly issuanceCurrency: string;
  readonly referenceCurrency: string;
}): string | null => {
  const fxRate = strikeFxRate(input.issuanceEntryPriceMinor, input.referenceEntryPriceMinor);
  if (input.strikePerIntex === null || fxRate === null || input.issuanceEntryPriceMinor === null) return null;
  const rawStrikePerIntex = deriveStrikeAmountMinor(input.issuanceEntryPriceMinor, input.promisLoadMinor);
  const prefix = `Entry Price ${formatPriceMinor9(input.referenceEntryPriceMinor)} ${input.referenceCurrency} × Intex Size ${formatPromisAmount(input.promisLoadMinor)} × FX ${input.referenceCurrency}→${input.issuanceCurrency} ${formatOracleRate18(fxRate)} = `;
  return rawStrikePerIntex === input.strikePerIntex
    ? `${prefix}${formatPriceMinor9(input.strikePerIntex)} ${input.issuanceCurrency}.`
    : `${prefix}${formatPriceMinor9(rawStrikePerIntex)} ${input.issuanceCurrency}; rounded up to ${formatPriceMinor9(input.strikePerIntex)} ${input.issuanceCurrency}.`;
};
