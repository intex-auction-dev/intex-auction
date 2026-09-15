import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarRangeRead, CalendarWorldwideDay } from '@/discovery/calendar-evidence';
import type { VenueAuctionSnapshot } from '@/protocol/profile-types';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import type { VenueDemandEvidence } from '@/demand/venue-bid-history';
import type {
  ResolvedOutbeReadProfile,
  ResolvedVenueReadProfile,
  ReviewedRuntime,
} from '@/runtime-config/load-reviewed-runtime-config';
import type { WalletState } from '@/wallet/wallet-state';
import { toDurationSeconds, toUtcTimestamp, worldwideDayMonth, type WorldwideDayKey } from '@/domain/protocol-time';
import { createPublicDiscoveryRuntime, type PublicDiscoveryRuntimeDependencies } from '@/app/public-discovery-runtime';
import { AUCTION_READ_POLL_INTERVAL_MS } from '@/demand/venue-ladder-polling';

const ADDRESS = '0x0000000000000000000000000000000000000001' as const;
const DAY_A = '20260817' as WorldwideDayKey;
const DAY_B = '20260818' as WorldwideDayKey;
const ADDRESS_B = '0x0000000000000000000000000000000000000002' as const;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const origin = (deploymentId = 'origin-a') =>
  ({
    id: 'outbe',
    name: 'Outbe',
    deploymentId,
    chainId: 100,
    addresses: { metadosis: ADDRESS, desis: ADDRESS, originRouter: ADDRESS, oracle: ADDRESS, intex: ADDRESS },
    oraclePair: { base: ADDRESS, quote: ADDRESS },
  }) as unknown as ResolvedOutbeReadProfile;

const venue = (chainId: number, deploymentId = `venue-${chainId}`) =>
  ({
    id: `venue-${chainId}`,
    name: `Venue ${chainId}`,
    deploymentId,
    chainId,
    addresses: { intexAuction: ADDRESS },
    adapterProfile: 'multi-issuance-usd-reference',
  }) as unknown as ResolvedVenueReadProfile;

const reviewed = (
  originProfile: ResolvedOutbeReadProfile,
  selectedVenue: ResolvedVenueReadProfile,
): ReviewedRuntime => ({
  evaluation: { state: 'ready' } as ReviewedRuntime['evaluation'],
  origin: originProfile,
  venues: [selectedVenue],
  selectedVenue,
  timing: null,
});

const disconnected = (): WalletState => ({ kind: 'disconnected', providers: [] });
const connected = (profile: ResolvedVenueReadProfile, address: Address = ADDRESS): WalletState =>
  ({
    kind: 'connected-supported',
    providers: [],
    activeVenue: profile,
    connection: { provider: { type: 'injected', id: 'test', name: 'Test' }, chainId: profile.chainId, address },
    networkSwitch: { kind: 'idle' },
  }) as unknown as WalletState;
const unsupported = (chainId = 999): WalletState =>
  ({
    kind: 'connected-unsupported',
    providers: [],
    activeVenue: null,
    connection: { provider: { type: 'injected', id: 'test', name: 'Test' }, chainId, address: ADDRESS },
    networkSwitch: { kind: 'idle' },
  }) as unknown as WalletState;

const day = (
  worldwideDay: WorldwideDayKey,
  venueStage: CalendarWorldwideDay['venueStage'] = 'committing-bids',
): CalendarWorldwideDay => ({
  worldwideDay,
  originRecord: { kind: 'not-found' },
  lifecycle: 'offering',
  dayType: 'green',
  terminalDisposition: null,
  globalAuction: {
    stage: null,
    terminalDisposition: 'active',
    totalBids: null,
    venueBids: 7n,
    grossIncludedDemand: null,
    clearingRate: null,
    issuedIntexCount: null,
    offeredQuantity: null,
    offeredQuantityEvidence: 'unavailable',
  },
  venueParticipation: 'included',
  originDelivery: { stageStart: 'dispatched', clearing: 'not-observed', result: 'not-observed' },
  venueReceipt: 'stage-received',
  venueStage,
  scheduleAvailability: { kind: 'unavailable' },
  venueAuction: null,
  canonicalSeries: null,
  failures: [],
});

