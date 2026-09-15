import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import { InstrumentSpecification } from '@/discovery/public-auction-view';

const auction = {
  worldwideDay: '20260804',
  venue: {
    kind: 'delivered',
    auction: {
      params: {
        issuanceCurrency: 840,
        issuanceCurrencies: [840, 949],
        strikeAmountsMinor: [100_000n * 10n ** 18n],
        referenceCurrency: 840,
        promisLoadMinor: 100_000n * 10n ** 18n,
        entryPriceMinor: 1n * 10n ** 18n,
        floorPriceMinor: 108n * 10n ** 16n,
        callPriceMinor: 228n * 10n ** 16n,
        callTrigger: {
          windowDays: 30,
          thresholdDays: 21,
          intexCallPeriod: 7n * 86_400n,
        },
      },
    },
  },
} as unknown as PublicAuctionRead;

describe('Intex Details tooltip presentation', () => {
  it('renders the same five info affordances and approved copy structure', () => {
    const markup = renderToStaticMarkup(<InstrumentSpecification auction={auction} />);

    expect(markup.match(/class="info-tip"/g)).toHaveLength(5);
    for (const label of ['Entry Price', 'Strike Amount', 'Floor Price', 'Call Price', 'Deadline']) {
      expect(markup).toContain(`<dt>${label}<button`);
      expect(markup).toContain('aria-label');
    }
    expect(markup).toContain('<dt>Intex Size</dt>');
    expect(markup).toContain('<dt>Call Event</dt>');
  });
});
