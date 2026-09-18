import type { ReactNode } from 'react';
import { Check, Download, LoaderCircle, ShieldCheck, Wallet, X, XCircle } from 'lucide-react';
import { calculateEscrowLockMinor } from '../../domain/escrow-lock';
import { getPreferredIssuanceCurrency } from '../../domain/issuance-currency-preference';
import { expectedIssuanceWindow, expectedSeriesLabel } from '../../domain/expected-issuance';
import { formatContractBidRatePercent } from '../../domain/commit-domain';
import {
  contractCurrencyTerms,
  preferredIssuanceCurrency,
  referenceEntryPrice,
} from '../../oracle/multi-currency-evidence';
import { strikeAmountRows, strikeCalculationCopy } from '../commit-view-model';
import type {
  BidderActionController,
  BidderActionEvidence,
  BidderActionProgress,
} from '../use-bidder-action-controller';
import type { CurrencyFormatters } from '../../oracle/currency-state';
import type { PublicAuctionRead } from '../../discovery/load-public-auction';
import type { ResolvedVenueReadProfile } from '../../runtime-config/load-reviewed-runtime-config';
import { currencyCode, formatPromisAmount, integer, intexUnit, scheduleTime } from '../../ui/display-format';
import { Button, Card, Icon } from '../../ui/primitives';
import { BidderReceipt, CommitBidDetails, CommitConversionRates, type BidderReceiptDetail } from './cards';
import { RevealStepAction, TransactionContracts, TransactionStep } from './transaction-steps';

type ReceiptEvidence = Extract<BidderActionEvidence, { kind: 'receipt' }>;

const shortHash = (value: string): string => `${value.slice(0, 10)}…${value.slice(-8)}`;
const formatHours = (seconds: number): string => {
  const hours = seconds / 3_600;
  if (Number.isInteger(hours)) return `${hours}h`;
  const minutes = Math.round((seconds % 3_600) / 60);
  return `${Math.floor(hours)}h ${minutes}m`;
};

const strikeCurrencyTip = (issuanceCurrency: string, referenceCurrency: string): string =>
  `The strike amount is stored in ${issuanceCurrency} (issuance currency). The ${referenceCurrency} equivalent is converted at the current Oracle rate and updates live.`;

const txStepStatus = (
  progress: BidderActionProgress | null,
  amount: (value: bigint) => string,
): { readonly approval: string | null; readonly action: string | null } => {
  if (!progress) return { approval: null, action: null };
  const value = progress.value;
  const op = progress.operation;
  switch (value.kind) {
    case 'requesting-signature':
      return { approval: null, action: null };
    case 'persisting-receipt':
      return { approval: null, action: 'Persisting and cryptographically revalidating reveal material.' };
    case 'approval-required':
      return { approval: null, action: null };
    case 'approval-submitted':
      return { approval: `Approval submitted: ${shortHash(value.transactionHash)}.`, action: null };
    case 'approval-confirming':
      return { approval: `Waiting for approval confirmation: ${shortHash(value.transactionHash)}.`, action: null };
    case 'ready-to-commit':
    case 'ready-to-reveal':
      return { approval: null, action: null };
    case 'commit-submitted':
    case 'reveal-submitted':
      return {
        approval: null,
        action: `${op === 'reveal' ? 'Reveal' : op === 'recommit' ? 'Recommit' : 'Commit'} submitted: ${shortHash(value.transactionHash)}.`,
      };
    case 'commit-confirming':
    case 'reveal-confirming':
      return {
        approval: null,
        action: `Waiting for ${op === 'reveal' ? 'reveal' : op === 'recommit' ? 'recommit' : 'commit'} confirmation: ${shortHash(value.transactionHash)}.`,
      };
    case 'cancel-submitted':
      return { approval: null, action: `Cancellation submitted: ${shortHash(value.transactionHash)}.` };
    case 'cancel-confirming':
      return { approval: null, action: `Waiting for cancellation confirmation: ${shortHash(value.transactionHash)}.` };
    case 'reconciling':
      return {
        approval: null,
        action: `Reconciling bidder-level ${op === 'reveal' ? 'reveal and escrow-lock' : op === 'cancellation' ? 'cancellation and bond' : 'commitment and bond'} state.`,
      };
    case 'confirmed':
      if ('returnedBondAmount' in value)
        return {
          approval: null,
          action: `Cancellation confirmed. ${amount(value.returnedBondAmount)} was returned atomically.`,
        };
      if ('lockedAmount' in value)
        return { approval: null, action: `Reveal confirmed. ${amount(value.lockedAmount)} is locked.` };
      return {
        approval: null,
        action: `${op === 'recommit' ? 'Recommit' : 'Commit'} confirmed. Receipt is stored in this browser.`,
      };
  }
};