const range = (
  worldwideDay: WorldwideDayKey,
  venueStage: CalendarWorldwideDay['venueStage'] = 'committing-bids',
): CalendarRangeRead => ({
  start: '20260701' as WorldwideDayKey,
  end: '20261001' as WorldwideDayKey,
  days: [day(worldwideDay, venueStage)],
  failures: [],
});

const auction = (worldwideDay: WorldwideDayKey): PublicAuctionRead => ({
  worldwideDay,
  originIdentity: { name: 'Outbe', chainId: 100 },
  venueIdentity: { name: 'Venue', chainId: 56 },
  origin: { kind: 'not-found' },
  venue: { kind: 'delivery-pending' },
});

const venueAuction = (
  stage: VenueAuctionSnapshot['stage'],
  result: Partial<VenueAuctionSnapshot['result']> = {},
): VenueAuctionSnapshot => ({
  worldwideDay: DAY_A,
  stage,
  dayType: 'green',
  paymentToken: ADDRESS,
  schedule: {
    commitEnd: toUtcTimestamp(100n),
    revealEnd: toUtcTimestamp(200n),
    issuanceEnd: toUtcTimestamp(300n),
  },
  params: {
    issuanceCurrency: 840,
    referenceCurrency: 840,
    promisLoadMinor: 100_000n,
    minIntexBidRate: 500_000,
    minIntexBidQuantity: 1,
    entryPriceMinor: 100n,
    floorPriceMinor: 80n,
    callPriceMinor: 120n,
    commitBondMinor: 10n,
    callTrigger: { windowDays: 30, thresholdDays: 15, intexCallPeriod: toDurationSeconds(86_400n) },
  },
  runningCounts: { committedBids: 2, revealedBids: 1 },
  result: {
    auctionClearingRate: 0n,
    wonBidsCount: 0,
    issuedIntexCount: 0,
    issuedIntexLoadedPromis: 0n,
    ...result,
  },
});

const deliveredAuction = (snapshot: VenueAuctionSnapshot): PublicAuctionRead => ({
  worldwideDay: snapshot.worldwideDay,
  originIdentity: { name: 'Outbe', chainId: 100 },
  venueIdentity: { name: 'Venue', chainId: 56 },
  origin: { kind: 'not-found' },
  venue: { kind: 'delivered', auction: snapshot },
});

const demandEvidence = (
  stage: VenueAuctionSnapshot['stage'],
  authoritativeClearingRate: bigint | null,
): VenueDemandEvidence => ({
  logs: {
    confirmedThroughBlock: 10n,
    bidReveals: [],
    reaps: [],
    reapStatus: 'not-observed',
    cacheStatus: { BidRevealed: 'cache-hit', AuctionReaped: 'cache-hit' },
  },
  live: { stage, bids: [], authoritativeClearingRate },
});

const fakeActivity = {
  isActive: () => true,
  subscribe: () => () => undefined,
};

const baseDependencies = (): PublicDiscoveryRuntimeDependencies => ({
  createOriginReaders: vi.fn(async () => ({ originClient: {}, originAdapter: {} }) as never),
  createVenueReaders: vi.fn(async () => ({ venueClient: {}, venuePublicClient: {}, venueAdapter: {} }) as never),
  loadOriginCalendar: vi.fn(
    async ({ days }) =>
      ({
        ...range(days[0]!),
        days: [
          {
            ...day(days[0]!),
            venueStage: null,
            venueAuction: null,
            globalAuction: { ...day(days[0]!).globalAuction, venueBids: null },
          },
        ],
      }) as CalendarRangeRead,
  ),
  applyVenueCalendar: vi.fn(
    async ({
      originRange,
      venue: activeVenue,
    }: Parameters<PublicDiscoveryRuntimeDependencies['applyVenueCalendar']>[0]) =>
      ({
        ...originRange,
        days: originRange.days.map((value) => ({
          ...value,
          venueStage: activeVenue.chainId === 97 ? 'revealing-bids' : 'committing-bids',
          venueParticipation: 'included',
          venueReceipt: 'stage-received',
        })),
      }) as CalendarRangeRead,
  ),
  loadAuction: vi.fn(async ({ worldwideDay }) => auction(worldwideDay)),
  loadVenueDemand: vi.fn(async () => {
    throw new Error('ladder unavailable in unit fixture');
  }),
  loadCompletion: vi.fn(async () => {
    throw new Error('completion unavailable in unit fixture');
  }),
  loadPortfolio: vi.fn(async () => {
    throw new Error('portfolio unavailable in unit fixture');
  }),
  activity: () => fakeActivity,
  now: () => Date.now(),
});

