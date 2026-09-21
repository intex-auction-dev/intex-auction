import { useEffect, useState } from 'react';
import { AlertTriangle, FileSignature, LoaderCircle, Upload, X } from 'lucide-react';
import { formatUnits, type PublicClient } from 'viem';
import type { CalendarWorldwideDay } from '../discovery/calendar-evidence';
import {
  effectiveMinimumBidQuantity,
  effectiveMinimumBidRate,
  formatContractBidRatePercent,
  parseBidRatePercent,
  paymentAmountToBidRatePercent,
} from '../domain/commit-domain';
import { calculateEscrowLockMinor, maxQuantityForEscrowLock, BID_RATE_SCALE, UINT16_MAX } from '../domain/escrow-lock';
import type { PublicAuctionRead } from '../discovery/load-public-auction';
import { useBidderActionController, type BidderActionProgress } from './use-bidder-action-controller';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import type { WalletState } from '../wallet/wallet-state';
import { getPreferredIssuanceCurrency } from '../domain/issuance-currency-preference';
import {
  contractCurrencyTerms,
  preferredIssuanceCurrency,
  referenceEntryPrice,
} from '../oracle/multi-currency-evidence';
import { strikeAmountRows } from './commit-view-model';
import type { OracleConversions } from '../oracle/oracle-conversions';
import { useCurrencyFormatters } from '../oracle/currency-state';
import {
  currencyCode,
  formatCurrencyMinor18,
  formatOracleRate18,
  formatPaymentTokenAmount,
  formatPriceMinor9,
  formatPromisAmount,
  integer,
  intexUnit,
} from '../ui/display-format';
import { Button, Card, Icon, Notice } from '../ui/primitives';
import { CommitBidDetails, CommitConversionRates } from './commit-panel/cards';
import { CommitStepper, IssuanceCurrencyField, ReferenceCurrencyField, steppedValue } from './commit-panel/fields';
import { RevealReceiptCard } from './commit-panel/reveal-receipt-card';
import { TransactionContracts, TransactionStep } from './commit-panel/transaction-steps';
import '../discovery/bidder-receipt.css';
import './commit-panel.css';

export { formatPaymentTokenAmount, formatPromisAmount } from '../ui/display-format';
export { BidderReceipt, CommitBidDetails, CommitConversionRates } from './commit-panel/cards';
export {
  currencyPickerItems,
  CommitStepper,
  IssuanceCurrencyField,
  ReferenceCurrencyField,
} from './commit-panel/fields';
export { RevealStepAction, TransactionContracts } from './commit-panel/transaction-steps';

interface CommitPanelProps {
  readonly auction: PublicAuctionRead;
  readonly calendarDay: CalendarWorldwideDay | null;
  readonly walletState: WalletState;
  readonly profile: ResolvedVenueReadProfile | null;
  readonly publicClient: PublicClient | null;
  readonly contextToken: string;
  readonly isContextCurrent: (token: string) => boolean;
  readonly bidsFanInTimeoutSeconds?: number | null;
}

const displayPaymentTokenSymbol = (symbol: string): string => (symbol.toLowerCase() === 'wcoen' ? 'Œ' : symbol);

export const formatFixedRate18 = (value: bigint): string => {
  return formatCurrencyMinor18(value);
};

const shortHash = (value: string): string => `${value.slice(0, 10)}…${value.slice(-8)}`;

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

export function BidderTransactionNotice({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <Notice tone="warning" live="polite">
      <strong>Transaction status unresolved.</strong> {message}
    </Notice>
  );
}

const openReceiptTools = () => globalThis.dispatchEvent(new Event('itx-acn:open-receipts'));
const openWalletControls = () => globalThis.dispatchEvent(new Event('itx-acn:open-wallet'));

export const liveEntryPriceCopy = (input: {
  readonly referenceCurrency: number;
  readonly contractEntryPriceMinor: bigint;
  readonly liveOracleConversions: OracleConversions | null | undefined;
  readonly paymentTokenSymbol: string;
  readonly paymentTokenDecimals?: number;
}): string => {
  const live = input.liveOracleConversions?.byIsoCode.get(input.referenceCurrency);
  const displaySymbol = displayPaymentTokenSymbol(input.paymentTokenSymbol);
  const amount =
    live?.kind === 'available' ? formatOracleRate18(live.rate) : formatPriceMinor9(input.contractEntryPriceMinor);
  return `1 ${displaySymbol} ≈ ${amount} ${currencyCode(input.referenceCurrency)}`;
};

