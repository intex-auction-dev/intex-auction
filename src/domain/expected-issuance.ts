import { iso4217Currency } from './iso-4217';

export interface ExpectedIssuanceWindow {
  originSeriesEarliest: bigint;
  originSeriesLatest: bigint;
  issuanceStageEnd: bigint;
  targetDeliveryGuaranteed: false;
}

export const expectedIssuanceWindow = (
  revealEnd: bigint,
  issuanceEnd: bigint,
  bidsFanInTimeoutSeconds: number,
): ExpectedIssuanceWindow | null => {
  if (revealEnd <= 0n || issuanceEnd <= revealEnd || bidsFanInTimeoutSeconds <= 0) return null;
  return {
    originSeriesEarliest: revealEnd,
    originSeriesLatest: revealEnd + BigInt(bidsFanInTimeoutSeconds),
    issuanceStageEnd: issuanceEnd,
    targetDeliveryGuaranteed: false,
  };
};

export const expectedSeriesLabel = (
  worldwideDay: string,
  issuanceCurrency: number,
  referenceCurrency: number,
): string | null => {
  if (worldwideDay.length !== 8) return null;
  const issuance = iso4217Currency(issuanceCurrency);
  const reference = iso4217Currency(referenceCurrency);
  if (!issuance || !reference) return null;
  const date = `${worldwideDay.slice(0, 4)}-${worldwideDay.slice(4, 6)}-${worldwideDay.slice(6, 8)}`;
  return `${date}-${issuance.alphaCode}-${reference.alphaCode.slice(0, 1)}`;
};
