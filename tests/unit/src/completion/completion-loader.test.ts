import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { PAYMENT_TOKEN_DECIMALS } from '@/domain/protocol-constants';
import { parseWorldwideDayKey, toDurationSeconds, toUtcTimestamp } from '@/domain/protocol-time';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import { loadAuctionCompletion, loadPortfolio } from '@/completion/completion-loader';
import type {
  BidderCompletionEvidence,
  PortfolioTokenRow,
  RecipientSeriesEvidence,
  TargetSeriesSnapshot,
} from '@/completion/completion-adapters';
import type { CanonicalSeriesSnapshot, VenueAuctionSnapshot } from '@/protocol/profile-types';

const parsed = parseWorldwideDayKey('20260804');
if (!parsed.ok) throw new Error('Invalid test WorldwideDay.');
const worldwideDay = parsed.value;
const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const sid = (value: number): Hex => `0x${value.toString(16).padStart(28, '0')}`;

const venueAuction = (issuedIntexCount: number): VenueAuctionSnapshot => ({
  worldwideDay,
  stage: 'completed',
  dayType: 'green',
  paymentToken: '0x1111111111111111111111111111111111111111',
  schedule: {
    commitEnd: toUtcTimestamp(1n),
    revealEnd: toUtcTimestamp(2n),
    issuanceEnd: toUtcTimestamp(3n),
  },
  params: {
    issuanceCurrency: 840,
    referenceCurrency: 840,
    promisLoadMinor: 1_000n,
    minIntexBidRate: 600_000,
    minIntexBidQuantity: 1,
    entryPriceMinor: 1_000n,
    floorPriceMinor: 900n,
    callPriceMinor: 1_200n,
    commitBondMinor: 100n,
    callTrigger: { windowDays: 30, thresholdDays: 21, intexCallPeriod: toDurationSeconds(20n) },
  },
  runningCounts: { committedBids: 1, revealedBids: 1 },
  result: {
    auctionClearingRate: issuedIntexCount === 0 ? 0n : 800_000n,
    wonBidsCount: issuedIntexCount === 0 ? 0 : 1,
    issuedIntexCount,
    issuedIntexLoadedPromis: BigInt(issuedIntexCount) * 1_000n,
  },
});

const auction = (issuedIntexCount: number): PublicAuctionRead => ({
  worldwideDay,
  originIdentity: { name: 'Outbe', chainId: 1 },
  venueIdentity: { name: 'Venue', chainId: 2 },
  origin: { kind: 'not-found' },
  venue: { kind: 'delivered', auction: venueAuction(issuedIntexCount) },
});

const canonical = (seriesId: Hex, state = 0): CanonicalSeriesSnapshot => ({
  seriesId,
  promisLoadMinor: 1_000n,
  entryPriceMinor: 1_000n,
  floorPriceMinor: 900n,
  issuedIntexCount: 5,
  callWindowDays: 30,
  callThresholdDays: 21,
  callPriceMinor: 1_200n,
  state,
  issuedAt: toUtcTimestamp(10n),
  calledAt: toUtcTimestamp(state === 2 ? 100n : 0n),
  intexCallPeriod: toDurationSeconds(20n),
  issuanceCurrency: 840,
  referenceCurrency: 840,
});

const target = (seriesId: Hex, lifecycle: TargetSeriesSnapshot['lifecycle'] = 'issued'): TargetSeriesSnapshot => ({
  seriesId,
  worldwideDay: Number(worldwideDay),
  lifecycle,
  issuedAt: 10n,
  calledAt: lifecycle === 'called' ? 100n : 0n,
  intexCallPeriod: 20n,
  issuedTokenId: BigInt(seriesId),
  settledTokenId: 1_000n + BigInt(seriesId),
  issuedIntexCount: 5,
  promisLoadMinor: 1_000n,
  entryPriceMinor: 1_000n,
  floorPriceMinor: 900n,
  callPriceMinor: 1_200n,
});

const noBid: BidderCompletionEvidence = {
  lock: { lockedAmount: 0n, lockedAt: 0n, status: 'none', failedRefund: 0n, splitRecorded: false },
  recoveredAmount: null,
  burnedAmount: null,
};