const update = (
  runtime: ReturnType<typeof createPublicDiscoveryRuntime>,
  config: ReviewedRuntime,
  walletState: WalletState,
  worldwideDay = DAY_A,
) =>
  runtime.updateContext({
    runtime: config,
    walletState,
    selectedWorldwideDay: worldwideDay,
    firstMonth: worldwideDayMonth(worldwideDay),
    activePage: 'auctions',
  });

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe('public discovery runtime lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads one origin range and applies the venue overlay after both readers initialize', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), profile), disconnected());
    await flush();

    expect(deps.loadOriginCalendar).toHaveBeenCalledTimes(1);
    expect(deps.applyVenueCalendar).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('retains origin evidence while replacing the venue overlay on a venue switch', async () => {
    const a = venue(56);
    const b = venue(97);
    const deps = baseDependencies();
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), a), connected(a));
    await flush();
    update(runtime, reviewed(origin(), b), connected(b));
    await flush();

    const state = runtime.getState();
    expect(state.activeVenue?.chainId).toBe(97);
    expect(state.calendar.kind).toBe('loaded');
    if (state.calendar.kind === 'loaded') {
      expect(state.calendar.value.days[0]?.lifecycle).toBe('offering');
      expect(state.calendar.value.days[0]?.venueStage).toBe('revealing-bids');
    }
    runtime.dispose();
  });

  it('rejects a late selected-auction result after the selected WorldwideDay changes', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const slow = deferred<PublicAuctionRead>();
    vi.mocked(deps.loadAuction).mockReturnValueOnce(slow.promise).mockResolvedValueOnce(auction(DAY_B));
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), profile), connected(profile), DAY_A);
    await flush();
    update(runtime, reviewed(origin(), profile), connected(profile), DAY_B);
    await flush();
    slow.resolve(auction(DAY_A));
    await flush();

    const state = runtime.getState();
    expect(state.selectedAuction.kind).toBe('loaded');
    if (state.selectedAuction.kind === 'loaded') expect(state.selectedAuction.auction.worldwideDay).toBe(DAY_B);
    runtime.dispose();
  });

  it('keeps origin facts while an unsupported-chain transition clears venue-bound evidence', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), profile), connected(profile));
    await flush();
    update(runtime, reviewed(origin(), profile), unsupported());
    await flush();

    const state = runtime.getState();
    expect(state.activeVenue).toBeNull();
    expect(state.ladder).toEqual({ kind: 'unavailable', reason: 'unsupported-chain' });
    expect(state.calendar.kind).toBe('loaded');
    if (state.calendar.kind === 'loaded') {
      const retained = state.calendar.value.days[0]!;
      expect(retained.lifecycle).toBe('offering');
      expect(retained.venueStage).toBeNull();
      expect(retained.globalAuction.venueBids).toBeNull();
    }
    runtime.dispose();
  });

  it('reuses a covered calendar range instead of loading it again for the same context', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const runtime = createPublicDiscoveryRuntime(deps);
    const config = reviewed(origin(), profile);

    update(runtime, config, disconnected());
    await flush();
    const afterInitialLoad = vi.mocked(deps.loadOriginCalendar).mock.calls.length;
    update(runtime, config, disconnected(), DAY_B);
    await flush();

    expect(deps.loadOriginCalendar).toHaveBeenCalledTimes(afterInitialLoad);
    runtime.dispose();
  });

  it('keeps public calendar evidence across an account-only switch', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const runtime = createPublicDiscoveryRuntime(deps);
    const config = reviewed(origin(), profile);

    update(runtime, config, connected(profile, ADDRESS));
    await flush();
    const calendarReads = vi.mocked(deps.loadOriginCalendar).mock.calls.length;
    const oldToken = runtime.getState().contextToken;
    update(runtime, config, connected(profile, ADDRESS_B));
    await flush();

    expect(deps.loadOriginCalendar).toHaveBeenCalledTimes(calendarReads);
    expect(runtime.getState().contextToken).not.toBe(oldToken);
    expect(runtime.getState().calendar.kind).toBe('loaded');
    runtime.dispose();
  });

  it('rebuilds venue readers when returning from an unsupported chain', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const runtime = createPublicDiscoveryRuntime(deps);
    const config = reviewed(origin(), profile);

    update(runtime, config, connected(profile));
    await flush();
    update(runtime, config, unsupported());
    await flush();
    update(runtime, config, connected(profile));
    await flush();

    expect(deps.createVenueReaders).toHaveBeenCalledTimes(2);
    expect(runtime.getState().activeVenue?.chainId).toBe(56);
    expect(runtime.getState().calendar.kind).toBe('loaded');
    runtime.dispose();
  });

  it('invalidates readers and calendar cache when the origin deployment changes', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin('origin-a'), profile), connected(profile));
    await flush();
    const calendarReads = vi.mocked(deps.loadOriginCalendar).mock.calls.length;
    update(runtime, reviewed(origin('origin-b'), profile), connected(profile));
    await flush();

    expect(deps.createOriginReaders).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.loadOriginCalendar).mock.calls.length).toBeGreaterThan(calendarReads);
    runtime.dispose();
  });

  it('ignores a venue reader that resolves after its venue context was replaced', async () => {
    const a = venue(56);
    const b = venue(97);
    const deps = baseDependencies();
    const aReaders = deferred<Awaited<ReturnType<PublicDiscoveryRuntimeDependencies['createVenueReaders']>>>();
    const bReaders = deferred<Awaited<ReturnType<PublicDiscoveryRuntimeDependencies['createVenueReaders']>>>();
    vi.mocked(deps.createVenueReaders).mockImplementation((profile) =>
      profile.chainId === 56 ? aReaders.promise : bReaders.promise,
    );
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), a), connected(a));
    await flush();
    update(runtime, reviewed(origin(), b), connected(b));
    await flush();
    aReaders.resolve({ venueClient: {}, venuePublicClient: {}, venueAdapter: {} } as never);
    await flush();
    expect(deps.loadAuction).not.toHaveBeenCalled();
    bReaders.resolve({ venueClient: {}, venuePublicClient: {}, venueAdapter: {} } as never);
    await flush();

    expect(vi.mocked(deps.loadAuction).mock.calls.every(([input]) => input.venue.chainId === 97)).toBe(true);
    expect(deps.loadAuction).toHaveBeenCalled();
    runtime.dispose();
  });

  it('rejects a late calendar range after the visible month changes again', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const runtime = createPublicDiscoveryRuntime(deps);
    const config = reviewed(origin(), profile);
    const walletState = connected(profile);
    update(runtime, config, walletState);
    await flush();

    const slow = deferred<CalendarRangeRead>();
    const oldRange = { ...range(DAY_A), start: '20261201' as WorldwideDayKey, end: '20270301' as WorldwideDayKey };
    const newRange = { ...range(DAY_A), start: '20270201' as WorldwideDayKey, end: '20270501' as WorldwideDayKey };
    vi.mocked(deps.loadOriginCalendar).mockReset().mockReturnValueOnce(slow.promise).mockResolvedValueOnce(newRange);
    runtime.updateContext({
      runtime: config,
      walletState,
      selectedWorldwideDay: DAY_A,
      firstMonth: { year: 2027, month: 1 },
      activePage: 'auctions',
    });
    runtime.updateContext({
      runtime: config,
      walletState,
      selectedWorldwideDay: DAY_A,
      firstMonth: { year: 2027, month: 3 },
      activePage: 'auctions',
    });
    await flush();
    slow.resolve(oldRange);
    await flush();

    const state = runtime.getState();
    expect(state.calendar.kind).toBe('loaded');
    if (state.calendar.kind === 'loaded') expect(state.calendar.value.start).toBe(newRange.start);
    runtime.dispose();
  });

  it('keeps origin calendar evidence when venue reader creation fails', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    vi.mocked(deps.createVenueReaders).mockRejectedValue(new Error('venue rpc unavailable'));
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), profile), connected(profile));
    await flush();

    const state = runtime.getState();
    expect(state.calendar.kind).toBe('loaded');
    expect(state.ladder).toEqual({ kind: 'failure', message: 'venue rpc unavailable' });
    if (state.calendar.kind === 'loaded') expect(state.calendar.value.days[0]?.lifecycle).toBe('offering');
    runtime.dispose();
  });

  it('resumes selected-auction polling when browser activity becomes visible', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    let active = false;
    const listeners = new Set<() => void>();
    deps.activity = () => ({
      isActive: () => active,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), profile), connected(profile));
    await flush();
    expect(deps.loadAuction).not.toHaveBeenCalled();
    active = true;
    listeners.forEach((listener) => {
      listener();
    });
    await flush();

    expect(deps.loadAuction).toHaveBeenCalled();
    runtime.dispose();
  });

  it('immediately refreshes the ladder with enriched result evidence when the lifecycle stage changes', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const issuance = venueAuction('issuance');
    const completed = venueAuction('completed', {
      auctionClearingRate: 500_000n,
      wonBidsCount: 1,
      issuedIntexCount: 1,
      issuedIntexLoadedPromis: 100_000n,
    });
    const firstLadder = deferred<VenueDemandEvidence>();
    vi.mocked(deps.loadOriginCalendar).mockResolvedValue(range(DAY_A, 'issuance'));
    vi.mocked(deps.loadAuction)
      .mockResolvedValueOnce(deliveredAuction(issuance))
      .mockResolvedValueOnce(deliveredAuction(completed));
    vi.mocked(deps.applyVenueCalendar).mockImplementation(async ({ originRange }) => ({
      ...originRange,
      days: originRange.days.map((value) => ({
        ...value,
        venueStage: 'issuance',
        venueReceipt: 'stage-received',
        venueAuction: issuance,
      })),
    }));
    vi.mocked(deps.loadVenueDemand)
      .mockReturnValueOnce(firstLadder.promise)
      .mockResolvedValueOnce(demandEvidence('completed', 500_000n));
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), profile), connected(profile));
    await flush();
    expect(deps.loadVenueDemand).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AUCTION_READ_POLL_INTERVAL_MS);
    await flush();
    expect(deps.loadVenueDemand).toHaveBeenCalledTimes(1);

    firstLadder.resolve(demandEvidence('issuance', null));
    await flush();

    expect(deps.loadVenueDemand).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.loadVenueDemand).mock.calls[1]?.[0].liveAuction).toEqual(completed);
    const state = runtime.getState();
    expect(state.ladder.kind).toBe('loaded');
    if (state.ladder.kind === 'loaded') {
      expect(state.ladder.model.stage).toBe('completed');
      expect(state.ladder.model.authoritativeClearingRate).toBe(500_000n);
    }
    runtime.dispose();
  });

  it('replaces a stale ladder when the terminal lifecycle refresh fails', async () => {
    const profile = venue(56);
    const deps = baseDependencies();
    const issuance = venueAuction('issuance');
    const completed = venueAuction('completed', { auctionClearingRate: 500_000n });
    const firstLadder = deferred<VenueDemandEvidence>();
    vi.mocked(deps.loadOriginCalendar).mockResolvedValue(range(DAY_A, 'issuance'));
    vi.mocked(deps.loadAuction)
      .mockResolvedValueOnce(deliveredAuction(issuance))
      .mockResolvedValueOnce(deliveredAuction(completed));
    vi.mocked(deps.applyVenueCalendar).mockImplementation(async ({ originRange }) => ({
      ...originRange,
      days: originRange.days.map((value) => ({ ...value, venueStage: 'issuance', venueAuction: issuance })),
    }));
    vi.mocked(deps.loadVenueDemand)
      .mockReturnValueOnce(firstLadder.promise)
      .mockRejectedValueOnce(new Error('final ladder unavailable'));
    const runtime = createPublicDiscoveryRuntime(deps);

    update(runtime, reviewed(origin(), profile), connected(profile));
    await flush();
    await vi.advanceTimersByTimeAsync(AUCTION_READ_POLL_INTERVAL_MS);
    await flush();
    firstLadder.resolve(demandEvidence('issuance', null));
    await flush();

    expect(runtime.getState().ladder).toEqual({ kind: 'failure', message: 'final ladder unavailable' });
    runtime.dispose();
  });
});