const openReceiptTools = () => globalThis.dispatchEvent(new Event('itx-acn:open-receipts'));

export interface RevealReceiptCardProps {
  readonly evidence: ReceiptEvidence;
  readonly auction: PublicAuctionRead;
  readonly profile: ResolvedVenueReadProfile | null;
  readonly bidsFanInTimeoutSeconds?: number | null | undefined;
  readonly controller: BidderActionController;
  readonly currency: CurrencyFormatters;
  readonly paymentAmount: (value: bigint) => string;
  readonly transactionNotice: ReactNode;
  readonly expanded: boolean;
  readonly setExpanded: (value: boolean) => void;
}

export function RevealReceiptCard({
  evidence,
  auction,
  profile,
  bidsFanInTimeoutSeconds,
  controller,
  currency,
  paymentAmount,
  transactionNotice,
  expanded,
  setExpanded,
}: RevealReceiptCardProps) {
  const quantity = BigInt(evidence.receipt.quantity);
  const revealLock =
    evidence.receipt.revealLockMinor ??
    calculateEscrowLockMinor({
      quantity,
      promisLoadMinor: evidence.fresh.params.promisLoadMinor,
      bidRate: BigInt(evidence.receipt.contractBidRate),
    });
  const perIntexLock = calculateEscrowLockMinor({
    quantity: 1n,
    promisLoadMinor: evidence.fresh.params.promisLoadMinor,
    bidRate: BigInt(evidence.receipt.contractBidRate),
  });
  const issuanceCode =
    evidence.receipt.issuanceCurrency !== null &&
    evidence.fresh.params.issuanceCurrencies.includes(evidence.receipt.issuanceCurrency)
      ? evidence.receipt.issuanceCurrency
      : (preferredIssuanceCurrency(
          evidence.fresh.params.issuanceCurrencies,
          evidence.fresh.params.referenceCurrency,
          getPreferredIssuanceCurrency(),
        ) ?? evidence.fresh.params.referenceCurrency);
  const issuanceCurrency = currencyCode(issuanceCode);
  const referenceCode =
    evidence.receipt.referenceCurrency !== null &&
    (evidence.fresh.params.referenceCurrencies ?? []).includes(evidence.receipt.referenceCurrency)
      ? evidence.receipt.referenceCurrency
      : evidence.fresh.params.referenceCurrency;
  const referenceCurrency = currencyCode(referenceCode);
  const referenceEntryPriceMinor = referenceEntryPrice(
    evidence.fresh.params.referenceCurrencies,
    evidence.fresh.params.referenceEntryPrices,
    referenceCode,
    evidence.fresh.params.entryPriceMinor,
  );
  const issuanceTerms = contractCurrencyTerms({
    issuanceCurrencies: evidence.fresh.params.issuanceCurrencies,
    issuanceEntryPrices: evidence.fresh.params.issuanceEntryPrices,
    strikeAmountsMinor: evidence.fresh.params.strikeAmountsMinor,
    oraclePairIds: evidence.fresh.params.oraclePairIds,
    issuanceCurrency: issuanceCode,
    referenceCurrency: referenceCode,
    referenceEntryPriceMinor,
    promisLoadMinor: evidence.fresh.params.promisLoadMinor,
    conversions: currency.conversions,
  });
  const perIntexConversions = currency.formatCoenCurrencyLine(perIntexLock, [
    ...(issuanceTerms === null
      ? []
      : [{ isoCode: issuanceCode, contractFallback: issuanceTerms.issuanceEntryPriceMinor }]),
    { isoCode: referenceCode, contractFallback: referenceEntryPriceMinor },
  ]);
  const totalConversions = currency.formatCoenCurrencyLine(revealLock, [
    ...(issuanceTerms === null
      ? []
      : [{ isoCode: issuanceCode, contractFallback: issuanceTerms.issuanceEntryPriceMinor }]),
    { isoCode: referenceCode, contractFallback: referenceEntryPriceMinor },
  ]);
  const strikePerIntex = issuanceTerms?.strikeAmountMinor ?? null;
  const referenceStrikePerIntexMinor = issuanceTerms?.referenceStrikeAmountMinor ?? null;
  const strikeRow = strikeAmountRows({
    quantity,
    issuanceCurrency,
    referenceCurrency,
    strikePerIntex,
    referenceStrikePerIntexMinor,
  });
  const strikeCalculation = strikeCalculationCopy({
    strikePerIntex,
    issuanceEntryPriceMinor: issuanceTerms?.issuanceEntryPriceMinor ?? null,
    referenceEntryPriceMinor,
    promisLoadMinor: evidence.fresh.params.promisLoadMinor,
    issuanceCurrency,
    referenceCurrency,
  });
  const strikeTip =
    strikeCalculation === null
      ? undefined
      : ([
          { title: 'Currency', body: strikeCurrencyTip(issuanceCurrency, referenceCurrency) },
          {
            title: 'How it is calculated',
            body: `${strikeCalculation} The ${referenceCurrency} equivalent shown is a live conversion, not a stored value.`,
          },
        ] as const);
  const issuanceWindow =
    auction.venue.kind === 'delivered' && bidsFanInTimeoutSeconds !== null && bidsFanInTimeoutSeconds !== undefined
      ? expectedIssuanceWindow(
          auction.venue.auction.schedule.revealEnd,
          auction.venue.auction.schedule.issuanceEnd,
          bidsFanInTimeoutSeconds,
        )
      : null;
  const issuanceExternalityTip =
    issuanceWindow === null || bidsFanInTimeoutSeconds === null || bidsFanInTimeoutSeconds === undefined
      ? undefined
      : ([
          {
            title: 'Issuance window',
            body: `The origin series is created once global clearing runs, within ${formatHours(bidsFanInTimeoutSeconds)} after the reveal window closes. Delivery to this venue is expected during the issuance stage (closes ${scheduleTime(issuanceWindow.issuanceStageEnd)}) but is not time-guaranteed.`,
          },
        ] as const);
  const details: readonly BidderReceiptDetail[] = [
    {
      label: 'Quantity',
      value: `${integer(evidence.receipt.quantity)} ${intexUnit(evidence.receipt.quantity)}`,
      detail: `${formatPromisAmount(quantity * evidence.fresh.params.promisLoadMinor)} Promis`,
    },
    {
      label: 'Bid amount per Intex',
      value: paymentAmount(perIntexLock),
      detail: perIntexConversions === 'Conversion unavailable' ? undefined : perIntexConversions,
    },
    {
      label: 'Total bid amount',
      value: paymentAmount(revealLock),
      detail: `${totalConversions === 'Conversion unavailable' ? '' : `${totalConversions} · `}${evidence.phase === 'revealed' ? 'locked to escrow' : 'will be locked to escrow at reveal'}`,
    },
    { label: 'Strike amount', value: strikeRow.perIntexValue, detail: strikeRow.perIntexDetail, tip: strikeTip },
    { label: 'Total strike amount', value: strikeRow.totalValue, detail: strikeRow.totalDetail },
    {
      label: 'Intex series to be issued',
      value: expectedSeriesLabel(auction.worldwideDay, issuanceCode, referenceCode) ?? 'Assigned at issuance',
      tip: issuanceExternalityTip,
    },
  ];
  const receipt = (title: string, revealed = false) => (
    <BidderReceipt
      title={title}
      icon={revealed ? Check : ShieldCheck}
      primaryLabel="Bid rate"
      primaryValue={formatContractBidRatePercent(evidence.receipt.contractBidRate)}
      primaryDetail="of escrow basis"
      details={details}
    />
  );

  if (evidence.phase === 'reveal-ready') {
    if (!expanded)
      return (
        <Card
          key="receipt"
          className="action-card commit-panel commit-panel--receipt"
          aria-labelledby="reveal-prompt-title"
        >
          <h2 id="reveal-prompt-title">Reveal your bid</h2>
          {transactionNotice}
          {receipt('Sealed Bid Committed')}
          <Button
            className="action-card__button"
            disabled={controller.busy || evidence.reconciliationMessage !== null}
            onClick={() => setExpanded(true)}
          >
            <Icon icon={ShieldCheck} size={15} /> Reveal Bid
          </Button>
        </Card>
      );
    const revealProgressKind = controller.progress?.operation === 'reveal' ? controller.progress.value.kind : null;
    const revealStatus = txStepStatus(
      controller.progress?.operation === 'reveal' ? controller.progress : null,
      paymentAmount,
    );
    const approvalComplete =
      evidence.fresh.allowance >= revealLock ||
      revealProgressKind === 'ready-to-reveal' ||
      revealProgressKind === 'reveal-submitted' ||
      revealProgressKind === 'reveal-confirming' ||
      revealProgressKind === 'reconciling' ||
      revealProgressKind === 'confirmed';
    const revealSubmitted =
      revealProgressKind === 'reveal-submitted' ||
      revealProgressKind === 'reveal-confirming' ||
      revealProgressKind === 'reconciling' ||
      revealProgressKind === 'confirmed';
    const revealFrozenCross =
      issuanceTerms === null || evidence.fresh.params.entryPriceMinor <= 0n
        ? null
        : (issuanceTerms.issuanceEntryPriceMinor * 10n ** 18n) / evidence.fresh.params.entryPriceMinor;
    const revealConversionRows = [
      {
        pair: `Œ / ${issuanceCurrency}`,
        value: currency.formatCoenReferenceRate(
          issuanceCode,
          issuanceTerms?.issuanceEntryPriceMinor ?? null,
          evidence.fresh.paymentTokenSymbol,
        ),
      },
      {
        pair: `Œ / ${referenceCurrency}`,
        value: currency.formatCoenReferenceRate(
          evidence.fresh.params.referenceCurrency,
          evidence.fresh.params.entryPriceMinor,
          evidence.fresh.paymentTokenSymbol,
        ),
      },
      {
        pair: `${referenceCurrency} / ${issuanceCurrency}`,
        value: currency.formatCrossRate(evidence.fresh.params.referenceCurrency, issuanceCode, revealFrozenCross),
      },
    ] as const;
    return (
      <Card
        key="reveal-form"
        className="action-card commit-panel commit-panel--expanded"
        aria-labelledby="reveal-panel-title"
      >
        <div className="commit-panel__header">
          <h2 id="reveal-panel-title">Reveal &amp; Lock Funds</h2>
          <Button variant="ghost" size="icon" aria-label="Close reveal form" onClick={() => setExpanded(false)}>
            <Icon icon={X} size={17} />
          </Button>
        </div>
        {transactionNotice}
        <CommitBidDetails
          rows={[
            {
              label: 'Quantity',
              value: `${integer(evidence.receipt.quantity)} ${intexUnit(evidence.receipt.quantity)}`,
              detail: `${formatPromisAmount(quantity * evidence.fresh.params.promisLoadMinor)} Promis`,
            },
            {
              label: 'Bid rate',
              value: `${formatContractBidRatePercent(evidence.receipt.contractBidRate)} of escrow basis`,
            },
            {
              label: 'Bid amount per Intex',
              value: paymentAmount(perIntexLock),
              detail: perIntexConversions === 'Conversion unavailable' ? undefined : perIntexConversions,
            },
            {
              label: 'Total bid amount',
              value: paymentAmount(revealLock),
              detail: totalConversions === 'Conversion unavailable' ? undefined : totalConversions,
            },
          ]}
        />
        <CommitConversionRates rows={revealConversionRows} />
        <TransactionContracts profile={profile} />
        <div className="commit-panel__transaction-steps">
          <TransactionStep
            number={1}
            title="Approve escrow transfer"
            body={`Allow the escrow contract to lock ${paymentAmount(revealLock)}. This is an ERC-20 approval — no funds move in this step. Your ${paymentAmount(evidence.fresh.params.commitBondMinor)} commit bond is automatically returned when the reveal succeeds.`}
            state={approvalComplete ? 'complete' : 'active'}
            status={revealStatus.approval}
          >
            {!approvalComplete && (
              <Button
                className="commit-panel__step-action"
                disabled={controller.busy}
                onClick={() => {
                  void controller.revealBid();
                }}
              >
                <Icon icon={controller.busy ? LoaderCircle : Wallet} size={15} />
                {controller.busy ? 'Approving…' : 'Approve allowance'}
              </Button>
            )}
          </TransactionStep>
          <TransactionStep
            number={2}
            title="Reveal your sealed bid"
            body="Your bid is revealed on-chain via revealBid. Commit bond returned, escrow locked."
            state={approvalComplete ? 'active' : 'waiting'}
            status={revealStatus.action}
          >
            <RevealStepAction
              approvalComplete={approvalComplete}
              submitted={revealSubmitted}
              busy={controller.busy}
              failed={controller.failure !== null}
              onClick={() => {
                void controller.revealBid();
              }}
            />
          </TransactionStep>
        </div>
        {evidence.reconciliationMessage && (
          <p className="commit-panel__backup-warning" role="alert">
            {evidence.reconciliationMessage}
          </p>
        )}
      </Card>
    );
  }

  if (evidence.phase === 'revealed')
    return (
      <Card key="revealed" className="action-card commit-panel commit-panel--receipt" aria-labelledby="revealed-title">
        <h2 id="revealed-title">Bid revealed</h2>
        {transactionNotice}
        {receipt('Bid revealed & escrow locked', true)}
        {evidence.reconciliationMessage && (
          <p className="commit-panel__backup-warning" role="alert">
            {evidence.reconciliationMessage}
          </p>
        )}
        <div className="commit-panel__receipt-actions">
          <Button onClick={openReceiptTools}>
            <Icon icon={Download} size={15} /> View Receipt
          </Button>
        </div>
      </Card>
    );

  return (
    <Card
      key="committed"
      className="action-card commit-panel commit-panel--receipt"
      aria-labelledby="commit-receipt-title"
    >
      <h2 id="commit-receipt-title">Your sealed bid</h2>
      {transactionNotice}
      {receipt('Sealed Bid Committed')}
      {evidence.reconciliationMessage && (
        <p className="commit-panel__backup-warning" role="alert">
          {evidence.reconciliationMessage}
        </p>
      )}
      {evidence.receipt.backupStatus === 'failed' && (
        <p className="commit-panel__backup-warning" role="alert">
          The commitment remains confirmed, but the last receipt download attempt failed. You can try downloading the
          receipt again.
        </p>
      )}
      <div className="commit-panel__receipt-actions">
        <Button
          disabled={controller.busy || evidence.reconciliationMessage !== null}
          onClick={() => {
            void controller.cancelCommit();
          }}
        >
          <Icon icon={controller.busy ? LoaderCircle : XCircle} size={15} />
          {controller.busy ? 'Cancelling…' : 'Cancel Commit'}
        </Button>
        <Button onClick={openReceiptTools}>
          <Icon icon={Download} size={15} /> View Receipt
        </Button>
      </div>
    </Card>
  );
}