const recipient = (seriesId: Hex, wonCount: bigint): RecipientSeriesEvidence => ({
  seriesId,
  issuanceInstructionsReceived: true,
  deferred: false,
  deliveredEvent: wonCount > 0n,
  wonCount,
  currentIssuedBalance: wonCount,
  currentSettledBalance: 0n,
});

describe('Phase 10 completion loader', () => {
  it('does not fabricate a seriesId-from-WWD fallback when target provisioning is absent', async () => {
    const canonicalReads: Hex[] = [];
    const result = await loadAuctionCompletion(
      auction(5),
      {
        readCanonicalSeries: async (seriesId) => {
          canonicalReads.push(seriesId);
          return canonical(seriesId, 1);
        },
      },
      {
        readSeriesIdsByWorldwideDay: async () => [],
        readLatestBlockTimestamp: async () => 121n,
        readTargetSeries: async () => {
          throw new Error('not called');
        },
        readRecipientEvidence: async () => {
          throw new Error('not called');
        },
        readBidderCompletion: async () => noBid,
        readBidderRevealedBid: async () => null,
        readPaymentToken: async () => ({ decimals: 18, symbol: 'wCOEN' }),
      },
      null,
    );
    expect(result.result).toBe('sale');
    expect(result.targetSeriesIds).toEqual([]);
    expect(result.series).toEqual([]);
    expect(canonicalReads).toEqual([]);
  });

  it('never fabricates a canonical series for the multi-issuance profile when target provisioning is absent', async () => {
    const canonicalReads: Hex[] = [];
    const result = await loadAuctionCompletion(
      auction(5),
      {
        readCanonicalSeries: async (seriesId) => {
          canonicalReads.push(seriesId);
          return canonical(seriesId, 1);
        },
      },
      {
        readSeriesIdsByWorldwideDay: async () => [],
        readLatestBlockTimestamp: async () => 121n,
        readTargetSeries: async () => {
          throw new Error('not called');
        },
        readRecipientEvidence: async () => {
          throw new Error('not called');
        },
        readBidderCompletion: async () => noBid,
        readBidderRevealedBid: async () => null,
        readPaymentToken: async () => ({ decimals: 6, symbol: 'USDC' }),
      },
      null,
    );
    expect(result.result).toBe('sale');
    expect(result.targetSeriesIds).toEqual([]);
    expect(result.series).toEqual([]);
    expect(canonicalReads).toEqual([]);
    expect(result.paymentTokenDecimals).toBe(6);
    expect(result.paymentTokenSymbol).toBe('USDC');
  });

  it('preserves reviewed auction currency terms for completion amount conversions', async () => {
    const base = auction(5);
    if (base.venue.kind !== 'delivered') throw new Error('Expected delivered venue fixture.');
    const result = await loadAuctionCompletion(
      {
        ...base,
        venue: {
          kind: 'delivered',
          auction: {
            ...base.venue.auction,
            params: {
              ...base.venue.auction.params,
              issuanceCurrency: 949,
              issuanceCurrencies: [949],
              issuanceEntryPrices: [34_000_000_000_000_000_000n],
              referenceCurrency: 840,
              entryPriceMinor: 1_000_000_000_000_000_000n,
            },
          },
        },
      },
      { readCanonicalSeries: async () => null },
      {
        readSeriesIdsByWorldwideDay: async () => [],
        readLatestBlockTimestamp: async () => 121n,
        readTargetSeries: async () => {
          throw new Error('not called');
        },
        readRecipientEvidence: async () => {
          throw new Error('not called');
        },
        readBidderCompletion: async () => noBid,
        readBidderRevealedBid: async () => null,
        readPaymentToken: async () => ({ decimals: 18, symbol: 'wCOEN' }),
      },
      null,
    );

    expect(result.issuanceCurrency).toBe(949);
    expect(result.issuanceEntryPriceMinor).toBe(34_000_000_000_000_000_000n);
    expect(result.referenceCurrency).toBe(840);
    expect(result.entryPriceMinor).toBe(1_000_000_000_000_000_000n);
  });

  it('treats no-sale as terminal without missing-series or issuance-pending state', async () => {
    const result = await loadAuctionCompletion(
      auction(0),
      { readCanonicalSeries: async () => null },
      {
        readSeriesIdsByWorldwideDay: async () => [],
        readLatestBlockTimestamp: async () => 121n,
        readTargetSeries: async () => {
          throw new Error('not called');
        },
        readRecipientEvidence: async () => {
          throw new Error('not called');
        },
        readBidderCompletion: async () => noBid,
        readBidderRevealedBid: async () => null,
        readPaymentToken: async () => ({ decimals: 18, symbol: 'wCOEN' }),
      },
      wallet,
    );
    expect(result.result).toBe('no-sale');
    expect(result.series).toEqual([]);
    expect(result.bidderEconomics).toEqual({ kind: 'no-bid-lock' });
    expect(result.bidderBidRate).toBeNull();
  });

  it('refunds a finalized no-sale lock fully without fabricating issuance evidence', async () => {
    const result = await loadAuctionCompletion(
      auction(0),
      { readCanonicalSeries: async () => null },
      {
        readSeriesIdsByWorldwideDay: async () => [],
        readLatestBlockTimestamp: async () => 121n,
        readTargetSeries: async () => {
          throw new Error('not called');
        },
        readRecipientEvidence: async () => {
          throw new Error('not called');
        },
        readBidderCompletion: async () => ({
          ...noBid,
          lock: { lockedAmount: 1_000n, lockedAt: 1n, status: 'finalized', failedRefund: 0n, splitRecorded: true },
        }),
        readBidderRevealedBid: async () => null,
        readPaymentToken: async () => ({ decimals: 18, symbol: 'wCOEN' }),
      },
      wallet,
    );
    expect(result.result).toBe('no-sale');
    expect(result.bidderEconomics).toEqual({
      kind: 'finalized',
      lockedAmount: 1_000n,
      paidAmount: 0n,
      refundedAmount: 1_000n,
      burnedAmount: 0n,
      wonCount: 0n,
      source: 'normal-finalization',
    });
  });

  it('distinguishes a never-auctioned not-applicable venue from a cancellation', async () => {
    const result = await loadAuctionCompletion(
      { ...auction(0), venue: { kind: 'not-applicable', reason: 'terminal-origin-no-auction' } as const },
      {
        readCanonicalSeries: async () => {
          throw new Error('not called');
        },
      },
      {
        readSeriesIdsByWorldwideDay: async () => {
          throw new Error('not called');
        },
        readLatestBlockTimestamp: async () => {
          throw new Error('not called');
        },
        readTargetSeries: async () => {
          throw new Error('not called');
        },
        readRecipientEvidence: async () => {
          throw new Error('not called');
        },
        readBidderCompletion: async () => {
          throw new Error('not called');
        },
        readBidderRevealedBid: async () => {
          throw new Error('not called');
        },
        readPaymentToken: async () => {
          throw new Error('not called');
        },
      },
      wallet,
    );
    expect(result.result).toBe('no-auction');
    expect(result.targetSeriesIds).toEqual([]);
    expect(result.series).toEqual([]);
    expect(result.bidderEconomics).toBeNull();
  });

  it('preserves multiple target series for one WorldwideDay', async () => {
    const result = await loadAuctionCompletion(
      auction(5),
      { readCanonicalSeries: async (seriesId) => canonical(seriesId, seriesId === sid(9) ? 2 : 1) },
      {
        readSeriesIdsByWorldwideDay: async () => [sid(7), sid(9)],
        readLatestBlockTimestamp: async () => 121n,
        readTargetSeries: async (seriesId) => target(seriesId, seriesId === sid(9) ? 'called' : 'qualified'),
        readRecipientEvidence: async (seriesId) => recipient(seriesId, seriesId === sid(7) ? 2n : 3n),
        readBidderCompletion: async () => ({
          ...noBid,
          lock: { lockedAmount: 4_000n, lockedAt: 1n, status: 'finalized', failedRefund: 0n, splitRecorded: true },
          recoveredAmount: 0n,
          burnedAmount: 4_000n,
        }),
        readBidderRevealedBid: async () => ({ quantity: 4n, bidRate: 900_000n }),
        readPaymentToken: async () => ({ decimals: 18, symbol: 'wCOEN' }),
      },
      wallet,
    );
    expect(result.targetSeriesIds).toEqual([sid(7), sid(9)]);
    expect(result.series.map((item) => item.seriesId)).toEqual([sid(7), sid(9)]);
    expect(result.series[1]).toMatchObject({
      canonicalLifecycle: 'called',
      targetExpired: true,
      recipientDelivery: 'delivered',
    });
    expect(result.bidderEconomics).toEqual({
      kind: 'finalized',
      lockedAmount: 4_000n,
      paidAmount: 0n,
      refundedAmount: 0n,
      burnedAmount: 4_000n,
      wonCount: 5n,
      source: 'recovery',
    });
    expect(result.paymentTokenDecimals).toBe(PAYMENT_TOKEN_DECIMALS);
    expect(result.paymentTokenSymbol).toBe('wCOEN');
    expect(result.bidderBidRate).toBe(900_000n);
    expect(result.bidderBidQuantity).toBe(4n);
  });

  it('marks a fully refunded finalized bidder as no allocation only with recovery evidence', async () => {
    const result = await loadAuctionCompletion(
      auction(5),
      { readCanonicalSeries: async (seriesId) => canonical(seriesId) },
      {
        readSeriesIdsByWorldwideDay: async () => [sid(7)],
        readLatestBlockTimestamp: async () => 100n,
        readTargetSeries: async () => target(sid(7)),
        readRecipientEvidence: async () => recipient(sid(7), 0n),
        readBidderCompletion: async () => ({
          ...noBid,
          lock: { lockedAmount: 800n, lockedAt: 1n, status: 'finalized', failedRefund: 0n, splitRecorded: true },
          recoveredAmount: 800n,
          burnedAmount: 0n,
        }),
        readBidderRevealedBid: async () => null,
        readPaymentToken: async () => ({ decimals: 18, symbol: 'wCOEN' }),
      },
      wallet,
    );
    expect(result.bidderEconomics).toEqual({
      kind: 'finalized',
      lockedAmount: 800n,
      paidAmount: 0n,
      refundedAmount: 800n,
      burnedAmount: 0n,
      wonCount: 0n,
      source: 'recovery',
    });
    expect(result.series[0]?.recipientDelivery).toBe('not-a-winner');
  });
});

