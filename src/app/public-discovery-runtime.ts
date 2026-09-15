import type { Address, PublicClient } from 'viem';
import {
  createOriginCalendarReaders,
  createVenueCalendarReaders,
  applyVenueCalendarOverlay,
  loadOriginCalendarRangeWithReaders,
  type CalendarRangeRead,
  type OriginCalendarReaders,
  type VenueCalendarReaders,
} from '../discovery/calendar-evidence';
import { CompletionVenueAdapter } from '../completion/completion-adapters';
import {
  loadAuctionCompletion,
  loadPortfolio,
  type AuctionCompletionRead,
  type PortfolioRead,
} from '../completion/completion-loader';
import type { CompletionViewState, PortfolioViewState } from '../completion/completion-card';
import { OutbeAuctionAdapter } from '../protocol/origin-adapter';
import { OracleAdapter } from '../protocol/oracle-adapter';
import type { VenueAuctionSnapshot } from '../protocol/profile-types';
import { loadPublicAuctionWithAdapters, type PublicAuctionRead } from '../discovery/load-public-auction';
import { loadOracleConversions, type OracleConversions } from '../oracle/oracle-conversions';
import { loadVenueDemandEvidence, type VenueDemandEvidence } from '../demand/venue-bid-history';
import { buildVenueDemandModel } from '../demand/venue-demand-model';
import type { VenueLadderViewState } from '../demand/venue-demand-ladder';
import {
  auctionReadNextPollDelay,
  AUCTION_READ_POLL_INTERVAL_MS,
  browserPollingActivity,
  COMPLETION_POLL_INTERVAL_MS,
  ORACLE_HISTORY_POLL_INTERVAL_MS,
  startSequentialVenuePolling,
  venueDemandNextPollDelay,
  type SequentialVenuePollingController,
  type VenuePollingActivity,
} from '../demand/venue-ladder-polling';
import { withRpcDiagnostics } from '../chain/rpc-diagnostics';
import { diagnosticError, emitDiagnostic } from '../diagnostics/local-diagnostics';
import {
  buildTwoMonthWorldwideDayGrid,
  CALENDAR_WINDOW_DAYS,
  calendarWorldwideDayWindow,
  compareWorldwideDays,
  contiguousWorldwideDayWindow,
  shiftWorldwideDay,
  type WorldwideDayKey,
  type WorldwideDayMonth,
} from '../domain/protocol-time';
import type {
  ResolvedOutbeReadProfile,
  ResolvedVenueReadProfile,
  ReviewedRuntime,
} from '../runtime-config/load-reviewed-runtime-config';
import type { WalletState } from '../wallet/wallet-state';
import {
  activeVenueForWallet,
  originContextIdentity,
  retainOriginCalendarEvidence,
  venueContextIdentity,
  walletContextIdentity,
} from './read-context';

type CalendarState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; value: CalendarRangeRead }
  | { kind: 'failure'; message: string };
type AuctionState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; auction: PublicAuctionRead }
  | { kind: 'failure'; message: string };

export interface PublicDiscoveryRuntimeState {
  calendar: CalendarState;
  selectedAuction: AuctionState;
  ladder: VenueLadderViewState;
  completion: CompletionViewState;
  portfolio: PortfolioViewState;
  oracleConversions: OracleConversions | null;
  activeVenue: ResolvedVenueReadProfile | null;
  contextToken: string;
}

export interface PublicDiscoveryRuntimeContext {
  runtime: ReviewedRuntime | null;
  walletState: WalletState;
  selectedWorldwideDay: WorldwideDayKey;
  firstMonth: WorldwideDayMonth;
  activePage: 'auctions' | 'portfolio';
}

type ReadContext = {
  origin: ResolvedOutbeReadProfile;
  venue: ResolvedVenueReadProfile;
  originReaders: OriginCalendarReaders;
  venueReaders: VenueCalendarReaders;
};

