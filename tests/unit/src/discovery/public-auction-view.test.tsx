import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '@/app/App';
import { parseWorldwideDayKey, toDurationSeconds, toUtcTimestamp } from '@/domain/protocol-time';
import type { ReviewedRuntime } from '@/runtime-config/load-reviewed-runtime-config';
import type { RuntimeConfigEvaluation } from '@/runtime-config/runtime-config';
import type { CalendarWorldwideDay } from '@/discovery/calendar-evidence';
import { CurrencyRatesProvider } from '@/oracle/currency-state';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import type { OracleConversions } from '@/oracle/oracle-conversions';
import type { VenueAuctionStage } from '@/protocol/read-model';
import {
  ProtocolEvidence,
  PublicAuctionView,
  venueLifecyclePresentation,
  venueStatusPresentation,
} from '@/discovery/public-auction-view';

const parsed = parseWorldwideDayKey('20260804');
if (!parsed.ok) throw new Error('Invalid test WWD.');
const worldwideDay = parsed.value;

const delivered: PublicAuctionRead = {
  worldwideDay,
  originIdentity: { name: 'Outbe', chainId: 31337 },
  venueIdentity: { name: 'Local venue', chainId: 31337 },
  origin: {
    kind: 'retained',
    worldwideDay: {
      worldwideDay,
      lifecycle: 'offering',
      dayType: 'green',
      formingStart: toUtcTimestamp(1n),
      formingEnd: toUtcTimestamp(2n),
      lookbackEnd: toUtcTimestamp(3n),
      offeringEnd: toUtcTimestamp(4n),
      scheduledProcessTime: toUtcTimestamp(5n),
      previousVwap: 990_000n,
      currentVwap: 995_000n,
    },
    terminal: null,
    globalAuction: {
      stage: 'none',
      totalBids: 0n,
      venueBids: 0n,
      venueIntakeComplete: false,
      venueInTargetSnapshot: true,
    },
    canonicalSeries: null,
  },
  venue: {
    kind: 'delivered',
    auction: {
      worldwideDay,
      stage: 'committing-bids',
      dayType: 'green',
      paymentToken: '0x1111111111111111111111111111111111111111',
      schedule: {
        commitEnd: toUtcTimestamp(1_785_837_675n),
        revealEnd: toUtcTimestamp(1_785_924_075n),
        issuanceEnd: toUtcTimestamp(1_786_010_475n),
      },
      params: {
        issuanceCurrency: 840,
        issuanceCurrencies: [840, 949],
        issuanceEntryPrices: [1_000_000_000n, 34_000_000_000n],
        strikeAmountsMinor: [100_000n * 10n ** 9n],
        oraclePairIds: [1, 2],
        referenceCurrency: 840,
        promisLoadMinor: 100_000n * 10n ** 18n,
        minIntexBidRate: 600_000,
        minIntexBidQuantity: 1,
        entryPriceMinor: 1_000_000_000n,
        floorPriceMinor: 1_080_000_000n,
        callPriceMinor: 2_280_000_000n,
        commitBondMinor: 10n,
        callTrigger: {
          windowDays: 30,
          thresholdDays: 21,
          intexCallPeriod: toDurationSeconds(86_400n),
        },
      },
      runningCounts: { committedBids: 2, revealedBids: 1 },
      result: {
        auctionClearingRate: 0n,
        wonBidsCount: 0,
        issuedIntexCount: 0,
        issuedIntexLoadedPromis: 0n,
      },
    },
  },
};

const html = (auction: PublicAuctionRead): string => renderToStaticMarkup(<PublicAuctionView auction={auction} />);

const withCurrencyRates = (auction: PublicAuctionRead, conversions: OracleConversions | null): string =>
  renderToStaticMarkup(
    <CurrencyRatesProvider conversions={conversions}>
      <PublicAuctionView auction={auction} />
    </CurrencyRatesProvider>,
  );

const withStage = (stage: VenueAuctionStage): PublicAuctionRead => ({
  ...delivered,
  venue:
    delivered.venue.kind === 'delivered'
      ? { kind: 'delivered', auction: { ...delivered.venue.auction, stage } }
      : delivered.venue,
});