describe('Phase 10 portfolio loader', () => {
  it('keeps current balance, token status and canonical lifecycle separate', async () => {
    const rows: readonly PortfolioTokenRow[] = [
      { seriesId: sid(7), tokenId: 1007n, tokenStatus: 'settled', balance: 3n, targetSeries: target(sid(7), 'issued') },
      { seriesId: sid(9), tokenId: 9n, tokenStatus: 'issued', balance: 2n, targetSeries: target(sid(9), 'called') },
    ];
    const result = await loadPortfolio(
      wallet,
      { readCanonicalSeries: async (seriesId) => canonical(seriesId, seriesId === sid(7) ? 1 : 2) },
      {
        readPortfolio: async () => rows,
        readLatestBlockTimestamp: async () => 121n,
        readWalletBalances: async () => ({
          nativeBalance: 0n,
          paymentTokenBalance: 0n,
          paymentTokenDecimals: 18,
          paymentTokenSymbol: 'wCOEN',
        }),
      },
      { originChainId: 31337, venueChainId: 56 },
    );
    expect(result.rows).toMatchObject([
      {
        seriesId: sid(7),
        tokenStatus: 'settled',
        balance: 3n,
        canonicalLifecycle: 'qualified',
        lifecycleDelivery: 'target-behind',
      },
      {
        seriesId: sid(9),
        tokenStatus: 'issued',
        balance: 2n,
        canonicalLifecycle: 'called',
        targetExpired: true,
        lifecycleDelivery: 'matched',
      },
    ]);
  });
});