const strikeCurrencyTip = (issuanceCurrency: string, referenceCurrency: string): string =>
  `The strike amount is stored in ${issuanceCurrency} (issuance currency). The ${referenceCurrency} equivalent is converted at the current Oracle rate and updates live.`;

export const commitFormCopy = {
  quantityHint: (minimum: number) => `Min – ${integer(minimum)} ${intexUnit(minimum)}.`,
  // Terminology rule 3 permits "strike" on the primary auction UI only. The contract denominator is
  // the escrow basis (`promisLoadMinor`, IntexAuction.sol:403); the receipt, ladder and completion
  // surfaces keep the contract-accurate wording.
  bidRateHint: (minimum: number) => `Percent of strike. Min – ${formatContractBidRatePercent(minimum)}.`,
  bidRate: (rate: number) => `${formatContractBidRatePercent(rate)} of strike`,
  bond: (amount: string) => `Committing locks a refundable ${amount} bond.`,
} as const;

function CommitPrompt({
  busy = false,
  label = 'Commit Sealed Bid',
  onClick,
}: {
  readonly busy?: boolean;
  readonly label?: string;
  readonly onClick?: () => void;
}) {
  return (
    <Card className="action-card commit-panel commit-panel--prompt" aria-labelledby="commit-prompt-title">
      <h2 id="commit-prompt-title">Place your bid</h2>
      <Button className="action-card__button" disabled={busy} onClick={onClick}>
        <Icon icon={busy ? LoaderCircle : FileSignature} size={15} />
        {label}
      </Button>
    </Card>
  );
}

