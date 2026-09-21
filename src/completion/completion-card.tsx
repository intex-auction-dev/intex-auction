import { CheckCircle2, CircleX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, Card, Icon, Notice } from '../ui/primitives';
import {
  formatCompletionPromis as promis,
  formatPaymentTokenAmount,
  integer,
  intexUnitBig as intexUnit,
} from '../ui/display-format';
import type { AuctionCompletionRead, PortfolioRead } from './completion-loader';
import type { BidderEconomics } from '../domain/completion-domain';
import { formatContractBidRatePercent } from '../domain/commit-domain';
import { calculateEscrowLockMinor } from '../domain/escrow-lock';
import { expectedSeriesLabel } from '../domain/expected-issuance';
import { useCurrencyFormatters } from '../oracle/currency-state';
import '../discovery/bidder-receipt.css';
import './completion-card.css';

export type CompletionViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'loaded'; value: AuctionCompletionRead };

export type PortfolioViewState =
  | { kind: 'disconnected' }
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'loaded'; value: PortfolioRead };

const payment = formatPaymentTokenAmount;

const conversionSmall = (line: string | null): ReactNode | null =>
  line !== null && line !== 'Conversion unavailable' ? <small>{line}</small> : null;

function ResultReceipt({
  value,
  economics,
}: {
  value: AuctionCompletionRead;
  economics: Extract<BidderEconomics, { kind: 'finalized' }>;
}) {
  const [originalBidOpen, setOriginalBidOpen] = useState(false);
  const won = economics.wonCount > 0n;
  const currency = useCurrencyFormatters();
  const paidPerIntex = economics.wonCount > 0n ? economics.paidAmount / economics.wonCount : 0n;
  const coenBasis = value.paymentTokenDecimals === 18;
  const issuanceEntry =
    coenBasis && value.issuanceEntryPriceMinor !== null
      ? { isoCode: value.issuanceCurrency, contractFallback: value.issuanceEntryPriceMinor }
      : null;
  const referenceEntry = coenBasis
    ? { isoCode: value.referenceCurrency, contractFallback: value.entryPriceMinor }
    : null;
  const wonEntries =
    issuanceEntry && referenceEntry
      ? [issuanceEntry, referenceEntry]
      : issuanceEntry
        ? [issuanceEntry]
        : referenceEntry
          ? [referenceEntry]
          : [];
  const lostEntries = issuanceEntry ? [issuanceEntry] : [];
  const perIntexConversions = coenBasis ? currency.formatCoenCurrencyLine(paidPerIntex, wonEntries) : null;
  const totalConversions = coenBasis
    ? currency.formatCoenCurrencyLine(
        won ? economics.paidAmount : economics.refundedAmount,
        won ? wonEntries : lostEntries,
      )
    : null;
  const refundedConversions =
    coenBasis && won ? currency.formatCoenCurrencyLine(economics.refundedAmount, wonEntries) : null;
  const originalBid =
    value.bidderBidQuantity !== null && value.bidderBidRate !== null
      ? {
          quantity: value.bidderBidQuantity,
          rate: formatContractBidRatePercent(Number(value.bidderBidRate)),
          amountPerIntex: calculateEscrowLockMinor({
            quantity: 1n,
            promisLoadMinor: value.promisLoadMinor,
            bidRate: value.bidderBidRate,
          }),
        }
      : null;
  const originalBidPerIntexConversions =
    originalBid !== null && coenBasis ? currency.formatCoenCurrencyLine(originalBid.amountPerIntex, wonEntries) : null;
  const originalBidTotalConversions =
    originalBid !== null && coenBasis ? currency.formatCoenCurrencyLine(economics.lockedAmount, wonEntries) : null;
  const clearing = formatContractBidRatePercent(Number(value.clearingRate));
  const originalBidRate =
    value.bidderBidRate === null ? null : formatContractBidRatePercent(Number(value.bidderBidRate));
  const series = value.series[0]?.seriesId ?? value.targetSeriesIds[0] ?? null;
  const seriesLabel =
    series === null ? null : expectedSeriesLabel(value.worldwideDay, value.issuanceCurrency, value.referenceCurrency);
  return (
    <div className="bidder-receipt-stack">
      <div className={`bidder-receipt bidder-receipt--${won ? 'success' : 'neutral'}`}>
        {won && (
          <div className="bidder-receipt__glow" aria-hidden="true">
            <i />
            <i />
          </div>
        )}
        <div className="bidder-receipt__content">
          <div className="bidder-receipt__header">
            <span>
              <Icon icon={won ? CheckCircle2 : CircleX} size={13} />
            </span>
            <strong>{won ? 'Bid won' : 'Bid not selected'}</strong>
          </div>
          <div className="bidder-receipt__primary">
            <span>{won ? 'Clearing rate' : 'Your bid'}</span>
            <b>{won ? clearing : 'Not selected'}</b>
            <small>{won ? 'of strike' : 'Not selected at clearing'}</small>
          </div>
          {won && (
            <div className="bidder-receipt__secondary">
              <span>Promis rights</span>
              <b>{promis(economics.wonCount * value.promisLoadMinor)} Promis</b>
              <small>
                across {integer(economics.wonCount)} {intexUnit(economics.wonCount)}
              </small>
            </div>
          )}
          {!won && (
            <div className="bidder-receipt__secondary">
              <span>Clearing rate</span>
              <b>{clearing}</b>
              <small>of strike</small>
            </div>
          )}
          {!won && originalBidRate !== null && (
            <p className="bidder-receipt__original-bid-summary">
              You bid {originalBidRate} of strike · cleared at {clearing} of strike
            </p>
          )}
          <dl className="bidder-receipt__details">
            {won && (
              <div>
                <dt>Filled</dt>
                <dd>
                  {integer(economics.wonCount)} {intexUnit(economics.wonCount)}
                </dd>
              </div>
            )}
            {won && (
              <div>
                <dt>Paid per Intex</dt>
                <dd>
                  {payment(paidPerIntex, value.paymentTokenDecimals, value.paymentTokenSymbol)}
                  {conversionSmall(perIntexConversions)}
                </dd>
              </div>
            )}
            {won && (
              <div>
                <dt>Refunded</dt>
                <dd>
                  {payment(economics.refundedAmount, value.paymentTokenDecimals, value.paymentTokenSymbol)}
                  {conversionSmall(refundedConversions)}
                </dd>
              </div>
            )}
            <div>
              <dt>{won ? 'Net paid' : 'Bid amount refunded'}</dt>
              <dd>
                {payment(
                  won ? economics.paidAmount : economics.refundedAmount,
                  value.paymentTokenDecimals,
                  value.paymentTokenSymbol,
                )}
                {conversionSmall(totalConversions)}
              </dd>
            </div>
            {seriesLabel !== null && (
              <div>
                <dt>Intex series</dt>
                <dd>{seriesLabel}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
      {won && originalBid !== null && (
        <div className="bidder-receipt__original-bid">
          <Button
            variant="ghost"
            className="bidder-receipt__original-bid-toggle"
            aria-expanded={originalBidOpen}
            onClick={() => setOriginalBidOpen((open) => !open)}
          >
            <strong>Your Original Bid</strong>
            <Icon icon={ChevronDown} size={16} />
          </Button>
          <div
            className={`bidder-receipt__original-bid-content${originalBidOpen ? ' bidder-receipt__original-bid-content--open' : ''}`}
            aria-hidden={!originalBidOpen}
          >
            <div className="bidder-receipt__original-bid-details-wrap">
              <dl className="bidder-receipt__original-bid-details">
                <div>
                  <dt>Quantity</dt>
                  <dd>
                    {integer(originalBid.quantity)} {intexUnit(originalBid.quantity)}
                    <small>{promis(originalBid.quantity * value.promisLoadMinor)} Promis</small>
                  </dd>
                </div>
                <div>
                  <dt>Bid rate</dt>
                  <dd>
                    {originalBid.rate}
                    <small>of strike</small>
                  </dd>
                </div>
                <div>
                  <dt>Bid amount per Intex</dt>
                  <dd>
                    {payment(originalBid.amountPerIntex, value.paymentTokenDecimals, value.paymentTokenSymbol)}
                    {conversionSmall(originalBidPerIntexConversions)}
                  </dd>
                </div>
                <div>
                  <dt>Total bid amount</dt>
                  <dd>
                    {payment(economics.lockedAmount, value.paymentTokenDecimals, value.paymentTokenSymbol)}
                    {conversionSmall(originalBidTotalConversions)}
                    <small>locked to escrow</small>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function AuctionCompletionCard({
  state,
  venueSkipped = false,
  originName = 'Outbe',
  venueName = 'the venue',
}: {
  state: CompletionViewState;
  venueSkipped?: boolean;
  originName?: string;
  venueName?: string;
}) {
  if (state.kind === 'loading')
    return (
      <Card key="loading" className="completion-card completion-card--result">
        <h2>Your result</h2>
        <p className="completion-empty">Loading auction result…</p>
      </Card>
    );
  if (state.kind === 'unavailable')
    return (
      <Card key="unavailable" className="completion-card completion-card--result">
        <h2>Your result</h2>
        <p className="completion-empty" role="alert">
          {state.message}
        </p>
      </Card>
    );
  const value = state.value;

  if (venueSkipped) {
    return (
      <Card key="skipped" className="completion-card completion-card--result">
        <h2>Your result</h2>
        <Notice tone="neutral">
          This venue was excluded from global clearing. No auction result was applied on this venue.
        </Notice>
      </Card>
    );
  }
  if (value.result === 'cancelled' || value.result === 'no-auction') return null;
  if (value.result === 'awaiting-result') {
    return (
      <Card key="awaiting" className="completion-card completion-card--result">
        <h2>Your result</h2>
        <Notice tone="neutral">The auction result is not available yet.</Notice>
      </Card>
    );
  }
  if (value.result === 'no-sale') {
    const noBids = value.revealedBidCount === 0;
    return (
      <Card key="no-sale" className="completion-card completion-card--result" aria-labelledby="completion-title">
        <h2 id="completion-title">Your result</h2>
        <Notice tone={noBids ? 'danger' : 'warning'}>
          {noBids ? (
            <>
              <strong>No-bid cancellation.</strong> Reveal closed with an empty final BIDS_BATCH, so the series is
              cancelled without issuance.
            </>
          ) : (
            <>
              <strong>Auction Cancelled.</strong> {originName} found no qualifying demand above the minimum bid rate, so{' '}
              {venueName} records a cancelled result.
            </>
          )}
        </Notice>
      </Card>
    );
  }

  const economics = value.bidderEconomics;
  if (economics === null || economics.kind === 'no-bid-lock') {
    return (
      <Card key="no-bid" className="completion-card completion-card--result" aria-labelledby="completion-title">
        <h2 id="completion-title">Your result</h2>
        <Notice tone="neutral">
          Series cleared at {formatContractBidRatePercent(Number(value.clearingRate))}. You had no revealed bid in this
          series.
        </Notice>
      </Card>
    );
  }
  if (economics.kind !== 'finalized') {
    return (
      <Card key="reconciling" className="completion-card completion-card--result" aria-labelledby="completion-title">
        <h2 id="completion-title">Your result</h2>
        <Notice tone="warning">
          Your bidder result is still reconciling from the venue. No final allocation is shown until the contract-backed
          evidence is complete.
        </Notice>
      </Card>
    );
  }
  return (
    <Card key="finalized" className="completion-card completion-card--result" aria-labelledby="completion-title">
      <h2 id="completion-title">Your result</h2>
      <ResultReceipt value={value} economics={economics} />
    </Card>
  );
}

export function PortfolioCard({ state, chainName }: { state: PortfolioViewState; chainName: string }) {
  const rows = state.kind === 'loaded' ? state.value.rows : [];
  const seriesCount = new Set(rows.map((row) => row.seriesId)).size;
  const totalBalance = rows.reduce((sum, row) => sum + row.balance, 0n);
  const totalPromis = rows.reduce((sum, row) => sum + row.balance * row.targetSeries.promisLoadMinor, 0n);

  return (
    <Card className="portfolio-card" id="portfolio" aria-labelledby="portfolio-title">
      <div className="portfolio-card__summary">
        <strong id="portfolio-title">Portfolio</strong>
      </div>
      {state.kind === 'disconnected' && (
        <p className="portfolio-card__state">Connect your wallet to view your intex holdings.</p>
      )}
      {state.kind === 'loading' && <p className="portfolio-card__state">Loading your intex holdings…</p>}
      {state.kind === 'unavailable' && <p className="portfolio-card__state">{state.message}</p>}
      {state.kind === 'loaded' && (
        <>
          <div className="portfolio-asset-row">
            <span className="portfolio-token-icon" aria-hidden="true">
              Œ
            </span>
            <div className="portfolio-row__body">
              <strong>{state.value.walletBalance.paymentTokenSymbol}</strong>
              <span>Spendable balance</span>
            </div>
            <div className="portfolio-row__end">
              <strong>
                {payment(
                  state.value.walletBalance.paymentTokenBalance,
                  state.value.walletBalance.paymentTokenDecimals,
                  state.value.walletBalance.paymentTokenSymbol,
                )}
              </strong>
              <span>{chainName}</span>
            </div>
          </div>
          <div className="portfolio-asset-row">
            <span className="portfolio-token-icon" aria-hidden="true">
              I
            </span>
            <div className="portfolio-row__body">
              <strong>Intex</strong>
              <span>across {seriesCount} series</span>
            </div>
            <div className="portfolio-row__end">
              <strong>
                {integer(totalBalance)} {intexUnit(totalBalance)}
              </strong>
              <span>{promis(totalPromis)} Promis rights</span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

export function PortfolioPage({ state, chainName }: { state: PortfolioViewState; chainName: string }) {
  return (
    <div className="portfolio-page">
      <header className="portfolio-page__header">
        <span className="auction-page-heading__title">Portfolio</span>
      </header>
      <PortfolioCard state={state} chainName={chainName} />
    </div>
  );
}
