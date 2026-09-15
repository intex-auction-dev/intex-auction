import type { Address, Hex } from 'viem';
import { PAYMENT_TOKEN_DECIMALS } from '../domain/protocol-constants';
import type { WorldwideDayKey } from '../domain/protocol-time';
import type { PublicAuctionRead } from '../discovery/load-public-auction';
import type { OutbeAuctionAdapter } from '../protocol/origin-adapter';
import type { CanonicalSeriesSnapshot } from '../protocol/profile-types';
import {
  decodeIntexLifecycle,
  deriveBidderEconomics,
  deriveRecipientDelivery,
  deriveSeriesProvisioning,
  isTargetSeriesExpired,
  targetAuctionResult,
  type BidderEconomics,
  type IntexLifecycle,
  type RecipientDelivery,
  type SeriesProvisioning,
  type TargetAuctionResult,
} from '../domain/completion-domain';
import type {
  CompletionVenueAdapter,
  PortfolioTokenRow,
  RecipientSeriesEvidence,
  TargetSeriesSnapshot,
} from './completion-adapters';

export interface CompletionSeriesRead {
  seriesId: Hex;
  canonical: CanonicalSeriesSnapshot | null;
  canonicalLifecycle: IntexLifecycle | null;
  target: TargetSeriesSnapshot | null;
  targetExpired: boolean;
  provisioning: SeriesProvisioning;
  recipient: RecipientSeriesEvidence | null;
  recipientDelivery: RecipientDelivery | null;
}

export interface AuctionCompletionRead {
  worldwideDay: WorldwideDayKey;
  result: TargetAuctionResult;
  targetSeriesIds: readonly Hex[];
  series: readonly CompletionSeriesRead[];
  bidderEconomics: BidderEconomics | null;
  bidderBidQuantity: bigint | null;
  bidderBidRate: bigint | null;
  clearingRate: bigint;
  promisLoadMinor: bigint;
  issuanceCurrency: number;
  issuanceEntryPriceMinor: bigint | null;
  referenceCurrency: number;
  entryPriceMinor: bigint;
  revealedBidCount: number;
  latestVenueBlockTimestamp: bigint;
  paymentTokenDecimals: number;
  paymentTokenSymbol: string;
}

export interface PortfolioReadRow extends PortfolioTokenRow {
  canonical: CanonicalSeriesSnapshot | null;
  canonicalLifecycle: IntexLifecycle | null;
  targetExpired: boolean;
  lifecycleDelivery: 'matched' | 'target-behind' | 'target-ahead' | 'canonical-unavailable';
}

export interface PortfolioRead {
  wallet: Address;
  rows: readonly PortfolioReadRow[];
  latestVenueBlockTimestamp: bigint;
  walletBalance: {
    nativeBalance: bigint;
    paymentTokenBalance: bigint;
    paymentTokenDecimals: number;
    paymentTokenSymbol: string;
    isOriginVenue: boolean;
  };
}

export interface CompletionOriginReader {
  readCanonicalSeries(seriesId: Hex): Promise<CanonicalSeriesSnapshot | null>;
}

const lifecycleRank: Readonly<Record<IntexLifecycle, number>> = {
  issued: 0,
  qualified: 1,
  called: 2,
};

const PAYMENT_TOKEN_SYMBOL_FALLBACK = 'wCOEN';

const lifecycleDelivery = (
  canonical: IntexLifecycle | null,
  target: IntexLifecycle,
): PortfolioReadRow['lifecycleDelivery'] => {
  if (!canonical) return 'canonical-unavailable';
  if (lifecycleRank[target] < lifecycleRank[canonical]) return 'target-behind';
  if (lifecycleRank[target] > lifecycleRank[canonical]) return 'target-ahead';
  return 'matched';
};

const candidateSeriesIds = (
  _result: TargetAuctionResult,
  _worldwideDay: WorldwideDayKey,
  targetSeriesIds: readonly Hex[],
): readonly Hex[] => {
  return targetSeriesIds;
};

