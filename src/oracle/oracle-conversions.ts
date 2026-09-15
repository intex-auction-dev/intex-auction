import type { UtcTimestamp } from '../domain/protocol-time';
import { iso4217Currency } from '../domain/iso-4217';
import type { OracleAdapter } from '../protocol/oracle-adapter';

export type OracleConversion =
  | {
      kind: 'available';
      isoCode: number;
      denomination: string;
      rate: bigint;
      sourceBlock: bigint | null;
      sourceTimestamp: UtcTimestamp | null;
    }
  | { kind: 'unavailable'; isoCode: number; denomination: string; reason: string };

export interface OracleConversions {
  readonly byIsoCode: ReadonlyMap<number, OracleConversion>;
}

const RATE_SCALE = 10n ** 18n;

export const liveOracleCrossRate = (
  conversions: OracleConversions,
  referenceIsoCode: number,
  issuanceIsoCode: number,
): bigint | null => {
  const reference = conversions.byIsoCode.get(referenceIsoCode);
  const issuance = conversions.byIsoCode.get(issuanceIsoCode);
  if (reference?.kind !== 'available' || issuance?.kind !== 'available' || reference.rate <= 0n) return null;
  return (issuance.rate * RATE_SCALE) / reference.rate;
};

export const loadOracleConversions = async (
  adapter: Pick<OracleAdapter, 'readSettlementCurrencies' | 'readCoenExchangeRate'>,
  isoCodes: readonly number[],
): Promise<OracleConversions> => {
  const settlements = await adapter.readSettlementCurrencies();
  const settlementByIso = new Map(settlements.map((item) => [item.isoCode, item]));
  const codes = [...new Set([...isoCodes, ...settlementByIso.keys()])];
  const entries = await Promise.all(
    codes.map(async (isoCode): Promise<[number, OracleConversion]> => {
      const settlement = settlementByIso.get(isoCode);
      const denomination = settlement?.denomination ?? iso4217Currency(isoCode)?.alphaCode ?? `ISO ${isoCode}`;
      if (!settlement)
        return [
          isoCode,
          { kind: 'unavailable', isoCode, denomination, reason: 'Currency is not registered by the Oracle.' },
        ];
      try {
        const rate = await adapter.readCoenExchangeRate(isoCode);
        if (rate <= 0n) {
          return [isoCode, { kind: 'unavailable', isoCode, denomination, reason: 'Oracle observation is incomplete.' }];
        }
        return [isoCode, { kind: 'available', isoCode, denomination, rate, sourceBlock: null, sourceTimestamp: null }];
      } catch (error) {
        return [
          isoCode,
          {
            kind: 'unavailable',
            isoCode,
            denomination,
            reason: error instanceof Error ? error.message : 'Oracle read failed.',
          },
        ];
      }
    }),
  );
  return { byIsoCode: new Map(entries) };
};
