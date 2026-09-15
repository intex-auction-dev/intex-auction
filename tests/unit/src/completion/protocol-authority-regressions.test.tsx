import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { parseWorldwideDayKey, toDurationSeconds, toUtcTimestamp } from '@/domain/protocol-time';
import { AuctionCompletionCard } from '@/completion/completion-card';
import type { AuctionCompletionRead } from '@/completion/completion-loader';
import { VenueAuctionNotFoundError } from '@/chain/revert-classify';
import type { GlobalAuctionSnapshot, VenueAuctionSnapshot, WorldwideDaySnapshot } from '@/protocol/profile-types';
import { loadPublicAuctionWithAdapters, type PublicAuctionAdapters } from '@/discovery/load-public-auction';

const parsed = parseWorldwideDayKey('20260804');
if (!parsed.ok) throw new Error('Invalid test WorldwideDay.');
const worldwideDay = parsed.value;

const day: WorldwideDaySnapshot = {
  worldwideDay,
  lifecycle: 'completed',
  dayType: 'green',
  formingStart: toUtcTimestamp(1n),
  formingEnd: toUtcTimestamp(2n),
  lookbackEnd: toUtcTimestamp(3n),
  offeringEnd: toUtcTimestamp(4n),
  scheduledProcessTime: toUtcTimestamp(5n),
  previousVwap: 990_000n,
  currentVwap: 995_000n,
};

const noAuctionGlobal: GlobalAuctionSnapshot = {
  stage: 'none',
  totalBids: 0n,
  venueBids: 0n,
  venueIntakeComplete: false,
  venueInTargetSnapshot: false,
};

const deliveredVenue: VenueAuctionSnapshot = {
  worldwideDay,
  stage: 'committing-bids',
  dayType: 'green',
  paymentToken: '0x1111111111111111111111111111111111111111' as Address,
  schedule: {
    commitEnd: toUtcTimestamp(10n),
    revealEnd: toUtcTimestamp(20n),
    issuanceEnd: toUtcTimestamp(30n),
  },
  params: {
    issuanceCurrency: 949,
    issuanceCurrencies: [840, 949],
    issuanceEntryPrices: [1n, 34n],
    strikeAmountsMinor: [100n, 3_400n],
    oraclePairIds: [1, 2],
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

const adapters = (venue: 'delivered' | 'missing'): PublicAuctionAdapters => ({
  origin: {
    validateDeployment: async () => undefined,
    readWorldwideDayState: async () => ({ kind: 'retained', snapshot: day, terminal: null }),
    readGlobalAuction: async () => noAuctionGlobal,
    readCanonicalSeries: async () => null,
  },
  venue: {
    validateDeployment: async () => undefined,
    readAuction: async () => {
      if (venue === 'missing') throw new VenueAuctionNotFoundError('absent');
      return deliveredVenue;
    },
  },
});

const load = (venue: 'delivered' | 'missing') =>
  loadPublicAuctionWithAdapters(
    { name: 'Outbe', chainId: 31337 },
    { name: 'Venue', chainId: 31337 },
    adapters(venue),
    worldwideDay,
  );

const seriesId = `0x${(20260804).toString(16).padStart(28, '0')}` as Hex;
const loser: AuctionCompletionRead = {
  worldwideDay,
  result: 'sale',
  targetSeriesIds: [seriesId],
  series: [],
  bidderEconomics: {
    kind: 'finalized',
    lockedAmount: 800n,
    paidAmount: 0n,
    refundedAmount: 800n,
    burnedAmount: 0n,
    wonCount: 0n,
    source: 'normal-finalization',
  },
  clearingRate: 500_000n,
  promisLoadMinor: 1_000_000_000_000_000_000n,
  issuanceCurrency: 840,
  referenceCurrency: 840,
  issuanceEntryPriceMinor: null,
  entryPriceMinor: 1_000_000_000_000_000_000n,
  revealedBidCount: 2,
  latestVenueBlockTimestamp: 100n,
  paymentTokenDecimals: 18,
  paymentTokenSymbol: 'wCOEN',
  bidderBidQuantity: 1n,
  bidderBidRate: 600_000n,
};

describe('current upstream protocol authority regressions', () => {
  it('does not expose reference-price projections as issuance-specific public economics', async () => {
    const result = await load('delivered');
    expect(result.venue.kind).toBe('delivered');
    if (result.venue.kind !== 'delivered') throw new Error('Expected delivered venue.');
    expect(result.venue.auction.params.referenceCurrency).toBe(840);
    expect(result.venue.auction.params.entryPriceMinor).toBe(100n);
    expect(result.venue.auction.params.issuanceCurrency).toBe(0);
    expect(result.venue.auction.params.issuanceCurrencies).toEqual([]);
    expect(result.venue.auction.params.issuanceEntryPrices).toEqual([]);
    expect(result.venue.auction.params.strikeAmountsMinor).toEqual([]);
    expect(result.venue.auction.params.oraclePairIds).toEqual([]);
  });

  it('classifies an absent venue as terminal no-auction when retained origin lifecycle is terminal and Desis has no auction', async () => {
    const result = await load('missing');
    expect(result.origin).toEqual(
      expect.objectContaining({
        kind: 'retained',
        worldwideDay: expect.objectContaining({ lifecycle: 'completed' }),
        globalAuction: expect.objectContaining({ stage: 'none' }),
      }),
    );
    expect(result.venue).toEqual({ kind: 'not-applicable', reason: 'terminal-origin-no-auction' });
  });

  it('does not claim a losing bid was below the clearing rate', () => {
    const html = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: loser }} />);
    expect(html).toContain('Not selected at clearing');
    expect(html).not.toContain('below the');
  });
});