export const loadAuctionCompletion = async (
  auction: PublicAuctionRead,
  origin: CompletionOriginReader,
  venue: Pick<
    CompletionVenueAdapter,
    | 'readSeriesIdsByWorldwideDay'
    | 'readLatestBlockTimestamp'
    | 'readTargetSeries'
    | 'readRecipientEvidence'
    | 'readBidderCompletion'
    | 'readBidderRevealedBid'
    | 'readPaymentToken'
  >,
  wallet: Address | null,
): Promise<AuctionCompletionRead> => {
  if (auction.venue.kind !== 'delivered') {
    return {
      worldwideDay: auction.worldwideDay,
      result: auction.venue.kind === 'not-applicable' ? 'no-auction' : 'awaiting-result',
      targetSeriesIds: [],
      series: [],
      bidderEconomics: null,
      bidderBidQuantity: null,
      bidderBidRate: null,
      clearingRate: 0n,
      promisLoadMinor: 0n,
      issuanceCurrency: 0,
      issuanceEntryPriceMinor: null,
      referenceCurrency: 0,
      entryPriceMinor: 0n,
      revealedBidCount: 0,
      latestVenueBlockTimestamp: 0n,
      paymentTokenDecimals: PAYMENT_TOKEN_DECIMALS,
      paymentTokenSymbol: PAYMENT_TOKEN_SYMBOL_FALLBACK,
    };
  }

  const venueAuction = auction.venue.auction;
  const issuanceIndex = venueAuction.params.issuanceCurrencies?.indexOf(venueAuction.params.issuanceCurrency) ?? -1;
  const issuanceEntryPriceMinor =
    issuanceIndex >= 0
      ? (venueAuction.params.issuanceEntryPrices?.[issuanceIndex] ?? null)
      : venueAuction.params.issuanceCurrency === venueAuction.params.referenceCurrency
        ? venueAuction.params.entryPriceMinor
        : null;
  const result = targetAuctionResult(venueAuction.stage, venueAuction.result.issuedIntexCount);
  const [targetSeriesIds, latestVenueBlockTimestamp, paymentToken] = await Promise.all([
    venue.readSeriesIdsByWorldwideDay(auction.worldwideDay),
    venue.readLatestBlockTimestamp(),
    venue.readPaymentToken(),
  ]);
  const candidates = candidateSeriesIds(result, auction.worldwideDay, targetSeriesIds);
  const targetSet = new Set(targetSeriesIds);

  const baseSeries = await Promise.all(
    candidates.map(async (seriesId) => {
      const [canonical, target, recipient] = await Promise.all([
        origin.readCanonicalSeries(seriesId),
        targetSet.has(seriesId) ? venue.readTargetSeries(seriesId) : Promise.resolve(null),
        wallet && targetSet.has(seriesId) ? venue.readRecipientEvidence(seriesId, wallet) : Promise.resolve(null),
      ]);
      if (target && target.worldwideDay !== Number(auction.worldwideDay)) {
        throw new TypeError(`Target series ${seriesId} belongs to WorldwideDay ${target.worldwideDay}.`);
      }
      return { seriesId, canonical, target, recipient };
    }),
  );

  const [bidder, bidderRevealedBid] = wallet
    ? await Promise.all([
        venue.readBidderCompletion(auction.worldwideDay, wallet),
        venue.readBidderRevealedBid(auction.worldwideDay, wallet),
      ])
    : [null, null];
  const combinedRecipient = baseSeries.reduce<RecipientSeriesEvidence | null>((combined, item) => {
    if (!item.recipient) return combined;
    if (!combined) return item.recipient;
    return {
      seriesId: combined.seriesId,
      issuanceInstructionsReceived:
        combined.issuanceInstructionsReceived && item.recipient.issuanceInstructionsReceived,
      deferred: combined.deferred || item.recipient.deferred,
      deliveredEvent: combined.deliveredEvent || item.recipient.deliveredEvent,
      wonCount: combined.wonCount + item.recipient.wonCount,
      currentIssuedBalance: combined.currentIssuedBalance + item.recipient.currentIssuedBalance,
      currentSettledBalance: combined.currentSettledBalance + item.recipient.currentSettledBalance,
    };
  }, null);

  let bidderEconomics: BidderEconomics | null = null;
  if (bidder) {
    const exact =
      bidder.exactRetriedRefund !== null && bidder.exactRetriedPaid !== null
        ? { exactRefundedAmount: bidder.exactRetriedRefund, exactPaidAmount: bidder.exactRetriedPaid }
        : {};
    const recovery = {
      ...(bidder.recoveredAmount !== null ? { recoveredAmount: bidder.recoveredAmount } : {}),
      ...(bidder.burnedAmount !== null ? { burnedAmount: bidder.burnedAmount } : {}),
    };
    if (combinedRecipient) {
      bidderEconomics = deriveBidderEconomics({
        lockedAmount: bidder.lock.lockedAmount,
        lockStatus: bidder.lock.status,
        wonCount: combinedRecipient.wonCount,
        promisLoadMinor: venueAuction.params.promisLoadMinor,
        clearingRate: venueAuction.result.auctionClearingRate,
        issuanceInstructionsReceived: combinedRecipient.issuanceInstructionsReceived,
        deliveryDeferred: combinedRecipient.deferred,
        deliveryObserved: combinedRecipient.deliveredEvent,
        ...exact,
        ...recovery,
      });
    } else if (result === 'no-sale') {
      bidderEconomics = deriveBidderEconomics({
        lockedAmount: bidder.lock.lockedAmount,
        lockStatus: bidder.lock.status,
        wonCount: 0n,
        promisLoadMinor: venueAuction.params.promisLoadMinor,
        clearingRate: venueAuction.result.auctionClearingRate,
        noSale: true,
        issuanceInstructionsReceived: false,
        deliveryDeferred: false,
        deliveryObserved: false,
        ...exact,
        ...recovery,
      });
    } else if (bidder.lock.status === 'none') {
      bidderEconomics = { kind: 'no-bid-lock' };
    } else if (bidder.lock.status === 'locked') {
      bidderEconomics = { kind: 'pending', lockedAmount: bidder.lock.lockedAmount };
    } else {
      bidderEconomics = {
        kind: 'unknown',
        lockedAmount: bidder.lock.lockedAmount,
        reason: 'Bidder finalization is complete, but target issuance evidence is not available.',
      };
    }
  }

  const provisioning = deriveSeriesProvisioning(result, targetSeriesIds.length);
  const series = baseSeries.map<CompletionSeriesRead>((item) => {
    const canonicalLifecycle = item.canonical ? decodeIntexLifecycle(item.canonical.state) : null;
    const targetExpired = item.target
      ? isTargetSeriesExpired({
          lifecycle: item.target.lifecycle,
          calledAt: item.target.calledAt,
          intexCallPeriod: item.target.intexCallPeriod,
          latestBlockTimestamp: latestVenueBlockTimestamp,
        })
      : false;
    const recipientDelivery = item.recipient
      ? deriveRecipientDelivery({
          result,
          seriesProvisioned: item.target !== null,
          issuanceInstructionsReceived: item.recipient.issuanceInstructionsReceived,
          deferred: item.recipient.deferred,
          deliveredEvent: item.recipient.deliveredEvent,
          wonCount: item.recipient.wonCount,
          bidderEconomics,
        })
      : null;
    return {
      ...item,
      canonicalLifecycle,
      targetExpired,
      provisioning: item.target ? 'provisioned' : provisioning,
      recipientDelivery,
    };
  });

  return {
    worldwideDay: auction.worldwideDay,
    result,
    targetSeriesIds,
    series,
    bidderEconomics,
    bidderBidQuantity: bidderRevealedBid?.quantity ?? null,
    bidderBidRate: bidderRevealedBid?.bidRate ?? null,
    clearingRate: venueAuction.result.auctionClearingRate,
    promisLoadMinor: venueAuction.params.promisLoadMinor,
    issuanceCurrency: venueAuction.params.issuanceCurrency,
    issuanceEntryPriceMinor,
    referenceCurrency: venueAuction.params.referenceCurrency,
    entryPriceMinor: venueAuction.params.entryPriceMinor,
    revealedBidCount: venueAuction.runningCounts.revealedBids,
    latestVenueBlockTimestamp,
    paymentTokenDecimals: paymentToken.decimals,
    paymentTokenSymbol: paymentToken.symbol,
  };
};

