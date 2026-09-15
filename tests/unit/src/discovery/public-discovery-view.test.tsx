import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import {
  buildTwoMonthWorldwideDayGrid,
  contiguousWorldwideDayWindow,
  parseWorldwideDayKey,
  toDurationSeconds,
  toUtcTimestamp,
  worldwideDayMonth,
  type WorldwideDayKey,
} from '@/domain/protocol-time';
import type { CalendarOriginDelivery, CalendarRangeRead, CalendarWorldwideDay } from '@/discovery/calendar-evidence';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import { ProtocolEvidence } from '@/discovery/public-auction-view';
import {
  CalendarLegend,
  CalendarSelectionStage,
  CalendarSelectionSummary,
  DemandBarChart,
  PublicDiscoveryView,
  shouldShowVenueLadder,
  type OraclePriceSectionProps,
} from '@/discovery/public-discovery-view';
import type { VenueLadderViewState } from '@/demand/venue-demand-ladder';

vi.mock('@/ui/error-boundary', () => ({
  ErrorBoundary: ({ children, name }: { children: ReactNode; name: string }) => (
    <div data-error-boundary={name}>{children}</div>
  ),
}));

const COEN = '0x0000000000000000000000000000000000000000' as Address;
const USD_QUOTE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const parsed = parseWorldwideDayKey('20260804');
if (!parsed.ok) throw new Error('Invalid test WWD.');
const selected = parsed.value;

const noDelivery: CalendarOriginDelivery = {
  stageStart: 'not-observed',
  clearing: 'not-observed',
  result: 'not-observed',
};

const baseCell = (worldwideDay: WorldwideDayKey): CalendarWorldwideDay => ({
  worldwideDay,
  originRecord: { kind: 'not-found' },
  lifecycle: null,
  dayType: null,
  terminalDisposition: null,
  globalAuction: {
    stage: null,
    terminalDisposition: 'none',
    totalBids: null,
    venueBids: null,
    grossIncludedDemand: null,
    clearingRate: null,
    issuedIntexCount: null,
    offeredQuantity: null,
    offeredQuantityEvidence: 'unavailable',
  },
  venueParticipation: 'unknown',
  originDelivery: noDelivery,
  venueReceipt: 'not-observed',
  venueStage: null,
  scheduleAvailability: { kind: 'unavailable' },
  venueAuction: null,
  canonicalSeries: null,
  failures: [],
});

const calendar = (override: Partial<CalendarWorldwideDay>): CalendarRangeRead => {
  const days = contiguousWorldwideDayWindow('20260701' as WorldwideDayKey, 90);
  return {
    start: days[0]!,
    end: days[days.length - 1]!,
    failures: [],
    days: days.map((worldwideDay) =>
      worldwideDay === selected ? { ...baseCell(worldwideDay), ...override, worldwideDay } : baseCell(worldwideDay),
    ),
  };
};

const auction: PublicAuctionRead = {
  worldwideDay: selected,
  originIdentity: { name: 'Outbe', chainId: 31337 },
  venueIdentity: { name: 'Local venue', chainId: 31337 },
  origin: {
    kind: 'retained',
    worldwideDay: {
      worldwideDay: selected,
      lifecycle: 'completed',
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
      stage: 'cleared',
      totalBids: 10n,
      venueBids: 4n,
      venueIntakeComplete: true,
      venueInTargetSnapshot: true,
    },
    canonicalSeries: null,
  },
  venue: {
    kind: 'delivered',
    auction: {
      worldwideDay: selected,
      stage: 'completed',
      dayType: 'green',
      paymentToken: '0x1111111111111111111111111111111111111111',
      schedule: {
        commitEnd: toUtcTimestamp(1_785_837_675n),
        revealEnd: toUtcTimestamp(1_785_924_075n),
        issuanceEnd: toUtcTimestamp(1_786_010_475n),
      },
      params: {
        issuanceCurrency: 840,
        referenceCurrency: 840,
        promisLoadMinor: 1_000n * 10n ** 18n,
        minIntexBidRate: 600_000,
        minIntexBidQuantity: 1,
        entryPriceMinor: 1_000_000_000_000_000_000n,
        floorPriceMinor: 1_080_000_000_000_000_000n,
        callPriceMinor: 2_280_000_000_000_000_000n,
        commitBondMinor: 10n,
        callTrigger: {
          windowDays: 30,
          thresholdDays: 21,
          intexCallPeriod: toDurationSeconds(86_400n),
        },
      },
      runningCounts: { committedBids: 10, revealedBids: 8 },
      result: {
        auctionClearingRate: 750_000n,
        wonBidsCount: 6,
        issuedIntexCount: 10,
        issuedIntexLoadedPromis: 10_000n * 10n ** 18n,
      },
    },
  },
};

