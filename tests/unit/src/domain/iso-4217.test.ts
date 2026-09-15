import { describe, expect, it } from 'vitest';
import {
  ISO_4217_CURRENCIES,
  ISO_4217_SNAPSHOT_PUBLISHED,
  ISO_4217_SNAPSHOT_SHA256,
  formatIso4217Currency,
  formatIso4217CurrencyCode,
  iso4217Currency,
  searchIso4217Currencies,
} from '@/domain/iso-4217';

describe('protocol-pinned ISO 4217 catalogue', () => {
  it('is sorted, unique and pinned to the reviewed SIX snapshot', () => {
    expect(ISO_4217_SNAPSHOT_PUBLISHED).toBe('2026-01-01');
    expect(ISO_4217_SNAPSHOT_SHA256).toBe('838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9');
    expect(ISO_4217_CURRENCIES.length).toBeGreaterThan(150);
    const codes = ISO_4217_CURRENCIES.map((currency) => currency.numericCode);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('resolves and searches by code, name and territory', () => {
    expect(iso4217Currency(840)?.alphaCode).toBe('USD');
    expect(iso4217Currency(999)?.alphaCode).toBe('XXX');
    expect(formatIso4217Currency(949)).toContain('TRY');
    expect(searchIso4217Currencies('euro', [840, 949, 978]).map((currency) => currency.numericCode)).toEqual([978]);
    expect(searchIso4217Currencies('türkiye', [840, 949, 978]).map((currency) => currency.alphaCode)).toEqual(['TRY']);
  });

  it('renders alpha + numeric ISO code for currency identity and degrades to ISO fallback', () => {
    expect(formatIso4217CurrencyCode(949)).toBe('TRY · 949');
    expect(formatIso4217CurrencyCode(840)).toBe('USD · 840');
    expect(formatIso4217CurrencyCode(978)).toBe('EUR · 978');
    expect(formatIso4217CurrencyCode(1)).toBe('ISO 1');
  });

  it('uses full bidder-facing names and omits non-currency issuance labels', () => {
    expect(formatIso4217Currency(8)).toBe('ALL — Albanian Lek');
    expect(formatIso4217Currency(50)).toBe('BDT — Bangladeshi Taka');
    expect(formatIso4217Currency(410)).toBe('KRW — South Korean Won');
    expect(searchIso4217Currencies('', [8])[0]?.name).toBe('Albanian Lek');

    const codes = searchIso4217Currencies(
      '',
      ISO_4217_CURRENCIES.map((currency) => currency.numericCode),
    ).map((currency) => currency.alphaCode);
    expect(codes).toContain('USD');
    expect(codes).toContain('XAF');
    expect(codes).not.toEqual(
      expect.arrayContaining([
        'BOV',
        'CHE',
        'CHW',
        'CLF',
        'COU',
        'MXV',
        'USN',
        'UYI',
        'UYW',
        'XAD',
        'XAG',
        'XAU',
        'XBA',
        'XBB',
        'XBC',
        'XBD',
        'XDR',
        'XPD',
        'XPT',
        'XSU',
        'XTS',
        'XUA',
        'XXX',
      ]),
    );
  });
});