export const loadPortfolio = async (
  wallet: Address,
  origin: Pick<OutbeAuctionAdapter, 'readCanonicalSeries'>,
  venue: Pick<CompletionVenueAdapter, 'readPortfolio' | 'readLatestBlockTimestamp' | 'readWalletBalances'>,
  options: { originChainId: number; venueChainId: number },
): Promise<PortfolioRead> => {
  const [targetRows, latestVenueBlockTimestamp, balances] = await Promise.all([
    venue.readPortfolio(wallet),
    venue.readLatestBlockTimestamp(),
    venue.readWalletBalances(wallet),
  ]);
  const canonicalBySeries = new Map<Hex, CanonicalSeriesSnapshot | null>();
  await Promise.all(
    [...new Set(targetRows.map((row) => row.seriesId))].map(async (seriesId) => {
      canonicalBySeries.set(seriesId, await origin.readCanonicalSeries(seriesId));
    }),
  );
  const rows = targetRows.map<PortfolioReadRow>((row) => {
    const canonical = canonicalBySeries.get(row.seriesId) ?? null;
    const canonicalLifecycle = canonical ? decodeIntexLifecycle(canonical.state) : null;
    return {
      ...row,
      canonical,
      canonicalLifecycle,
      targetExpired: isTargetSeriesExpired({
        lifecycle: row.targetSeries.lifecycle,
        calledAt: row.targetSeries.calledAt,
        intexCallPeriod: row.targetSeries.intexCallPeriod,
        latestBlockTimestamp: latestVenueBlockTimestamp,
      }),
      lifecycleDelivery: lifecycleDelivery(canonicalLifecycle, row.targetSeries.lifecycle),
    };
  });
  return {
    wallet,
    rows,
    latestVenueBlockTimestamp,
    walletBalance: { ...balances, isOriginVenue: options.originChainId === options.venueChainId },
  };
};