export interface PublicDiscoveryRuntimeDependencies {
  createOriginReaders(profile: ResolvedOutbeReadProfile): Promise<OriginCalendarReaders>;
  createVenueReaders(profile: ResolvedVenueReadProfile): Promise<VenueCalendarReaders>;
  loadOriginCalendar(input: {
    runtime: ReviewedRuntime;
    originReaders: OriginCalendarReaders;
    days: readonly WorldwideDayKey[];
  }): Promise<CalendarRangeRead>;
  applyVenueCalendar(input: {
    runtime: ReviewedRuntime;
    venue: ResolvedVenueReadProfile;
    originReaders: OriginCalendarReaders;
    venueReaders: VenueCalendarReaders;
    originRange: CalendarRangeRead;
  }): Promise<CalendarRangeRead>;
  loadAuction(input: ReadContext & { worldwideDay: WorldwideDayKey }): Promise<PublicAuctionRead>;
  loadVenueDemand(input: {
    venue: ResolvedVenueReadProfile;
    readers: VenueCalendarReaders;
    worldwideDay: WorldwideDayKey;
    signal: AbortSignal;
    liveAuction?: VenueAuctionSnapshot;
  }): Promise<VenueDemandEvidence>;
  loadCompletion(
    input: ReadContext & { auction: PublicAuctionRead; wallet: Address | null },
  ): Promise<AuctionCompletionRead>;
  loadPortfolio(input: ReadContext & { wallet: Address }): Promise<PortfolioRead>;
  activity(): VenuePollingActivity;
  now(): number;
}

