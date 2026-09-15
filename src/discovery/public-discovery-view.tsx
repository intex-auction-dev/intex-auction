import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicAuctionRead } from './load-public-auction';
import type { CalendarRangeRead, CalendarWorldwideDay } from './calendar-evidence';
import { CHART_WINDOW_POINTS } from '../domain/protocol-constants';
import type { WorldwideDayCalendarMonth, WorldwideDayKey, WorldwideDayMonth } from '../domain/protocol-time';
import { Badge, Card } from '../ui/primitives';
import {
  AuctionFailureNotices,
  AuctionKeyMetrics,
  AuctionLifecycleCard,
  authoritativeStage,
  InstrumentSpecification,
  ReadOnlyActionRail,
  venueStatusClassName,
  venueStatusPresentation,
} from './public-auction-view';
import { OraclePriceChart } from '../oracle/oracle-price-chart';
import type { Address } from 'viem';
import { VenueDemandLadder, type VenueLadderViewState } from '../demand/venue-demand-ladder';
import { buildOracleChartModel } from '../oracle/oracle-chart-model';
import type { OracleAdapter } from '../protocol/oracle-adapter';
import type { OraclePriceHistory, VenueAuctionSnapshot } from '../protocol/profile-types';
import { loadOraclePriceHistory } from '../oracle/oracle-history-refresh';
import {
  browserPollingActivity,
  ORACLE_HISTORY_POLL_INTERVAL_MS,
  startSequentialVenuePolling,
} from '../demand/venue-ladder-polling';
import type { VenueAuctionStage } from '../protocol/read-model';
import { AUCTION_WIDGET_BOUNDARIES, AuctionWidgetBoundary } from './auction-widget-boundary';
import { friendlyErrorMessage } from '../chain/contract-errors';
import { AuctionCalendarPopover } from './public-discovery-view/calendar';
import { DemandDots } from './public-discovery-view/demand-history';
import './calendar.css';
import './public-discovery-view.css';

export {
  auctionCalendarStatus,
  CalendarLegend,
  CalendarSelectionStage,
  CalendarSelectionSummary,
  calendarDayOpensAuction,
  worldwideDayCalendarStatus,
} from './public-discovery-view/calendar';
export {
  DemandBarChart,
  DemandPopover,
  previousDemandPage,
  previousDemandPoints,
} from './public-discovery-view/demand-history';
export type { PreviousDemandPoint } from './public-discovery-view/demand-history';

export interface OraclePriceSectionProps {
  adapter: Pick<OracleAdapter, 'readPriceSnapshotHistory'>;
  pair: { base: Address; quote: Address };
  venueAuction: VenueAuctionSnapshot | null;
  quoteDenomination: string;
}

interface PublicDiscoveryViewProps {
  actionRail?: ReactNode;
  calendar: CalendarRangeRead;
  firstMonth: WorldwideDayMonth;
  monthGrids: readonly [WorldwideDayCalendarMonth, WorldwideDayCalendarMonth];
  selectedWorldwideDay: WorldwideDayKey;
  selectedAuction: PublicAuctionRead | null;
  selectedAuctionLoading: boolean;
  oracle: OraclePriceSectionProps;
  ladder: VenueLadderViewState;
  onLoadEarlierDemand?: ((beforeWorldwideDay: WorldwideDayKey) => Promise<CalendarRangeRead | null>) | undefined;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onSelectDay: (worldwideDay: WorldwideDayKey) => void;
}

function AuctionHeading({
  selected,
  selectedAuction,
  calendarControl,
  demand,
}: {
  selected: CalendarWorldwideDay | null;
  selectedAuction: PublicAuctionRead | null;
  calendarControl: React.ReactNode;
  demand: React.ReactNode;
}) {
  const venueStatus = venueStatusPresentation(selectedAuction, selected);
  return (
    <header className="auction-page-heading auction-page-heading--discovery">
      <div className="auction-page-heading__identity">
        <span className="auction-page-heading__title">Auction</span>
        <span aria-hidden="true" />
        <Badge className={venueStatusClassName(venueStatus)} tone={venueStatus.tone} dot>
          {venueStatus.label}
        </Badge>
        <span aria-hidden="true" />
        {calendarControl}
        <span aria-hidden="true" />
        {demand}
      </div>
    </header>
  );
}

const oracleErrorMessage = (error: unknown): string => friendlyErrorMessage(error);

type OracleHistoryState =
  | { kind: 'loading' }
  | { kind: 'loaded'; history: OraclePriceHistory }
  | { kind: 'unavailable'; message: string };

