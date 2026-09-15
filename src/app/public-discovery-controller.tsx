import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BrowserSupportResult } from './runtime-gates';
import { App } from './App';
import { createPublicDiscoveryRuntime } from './public-discovery-runtime';
import { auctionRoutePath, parseAuctionRoute, type AuctionRouteResult } from '../discovery/auction-route';
import type { CalendarRangeRead } from '../discovery/calendar-evidence';
import { CommitPanel } from '../bidding/commit-panel';
import { AuctionCompletionCard, PortfolioPage } from '../completion/completion-card';
import { AuctionRecoveryPanel, recoveryEvidenceHasDay } from '../recovery/recovery-card';
import { useRecoveryController } from '../recovery/use-recovery-controller';
import type { OraclePriceSectionProps } from '../discovery/public-discovery-view';
import { ErrorBoundary } from '../ui/error-boundary';
import {
  buildTwoMonthWorldwideDayGrid,
  currentWorldwideDay,
  shiftWorldwideDayMonth,
  worldwideDayMonth,
  type WorldwideDayKey,
} from '../domain/protocol-time';
import { iso4217Currency } from '../domain/iso-4217';
import { loadReviewedRuntimeConfig, type ReviewedRuntime } from '../runtime-config/load-reviewed-runtime-config';
import { useWalletController } from '../wallet/use-wallet-controller';

interface PublicDiscoveryControllerProps {
  browserSupport: BrowserSupportResult;
}