export function CommitPanel(props: CommitPanelProps) {
  const controller = useBidderActionController(props);
  const { evidence } = controller;
  const currency = useCurrencyFormatters();
  const paymentAmount = (value: bigint): string =>
    'fresh' in evidence
      ? formatPaymentTokenAmount(value, evidence.fresh.paymentTokenDecimals, evidence.fresh.paymentTokenSymbol)
      : `Œ${integer(value)}`;
  const transactionNotice = <BidderTransactionNotice message={controller.transactionNotice} />;
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const preparingFresh = evidence.kind === 'available' || evidence.kind === 'receipt' ? evidence.fresh : null;
  const allowedCurrencies = preparingFresh?.params.issuanceCurrencies ?? [];

  useEffect(() => {
    setExpanded(false);
    setConfirming(false);
  }, [props.contextToken]);

  useEffect(() => {
    if (evidence.kind !== 'available') {
      setExpanded(false);
      setConfirming(false);
    }
  }, [evidence.kind]);

  if (props.walletState.kind === 'disconnected' || props.walletState.kind === 'discovering') {
    return <CommitPrompt onClick={openWalletControls} />;
  }
  if (props.walletState.kind === 'connecting' || props.walletState.kind === 'reconnecting') {
    return (
      <CommitPrompt
        busy
        label={props.walletState.kind === 'reconnecting' ? 'Restoring wallet…' : 'Connecting wallet…'}
      />
    );
  }
  if (props.walletState.kind === 'failed' && props.walletState.connection === null) {
    return <CommitPrompt onClick={openWalletControls} />;
  }
  if (evidence.kind === 'loading') {
    return <CommitPrompt busy label="Checking bidder state…" />;
  }

  if (evidence.kind === 'missing-receipt') {
    return (
      <Card
        key="missing-receipt"
        className="action-card commit-panel commit-panel--critical"
        aria-labelledby="commit-missing-receipt-title"
      >
        <h2 id="commit-missing-receipt-title">
          <Icon icon={AlertTriangle} size={16} /> Reveal receipt missing
        </h2>
        <p role="alert">
          This commitment is on-chain, but this browser does not have its reveal receipt. Import the matching receipt to
          reveal or cancel safely.
        </p>
        <code className="commit-panel__hash" title={evidence.liveCommitHash}>
          {shortHash(evidence.liveCommitHash)}
        </code>
        <Button className="action-card__button" onClick={openReceiptTools}>
          <Icon icon={Upload} size={15} /> Import receipt
        </Button>
      </Card>
    );
  }

  if (evidence.kind === 'blocked' || evidence.kind === 'inactive-receipt' || evidence.kind === 'failure') {
    return (
      <Card
        key="blocked"
        className={`action-card commit-panel ${evidence.kind === 'failure' ? 'commit-panel--critical' : ''}`.trim()}
      >
        <h2>Bidder action</h2>
        <p {...(evidence.kind === 'failure' ? { role: 'alert' as const } : {})}>{evidence.message}</p>
      </Card>
    );
  }

  if (evidence.kind === 'receipt' && evidence.phase !== 'cancelled') {
    return (
      <RevealReceiptCard
        evidence={evidence}
        auction={props.auction}
        profile={props.profile}
        bidsFanInTimeoutSeconds={props.bidsFanInTimeoutSeconds}
        controller={controller}
        currency={currency}
        paymentAmount={paymentAmount}
        transactionNotice={transactionNotice}
        expanded={expanded}
        setExpanded={setExpanded}
      />
    );
  }

  const fresh = evidence.fresh;
  if (!expanded)
    return (
      <>
        {transactionNotice}
        <CommitPrompt onClick={() => setExpanded(true)} />
      </>
    );
  const nominalPromis = controller.validation?.ok
    ? BigInt(controller.validation.bid.quantity) * fresh.params.promisLoadMinor
    : 0n;
  const parsedBidRate = (() => {
    try {
      return parseBidRatePercent(controller.bidRatePercent);
    } catch {
      return null;
    }
  })();
  const perIntexLock =
    parsedBidRate === null
      ? 0n
      : calculateEscrowLockMinor({
          quantity: 1n,
          promisLoadMinor: fresh.params.promisLoadMinor,
          bidRate: BigInt(parsedBidRate),
        });
  const totalBidMinor = controller.validation?.ok ? controller.validation.bid.revealLockMinor : 0n;
  const minBidRate = effectiveMinimumBidRate(fresh.params.minIntexBidRate);
  const minBidRatePercent = minBidRate / 10_000;
  const maxBidRatePercent = Number(BID_RATE_SCALE / 10_000n);
  const minBidQuantity = effectiveMinimumBidQuantity(fresh.params.minIntexBidQuantity);
  const minBidPerIntexMinor = calculateEscrowLockMinor({
    quantity: 1n,
    promisLoadMinor: fresh.params.promisLoadMinor,
    bidRate: BigInt(minBidRate),
  });
  const maxBidQuantity = Math.max(
    minBidQuantity,
    parsedBidRate === null
      ? Number(UINT16_MAX)
      : Number(
          maxQuantityForEscrowLock({
            promisLoadMinor: fresh.params.promisLoadMinor,
            bidRate: BigInt(parsedBidRate),
          }),
        ),
  );
  const adjustBidRate = (step: number) =>
    controller.setBidRatePercent(steppedValue(controller.bidRatePercent, step, minBidRatePercent, maxBidRatePercent));
  const setBidPerIntex = (value: string) => {
    try {
      controller.setBidRatePercent(
        paymentAmountToBidRatePercent({
          value,
          paymentTokenDecimals: fresh.paymentTokenDecimals,
          promisLoadMinor: fresh.params.promisLoadMinor,
        }),
      );
    } catch {}
  };

  const selectedIssuanceCode =
    controller.issuanceCurrency ??
    preferredIssuanceCurrency(
      fresh.params.issuanceCurrencies,
      fresh.params.referenceCurrency,
      getPreferredIssuanceCurrency(),
    ) ??
    null;
  const issuanceCurrency = selectedIssuanceCode === null ? 'Unavailable' : currencyCode(selectedIssuanceCode);
  const selectedReferenceCurrencyCode = controller.referenceCurrency ?? fresh.params.referenceCurrency;
  const referenceCurrency = currencyCode(selectedReferenceCurrencyCode);
  const allowedReferenceCurrencies = fresh.params.referenceCurrencies ?? [fresh.params.referenceCurrency];
  const referenceEntryPriceMinor = referenceEntryPrice(
    fresh.params.referenceCurrencies,
    fresh.params.referenceEntryPrices,
    selectedReferenceCurrencyCode,
    fresh.params.entryPriceMinor,
  );
  const selectedTerms =
    selectedIssuanceCode === null
      ? null
      : contractCurrencyTerms({
          issuanceCurrencies: fresh.params.issuanceCurrencies,
          issuanceEntryPrices: fresh.params.issuanceEntryPrices,
          strikeAmountsMinor: fresh.params.strikeAmountsMinor,
          oraclePairIds: fresh.params.oraclePairIds,
          issuanceCurrency: selectedIssuanceCode,
          referenceCurrency: selectedReferenceCurrencyCode,
          referenceEntryPriceMinor,
          promisLoadMinor: fresh.params.promisLoadMinor,
          conversions: currency.conversions,
        });
  const conversionEntries = (): ReadonlyArray<{ isoCode: number; contractFallback: bigint | null }> => [
    ...(selectedIssuanceCode === null
      ? []
      : [{ isoCode: selectedIssuanceCode, contractFallback: selectedTerms?.issuanceEntryPriceMinor ?? null }]),
    { isoCode: selectedReferenceCurrencyCode, contractFallback: referenceEntryPriceMinor },
  ];
  const bidConversions = currency.formatCoenCurrencyLine(totalBidMinor, conversionEntries());
  const perIntexConversions = currency.formatCoenCurrencyLine(perIntexLock, conversionEntries());
  const minBidConversions = currency.formatCoenCurrencyLine(minBidPerIntexMinor, conversionEntries());
  const strikeRow = strikeAmountRows({
    quantity: controller.validation?.ok ? BigInt(controller.validation.bid.quantity) : null,
    issuanceCurrency,
    referenceCurrency,
    strikePerIntex: selectedTerms?.strikeAmountMinor ?? null,
    referenceStrikePerIntexMinor: selectedTerms?.referenceStrikeAmountMinor ?? null,
  });
  const frozenCrossRate =
    selectedTerms === null || referenceEntryPriceMinor <= 0n
      ? null
      : (selectedTerms.issuanceEntryPriceMinor * 10n ** 18n) / referenceEntryPriceMinor;
  const conversionPair = `${referenceCurrency} / ${issuanceCurrency}`;
  const showsIssuanceRates = selectedIssuanceCode !== null && selectedIssuanceCode !== selectedReferenceCurrencyCode;
  const conversionRows = [
    ...(showsIssuanceRates
      ? [
          {
            pair: `Œ / ${issuanceCurrency}`,
            value: currency.formatCoenReferenceRate(
              selectedIssuanceCode,
              selectedTerms?.issuanceEntryPriceMinor ?? null,
              fresh.paymentTokenSymbol,
            ),
          },
        ]
      : []),
    {
      pair: `Œ / ${referenceCurrency}`,
      value: currency.formatCoenReferenceRate(
        selectedReferenceCurrencyCode,
        referenceEntryPriceMinor,
        fresh.paymentTokenSymbol,
      ),
    },
    ...(showsIssuanceRates
      ? [
          {
            pair: conversionPair,
            value: currency.formatCrossRate(selectedReferenceCurrencyCode, selectedIssuanceCode, frozenCrossRate),
          },
        ]
      : []),
  ] as const;
  const conversionReady = selectedTerms !== null;
  const commitProgressKind = controller.progress?.operation === 'commit' ? controller.progress.value.kind : null;
  const commitStatus = txStepStatus(
    controller.progress?.operation === 'commit' ? controller.progress : null,
    paymentAmount,
  );
  const approvalComplete =
    commitProgressKind === 'ready-to-commit' ||
    commitProgressKind === 'commit-submitted' ||
    commitProgressKind === 'commit-confirming' ||
    commitProgressKind === 'reconciling' ||
    commitProgressKind === 'confirmed';

  return (
    <Card
      key="commit-form"
      className="action-card commit-panel commit-panel--expanded"
      aria-labelledby="commit-panel-title"
    >
      <div className="commit-panel__header">
        <h2 id="commit-panel-title">Commit Sealed Bid</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close sealed bid form"
          onClick={() => {
            setExpanded(false);
            setConfirming(false);
          }}
        >
          <Icon icon={X} size={17} />
        </Button>
      </div>
      {transactionNotice}
      <fieldset className="commit-panel__currency-fields" aria-label="Auction currencies">
        <IssuanceCurrencyField
          allowed={allowedCurrencies}
          selected={controller.issuanceCurrency}
          disabled={controller.busy || confirming}
          onSelect={controller.setIssuanceCurrency}
        />
        <ReferenceCurrencyField
          allowed={allowedReferenceCurrencies}
          selected={selectedReferenceCurrencyCode}
          disabled={controller.busy || confirming}
          onSelect={controller.setReferenceCurrency}
        />
      </fieldset>
      <div className="commit-panel__fields">
        <CommitStepper
          label="Quantity"
          value={controller.quantity}
          minimum={minBidQuantity}
          maximum={maxBidQuantity}
          step={1}
          suffix="Intexes"
          hint={commitFormCopy.quantityHint(minBidQuantity)}
          inputMode="numeric"
          disabled={controller.busy || confirming}
          onChange={controller.setQuantity}
        />
        <CommitStepper
          label="Bid per Intex"
          value={parsedBidRate === null ? '' : formatUnits(perIntexLock, fresh.paymentTokenDecimals)}
          minimum={0}
          step={0.5}
          prefix={displayPaymentTokenSymbol(fresh.paymentTokenSymbol)}
          hint={`Min – ${paymentAmount(minBidPerIntexMinor)}${minBidConversions === 'Conversion unavailable' ? '' : ` ≈ ${minBidConversions}`}`}
          inputMode="decimal"
          disabled={controller.busy || confirming}
          onChange={setBidPerIntex}
          onDecrease={() => adjustBidRate(-0.5)}
          onIncrease={() => adjustBidRate(0.5)}
        />
        <CommitStepper
          label="Bid rate"
          value={controller.bidRatePercent}
          minimum={minBidRatePercent}
          maximum={maxBidRatePercent}
          step={0.5}
          suffix="%"
          hint={commitFormCopy.bidRateHint(minBidRate)}
          inputMode="decimal"
          disabled={controller.busy || confirming}
          onChange={controller.setBidRatePercent}
        />
      </div>
      <CommitBidDetails
        rows={[
          {
            label: 'Quantity',
            value: controller.validation?.ok
              ? `${integer(controller.validation.bid.quantity)} ${intexUnit(controller.validation.bid.quantity)}`
              : '—',
            detail: controller.validation?.ok ? `${formatPromisAmount(nominalPromis)} Promis` : '—',
          },
          {
            label: 'Bid rate',
            value: controller.validation?.ok ? commitFormCopy.bidRate(controller.validation.bid.bidRate) : '—',
          },
          {
            label: 'Bid amount per Intex',
            value: controller.validation?.ok ? paymentAmount(perIntexLock) : '—',
            detail: perIntexConversions,
          },
          {
            label: 'Total bid amount',
            value: controller.validation?.ok ? paymentAmount(totalBidMinor) : '—',
            detail: bidConversions,
          },
          { label: 'Promis', value: controller.validation?.ok ? formatPromisAmount(nominalPromis) : '—' },
          {
            label: 'Strike amount',
            value: strikeRow.perIntexValue,
            detail: strikeRow.perIntexDetail,
            tip:
              strikeRow.perIntexValue === '—'
                ? undefined
                : [{ title: 'Currency', body: strikeCurrencyTip(issuanceCurrency, referenceCurrency) }],
          },
          {
            label: 'Total strike amount',
            value: strikeRow.totalValue,
            detail: strikeRow.totalDetail,
          },
        ]}
      />
      <CommitConversionRates rows={conversionRows} />
      <TransactionContracts profile={props.profile} />
      {controller.validation && !controller.validation.ok && (
        <p className="commit-panel__validation" role="alert">
          {controller.validation.message}
        </p>
      )}
      {!confirming ? (
        <>
          <Button
            className="action-card__button"
            disabled={controller.busy || !controller.validation?.ok || !conversionReady}
            onClick={() => setConfirming(true)}
          >
            <Icon icon={FileSignature} size={15} /> Commit Sealed Bid
          </Button>
          <p className="commit-panel__bond-copy">{commitFormCopy.bond(paymentAmount(fresh.params.commitBondMinor))}</p>
        </>
      ) : (
        <div className="commit-panel__confirmation">
          <Button
            variant="outline"
            className="commit-panel__back"
            disabled={controller.busy}
            onClick={() => setConfirming(false)}
          >
            Back
          </Button>
          <div className="commit-panel__transaction-steps">
            <TransactionStep
              number={1}
              title="Approve bond transfer"
              body={`Allow the escrow contract to hold ${paymentAmount(fresh.params.commitBondMinor)} via the ERC-20 approval. This bond is required to participate in the auction. The bond is returned on reveal or cancellation according to the reviewed auction contract state.`}
              state={approvalComplete ? 'complete' : 'active'}
              status={commitStatus.approval}
            >
              {!approvalComplete && (
                <Button
                  className="commit-panel__step-action"
                  disabled={controller.busy || !controller.validation?.ok || !conversionReady}
                  onClick={() => {
                    void controller.submitCommit();
                  }}
                >
                  <Icon icon={controller.busy ? LoaderCircle : FileSignature} size={15} />
                  {controller.busy ? 'Approving…' : 'Approve allowance'}
                </Button>
              )}
            </TransactionStep>
            <TransactionStep
              number={2}
              title="Commit your sealed bid"
              body={`Your bid is sealed on-chain and ${paymentAmount(fresh.params.commitBondMinor)} bond is locked in escrow.`}
              state={approvalComplete ? 'active' : 'waiting'}
              status={commitStatus.action}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
