import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { USD_REFERENCE_CURRENCY } from '../domain/protocol-constants';
import type { OracleConversions } from './oracle-conversions';
import { liveOracleCrossRate } from './oracle-conversions';
import {
  coenToQuoteRate,
  formatCoenCurrency as formatCoenCurrencyValue,
  formatCoenCurrencyLine as formatCoenCurrencyLineValue,
  formatCurrencyCross as formatCurrencyCrossValue,
} from './multi-currency-evidence';
import { currencyCode, formatCurrencyMinor18, formatOracleRate18, formatPriceMinor9 } from '../ui/display-format';

export { currencyCode };

const CurrencyRatesContext = createContext<OracleConversions | null>(null);

export function CurrencyRatesProvider({
  children,
  conversions,
}: {
  readonly children: ReactNode;
  readonly conversions: OracleConversions | null | undefined;
}) {
  return <CurrencyRatesContext.Provider value={conversions ?? null}>{children}</CurrencyRatesContext.Provider>;
}

export const useCurrencyRates = (): OracleConversions | null => useContext(CurrencyRatesContext);

export interface CurrencyFormatters {
  readonly conversions: OracleConversions | null;
  readonly currencyCode: (isoCode: number) => string;
  readonly formatReferenceValue: (value: bigint, isoCode: number, options?: { readonly live?: boolean }) => string;
  readonly formatCoenCurrency: (amountCoenMinor: bigint, isoCode: number, contractFallback: bigint | null) => string;
  readonly formatCoenCurrencyLine: (
    amountCoenMinor: bigint,
    entries: ReadonlyArray<{ readonly isoCode: number; readonly contractFallback: bigint | null }>,
  ) => string;
  readonly formatCurrencyCross: (
    amountMinor: bigint,
    fromIsoCode: number,
    toIsoCode: number,
    fromContractFallback: bigint | null,
    toContractFallback: bigint | null,
  ) => string | null;
  readonly formatCoenReferenceRate: (
    isoCode: number,
    contractFallback: bigint | null,
    paymentTokenSymbol: string,
  ) => string;
  readonly formatCrossRate: (fromIsoCode: number, toIsoCode: number, contractFallback: bigint | null) => string;
}

export function useCurrencyFormatters(): CurrencyFormatters {
  const conversions = useCurrencyRates();
  return useMemo(
    (): CurrencyFormatters => ({
      conversions,
      currencyCode,
      formatReferenceValue: (value, isoCode, options = {}) => {
        const liveRate = options.live ? coenToQuoteRate(conversions, isoCode, null) : null;
        const amount = liveRate !== null ? formatOracleRate18(liveRate) : formatPriceMinor9(value);
        return isoCode === USD_REFERENCE_CURRENCY ? `$${amount}` : `${amount} ${currencyCode(isoCode)}`;
      },
      formatCoenCurrency: (amountCoenMinor, isoCode, contractFallback) =>
        formatCoenCurrencyValue(amountCoenMinor, isoCode, conversions, contractFallback),
      formatCoenCurrencyLine: (amountCoenMinor, entries) =>
        formatCoenCurrencyLineValue(amountCoenMinor, conversions, entries),
      formatCurrencyCross: (amountMinor, fromIsoCode, toIsoCode, fromContractFallback, toContractFallback) =>
        formatCurrencyCrossValue(
          amountMinor,
          fromIsoCode,
          toIsoCode,
          conversions,
          fromContractFallback,
          toContractFallback,
        ),
      formatCoenReferenceRate: (isoCode, contractFallback, paymentTokenSymbol) => {
        const live = conversions?.byIsoCode.get(isoCode);
        const liveRate = live?.kind === 'available' && live.rate > 0n ? live.rate : null;
        const displaySymbol = paymentTokenSymbol.toLowerCase() === 'wcoen' ? 'Œ' : paymentTokenSymbol;
        const amount =
          liveRate !== null
            ? formatOracleRate18(liveRate)
            : contractFallback !== null && contractFallback > 0n
              ? formatPriceMinor9(contractFallback)
              : null;
        return amount === null
          ? `1 ${displaySymbol} ≈ Conversion unavailable`
          : `1 ${displaySymbol} ≈ ${amount} ${currencyCode(isoCode)}`;
      },
      formatCrossRate: (fromIsoCode, toIsoCode, contractFallback) => {
        const live = conversions === null ? null : liveOracleCrossRate(conversions, fromIsoCode, toIsoCode);
        const rate = live ?? contractFallback;
        return rate === null || rate <= 0n
          ? 'Contract pricing evidence unavailable'
          : `1 ${currencyCode(fromIsoCode)} ≈ ${formatCurrencyMinor18(rate)} ${currencyCode(toIsoCode)}`;
      },
    }),
    [conversions],
  );
}
