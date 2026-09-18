import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { AuctionCompletionCard, PortfolioCard, PortfolioPage } from '@/completion/completion-card';
import type { AuctionCompletionRead, PortfolioRead } from '@/completion/completion-loader';
import { parseWorldwideDayKey, toDurationSeconds, toUtcTimestamp } from '@/domain/protocol-time';

const parsed = parseWorldwideDayKey('20260804');
if (!parsed.ok) throw new Error('Invalid test WorldwideDay.');
const worldwideDay = parsed.value;
const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const sid = (value: number): Hex => `0x${value.toString(16).padStart(28, '0')}`;

const noSale: AuctionCompletionRead = {
  worldwideDay,
  result: 'no-sale',
  targetSeriesIds: [],
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
  clearingRate: 0n,
  promisLoadMinor: 1_000_000n,
  issuanceCurrency: 840,
  referenceCurrency: 840,
  issuanceEntryPriceMinor: 1n,
  entryPriceMinor: 1n,
  revealedBidCount: 1,
  latestVenueBlockTimestamp: 100n,
  paymentTokenDecimals: 18,
  paymentTokenSymbol: 'wCOEN',
  bidderBidRate: 700_000n,
  bidderBidQuantity: 2n,
};

const portfolio: PortfolioRead = {
  wallet,
  latestVenueBlockTimestamp: 121n,
  walletBalance: {
    nativeBalance: 1_000_000_000_000_000_000n,
    paymentTokenBalance: 500_000_000_000_000_000n,
    paymentTokenDecimals: 18,
    paymentTokenSymbol: 'wCOEN',
    isOriginVenue: false,
  },
  rows: [
    {
      seriesId: sid(7),
      tokenId: 1007n,
      tokenStatus: 'settled',
      balance: 3n,
      targetSeries: {
        seriesId: sid(7),
        worldwideDay: Number(worldwideDay),
        lifecycle: 'issued',
        issuedAt: 10n,
        calledAt: 0n,
        intexCallPeriod: 20n,
        issuedTokenId: 7n,
        settledTokenId: 1007n,
        issuedIntexCount: 5,
        promisLoadMinor: 1_000n,
        entryPriceMinor: 1_000n,
        floorPriceMinor: 900n,
        callPriceMinor: 1_200n,
      },
      canonical: {
        seriesId: sid(7),
        promisLoadMinor: 1_000n,
        entryPriceMinor: 1_000n,
        floorPriceMinor: 900n,
        issuedIntexCount: 5,
        callWindowDays: 30,
        callThresholdDays: 21,
        callPriceMinor: 1_200n,
        state: 1,
        issuedAt: toUtcTimestamp(10n),
        calledAt: toUtcTimestamp(0n),
        intexCallPeriod: toDurationSeconds(20n),
        issuanceCurrency: 840,
        referenceCurrency: 840,
      },
      canonicalLifecycle: 'qualified',
      targetExpired: false,
      lifecycleDelivery: 'target-behind',
    },
  ],
};