const defaults: PublicDiscoveryRuntimeDependencies = {
  createOriginReaders: createOriginCalendarReaders,
  createVenueReaders: createVenueCalendarReaders,
  loadOriginCalendar: ({ runtime, originReaders, days }) => {
    if (!runtime.origin || !runtime.selectedVenue)
      throw new Error('Discovery runtime is missing an origin or reference venue.');
    return loadOriginCalendarRangeWithReaders(runtime.origin, runtime.selectedVenue.chainId, originReaders, days);
  },
  applyVenueCalendar: ({ runtime, venue, originReaders, venueReaders, originRange }) => {
    if (!runtime.origin) throw new Error('Discovery runtime is missing an origin profile.');
    return applyVenueCalendarOverlay(runtime.origin, venue, { ...originReaders, ...venueReaders }, originRange);
  },
  loadAuction: ({ origin, venue, originReaders, venueReaders, worldwideDay }) =>
    loadPublicAuctionWithAdapters(
      origin,
      venue,
      {
        origin: originReaders.originAdapter,
        venue: venueReaders.venueAdapter,
      },
      worldwideDay,
    ),
  loadVenueDemand: ({ venue, readers, worldwideDay, signal, liveAuction }) =>
    loadVenueDemandEvidence(
      withRpcDiagnostics(readers.venueClient, 'venue-ladder'),
      venue,
      worldwideDay,
      undefined,
      signal,
      liveAuction ? { liveAuction } : {},
    ),
  loadCompletion: ({ origin, venue, originReaders, venueReaders, auction, wallet }) =>
    loadAuctionCompletion(
      auction,
      new OutbeAuctionAdapter(withRpcDiagnostics(originReaders.originClient, 'completion:origin'), origin),
      new CompletionVenueAdapter(withRpcDiagnostics(venueReaders.venueClient, 'completion:venue'), venue),
      wallet,
    ),
  loadPortfolio: ({ origin, venue, originReaders, venueReaders, wallet }) =>
    loadPortfolio(
      wallet,
      new OutbeAuctionAdapter(withRpcDiagnostics(originReaders.originClient, 'portfolio:origin'), origin),
      new CompletionVenueAdapter(withRpcDiagnostics(venueReaders.venueClient, 'portfolio:venue'), venue),
      { originChainId: origin.chainId, venueChainId: venue.chainId },
    ),
  activity: browserPollingActivity,
  now: Date.now,
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown application failure.';
const rangeCovers = (range: CalendarRangeRead, month: WorldwideDayMonth): boolean => {
  const grid = buildTwoMonthWorldwideDayGrid(month);
  return (
    compareWorldwideDays(range.start, grid.visibleStart) <= 0 && compareWorldwideDays(range.end, grid.visibleEnd) >= 0
  );
};

const ladderEvidenceChanged = (previous: VenueAuctionSnapshot, next: VenueAuctionSnapshot): boolean =>
  previous.stage !== next.stage ||
  previous.result.auctionClearingRate !== next.result.auctionClearingRate ||
  previous.result.wonBidsCount !== next.result.wonBidsCount ||
  previous.result.issuedIntexCount !== next.result.issuedIntexCount ||
  previous.result.issuedIntexLoadedPromis !== next.result.issuedIntexLoadedPromis;

export const createPublicDiscoveryRuntime = (dependencies: PublicDiscoveryRuntimeDependencies = defaults) => {
  const listeners = new Set<() => void>();
  const originCalendarCache = new Map<string, CalendarRangeRead>();
  const venueCalendarCache = new Map<string, CalendarRangeRead>();
  const originCalendarRequests = new Map<string, Promise<CalendarRangeRead>>();
  const venueCalendarRequests = new Map<string, Promise<CalendarRangeRead>>();
  let state: PublicDiscoveryRuntimeState = {
    calendar: { kind: 'idle' },
    selectedAuction: { kind: 'idle' },
    ladder: { kind: 'loading' },
    completion: { kind: 'loading' },
    portfolio: { kind: 'disconnected' },
    oracleConversions: null,
    activeVenue: null,
    contextToken: '',
  };
  let context: PublicDiscoveryRuntimeContext | null = null;
  let originReaders: OriginCalendarReaders | null = null;
  let venueReaders: VenueCalendarReaders | null = null;
  let oracleHistoryAdapter: OracleAdapter | null = null;
  let oracleConversionsAdapter: Parameters<typeof loadOracleConversions>[0] | null = null;
  let keys = { origin: '', venue: null as string | null, wallet: '' };
  let calendarKeys: { origin: string; venue: string | null } | null = null;
  let selectedSnapshot: { token: string; day: WorldwideDayKey; at: number; auction: VenueAuctionSnapshot } | null =
    null;
  let version = 0;
  let disposed = false;
  const readerRequests = { origin: '', venue: '' };
  let venueReaderFailure: string | null = null;
  const watchers = new Map<string, SequentialVenuePollingController>();

  const emit = () => {
    state = { ...state };
    listeners.forEach((listener) => {
      listener();
    });
  };
  const current = (candidate: number) => !disposed && candidate === version;
  const stop = () => {
    watchers.forEach((controller) => {
      controller.stop();
    });
    watchers.clear();
  };
  const readContext = (): ReadContext | null =>
    context?.runtime?.origin && state.activeVenue && originReaders && venueReaders
      ? { origin: context.runtime.origin, venue: state.activeVenue, originReaders, venueReaders }
      : null;
  const watch = <T>(key: string, cycle: number, options: Parameters<typeof startSequentialVenuePolling<T>>[0]) => {
    if (watchers.has(key)) return;
    const controller = startSequentialVenuePolling({
      ...options,
      onResult: (value) => {
        if (current(cycle)) options.onResult(value);
      },
      onError: (error) => {
        if (current(cycle)) options.onError(error);
      },
    });
    watchers.set(key, controller);
  };
  const originCalendarKey = (start: WorldwideDayKey, end: WorldwideDayKey) => [keys.origin, start, end].join(':');
  const venueCalendarKey = (originKey: string, venue: string) => [originKey, venue].join(':');
  const originRange = (key: string, days: readonly WorldwideDayKey[]) => {
    const cached = originCalendarCache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = originCalendarRequests.get(key);
    if (pending) return pending;
    const request = dependencies
      .loadOriginCalendar({ runtime: context!.runtime!, originReaders: originReaders!, days })
      .then(
        (value) => {
          originCalendarCache.set(key, value);
          originCalendarRequests.delete(key);
          return value;
        },
        (error) => {
          originCalendarRequests.delete(key);
          throw error;
        },
      );
    originCalendarRequests.set(key, request);
    return request;
  };
  const venueRange = (
    key: string,
    origin: CalendarRangeRead,
    requestRuntime: ReviewedRuntime,
    requestVenue: ResolvedVenueReadProfile,
    requestOriginReaders: OriginCalendarReaders,
    requestVenueReaders: VenueCalendarReaders,
  ) => {
    const cached = venueCalendarCache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = venueCalendarRequests.get(key);
    if (pending) return pending;
    const request = dependencies
      .applyVenueCalendar({
        runtime: requestRuntime,
        venue: requestVenue,
        originReaders: requestOriginReaders,
        venueReaders: requestVenueReaders,
        originRange: origin,
      })
      .then(
        (value) => {
          venueCalendarCache.set(key, value);
          venueCalendarRequests.delete(key);
          return value;
        },
        (error) => {
          venueCalendarRequests.delete(key);
          throw error;
        },
      );
    venueCalendarRequests.set(key, request);
    return request;
  };

  const startCalendar = (cycle: number) => {
    if (!context?.runtime?.origin || !originReaders) return;
    const desiredVenue = state.activeVenue && venueReaders ? keys.venue : null;
    if (
      state.calendar.kind === 'loaded' &&
      calendarKeys?.origin === keys.origin &&
      calendarKeys.venue === desiredVenue &&
      rangeCovers(state.calendar.value, context.firstMonth)
    ) {
      emitDiagnostic({
        category: 'auction',
        event: 'context',
        worldwideDay: context.selectedWorldwideDay,
        cacheStatus: 'current',
        scanStatus: 'complete',
      });
      return;
    }
    const days = calendarWorldwideDayWindow(context.firstMonth);
    const start = days[0];
    const end = days[days.length - 1];
    if (!start || !end) return;
    const originKey = originCalendarKey(start, end);
    const key = desiredVenue ? venueCalendarKey(originKey, desiredVenue) : originKey;
    const cached = desiredVenue ? venueCalendarCache.get(key) : originCalendarCache.get(key);
    if (cached) {
      emitDiagnostic({
        category: 'auction',
        event: 'context',
        worldwideDay: context.selectedWorldwideDay,
        cacheStatus: 'hit',
        scanStatus: 'complete',
      });
      state.calendar = { kind: 'loaded', value: cached };
      calendarKeys = { origin: keys.origin, venue: desiredVenue };
      emit();
      startLadder(cycle);
      return;
    }
    if (state.calendar.kind !== 'loaded') {
      state.calendar = { kind: 'loading' };
      emit();
    }
    emitDiagnostic({
      category: 'auction',
      event: 'context',
      worldwideDay: context.selectedWorldwideDay,
      cacheStatus: 'miss',
      scanStatus: 'loading',
    });
    const requestRuntime = context.runtime;
    const requestVenue = state.activeVenue;
    const requestOriginReaders = originReaders;
    const requestVenueReaders = venueReaders;
    void originRange(originKey, days)
      .then((originValue) =>
        desiredVenue && requestVenue && requestVenueReaders
          ? venueRange(key, originValue, requestRuntime, requestVenue, requestOriginReaders, requestVenueReaders)
          : originValue,
      )
      .then(
        (value) => {
          if (!current(cycle)) return;
          state.calendar = { kind: 'loaded', value };
          calendarKeys = { origin: keys.origin, venue: desiredVenue };
          emitDiagnostic({
            category: 'auction',
            event: 'context',
            worldwideDay: context!.selectedWorldwideDay,
            cacheStatus: 'miss',
            scanStatus: 'complete',
          });
          emit();
          startLadder(cycle);
        },
        (error) => {
          if (!current(cycle)) return;
          emitDiagnostic({
            category: 'auction',
            event: 'context',
            worldwideDay: context!.selectedWorldwideDay,
            cacheStatus: 'miss',
            scanStatus: 'failed',
          });
          emitDiagnostic({
            category: 'error',
            event: 'runtime',
            component: 'calendar',
            operation: 'scan',
            ...diagnosticError(error),
          });
          if (state.calendar.kind !== 'loaded') state.calendar = { kind: 'failure', message: errorMessage(error) };
          emit();
        },
      );
  };

  const startConversions = (cycle: number, auction: PublicAuctionRead) => {
    if (!oracleConversionsAdapter || auction.venue.kind !== 'delivered') return;
    const codes = [
      ...new Set([
        auction.venue.auction.params.referenceCurrency,
        ...(auction.venue.auction.params.referenceCurrencies ?? []),
      ]),
    ];
    watch('conversions', cycle, {
      request: () => loadOracleConversions(oracleConversionsAdapter!, codes),
      nextDelay: () => ORACLE_HISTORY_POLL_INTERVAL_MS,
      onResult: (value) => {
        state.oracleConversions = value;
        emit();
      },
      onError: () => {
        state.oracleConversions = null;
        emit();
      },
      activity: dependencies.activity(),
      intervalMs: ORACLE_HISTORY_POLL_INTERVAL_MS,
    });
  };

  const startCompletion = (cycle: number, auction: PublicAuctionRead) => {
    const readers = readContext();
    if (
      !readers ||
      auction.venue.kind !== 'delivered' ||
      (auction.venue.auction.stage !== 'completed' && auction.venue.auction.stage !== 'cancelled')
    )
      return;
    const wallet = context!.walletState.kind === 'connected-supported' ? context!.walletState.connection.address : null;
    state.completion = { kind: 'loading' };
    emit();
    watch('completion', cycle, {
      request: () => dependencies.loadCompletion({ ...readers, auction, wallet }),
      nextDelay: () => COMPLETION_POLL_INTERVAL_MS,
      onResult: (value) => {
        state.completion = { kind: 'loaded', value };
        emit();
      },
      onError: (error) => {
        if (state.completion.kind !== 'loaded')
          state.completion = { kind: 'unavailable', message: errorMessage(error) };
        emit();
      },
      activity: dependencies.activity(),
      intervalMs: COMPLETION_POLL_INTERVAL_MS,
    });
  };

  const startAuction = (cycle: number) => {
    const readers = readContext();
    if (!readers || !context) return;
    const day = context.selectedWorldwideDay;
    if (state.selectedAuction.kind !== 'loaded' || state.selectedAuction.auction.worldwideDay !== day) {
      state.selectedAuction = { kind: 'loading' };
      emit();
    }
    watch('auction', cycle, {
      request: () => dependencies.loadAuction({ ...readers, worldwideDay: day }),
      nextDelay: (auction) =>
        auction.venue.kind === 'delivered'
          ? auctionReadNextPollDelay(
              auction.venue.auction.stage,
              auction.venue.auction.schedule.commitEnd,
              undefined,
              auction.venue.auction.schedule.revealEnd,
            )
          : auction.venue.kind === 'delivery-pending' || auction.venue.kind === 'failure'
            ? AUCTION_READ_POLL_INTERVAL_MS
            : null,
      onResult: (auction) => {
        const previous =
          selectedSnapshot?.token === state.contextToken && selectedSnapshot.day === day
            ? selectedSnapshot.auction
            : null;
        const next = auction.venue.kind === 'delivered' ? auction.venue.auction : null;
        selectedSnapshot = next ? { token: state.contextToken, day, at: dependencies.now(), auction: next } : null;
        state.selectedAuction = { kind: 'loaded', auction };
        emit();
        startConversions(cycle, auction);
        startCompletion(cycle, auction);
        if (previous && next && ladderEvidenceChanged(previous, next)) watchers.get('ladder')?.refresh();
      },
      onError: (error) => {
        if (state.selectedAuction.kind !== 'loaded')
          state.selectedAuction = { kind: 'failure', message: errorMessage(error) };
        emit();
      },
      activity: dependencies.activity(),
    });
  };

  function startLadder(cycle: number) {
    if (
      !context ||
      !state.activeVenue ||
      !venueReaders ||
      state.calendar.kind !== 'loaded' ||
      calendarKeys?.venue !== keys.venue
    ) {
      if (venueReaderFailure) {
        state.ladder = { kind: 'failure', message: venueReaderFailure };
        emit();
      }
      return;
    }
    const cell = state.calendar.value.days.find((day) => day.worldwideDay === context!.selectedWorldwideDay);
    if (!cell?.venueAuction) {
      state.ladder = { kind: 'unavailable', reason: 'no-venue-auction' };
      emit();
      return;
    }
    const reason =
      cell.venueParticipation === 'skipped'
        ? 'venue-skipped'
        : cell.venueParticipation === 'not-applicable'
          ? 'not-applicable'
          : cell.venueReceipt === 'delivery-pending'
            ? 'delivery-pending'
            : null;
    if (reason) {
      state.ladder = { kind: 'unavailable', reason };
      emit();
      return;
    }
    state.ladder = { kind: 'loading' };
    emit();
    watch('ladder', cycle, {
      request: (signal) => {
        const liveAuction = freshSelectedVenueAuction();
        return dependencies.loadVenueDemand({
          venue: state.activeVenue!,
          readers: venueReaders!,
          worldwideDay: context!.selectedWorldwideDay,
          signal,
          ...(liveAuction ? { liveAuction } : {}),
        });
      },
      nextDelay: (evidence) => venueDemandNextPollDelay(evidence.live.stage, cell.venueAuction!.schedule.commitEnd),
      repeatOnError:
        cell.venueStage === 'committing-bids' ||
        cell.venueStage === 'revealing-bids' ||
        cell.venueStage === 'issuance' ||
        cell.venueStage === 'completed',
      onResult: (evidence) => {
        try {
          state.ladder = { kind: 'loaded', model: buildVenueDemandModel(evidence) };
        } catch (error) {
          state.ladder = { kind: 'failure', message: errorMessage(error) };
        }
        emit();
      },
      onError: (error) => {
        const latest =
          selectedSnapshot?.token === state.contextToken && selectedSnapshot.day === context!.selectedWorldwideDay
            ? selectedSnapshot.auction
            : null;
        const terminal = latest?.stage === 'completed' || latest?.stage === 'cancelled';
        state.ladder = terminal
          ? { kind: 'failure', message: errorMessage(error) }
          : state.ladder.kind === 'loaded'
            ? { ...state.ladder, warning: errorMessage(error) }
            : { kind: 'failure', message: errorMessage(error) };
        emit();
      },
      activity: dependencies.activity(),
    });
  }

  const startPortfolio = (cycle: number) => {
    if (context?.activePage !== 'portfolio') return;
    if (context.walletState.kind !== 'connected-supported') {
      state.portfolio =
        context.walletState.kind === 'connected-unsupported'
          ? { kind: 'unavailable', message: 'Switch to a configured venue to view chain-bound holdings.' }
          : { kind: 'disconnected' };
      emit();
      return;
    }
    const readers = readContext();
    if (!readers) {
      state.portfolio = { kind: 'loading' };
      emit();
      return;
    }
    state.portfolio = { kind: 'loading' };
    emit();
    void dependencies.loadPortfolio({ ...readers, wallet: context.walletState.connection.address }).then(
      (value) => {
        if (current(cycle) && context?.activePage === 'portfolio') {
          state.portfolio = { kind: 'loaded', value };
          emit();
        }
      },
      (error) => {
        if (current(cycle) && context?.activePage === 'portfolio') {
          state.portfolio = { kind: 'unavailable', message: errorMessage(error) };
          emit();
        }
      },
    );
  };

  const restart = (resetAuction: boolean) => {
    stop();
    const cycle = ++version;
    if (resetAuction) {
      selectedSnapshot = null;
      state.selectedAuction = state.activeVenue ? { kind: 'loading' } : { kind: 'idle' };
      state.oracleConversions = null;
    }
    state.ladder = state.activeVenue
      ? { kind: 'loading' }
      : {
          kind: 'unavailable',
          reason: context?.walletState.kind === 'connected-unsupported' ? 'unsupported-chain' : 'no-venue-auction',
        };
    emit();
    startCalendar(cycle);
    startAuction(cycle);
    startLadder(cycle);
    startPortfolio(cycle);
    if (state.selectedAuction.kind === 'loaded') {
      startConversions(cycle, state.selectedAuction.auction);
      startCompletion(cycle, state.selectedAuction.auction);
    }
  };

  const ensureReaders = () => {
    const runtime = context?.runtime;
    const origin = runtime?.origin;
    if (!origin || runtime.evaluation.state !== 'ready') return;
    if (!originReaders && readerRequests.origin !== keys.origin) {
      const expected = keys.origin;
      readerRequests.origin = expected;
      void dependencies.createOriginReaders(origin).then(
        (readers) => {
          if (!disposed && expected === keys.origin) {
            originReaders = readers;
            oracleHistoryAdapter = new OracleAdapter(
              withRpcDiagnostics(readers.originClient, 'oracle-history'),
              origin,
            );
            oracleConversionsAdapter = new OracleAdapter(
              withRpcDiagnostics(readers.originClient, 'oracle-conversions'),
              origin,
            );
            readerRequests.origin = '';
            restart(false);
          }
        },
        (error) => {
          if (!disposed && expected === keys.origin) {
            readerRequests.origin = '';
            state.calendar = { kind: 'failure', message: errorMessage(error) };
            emit();
          }
        },
      );
    }
    if (state.activeVenue && !venueReaders && readerRequests.venue !== keys.venue) {
      const expected = keys.venue;
      readerRequests.venue = expected ?? '';
      void dependencies.createVenueReaders(state.activeVenue).then(
        (readers) => {
          if (!disposed && expected === keys.venue) {
            venueReaders = readers;
            venueReaderFailure = null;
            readerRequests.venue = '';
            restart(false);
          }
        },
        (error) => {
          if (!disposed && expected === keys.venue) {
            venueReaderFailure = errorMessage(error);
            readerRequests.venue = '';
            state.ladder = { kind: 'failure', message: venueReaderFailure };
            emit();
          }
        },
      );
    }
  };

  const updateContext = (next: PublicDiscoveryRuntimeContext) => {
    if (disposed) return;
    const nextOrigin = next.runtime?.origin ? originContextIdentity(next.runtime.origin).key : '';
    const nextVenue = next.runtime ? activeVenueForWallet(next.runtime, next.walletState) : null;
    const nextKeys = {
      origin: nextOrigin,
      venue: nextVenue ? venueContextIdentity(nextVenue).key : null,
      wallet: walletContextIdentity(next.walletState).key,
    };
    const originChanged = nextKeys.origin !== keys.origin;
    const venueChanged = nextKeys.venue !== keys.venue;
    const walletChanged = nextKeys.wallet !== keys.wallet;
    const selectionChanged = next.selectedWorldwideDay !== context?.selectedWorldwideDay;
    const monthChanged =
      next.firstMonth.year !== context?.firstMonth.year || next.firstMonth.month !== context?.firstMonth.month;
    const pageChanged = next.activePage !== context?.activePage;
    if (
      context &&
      !originChanged &&
      !venueChanged &&
      !walletChanged &&
      !selectionChanged &&
      !monthChanged &&
      !pageChanged
    )
      return;
    if (originChanged) {
      originCalendarCache.clear();
      venueCalendarCache.clear();
      originCalendarRequests.clear();
      venueCalendarRequests.clear();
      originReaders = null;
      oracleHistoryAdapter = null;
      oracleConversionsAdapter = null;
      readerRequests.origin = '';
      state.calendar = { kind: 'loading' };
      calendarKeys = null;
    } else if (venueChanged && state.calendar.kind === 'loaded') {
      state.calendar = { kind: 'loaded', value: retainOriginCalendarEvidence(state.calendar.value) };
      calendarKeys = { origin: nextOrigin, venue: null };
    }
    if (venueChanged) {
      venueCalendarCache.clear();
      venueCalendarRequests.clear();
      venueReaders = null;
      readerRequests.venue = '';
      venueReaderFailure = null;
    }
    context = next;
    keys = nextKeys;
    state.activeVenue = nextVenue;
    state.contextToken = [keys.origin, keys.venue ?? 'no-venue', keys.wallet, next.selectedWorldwideDay].join(':');
    restart(originChanged || venueChanged || selectionChanged);
    ensureReaders();
  };

  const loadEarlierDemand = async (beforeWorldwideDay: WorldwideDayKey): Promise<CalendarRangeRead | null> => {
    if (!context?.runtime?.origin || !originReaders) return null;
    const end = shiftWorldwideDay(beforeWorldwideDay, -1);
    const start = shiftWorldwideDay(end, -(CALENDAR_WINDOW_DAYS - 1));
    const days = contiguousWorldwideDayWindow(start, CALENDAR_WINDOW_DAYS);
    const desiredVenue = state.activeVenue && venueReaders ? keys.venue : null;
    const originKey = originCalendarKey(start, end);
    const key = desiredVenue ? venueCalendarKey(originKey, desiredVenue) : originKey;
    const cached = desiredVenue ? venueCalendarCache.get(key) : originCalendarCache.get(key);
    if (cached) return cached;
    const cycle = version;
    const requestRuntime = context.runtime;
    const requestVenue = state.activeVenue;
    const requestVenueReaders = venueReaders;
    const originValue = await originRange(originKey, days);
    const value =
      desiredVenue && requestVenue && requestVenueReaders
        ? await venueRange(key, originValue, requestRuntime, requestVenue, originReaders, requestVenueReaders)
        : originValue;
    if (!current(cycle)) return null;
    return value;
  };

  const freshSelectedVenueAuction = (): VenueAuctionSnapshot | undefined =>
    !selectedSnapshot ||
    !context ||
    selectedSnapshot.token !== state.contextToken ||
    selectedSnapshot.day !== context.selectedWorldwideDay ||
    dependencies.now() - selectedSnapshot.at > AUCTION_READ_POLL_INTERVAL_MS
      ? undefined
      : selectedSnapshot.auction;

  return {
    updateContext,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadEarlierDemand,
    freshSelectedVenueAuction,
    getVenuePublicClient: (): PublicClient | null => venueReaders?.venuePublicClient ?? null,
    getOracleHistoryAdapter: () => oracleHistoryAdapter,
    isContextCurrent: (token: string) => token === state.contextToken,
    dispose() {
      if (!disposed) {
        disposed = true;
        version += 1;
        stop();
        listeners.clear();
      }
    },
  };
};