const healthyCell: Partial<CalendarWorldwideDay> = {
  originRecord: { kind: 'retained', snapshot: {} as never },
  lifecycle: 'completed',
  dayType: 'green',
  globalAuction: {
    stage: 'cleared',
    terminalDisposition: 'cleared-sale',
    totalBids: 10n,
    venueBids: 4n,
    grossIncludedDemand: 18n,
    clearingRate: 750_000n,
    issuedIntexCount: 10n,
    offeredQuantity: 12n,
    offeredQuantityEvidence: 'same-transaction-unused-supply',
  },
  venueParticipation: 'included',
  venueReceipt: 'delivered',
  venueStage: 'completed',
  scheduleAvailability:
    auction.venue.kind === 'delivered'
      ? { kind: 'available', schedule: auction.venue.auction.schedule }
      : { kind: 'unavailable' },
  venueAuction: auction.venue.kind === 'delivered' ? auction.venue.auction : null,
};

const oracleProps: OraclePriceSectionProps = {
  adapter: {
    readPriceSnapshotHistory: async () => ({
      pair: { base: COEN, quote: USD_QUOTE },
      requestedCount: 1,
      pointsNewestFirst: [],
    }),
  },
  pair: { base: COEN, quote: USD_QUOTE },
  venueAuction: null,
  quoteDenomination: 'USD',
};

const markup = ({
  override = healthyCell,
  selectedAuction = auction,
  oracle = oracleProps,
  ladder = { kind: 'unavailable', reason: 'no-venue-auction' },
}: {
  override?: Partial<CalendarWorldwideDay>;
  selectedAuction?: PublicAuctionRead | null;
  oracle?: OraclePriceSectionProps;
  ladder?: VenueLadderViewState;
} = {}): string => {
  const firstMonth = worldwideDayMonth(selected);
  const grid = buildTwoMonthWorldwideDayGrid(firstMonth);
  return renderToStaticMarkup(
    <PublicDiscoveryView
      calendar={calendar(override)}
      firstMonth={firstMonth}
      monthGrids={[grid.first, grid.second]}
      selectedWorldwideDay={selected}
      selectedAuction={selectedAuction}
      selectedAuctionLoading={false}
      oracle={oracle}
      ladder={ladder}
      onPreviousMonth={() => undefined}
      onNextMonth={() => undefined}
      onSelectDay={() => undefined}
    />,
  );
};

describe('calendar copy and colors', () => {
  it('isolates every independently useful auction widget behind a standardized boundary', () => {
    const html = markup();

    expect(html.match(/data-error-boundary=/g)).toHaveLength(6);
    expect(html).toContain('data-error-boundary="Auction lifecycle"');
    expect(html).toContain('data-error-boundary="Auction metrics"');
    expect(html).toContain('data-error-boundary="Oracle chart"');
    expect(html).toContain('data-error-boundary="Bid ladder"');
    expect(html).toContain('data-error-boundary="Instrument details"');
    expect(html).toContain('data-error-boundary="Auction action rail"');
  });

  it('renders the approved legend and selected-day copy', () => {
    const selectedDay =
      calendar({ ...healthyCell, venueStage: 'committing-bids' }).days.find((day) => day.worldwideDay === selected) ??
      null;
    const html = renderToStaticMarkup(
      <>
        <CalendarSelectionSummary day={selectedDay} />
        <CalendarLegend />
      </>,
    );

    expect(html).toContain('<strong>Auction</strong><span class="badge badge--success">Live</span>');
    expect(html).toContain('<strong>Worldwide Day</strong><span class="badge badge--success">Green day</span>');
    expect(html).toContain('<p>04.08.2026</p>');
    expect(html).toContain('<p>11.07.2026</p>');
    expect(html).toContain('calendar-legend__selected"></i>Selected');
    expect(html).toContain('calendar-legend__worldwide-day"></i>Worldwide Day');
    expect(html).toContain('calendar-legend__today"></i>Today&#x27;s auction');
    expect(html).toContain('calendar-legend__unknown"></i>Unknown');
    expect(html).not.toContain('Red or failed');
    expect(html).not.toContain('Delivery pending');
    expect(html).not.toContain('Unavailable');
  });

  it('uses the approved complete, cancelled, and day-type labels', () => {
    const complete = renderToStaticMarkup(
      <CalendarSelectionSummary
        day={{
          ...baseCell(selected),
          ...healthyCell,
          venueStage: 'completed',
        }}
      />,
    );
    const cancelled = renderToStaticMarkup(
      <CalendarSelectionSummary
        day={{
          ...baseCell(selected),
          ...healthyCell,
          dayType: 'red',
          venueStage: 'cancelled',
        }}
      />,
    );

    expect(complete).toContain('>Complete</span>');
    expect(complete).toContain('>Green day</span>');
    expect(cancelled).toContain('>Cancelled</span>');
    expect(cancelled).toContain('>Red day</span>');
  });
});