const completedWith = (revealedBids: number, issuedIntexCount: number): PublicAuctionRead => ({
  ...delivered,
  venue:
    delivered.venue.kind === 'delivered'
      ? {
          kind: 'delivered',
          auction: {
            ...delivered.venue.auction,
            stage: 'completed',
            runningCounts: { ...delivered.venue.auction.runningCounts, revealedBids },
            result: { ...delivered.venue.auction.result, issuedIntexCount },
          },
        }
      : delivered.venue,
});

const evaluation = (state: RuntimeConfigEvaluation['state']): RuntimeConfigEvaluation => ({
  state,
  originProfile: null,
  venueProfiles: [],
  walletConnect: { enabled: false, usable: false, projectId: null, metadata: null, issues: [] },
  timing: { bidsFanInTimeoutSeconds: null, issues: [] },
  networkAccessAllowed: false,
  defaultDisconnectedVenueChainId: 31337,
  issues: [],
});

const runtime = (state: RuntimeConfigEvaluation['state']): ReviewedRuntime => ({
  evaluation: evaluation(state),
  origin: null,
  venues: [],
  selectedVenue: null,
  timing: null,
});

const browserSupport = { supported: true, missingCapabilities: [] as string[] };

describe('public auction product presentation', () => {
  it('shows a fully filled circular indicator while clearing is in progress', () => {
    const markup = html(withStage('issuance'));
    expect(markup).toContain('auction-lifecycle__ring');
    expect(markup).toContain('stroke-dashoffset:0');
    expect(markup).not.toContain('lucide-circle');
    expect(markup).not.toContain('lucide-loader-circle');
  });

  it('uses the approved anatomy with three evidence-backed primary metrics and no bidder-facing diagnostics', () => {
    const markup = html(delivered);
    expect(markup).toContain('<span class="auction-page-heading__title">Auction</span>');
    expect(markup).toContain('2026 08 04');
    expect(markup).toContain('LIVE');
    expect(markup).toContain('auction-page-heading__status auction-page-heading__status--live');
    expect(markup).toContain('class="auction-lifecycle__deadline"');
    expect(markup).toContain('Auction Lifecycle');
    expect(markup).toContain('<strong class="auction-lifecycle__title">Commit Sealed Bid');
    expect(markup).toContain('<strong class="auction-lifecycle__title">Reveal Bid');
    expect(markup).toContain('<strong class="auction-lifecycle__title">Clearing in progress');
    expect(markup).toContain('<strong class="auction-lifecycle__title">Intex Issuance');
    expect(markup.match(/class="metric"/g)).toHaveLength(3);
    expect(markup).toContain('<dt>Entry Price');
    expect(markup).toContain('<dt>Supply</dt>');
    expect(markup).toContain('<dt>Sealed Bids</dt>');
    expect(markup).toContain('$1');
    expect(markup).toContain('COEN entry price');
    expect(markup).not.toContain('COEN entry price (');
    expect(markup).toContain('Known only at clearing');
    expect(markup).toContain('Sealed so far');
    expect(markup).toContain('Intex Details');
    expect(markup).toContain('Intex Size');
    expect(markup).toContain('Promis per Intex');
    expect(markup).toContain('100,000 Promis');
    expect(markup).toContain('Price of COEN fixed at auction start');
    expect(markup).toContain('Settlement Conditions');
    expect(markup.indexOf('<span class="auction-page-heading__title">Auction</span>')).toBeLessThan(
      markup.indexOf('Auction Lifecycle'),
    );
    expect(markup).not.toContain('Protocol Evidence');
    expect(markup).not.toContain('protocol-evidence');
    expect(markup).not.toContain('Independent protocol outcomes');
    expect(markup).not.toContain('Bidder Recovery');
    expect(markup).not.toContain('Current target balances');
    expect(markup).not.toContain('<h3>Public Result</h3>');
  });

  it('shows sealed bids before the reveal stage and both sealed and revealed bids from the reveal stage onward', () => {
    const committing = html(delivered);
    expect(committing).toContain('<dt>Sealed Bids</dt>');
    expect(committing).not.toContain('<dt>Revealed Bids</dt>');
    expect(committing.match(/class="metric"/g)).toHaveLength(3);

    const revealing = html(withStage('revealing-bids'));
    expect(revealing).toContain('<dt>Sealed Bids</dt>');
    expect(revealing).toContain('<dt>Revealed Bids</dt>');
    expect(revealing.match(/class="metric"/g)).toHaveLength(4);
  });

  it('matches the approved heading state labels, tones and live animation flag', () => {
    expect(venueStatusPresentation(withStage('committing-bids'), null)).toEqual({
      animated: true,
      kind: 'live',
      label: 'LIVE',
      tone: 'success',
    });
    expect(venueStatusPresentation(withStage('revealing-bids'), null)).toEqual({
      animated: true,
      kind: 'live',
      label: 'LIVE',
      tone: 'success',
    });
    expect(venueStatusPresentation(withStage('issuance'), null)).toEqual({
      animated: false,
      kind: 'ended',
      label: 'ENDED',
      tone: 'neutral',
    });
    expect(venueStatusPresentation(completedWith(1, 1), null)).toEqual({
      animated: false,
      kind: 'ended',
      label: 'COMPLETE',
      tone: 'neutral',
    });
    expect(venueStatusPresentation(completedWith(0, 0), null)).toEqual({
      animated: false,
      kind: 'cancelled',
      label: 'CANCELLED',
      tone: 'danger',
    });
    expect(venueStatusPresentation(completedWith(1, 0), null)).toEqual({
      animated: false,
      kind: 'cancelled',
      label: 'CANCELLED',
      tone: 'warning',
    });
    const authoritativeNoSale = {
      venueParticipation: 'included',
      venueReceipt: 'result-received',
      venueStage: 'completed',
      failures: [],
      globalAuction: { terminalDisposition: 'cleared-no-sale' },
    } as unknown as CalendarWorldwideDay;
    expect(venueStatusPresentation(completedWith(0, 0), authoritativeNoSale)).toEqual({
      animated: false,
      kind: 'cancelled',
      label: 'CANCELLED',
      tone: 'warning',
    });
    expect(venueStatusPresentation(withStage('cancelled'), null)).toEqual({
      animated: false,
      kind: 'cancelled',
      label: 'CANCELLED',
      tone: 'danger',
    });
  });

  it('maps every venue stage without treating cancellation as successful completion', () => {
    expect(venueLifecyclePresentation('committing-bids').steps).toEqual(['active', 'upcoming', 'upcoming', 'upcoming']);
    expect(venueLifecyclePresentation('revealing-bids').steps).toEqual(['complete', 'active', 'upcoming', 'upcoming']);
    expect(venueLifecyclePresentation('issuance').steps).toEqual(['complete', 'complete', 'active', 'upcoming']);
    expect(venueLifecyclePresentation('completed').steps).toEqual(['complete', 'complete', 'complete', 'complete']);
    const cancelled = venueLifecyclePresentation('cancelled');
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.steps).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming']);
    const cancelledMarkup = html(withStage('cancelled'));
    expect(cancelledMarkup).toContain('Auction cancelled');
    expect(cancelledMarkup).toContain('cancelled before issuance');
    expect(cancelledMarkup).not.toContain('Venue result complete');
  });

  it('renders a completed auction with no reveals as the no-bid cancellation state', () => {
    const markup = html(completedWith(0, 0));
    expect(markup).toContain('No-bid cancellation');
    expect(markup).toContain('cancelled without issuance');
    expect(markup).toContain('auction-page-heading__status--cancelled');
    expect(markup).not.toContain('Intex issued</span>');
    expect(markup).not.toContain('Public Result');
    expect(markup).not.toContain('Venue authority only');
    expect(markup).not.toContain('Commit Sealed Bid</button>');
  });

  it('renders revealed demand with zero issuance as the no-sale cancellation state', () => {
    const markup = html(completedWith(1, 0));
    expect(markup).toContain('Auction Cancelled');
    expect(markup).toContain('no revealed demand qualified at the minimum bid rate');
    expect(markup).toContain('auction-lifecycle-cancelled--warning');
    expect(markup).toContain('badge--warning auction-page-heading__status auction-page-heading__status--cancelled');
    expect(markup).not.toContain('No-bid cancellation');
  });

  it('shows contract-backed strike terms and the deadline consequence', () => {
    const markup = html(delivered);
    expect(markup).toContain('<dt>Strike Amount');
    expect(markup).toContain('100,000.00 USD');
    expect(markup).toContain('To pay Strike Amount and settle Intex');
    expect(markup).not.toContain('<dt>Escrow Basis');
    expect(markup).not.toContain('% of strike');
    expect(markup).not.toContain('% Strike');
    expect(markup).toContain('Commit Sealed Bid');
    expect(markup).toMatch(/<button[^>]*disabled/);
    expect(markup).not.toMatch(/<form|<input|onSubmit/);
  });

  it('links public reference currency values to the global live rate state', () => {
    const markup = withCurrencyRates(delivered, {
      byIsoCode: new Map([
        [
          840,
          {
            kind: 'available',
            isoCode: 840,
            denomination: 'USD',
            rate: 2_000_000_000_000_000_000n,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
      ]),
    });

    expect(markup).toContain('$2.00');
    expect(markup).toContain('COEN entry price');
    expect(markup).not.toContain('COEN entry price (');
    expect(markup).not.toContain('$1</dd>');
  });

  it('renders delivery pending without inferred schedule dates or deadlines', () => {
    const markup = html({ ...delivered, venue: { kind: 'delivery-pending' } });
    expect(markup).toContain('Auction delivery pending');
    expect(markup).toContain('received the auction schedule yet');
    expect(markup).not.toContain('Commit closes');
    expect(markup).not.toContain('04 Aug 2026');
    expect(markup).not.toContain('1970-01-01');
  });

  it('keeps authority failures scoped while retaining healthy evidence', () => {
    const originFailure = html({
      ...delivered,
      origin: { kind: 'failure', failure: { kind: 'rpc', message: 'origin offline' } },
    });
    expect(originFailure).toContain('Origin · Rpc');
    expect(originFailure).toContain('origin offline');
    expect(originFailure).toContain('LIVE');
    expect(originFailure).toContain('Aug 4');
    expect(originFailure).not.toContain('UTC');

    const venueFailureAuction: PublicAuctionRead = {
      ...delivered,
      venue: { kind: 'failure', failure: { kind: 'rpc', message: 'venue offline' } },
    };
    const venueFailure = html(venueFailureAuction);
    expect(venueFailure).toContain('Active venue · Rpc');
    expect(venueFailure).toContain('venue offline');
    expect(venueFailure).toContain('The active-venue lifecycle is unavailable from the current scoped evidence.');
    expect(venueFailure).not.toContain('Protocol Evidence');

    const operatorEvidence = renderToStaticMarkup(
      <ProtocolEvidence auction={venueFailureAuction} calendarDay={null} />,
    );
    expect(operatorEvidence).toContain('<dt>Lifecycle</dt><dd>Offering</dd>');
  });

  it('labels the delivered payment-token evidence row as wCOEN, not "Payment token"', () => {
    const deliveredEvidence = renderToStaticMarkup(<ProtocolEvidence auction={delivered} calendarDay={null} />);
    expect(deliveredEvidence).toContain('<dt>wCOEN</dt>');
    expect(deliveredEvidence).not.toContain('Payment token');
  });

  it('renders terminal no-auction without a pending-delivery or bidder action', () => {
    const terminal: PublicAuctionRead = {
      ...delivered,
      origin:
        delivered.origin.kind === 'retained'
          ? {
              ...delivered.origin,
              worldwideDay: { ...delivered.origin.worldwideDay, lifecycle: 'failed' },
              terminal: {
                disposition: 'missed-offering',
                valueRouted: 0n,
                carryOverBefore: 0n,
                carryOverAfter: 0n,
                retirement: 'not-present',
                blockNumber: 10n,
              },
            }
          : delivered.origin,
      venue: { kind: 'not-applicable', reason: 'terminal-origin-no-auction' },
    };
    const markup = html(terminal);
    expect(markup).toContain('No bidder auction');
    expect(markup).not.toContain('Auction delivery pending');
    expect(markup).not.toContain('Place a sealed bid');
  });

  it('retains operational gates for invalid routes and disabled configuration', () => {
    const invalid = renderToStaticMarkup(
      <App
        browserSupport={browserSupport}
        state={{ kind: 'invalid-route', route: { kind: 'invalid-auction', reason: 'format' } }}
      />,
    );
    expect(invalid).toContain('Malformed WorldwideDay route');
    expect(invalid).not.toContain('Intex Details');

    const disabled = renderToStaticMarkup(
      <App browserSupport={browserSupport} state={{ kind: 'loaded-runtime', runtime: runtime('not-configured') }} />,
    );
    expect(disabled).toContain('Deployment not configured');
    expect(disabled).toContain('RPC activity');
    expect(disabled).toContain('Blocked');
  });
});
