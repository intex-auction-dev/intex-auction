import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import { AuctionLifecycleCard } from '@/discovery/public-auction-view';

const auction = {
  worldwideDay: '20260804',
  venue: {
    kind: 'delivered',
    auction: {
      stage: 'committing-bids',
      schedule: {
        commitEnd: 1_785_837_675n,
        revealEnd: 1_785_924_075n,
        issuanceEnd: 1_786_010_475n,
      },
    },
  },
} as unknown as PublicAuctionRead;

describe('auction lifecycle tooltips', () => {
  it('renders info-tip affordances for each lifecycle step', () => {
    const markup = renderToStaticMarkup(<AuctionLifecycleCard auction={auction} />);

    expect(markup.match(/class="info-tip"/g)).toHaveLength(4);
    for (const label of ['Commit Sealed Bid', 'Reveal Bid', 'Clearing in progress', 'Intex Issuance']) {
      expect(markup).toContain(`aria-label="${label} information"`);
    }
  });
});