describe('Phase 10 completion rendering', () => {
  it('renders no-sale and no-bid cancellation copy from contract-backed counts', () => {
    const html = renderToStaticMarkup(
      <AuctionCompletionCard state={{ kind: 'loaded', value: noSale }} originName="Outbe" venueName="BNB" />,
    );
    expect(html).toContain('Auction Cancelled.');
    expect(html).toContain(
      'Outbe found no qualifying demand above the minimum bid rate, so BNB records a cancelled result.',
    );
    expect(html).not.toContain('all escrowed funds refunded');
    expect(html).not.toContain('Target series pending');

    const noBidsHtml = renderToStaticMarkup(
      <AuctionCompletionCard state={{ kind: 'loaded', value: { ...noSale, revealedBidCount: 0 } }} />,
    );
    expect(noBidsHtml).toContain('No-bid cancellation.');
    expect(noBidsHtml).toContain('Reveal closed with an empty final BIDS_BATCH');
    expect(noBidsHtml).not.toContain('cancelled before clearing');
  });

  it('renders winner, loser, and observer result hierarchy', () => {
    const sale = {
      ...noSale,
      result: 'sale' as const,
      clearingRate: 500_000n,
      revealedBidCount: 2,
      targetSeriesIds: [sid(7)],
    };
    const winner = {
      ...sale,
      bidderEconomics: {
        kind: 'finalized' as const,
        lockedAmount: 1_000n,
        paidAmount: 800n,
        refundedAmount: 200n,
        burnedAmount: 0n,
        wonCount: 2n,
        source: 'normal-finalization' as const,
      },
    };
    const winnerHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: winner }} />);
    expect(winnerHtml).toContain('Bid won');
    expect(winnerHtml).toContain('Clearing rate');
    expect(winnerHtml).toContain('Promis rights');
    expect(winnerHtml).toContain('of escrow basis');
    expect(winnerHtml).toContain('Total bid amount');
    expect(winnerHtml).toContain('Refunded');
    expect(winnerHtml).toContain('Net paid');
    expect(winnerHtml).not.toContain('Total paid');
    const [resolvedBidHtml, originalBidHtml] = winnerHtml.split('<div class="bidder-receipt__original-bid"');
    expect(resolvedBidHtml).toContain('Clearing rate');
    expect(resolvedBidHtml).not.toContain('70%');
    expect(resolvedBidHtml).not.toContain('Total bid amount');
    expect(winnerHtml).toContain('bidder-receipt__original-bid-toggle');
    expect(winnerHtml).toContain('aria-expanded="false"');
    expect(winnerHtml).toContain('class="bidder-receipt__original-bid-content"');
    expect(winnerHtml).toContain('class="bidder-receipt__original-bid-details-wrap"');
    expect(originalBidHtml).toContain('Your Original Bid');
    expect(originalBidHtml).toContain('Quantity');
    expect(originalBidHtml).toContain('2 Intexes');
    expect(originalBidHtml).toContain('2 Promis');
    expect(originalBidHtml).toContain('Bid rate');
    expect(originalBidHtml).toContain('70%');
    expect(originalBidHtml).toContain('Bid amount per Intex');
    expect(originalBidHtml).toContain('Total bid amount');
    expect(originalBidHtml).toContain('locked to escrow');

    const winnerNoOriginalBid = { ...winner, bidderBidRate: null, bidderBidQuantity: null };
    const winnerNoOriginalBidHtml = renderToStaticMarkup(
      <AuctionCompletionCard state={{ kind: 'loaded', value: winnerNoOriginalBid }} />,
    );
    expect(winnerNoOriginalBidHtml).not.toContain('Your Original Bid');

    const paidAmounts = {
      ...sale,
      bidderEconomics: {
        kind: 'finalized' as const,
        lockedAmount: 50_000_000_000_000_000_000_000n,
        paidAmount: 50_000_000_000_000_000_000_000n,
        refundedAmount: 0n,
        burnedAmount: 0n,
        wonCount: 10n,
        source: 'normal-finalization' as const,
      },
    };
    const paidHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: paidAmounts }} />);
    expect(paidHtml).toContain('Paid per Intex');
    expect(paidHtml).toContain('>Œ5,000<');
    expect(paidHtml).toContain('Total bid amount');
    expect(paidHtml).toContain('Net paid');
    expect(paidHtml).toContain('>Œ50,000<');

    const usdc = {
      ...paidAmounts,
      paymentTokenDecimals: 6,
      paymentTokenSymbol: 'USDC',
    };
    const usdcHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: usdc }} />);
    expect(usdcHtml).toContain('>50,000,000,000,000,000 USDC<');
    expect(usdcHtml).toContain('>5,000,000,000,000,000 USDC<');
    expect(usdcHtml).not.toContain('Œ');

    const loser = {
      ...sale,
      bidderEconomics: {
        kind: 'finalized' as const,
        lockedAmount: 800n,
        paidAmount: 0n,
        refundedAmount: 800n,
        burnedAmount: 0n,
        wonCount: 0n,
        source: 'normal-finalization' as const,
      },
    };
    const loserHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: loser }} />);
    expect(loserHtml).toContain('Bid not selected');
    expect(loserHtml).toContain('Bid amount refunded');
    expect(loserHtml).toContain('of escrow basis');
    expect(loserHtml).toContain('You bid 70% of escrow basis · cleared at 50% of escrow basis');
    expect(loserHtml).toContain('Intex series');
    expect(loserHtml).toContain('2026-08-04-USD-U');
    expect(loserHtml).not.toContain('0x0000000000000000000000000007');

    const loserNoRateHtml = renderToStaticMarkup(
      <AuctionCompletionCard state={{ kind: 'loaded', value: { ...loser, bidderBidRate: null } }} />,
    );
    expect(loserNoRateHtml).toContain('Bid not selected');
    expect(loserNoRateHtml).not.toContain('You bid');

    const observerHtml = renderToStaticMarkup(
      <AuctionCompletionCard
        state={{ kind: 'loaded', value: { ...sale, bidderEconomics: { kind: 'no-bid-lock' } } }}
      />,
    );
    expect(observerHtml).toContain('You had no revealed bid in this series.');
  });

  it('adds currency conversion subtitles to the final outcome details rows', () => {
    const value = {
      ...noSale,
      result: 'sale' as const,
      clearingRate: 500_000n,
      targetSeriesIds: [sid(7)],
      issuanceCurrency: 949,
      referenceCurrency: 840,
      issuanceEntryPriceMinor: 34_000_000n,
      entryPriceMinor: 1_000_000n,
      bidderEconomics: {
        kind: 'finalized' as const,
        lockedAmount: 5_000_000_000_000_000_000_000n,
        paidAmount: 5_000_000_000_000_000_000_000n,
        refundedAmount: 0n,
        burnedAmount: 0n,
        wonCount: 1n,
        source: 'normal-finalization' as const,
      },
    };
    const html = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value }} />);
    expect(html).toContain('Bid won');
    expect(html).toContain('Paid per Intex');
    expect(html).toContain('>170,000.00 TRY · 5,000.00 USD<');
    expect(html).toContain('Net paid');
    expect(html).toContain('>170,000.00 TRY · 5,000.00 USD<');

    const loser = {
      ...value,
      bidderEconomics: {
        kind: 'finalized' as const,
        lockedAmount: 5_000_000_000_000_000_000_000n,
        paidAmount: 0n,
        refundedAmount: 5_000_000_000_000_000_000_000n,
        burnedAmount: 0n,
        wonCount: 0n,
        source: 'normal-finalization' as const,
      },
    };
    const loserHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: loser }} />);
    expect(loserHtml).toContain('Bid amount refunded');
    expect(loserHtml).toContain('>170,000.00 TRY<');
  });

  it('renders retried recovery economics with zero paid and no burn copy', () => {
    const retriedWinner = {
      ...noSale,
      result: 'sale' as const,
      clearingRate: 500_000n,
      revealedBidCount: 2,
      targetSeriesIds: [sid(7)],
      bidderEconomics: {
        kind: 'finalized' as const,
        lockedAmount: 1_000_000_000_000_000_000_000n,
        paidAmount: 0n,
        refundedAmount: 200_000_000_000_000_000_000n,
        burnedAmount: 800_000_000_000_000_000_000n,
        wonCount: 2n,
        source: 'recovery' as const,
      },
    };
    const winnerHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: retriedWinner }} />);
    expect(winnerHtml).toContain('Bid won');
    expect(winnerHtml).toContain('Paid per Intex');
    expect(winnerHtml).toContain('Total bid amount');
    expect(winnerHtml).toContain('Net paid');
    expect(winnerHtml).toContain('>Œ1,000<');
    expect(winnerHtml).toContain('>Œ0<');
    expect(winnerHtml).toContain('>Œ200<');
    expect(winnerHtml).not.toContain('Burned');

    const retriedLoser = {
      ...noSale,
      result: 'sale' as const,
      clearingRate: 500_000n,
      revealedBidCount: 2,
      targetSeriesIds: [sid(7)],
      bidderEconomics: {
        kind: 'finalized' as const,
        lockedAmount: 800n,
        paidAmount: 0n,
        refundedAmount: 800n,
        burnedAmount: 0n,
        wonCount: 0n,
        source: 'recovery' as const,
      },
    };
    const loserHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: retriedLoser }} />);
    expect(loserHtml).toContain('Bid not selected');
    expect(loserHtml).toContain('Bid amount refunded');
    expect(loserHtml).toContain('of escrow basis');
  });

  it('suppresses the ordinary action widget for cancelled series and keeps skipped venues explicit', () => {
    const cancelled = { ...noSale, result: 'cancelled' as const };
    const cancelledHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: cancelled }} />);
    expect(cancelledHtml).toBe('');

    const noAuction = { ...noSale, result: 'no-auction' as const };
    const noAuctionHtml = renderToStaticMarkup(<AuctionCompletionCard state={{ kind: 'loaded', value: noAuction }} />);
    expect(noAuctionHtml).toBe('');

    const skippedHtml = renderToStaticMarkup(
      <AuctionCompletionCard state={{ kind: 'loaded', value: noSale }} venueSkipped />,
    );
    expect(skippedHtml).toContain('excluded from global clearing');
    expect(skippedHtml).toContain('No auction result was applied on this venue.');
    expect(skippedHtml).not.toContain('No qualifying demand');
  });

  it('renders only current balances and drops the through-issuance lifecycle widget', () => {
    const html = renderToStaticMarkup(
      <PortfolioCard state={{ kind: 'loaded', value: portfolio }} chainName="Local venue" />,
    );
    expect(html).toContain('>Portfolio<');
    expect(html).toContain('wCOEN');
    expect(html).toContain('Spendable balance');
    expect(html).toContain('across 1 series');
    expect(html).toContain('3 Intexes');
    expect(html).toContain('Promis rights');
    expect(html).toContain('Local venue');
    expect(html).not.toContain('portfolio-series-list');
    expect(html).not.toContain('portfolio-series-row');
    expect(html).not.toContain('portfolio-called-row');
    expect(html).not.toContain('2026-08-04 · USD');
    expect(html).not.toContain('Settled');
    expect(html).not.toContain('Qualified origin · Issued venue');
    expect(html).not.toContain('Call deadline');
    expect(html).not.toContain('Update pending');
    expect(html).not.toContain('>Called<');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('Current balances');

    const emptyHtml = renderToStaticMarkup(
      <PortfolioCard state={{ kind: 'loaded', value: { ...portfolio, rows: [] } }} chainName="Local venue" />,
    );
    expect(emptyHtml).toContain('0 Intexes');
  });

  it('keeps the balance-only portfolio free of called-series lifecycle even when a series is called', () => {
    const row = portfolio.rows[0]!;
    const html = renderToStaticMarkup(
      <PortfolioCard
        state={{
          kind: 'loaded',
          value: {
            ...portfolio,
            rows: [
              {
                ...row,
                tokenId: 7n,
                tokenStatus: 'issued',
                targetSeries: { ...row.targetSeries, lifecycle: 'called', calledAt: 100n },
                canonicalLifecycle: 'called',
                lifecycleDelivery: 'matched',
              },
            ],
          },
        }}
        chainName="Local venue"
      />,
    );
    expect(html).toContain('3 Intexes');
    expect(html).not.toContain('portfolio-called-row');
    expect(html).not.toContain('>Called<');
    expect(html).not.toContain('Call deadline');
    expect(html).not.toContain('Called origin · Called venue');
  });

  it('renders the portfolio page header and content sections', () => {
    const html = renderToStaticMarkup(<PortfolioPage state={{ kind: 'disconnected' }} chainName="Local venue" />);
    expect(html).toContain('>Portfolio<');
    expect(html).toContain('Connect your wallet to view your intex holdings.');
    expect(html).not.toContain('Your Intex Series');
  });

  it('uses conservative copy for unavailable evidence', () => {
    const html = renderToStaticMarkup(
      <AuctionCompletionCard state={{ kind: 'unavailable', message: 'RPC read failed.' }} />,
    );
    expect(html).toContain('Your result');
    expect(html).toContain('RPC read failed.');
  });
});
