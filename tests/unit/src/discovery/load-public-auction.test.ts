import { HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseWorldwideDayKey, toDurationSeconds, toUtcTimestamp } from '@/domain/protocol-time';
import { IncompatibleDeploymentError, VenueAuctionNotFoundError } from '@/chain/revert-classify';
import type {
  CanonicalSeriesSnapshot,
  GlobalAuctionSnapshot,
  VenueAuctionSnapshot,
  WorldwideDaySnapshot,
} from '@/protocol/profile-types';
import { loadPublicAuctionWithAdapters, type PublicAuctionAdapters } from '@/discovery/load-public-auction';

const parsed = parseWorldwideDayKey('20260804');
if (!parsed.ok) throw new Error('Invalid test WWD.');
const worldwideDay = parsed.value;

const day: WorldwideDaySnapshot = {
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
};

const globalAuction: GlobalAuctionSnapshot = {
  stage: 'started',
  totalBids: 0n,
  venueBids: 0n,
  venueIntakeComplete: false,
  venueInTargetSnapshot: true,
};

const series: CanonicalSeriesSnapshot = {
  seriesId: `0x${(20260804).toString(16).padStart(28, '0')}`,
  promisLoadMinor: 1_000n,
  entryPriceMinor: 100n,
  floorPriceMinor: 90n,
  issuedIntexCount: 0,
  callWindowDays: 30,
  callThresholdDays: 21,
  callPriceMinor: 200n,
  state: 0,
  issuedAt: toUtcTimestamp(0n),
  calledAt: toUtcTimestamp(0n),
  intexCallPeriod: toDurationSeconds(86_400n),
  issuanceCurrency: 840,
  referenceCurrency: 840,
};

const venueAuction: VenueAuctionSnapshot = {
  worldwideDay,
  stage: 'committing-bids',
  dayType: 'green',
  paymentToken: '0x1111111111111111111111111111111111111111',
  schedule: {
    commitEnd: toUtcTimestamp(10n),
    revealEnd: toUtcTimestamp(20n),
    issuanceEnd: toUtcTimestamp(30n),
  },
  params: {
    issuanceCurrency: 840,
    referenceCurrency: 840,
    promisLoadMinor: 1_000n,
    minIntexBidRate: 600_000,
    minIntexBidQuantity: 1,
    entryPriceMinor: 100n,
    floorPriceMinor: 90n,
    callPriceMinor: 200n,
    commitBondMinor: 10n,
    callTrigger: {
      windowDays: 30,
      thresholdDays: 21,
      intexCallPeriod: toDurationSeconds(86_400n),
    },
  },
  runningCounts: { committedBids: 3, revealedBids: 1 },
  result: {
    auctionClearingRate: 0n,
    wonBidsCount: 0,
    issuedIntexCount: 0,
    issuedIntexLoadedPromis: 0n,
  },
};

const adapters = (
  overrides: Partial<{
    originState: Awaited<ReturnType<PublicAuctionAdapters['origin']['readWorldwideDayState']>>;
    originFailure: Error;
    venueFailure: Error;
    canonicalSeries: CanonicalSeriesSnapshot | null;
  }> = {},
  canonicalSeriesReads: string[] = [],
): PublicAuctionAdapters => ({
  origin: {
    validateDeployment: async () => {
      if (overrides.originFailure) throw overrides.originFailure;
    },
    readWorldwideDayState: async () =>
      overrides.originState ?? {
        kind: 'retained',
        snapshot: day,
        terminal: null,
      },
    readGlobalAuction: async () => globalAuction,
    readCanonicalSeries: async (seriesId) => {
      canonicalSeriesReads.push(seriesId);
      return overrides.canonicalSeries === undefined ? series : overrides.canonicalSeries;
    },
  },
  venue: {
    validateDeployment: async () => undefined,
    readAuction: async () => {
      if (overrides.venueFailure) throw overrides.venueFailure;
      return venueAuction;
    },
  },
});

const rpcFailure = (label: string) =>
  new HttpRequestError({
    url: `http://${label}`,
    details: `${label} unavailable`,
  });

const load = (value: PublicAuctionAdapters) =>
  loadPublicAuctionWithAdapters(
    { name: 'Outbe', chainId: 31337 },
    { name: 'Venue', chainId: 31337 },
    value,
    worldwideDay,
  );

