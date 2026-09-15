import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OracleConversions } from '@/oracle/oracle-conversions';
import { CurrencyRatesProvider, useCurrencyFormatters } from '@/oracle/currency-state';

const conversions = (usdRate: bigint, tryRate = 34n * 10n ** 18n): OracleConversions => ({
  byIsoCode: new Map([
    [
      840,
      { kind: 'available', isoCode: 840, denomination: 'USD', rate: usdRate, sourceBlock: null, sourceTimestamp: null },
    ],
    [
      949,
      { kind: 'available', isoCode: 949, denomination: 'TRY', rate: tryRate, sourceBlock: null, sourceTimestamp: null },
    ],
  ]),
});

function CurrencyConsumer() {
  const currency = useCurrencyFormatters();
  return (
    <dl>
      <div>
        <dt>Entry</dt>
        <dd>{currency.formatCoenReferenceRate(840, 1n * 10n ** 18n, 'Œ')}</dd>
      </div>
      <div>
        <dt>Cross</dt>
        <dd>{currency.formatCrossRate(840, 949, 34n * 10n ** 18n)}</dd>
      </div>
      <div>
        <dt>Total</dt>
        <dd>{currency.formatCoenCurrency(5n * 10n ** 18n, 840, 1n * 10n ** 18n)}</dd>
      </div>
    </dl>
  );
}

describe('currency rate state', () => {
  it('formats every currency reference through the current global Oracle rates', () => {
    const markup = renderToStaticMarkup(
      <CurrencyRatesProvider conversions={conversions(2n * 10n ** 18n)}>
        <CurrencyConsumer />
      </CurrencyRatesProvider>,
    );

    expect(markup).toContain('1 Œ ≈ 2.00 USD');
    expect(markup).toContain('1 USD ≈ 17.00 TRY');
    expect(markup).toContain('10.00 USD');
  });

  it('updates all consumers when the provider receives a new rate snapshot', () => {
    const first = renderToStaticMarkup(
      <CurrencyRatesProvider conversions={conversions(1n * 10n ** 18n)}>
        <CurrencyConsumer />
      </CurrencyRatesProvider>,
    );
    const second = renderToStaticMarkup(
      <CurrencyRatesProvider conversions={conversions(2n * 10n ** 18n)}>
        <CurrencyConsumer />
      </CurrencyRatesProvider>,
    );

    expect(first).toContain('1 Œ ≈ 1.00 USD');
    expect(first).toContain('1 USD ≈ 34.00 TRY');
    expect(first).toContain('5.00 USD');
    expect(second).toContain('1 Œ ≈ 2.00 USD');
    expect(second).toContain('1 USD ≈ 17.00 TRY');
    expect(second).toContain('10.00 USD');
  });
});