const OraclePriceSection = memo(function OraclePriceSection({
  adapter,
  pair,
  venueAuction,
  quoteDenomination,
}: OraclePriceSectionProps) {
  const [state, setState] = useState<OracleHistoryState>({ kind: 'loading' });
  const currentHistory = useRef<OraclePriceHistory | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: both fields of `pair` are listed
  useEffect(() => {
    currentHistory.current = null;
    setState({ kind: 'loading' });
    const controller = startSequentialVenuePolling({
      request: () => loadOraclePriceHistory(adapter, pair, currentHistory.current, CHART_WINDOW_POINTS),
      nextDelay: () => ORACLE_HISTORY_POLL_INTERVAL_MS,
      onResult: (history) => {
        currentHistory.current = history;
        setState({ kind: 'loaded', history });
      },
      onError: (error) => {
        setState((current) =>
          current.kind === 'loaded' ? current : { kind: 'unavailable', message: oracleErrorMessage(error) },
        );
      },
      activity: browserPollingActivity(),
      intervalMs: ORACLE_HISTORY_POLL_INTERVAL_MS,
    });
    return () => controller.stop();
  }, [adapter, pair.base, pair.quote]);

  const model = useMemo(() => {
    if (state.kind !== 'loaded') return null;
    try {
      return buildOracleChartModel(state.history, venueAuction);
    } catch {
      return null;
    }
  }, [state, venueAuction]);

  if (state.kind === 'unavailable') throw new Error(state.message);
  if (state.kind === 'loading') {
    return (
      <Card className="oracle-card">
        <p className="product-empty-state">Loading configured COEN Oracle history…</p>
      </Card>
    );
  }
  if (!model) throw new Error('Failed to process oracle price data.');
  return <OraclePriceChart model={model} quoteDenomination={quoteDenomination} />;
});

export const shouldShowVenueLadder = (stage: VenueAuctionStage | null, ladder: VenueLadderViewState): boolean => {
  if (stage === 'issuance' || stage === 'completed') return true;
  if (stage !== 'revealing-bids') return false;
  if (ladder.kind === 'failure' || ladder.kind === 'loading') return true;
  return ladder.kind === 'loaded' && ladder.model.rows.length > 0;
};

export function PublicDiscoveryView({
  actionRail,
  calendar,
  firstMonth,
  monthGrids,
  selectedWorldwideDay,
  selectedAuction,
  selectedAuctionLoading,
  oracle,
  ladder,
  onLoadEarlierDemand,
  onPreviousMonth,
  onNextMonth,
  onSelectDay,
}: PublicDiscoveryViewProps) {
  const byDay = new Map(calendar.days.map((day) => [day.worldwideDay, day]));
  const selected = byDay.get(selectedWorldwideDay) ?? null;
  const calendarControl = (
    <AuctionCalendarPopover
      calendar={calendar}
      firstMonth={firstMonth}
      monthGrids={monthGrids}
      selectedWorldwideDay={selectedWorldwideDay}
      byDay={byDay}
      onPreviousMonth={onPreviousMonth}
      onNextMonth={onNextMonth}
      onSelectDay={onSelectDay}
    />
  );
  const stage = selectedAuction ? authoritativeStage(selectedAuction, selected) : null;

  return (
    <div className="public-discovery">
      <AuctionHeading
        selected={selected}
        selectedAuction={selectedAuction}
        calendarControl={calendarControl}
        demand={
          <DemandDots
            calendar={calendar}
            selectedWorldwideDay={selectedWorldwideDay}
            onLoadEarlierDemand={onLoadEarlierDemand}
          />
        }
      />
      {selectedAuctionLoading && (
        <Card>
          <p className="product-empty-state">Loading selected auction evidence…</p>
        </Card>
      )}
      {!selectedAuctionLoading && selectedAuction && (
        <>
          <AuctionFailureNotices auction={selectedAuction} calendarDay={selected} />
          <div className="auction-product-layout">
            <div className="auction-product-main">
              <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.lifecycle} worldwideDay={selectedWorldwideDay}>
                <AuctionLifecycleCard auction={selectedAuction} calendarDay={selected} />
              </AuctionWidgetBoundary>
              <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.metrics} worldwideDay={selectedWorldwideDay}>
                <AuctionKeyMetrics auction={selectedAuction} calendarDay={selected} />
              </AuctionWidgetBoundary>
              <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.oracle} worldwideDay={selectedWorldwideDay}>
                <OraclePriceSection
                  adapter={oracle.adapter}
                  pair={oracle.pair}
                  venueAuction={oracle.venueAuction}
                  quoteDenomination={oracle.quoteDenomination}
                />
              </AuctionWidgetBoundary>
              {shouldShowVenueLadder(stage, ladder) && (
                <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.ladder} worldwideDay={selectedWorldwideDay}>
                  <VenueDemandLadder state={ladder} />
                </AuctionWidgetBoundary>
              )}
              <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.instrument} worldwideDay={selectedWorldwideDay}>
                <InstrumentSpecification auction={selectedAuction} calendarDay={selected} />
              </AuctionWidgetBoundary>
            </div>
            <aside className="auction-product-rail">
              <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.actionRail} worldwideDay={selectedWorldwideDay}>
                {actionRail ?? <ReadOnlyActionRail auction={selectedAuction} calendarDay={selected} />}
              </AuctionWidgetBoundary>
            </aside>
          </div>
        </>
      )}
      {!selectedAuctionLoading && !selectedAuction && (
        <Card>
          <p className="product-empty-state">Selected auction evidence is unavailable.</p>
        </Card>
      )}
    </div>
  );
}
