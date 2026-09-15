import { afterEach, describe, expect, it } from 'vitest';
import { getPreferredIssuanceCurrency, setPreferredIssuanceCurrency } from '@/domain/issuance-currency-preference';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

const installStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
};

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('issuance currency preference', () => {
  it('round-trips a selection and clears it on null', () => {
    const values = installStorage();
    expect(getPreferredIssuanceCurrency()).toBeNull();

    setPreferredIssuanceCurrency(949);
    expect(values.get('itx-acn:issuance-currency')).toBe('949');
    expect(getPreferredIssuanceCurrency()).toBe(949);

    setPreferredIssuanceCurrency(null);
    expect(values.has('itx-acn:issuance-currency')).toBe(false);
    expect(getPreferredIssuanceCurrency()).toBeNull();
  });

  it('accepts the upstream 1..999 bounds and rejects codes outside them', () => {
    const values = installStorage();
    setPreferredIssuanceCurrency(1);
    expect(getPreferredIssuanceCurrency()).toBe(1);
    setPreferredIssuanceCurrency(999);
    expect(getPreferredIssuanceCurrency()).toBe(999);

    setPreferredIssuanceCurrency(1_000);
    expect(values.has('itx-acn:issuance-currency')).toBe(false);
    setPreferredIssuanceCurrency(0);
    expect(getPreferredIssuanceCurrency()).toBeNull();
  });

  it('ignores stored values that are not usable issuance-currency codes', () => {
    for (const stored of ['', 'TRY', '1000', '0', '-949', '949.5', 'NaN']) {
      installStorage({ 'itx-acn:issuance-currency': stored });
      expect(getPreferredIssuanceCurrency()).toBeNull();
    }
  });

  it('degrades to no preference when storage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    expect(getPreferredIssuanceCurrency()).toBeNull();
    expect(() => setPreferredIssuanceCurrency(949)).not.toThrow();
  });
});