describe('joined public auction read', () => {
  it('keeps retained canonical and delivered venue state independent', async () => {
    const result = await load(adapters());
    expect(result.origin.kind).toBe('retained');
    expect(result.venue.kind).toBe('delivered');
  });

  it('shows venue delivery pending without inventing a schedule', async () => {
    const result = await load(adapters({ venueFailure: new VenueAuctionNotFoundError('absent') }));
    expect(result.origin.kind).toBe('retained');
    expect(result.venue).toEqual({ kind: 'delivery-pending' });
  });

  it('marks an absent venue not applicable when terminal origin evidence proves no auction', async () => {
    const result = await load(
      adapters({
        originState: {
          kind: 'history-unavailable',
          terminal: {
            disposition: 'missed-offering',
            valueRouted: 0n,
            carryOverBefore: 0n,
            carryOverAfter: 0n,
            retirement: 'not-present',
            blockNumber: 7n,
          },
          cleanedFinalLifecycle: 'failed',
        },
        venueFailure: new VenueAuctionNotFoundError('absent'),
      }),
    );
    expect(result.venue).toEqual({ kind: 'not-applicable', reason: 'terminal-origin-no-auction' });
  });

  it('retains venue data when the origin fails', async () => {
    const result = await load(adapters({ originFailure: rpcFailure('origin') }));
    expect(result.origin).toEqual(
      expect.objectContaining({
        kind: 'failure',
        failure: expect.objectContaining({ kind: 'rpc' }),
      }),
    );
    expect(result.venue.kind).toBe('delivered');
  });

  it('retains origin data when the venue fails', async () => {
    const result = await load(adapters({ venueFailure: new IncompatibleDeploymentError('venue mismatch') }));
    expect(result.origin.kind).toBe('retained');
    expect(result.venue).toEqual(
      expect.objectContaining({
        kind: 'failure',
        failure: expect.objectContaining({ kind: 'incompatible-deployment' }),
      }),
    );
  });

  it('reports both failures separately', async () => {
    const result = await load(
      adapters({
        originFailure: rpcFailure('origin'),
        venueFailure: rpcFailure('venue'),
      }),
    );
    expect(result.origin).toEqual(
      expect.objectContaining({
        kind: 'failure',
        failure: expect.objectContaining({ kind: 'rpc' }),
      }),
    );
    expect(result.venue).toEqual(
      expect.objectContaining({
        kind: 'failure',
        failure: expect.objectContaining({ kind: 'rpc' }),
      }),
    );
  });

  it('does not collapse completed Metadosis state into a cleared global auction', async () => {
    const completedDay = { ...day, lifecycle: 'completed' as const };
    const value = adapters({
      originState: { kind: 'retained', snapshot: completedDay, terminal: null },
    });
    const result = await load(value);
    expect(result.origin).toEqual(
      expect.objectContaining({
        kind: 'retained',
        worldwideDay: expect.objectContaining({ lifecycle: 'completed' }),
        globalAuction: expect.objectContaining({ stage: 'started' }),
      }),
    );
  });

  it('does not infer a skipped venue from a Red day without terminal evidence', async () => {
    const redDay = { ...day, dayType: 'red' as const };
    const result = await load(
      adapters({
        originState: { kind: 'retained', snapshot: redDay, terminal: null },
        venueFailure: new VenueAuctionNotFoundError('absent'),
      }),
    );
    expect(result.origin).toEqual(
      expect.objectContaining({
        kind: 'retained',
        worldwideDay: expect.objectContaining({ dayType: 'red' }),
      }),
    );
    expect(result.venue).toEqual({ kind: 'delivery-pending' });
  });

  it('keeps canonical-series absence separate from delivered venue state', async () => {
    const result = await load(adapters({ canonicalSeries: null }));
    expect(result.origin).toEqual(
      expect.objectContaining({
        kind: 'retained',
        canonicalSeries: null,
      }),
    );
    expect(result.venue.kind).toBe('delivered');
  });

  it('does not fabricate a WWD-derived series read for any profile', async () => {
    const canonicalSeriesReads: string[] = [];
    const result = await load(adapters({}, canonicalSeriesReads));
    expect(result.origin).toEqual(
      expect.objectContaining({
        kind: 'retained',
        canonicalSeries: null,
      }),
    );
    expect(canonicalSeriesReads).toEqual([]);
  });
});