type RuntimeState =
  | { kind: 'loading' }
  | { kind: 'loaded'; runtime: ReviewedRuntime }
  | { kind: 'failure'; message: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown application failure.';
export const discoveryPageFromHash = (hash: string): 'auctions' | 'portfolio' =>
  hash === '#portfolio' ? 'portfolio' : 'auctions';
export const usesCompletionActionRail = (stage: string | null): boolean =>
  stage === 'completed' || stage === 'cancelled';
const selectedFromRoute = (route: AuctionRouteResult): WorldwideDayKey =>
  route.kind === 'auction' ? route.worldwideDay : currentWorldwideDay();
export const defaultFirstMonth = (worldwideDay: WorldwideDayKey) =>
  shiftWorldwideDayMonth(worldwideDayMonth(worldwideDay), -1);

export const mostCurrentAuctionWorldwideDay = (calendar: Pick<CalendarRangeRead, 'days'>): WorldwideDayKey | null => {
  let best: CalendarRangeRead['days'][number] | null = null;
  for (const day of calendar.days) {
    const auction = day.venueAuction;
    if (!auction) continue;
    if (!best?.venueAuction) {
      best = day;
      continue;
    }
    const live = auction.stage !== 'completed' && auction.stage !== 'cancelled';
    const bestLive = best.venueAuction.stage !== 'completed' && best.venueAuction.stage !== 'cancelled';
    if ((live && !bestLive) || (live === bestLive && auction.schedule.commitEnd > best.venueAuction.schedule.commitEnd))
      best = day;
  }
  return best?.worldwideDay ?? null;
};

export function PublicDiscoveryController({ browserSupport }: PublicDiscoveryControllerProps) {
  const initialRoute = useMemo(() => parseAuctionRoute(globalThis.location.pathname), []);
  const startupSelectionPending = useRef(initialRoute.kind === 'other');
  const [invalidRoute, setInvalidRoute] = useState<Extract<AuctionRouteResult, { kind: 'invalid-auction' }> | null>(
    initialRoute.kind === 'invalid-auction' ? initialRoute : null,
  );
  const [selectedWorldwideDay, setSelectedWorldwideDay] = useState(() => selectedFromRoute(initialRoute));
  const [firstMonth, setFirstMonth] = useState(() => defaultFirstMonth(selectedFromRoute(initialRoute)));
  const [runtimeState, setRuntimeState] = useState<RuntimeState>({ kind: 'loading' });
  const activePage = useSyncExternalStore(
    (callback) => {
      globalThis.addEventListener('hashchange', callback);
      return () => globalThis.removeEventListener('hashchange', callback);
    },
    () => discoveryPageFromHash(globalThis.location.hash),
    () => 'auctions' as const,
  );
  const runtime = runtimeState.kind === 'loaded' ? runtimeState.runtime : null;
  const wallet = useWalletController(runtime);
  const discovery = useMemo(() => createPublicDiscoveryRuntime(), []);
  const discoveryState = useSyncExternalStore(discovery.subscribe, discovery.getState, discovery.getState);

  useEffect(() => () => discovery.dispose(), [discovery]);
  useLayoutEffect(() => {
    discovery.updateContext({ runtime, walletState: wallet.state, selectedWorldwideDay, firstMonth, activePage });
  }, [discovery, runtime, wallet.state, selectedWorldwideDay, firstMonth, activePage]);

  useEffect(() => {
    if (!browserSupport.supported) return undefined;
    let active = true;
    void loadReviewedRuntimeConfig().then(
      (value) => {
        if (active) setRuntimeState({ kind: 'loaded', runtime: value });
      },
      (error) => {
        if (active) setRuntimeState({ kind: 'failure', message: errorMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [browserSupport.supported]);

  useEffect(() => {
    const onPopState = () => {
      startupSelectionPending.current = false;
      const route = parseAuctionRoute(globalThis.location.pathname);
      if (route.kind === 'invalid-auction') {
        setInvalidRoute(route);
        return;
      }
      setInvalidRoute(null);
      const day = selectedFromRoute(route);
      setSelectedWorldwideDay(day);
      setFirstMonth(defaultFirstMonth(day));
    };
    globalThis.addEventListener('popstate', onPopState);
    return () => globalThis.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!startupSelectionPending.current || discoveryState.calendar.kind !== 'loaded') return;
    const day = mostCurrentAuctionWorldwideDay(discoveryState.calendar.value);
    if (!day) return;
    startupSelectionPending.current = false;
    if (day === selectedWorldwideDay) return;
    globalThis.history.replaceState(null, '', auctionRoutePath(day));
    setSelectedWorldwideDay(day);
    setFirstMonth(worldwideDayMonth(day));
  }, [discoveryState.calendar, selectedWorldwideDay]);

  const activeVenue = discoveryState.activeVenue;
  const commitContextToken = discoveryState.contextToken;
  const isCommitContextCurrent = useCallback((token: string) => discovery.isContextCurrent(token), [discovery]);
  const recovery = useRecoveryController({
    walletState: wallet.state,
    profile: activeVenue,
    publicClient: discovery.getVenuePublicClient(),
    worldwideDay: selectedWorldwideDay,
    contextToken: commitContextToken,
    isContextCurrent: isCommitContextCurrent,
  });

  if (!browserSupport.supported) {
    return (
      <App
        browserSupport={browserSupport}
        oracleConversions={discoveryState.oracleConversions}
        state={{ kind: 'loading-runtime' }}
        wallet={wallet}
      />
    );
  }
  if (invalidRoute) {
    return (
      <App
        browserSupport={browserSupport}
        oracleConversions={discoveryState.oracleConversions}
        state={{ kind: 'invalid-route', route: invalidRoute }}
        wallet={wallet}
      />
    );
  }
  if (runtimeState.kind === 'failure') {
    return (
      <App
        browserSupport={browserSupport}
        oracleConversions={discoveryState.oracleConversions}
        state={{ kind: 'failed', message: runtimeState.message }}
        wallet={wallet}
      />
    );
  }
  if (runtimeState.kind === 'loading') {
    return (
      <App
        browserSupport={browserSupport}
        oracleConversions={discoveryState.oracleConversions}
        state={{ kind: 'loading-runtime' }}
        wallet={wallet}
      />
    );
  }
  if (runtimeState.runtime.evaluation.state !== 'ready' || !runtimeState.runtime.origin) {
    return (
      <App
        browserSupport={browserSupport}
        oracleConversions={discoveryState.oracleConversions}
        state={{ kind: 'loaded-runtime', runtime: runtimeState.runtime }}
        wallet={wallet}
      />
    );
  }
  if (discoveryState.calendar.kind === 'idle' || discoveryState.calendar.kind === 'loading') {
    return (
      <App
        browserSupport={browserSupport}
        oracleConversions={discoveryState.oracleConversions}
        state={{ kind: 'loading-auction', runtime: runtimeState.runtime }}
        wallet={wallet}
      />
    );
  }
  if (discoveryState.calendar.kind === 'failure') {
    return (
      <App
        browserSupport={browserSupport}
        oracleConversions={discoveryState.oracleConversions}
        state={{ kind: 'failed', message: discoveryState.calendar.message }}
        wallet={wallet}
      />
    );
  }

  const oracleHistoryAdapter = discovery.getOracleHistoryAdapter();
  if (!oracleHistoryAdapter) {
    return (
      <App
        browserSupport={browserSupport}
        oracleConversions={discoveryState.oracleConversions}
        state={{ kind: 'loading-auction', runtime: runtimeState.runtime }}
        wallet={wallet}
      />
    );
  }
  const calendar = discoveryState.calendar.value;
  const selectedCell = calendar.days.find((day) => day.worldwideDay === selectedWorldwideDay) ?? null;
  const selectedAuction =
    discoveryState.selectedAuction.kind === 'loaded' ? discoveryState.selectedAuction.auction : null;
  const grid = buildTwoMonthWorldwideDayGrid(firstMonth);
  const oracle: OraclePriceSectionProps = {
    adapter: oracleHistoryAdapter,
    pair: runtimeState.runtime.origin.oraclePair,
    venueAuction: selectedCell?.venueAuction ?? null,
    quoteDenomination: selectedCell?.venueAuction
      ? (iso4217Currency(selectedCell.venueAuction.params.referenceCurrency)?.alphaCode ?? '')
      : '',
  };

  const selectDay = (worldwideDay: WorldwideDayKey) => {
    startupSelectionPending.current = false;
    globalThis.history.pushState(null, '', auctionRoutePath(worldwideDay));
    setSelectedWorldwideDay(worldwideDay);
    setInvalidRoute(null);
  };

  const primaryActionRail = selectedAuction ? (
    selectedAuction.venue.kind === 'delivered' && usesCompletionActionRail(selectedAuction.venue.auction.stage) ? (
      <AuctionCompletionCard
        state={discoveryState.completion}
        venueSkipped={selectedCell?.venueParticipation === 'skipped'}
        originName={selectedAuction.originIdentity.name}
        venueName={selectedAuction.venueIdentity.name}
      />
    ) : (
      <CommitPanel
        auction={selectedAuction}
        calendarDay={selectedCell}
        walletState={wallet.state}
        profile={activeVenue}
        publicClient={discovery.getVenuePublicClient()}
        contextToken={commitContextToken}
        isContextCurrent={isCommitContextCurrent}
        bidsFanInTimeoutSeconds={runtimeState.runtime.timing?.bidsFanInTimeoutSeconds ?? null}
      />
    )
  ) : undefined;

  const loadedLadder =
    discoveryState.ladder.kind === 'loaded'
      ? { ...discoveryState.ladder, explorerUrl: activeVenue?.explorerUrl ?? null }
      : null;
  const ladder =
    loadedLadder === null
      ? discoveryState.ladder
      : selectedAuction?.venue.kind === 'delivered'
        ? {
            ...loadedLadder,
            outcome: {
              supply: selectedAuction.venue.auction.result.issuedIntexCount,
              loadedPromis: selectedAuction.venue.auction.result.issuedIntexLoadedPromis,
              bidder:
                wallet.state.kind === 'connected-supported'
                  ? {
                      address: wallet.state.connection.address,
                      wonCount:
                        discoveryState.completion.kind === 'loaded' &&
                        discoveryState.completion.value.worldwideDay === selectedWorldwideDay &&
                        discoveryState.completion.value.bidderEconomics?.kind === 'finalized'
                          ? discoveryState.completion.value.bidderEconomics.wonCount
                          : null,
                    }
                  : null,
            },
          }
        : loadedLadder;

  return (
    <App
      browserSupport={browserSupport}
      oracleConversions={discoveryState.oracleConversions}
      wallet={wallet}
      state={{
        kind: 'loaded-discovery',
        activePage,
        portfolio: <PortfolioPage state={discoveryState.portfolio} chainName={activeVenue?.name ?? 'Active venue'} />,
        actionRail: selectedAuction ? (
          <ErrorBoundary name="Bidder actions" resetKey={`${selectedWorldwideDay}:${commitContextToken}`}>
            {primaryActionRail}
            {recoveryEvidenceHasDay(recovery.evidence, selectedWorldwideDay) && (
              <AuctionRecoveryPanel controller={recovery} worldwideDay={selectedWorldwideDay} />
            )}
          </ErrorBoundary>
        ) : undefined,
        runtime: runtimeState.runtime,
        calendar,
        firstMonth,
        monthGrids: [grid.first, grid.second],
        selectedWorldwideDay,
        selectedAuction,
        selectedAuctionLoading: discoveryState.selectedAuction.kind === 'loading',
        oracle,
        ladder,
        onLoadEarlierDemand: discovery.loadEarlierDemand,
        onPreviousMonth: () => setFirstMonth((month) => shiftWorldwideDayMonth(month, -1)),
        onNextMonth: () => setFirstMonth((month) => shiftWorldwideDayMonth(month, 1)),
        onSelectDay: selectDay,
      }}
    />
  );
}
