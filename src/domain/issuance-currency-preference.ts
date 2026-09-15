const STORAGE_KEY = 'itx-acn:issuance-currency';

const MIN_ISSUANCE_CURRENCY = 1;
const MAX_ISSUANCE_CURRENCY = 999;

const inUpstreamRange = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= MIN_ISSUANCE_CURRENCY && value <= MAX_ISSUANCE_CURRENCY;

export const getPreferredIssuanceCurrency = (): number | null => {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!stored) return null;
    const value = Number(stored);
    return inUpstreamRange(value) ? value : null;
  } catch {
    return null;
  }
};

export const setPreferredIssuanceCurrency = (value: number | null): void => {
  try {
    if (value === null || !inUpstreamRange(value)) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, String(value));
  } catch {}
};