describe('calendar footer hover preview', () => {
  const selectedDay = calendar(healthyCell).days.find((day) => day.worldwideDay === selected) ?? null;

  it('shows only the selected-day summary until a day is hovered, with the legend outside the stage', () => {
    const html = renderToStaticMarkup(<CalendarSelectionStage selected={selectedDay} hovered={null} />);

    expect(html).toContain('calendar-selection-stage__base');
    expect(html).toContain('<strong>Auction</strong>');
    expect(html).not.toContain('calendar-selection-stage__preview');
    expect(html).not.toContain('calendar-legend');
  });

  it('layers an aria-hidden hovered-day preview over the hidden selected summary', () => {
    const html = renderToStaticMarkup(<CalendarSelectionStage selected={selectedDay} hovered={selectedDay} />);

    expect(html).toContain('calendar-selection-stage__base--hidden');
    expect(html).toContain('calendar-selection-stage__preview');
    expect(html).not.toContain('calendar-selection-stage__preview--ending');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('previous demand presentation', () => {
  it('renders the approved scale, threshold and red-day date treatment', () => {
    const html = renderToStaticMarkup(
      <DemandBarChart
        data={[
          { cancelled: false, date: '20260730' as WorldwideDayKey, ratio: 0.75 },
          { cancelled: false, date: '20260731' as WorldwideDayKey, ratio: 2.25 },
          { cancelled: true, date: '20260801' as WorldwideDayKey, ratio: 0 },
        ]}
      />,
    );

    expect(html).toContain('Past auction oversubscription chart');
    expect(html).toContain('>0×</text>');
    expect(html).toContain('>1×</text>');
    expect(html).toContain('>2×</text>');
    expect(html).toContain('>3×</text>');
    expect(html).toContain('product-demand-over-gradient');
    expect(html).toContain('demand-popover__baseline');
    expect(html).toContain('demand-popover__date--cancelled');
    expect(html).toContain('>01.08</text>');
  });
});

describe('public discovery product presentation', () => {
  it('keeps recovery, completion and portfolio diagnostics off the auction surface', () => {
    const firstMonth = worldwideDayMonth(selected);
    const grid = buildTwoMonthWorldwideDayGrid(firstMonth);
    const html = renderToStaticMarkup(
      <PublicDiscoveryView
        actionRail={<div>Test action rail</div>}
        calendar={calendar(healthyCell)}
        firstMonth={firstMonth}
        monthGrids={[grid.first, grid.second]}
        selectedWorldwideDay={selected}
        selectedAuction={auction}
        selectedAuctionLoading={false}
        oracle={oracleProps}
        ladder={{ kind: 'unavailable', reason: 'no-venue-auction' }}
        onPreviousMonth={() => undefined}
        onNextMonth={() => undefined}
        onSelectDay={() => undefined}
      />,
    );

    expect(html).toContain('Test action rail');
    expect(html).not.toContain('Completion diagnostics');
    expect(html).not.toContain('Portfolio diagnostics');
    expect(html).not.toContain('Recovery diagnostics');
  });

  it('renders the approved heading, demand affordance and date-triggered calendar without bidder-facing diagnostics', () => {
    const html = markup();
    expect(html).toContain('<span class="auction-page-heading__title">Auction</span>');
    expect(html).toContain('auction-page-heading__status');
    expect(html).toContain('2026 08 04');
    expect(html).toContain('Prev. Demand');
    expect(html).toContain('aria-label="Demand history"');
    expect(html).toContain('aria-label="Show calendar"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('role="dialog"');
    expect(html.indexOf('<span class="auction-page-heading__title">Auction</span>')).toBeLessThan(
      html.indexOf('Auction Lifecycle'),
    );
    expect(html).not.toContain('Protocol Evidence');
    expect(html).not.toContain('protocol-evidence');
    expect(html).not.toContain('Independent protocol outcomes');
    expect(html).not.toContain('Bidder Recovery');
    expect(html).not.toContain('Current target balances');
    expect(html.match(/class="metric"/g)).toHaveLength(4);
    expect(html).toContain('<strong class="auction-lifecycle__title">Commit Sealed Bid');
    expect(html).toContain('<strong class="auction-lifecycle__title">Reveal Bid');
    expect(html).toContain('aria-label="Commit Sealed Bid information"');
    expect(html).toContain('aria-label="Reveal Bid information"');
    expect(html).toContain('aria-label="Clearing Rate Computed information"');
    expect(html).toContain('aria-label="Intex Issuance information"');
    expect(html).toContain('Loading configured COEN Oracle history…');
  });

  it('keeps canonical day diagnostics off the bidder surface', () => {
    const failedGreenAuction: PublicAuctionRead =
      auction.origin.kind === 'retained'
        ? {
            ...auction,
            origin: {
              ...auction.origin,
              worldwideDay: { ...auction.origin.worldwideDay, lifecycle: 'failed', dayType: 'green' },
            },
          }
        : auction;
    const failedGreenCalendar = calendar({ ...healthyCell, lifecycle: 'failed', dayType: 'green' });
    const failedGreenDay = failedGreenCalendar.days.find((day) => day.worldwideDay === selected) ?? null;
    const failedGreenProduct = markup({
      override: { ...healthyCell, lifecycle: 'failed', dayType: 'green' },
      selectedAuction: failedGreenAuction,
    });
    expect(failedGreenProduct).toContain('<span class="auction-page-heading__title">Auction</span>');
    expect(failedGreenProduct).not.toContain('<dt>Lifecycle</dt>');
    expect(failedGreenProduct).not.toContain('<dt>Day type</dt>');
    const failedGreenEvidence = renderToStaticMarkup(
      <ProtocolEvidence auction={failedGreenAuction} calendarDay={failedGreenDay} />,
    );
    expect(failedGreenEvidence).toContain('Green');
    expect(failedGreenEvidence).toContain('<dt>Lifecycle</dt><dd>Failed</dd>');

    const redAuction: PublicAuctionRead =
      auction.origin.kind === 'retained'
        ? {
            ...auction,
            origin: {
              ...auction.origin,
              worldwideDay: { ...auction.origin.worldwideDay, lifecycle: 'completed', dayType: 'red' },
            },
          }
        : auction;
    const redCalendar = calendar({
      ...healthyCell,
      lifecycle: 'completed',
      dayType: 'red',
      globalAuction: { ...healthyCell.globalAuction!, terminalDisposition: 'cancelled-red' },
    });
    const redDay = redCalendar.days.find((day) => day.worldwideDay === selected) ?? null;
    const redProduct = markup({
      override: {
        ...healthyCell,
        lifecycle: 'completed',
        dayType: 'red',
        globalAuction: { ...healthyCell.globalAuction!, terminalDisposition: 'cancelled-red' },
      },
      selectedAuction: redAuction,
    });
    expect(redProduct).toContain('<span class="auction-page-heading__title">Auction</span>');
    expect(redProduct).not.toContain('Protocol Evidence');
    const redEvidence = renderToStaticMarkup(<ProtocolEvidence auction={redAuction} calendarDay={redDay} />);
    expect(redEvidence).toContain('Red');
    expect(redEvidence).toContain('<dt>Lifecycle</dt><dd>Completed</dd>');
    expect(redEvidence).not.toContain('Green</span>');
  });

  it('shows offered quantity in the supply metric without a duplicate public-result table', () => {
    const complete = markup();
    expect(complete).toContain('<dt>Supply</dt><dd>12 Intexes</dd>');
    expect(complete).toContain('12,000 Promis offered');
    expect(complete).not.toContain('Public Result');
    expect(complete).not.toContain('Gross included demand');
    expect(complete).not.toContain('Venue authority only');

    const incomplete = markup({
      override: {
        ...healthyCell,
        globalAuction: {
          ...healthyCell.globalAuction!,
          offeredQuantity: 12n,
          offeredQuantityEvidence: 'unavailable',
        },
      },
    });
    expect(incomplete).toContain('<dt>Supply</dt><dd>—</dd>');
    expect(incomplete).not.toContain('12,000 Promis offered');
  });

  it('keeps auction content intact when Oracle or ladder evidence is unavailable', () => {
    const oracleLoading = markup();
    expect(oracleLoading).toContain('Auction</span>');
    expect(oracleLoading).toContain('Entry Price');
    expect(oracleLoading).toContain('Loading configured COEN Oracle history…');
    expect(oracleLoading).not.toContain('Canonical WWD, global auction and active-venue evidence remain unchanged');

    const ladderFailure = markup({ ladder: { kind: 'failure', message: 'Venue log scan failed.' } });
    expect(ladderFailure).toContain('Auction</span>');
    expect(ladderFailure).toContain('Loading configured COEN Oracle history…');
    expect(ladderFailure).toContain('Revealed Bids');
    expect(ladderFailure).toContain('Venue log scan failed.');
    expect(ladderFailure).toContain('Intex Details');
  });

  it('renders delivery pending and terminal no-auction without guessed dates or conflicting actions', () => {
    const pendingAuction = { ...auction, venue: { kind: 'delivery-pending' } } as PublicAuctionRead;
    const pending = markup({
      override: {
        ...healthyCell,
        venueReceipt: 'delivery-pending',
        venueStage: null,
        venueAuction: null,
        scheduleAvailability: { kind: 'pending' },
      },
      selectedAuction: pendingAuction,
    });
    expect(pending).toContain('Auction delivery pending');
    expect(pending).toContain('received the auction schedule yet');
    expect(pending).not.toContain('Commit closes');

    const terminalAuction = {
      ...auction,
      venue: { kind: 'not-applicable', reason: 'terminal-origin-no-auction' },
    } as PublicAuctionRead;
    const terminal = markup({
      override: {
        ...healthyCell,
        terminalDisposition: 'missed-offering',
        venueParticipation: 'not-applicable',
        venueReceipt: 'not-applicable',
        venueStage: null,
        venueAuction: null,
        scheduleAvailability: { kind: 'not-applicable' },
      },
      selectedAuction: terminalAuction,
    });
    expect(terminal).toContain('No bidder auction');
    expect(terminal).not.toContain('Auction delivery pending');
    expect(terminal).not.toContain('Place a sealed bid');
  });

  it('surfaces scoped failures without exposing the operator evidence panel', () => {
    const html = markup({
      override: {
        ...healthyCell,
        failures: [
          { authority: 'metadosis', kind: 'rpc', message: 'origin offline' },
          { authority: 'venue', kind: 'rpc', message: 'venue offline' },
        ],
      },
    });
    expect(html).toContain('Metadosis · Rpc');
    expect(html).toContain('origin offline');
    expect(html).toContain('Venue · Rpc');
    expect(html).toContain('venue offline');
    expect(html).not.toContain('Protocol Evidence');
    expect(html).not.toContain('Bidder Recovery');
    expect(html).not.toContain('% of strike');
  });

  it('shows the ladder only for reveal evidence and result-stage history', () => {
    const loadedWithRows: VenueLadderViewState = {
      kind: 'loaded',
      model: {
        label: 'Active-venue revealed demand',
        state: 'live-reconciled',
        stage: 'revealing-bids',
        rows: [{} as never],
        eventOrder: [],
        issues: [],
        reapStatus: 'not-observed',
        confirmedThroughBlock: 0n,
        authoritativeClearingRate: null,
        cacheStatus: { BidRevealed: 'cache-hit', AuctionReaped: 'cache-hit' },
        unconfirmedLiveCount: 0,
        confirmationPending: 'none',
      },
    };
    expect(shouldShowVenueLadder('committing-bids', loadedWithRows)).toBe(false);
    expect(
      shouldShowVenueLadder('revealing-bids', { ...loadedWithRows, model: { ...loadedWithRows.model, rows: [] } }),
    ).toBe(false);
    expect(shouldShowVenueLadder('revealing-bids', loadedWithRows)).toBe(true);
    expect(shouldShowVenueLadder('issuance', { kind: 'unavailable', reason: 'no-venue-auction' })).toBe(true);
    expect(shouldShowVenueLadder('completed', { kind: 'failure', message: 'scan failed' })).toBe(true);
  });

  it('does not inherit a stale venue stage when participation is skipped', () => {
    const skipped = markup({
      override: {
        ...healthyCell,
        venueParticipation: 'skipped',
        venueReceipt: 'delivered',
        venueStage: 'completed',
      },
    });
    expect(skipped).toContain('Active venue skipped');
    expect(skipped).toContain('A venue lifecycle is not applicable');
    expect(skipped).not.toContain('Revealed Bid Ladder');
  });
});
