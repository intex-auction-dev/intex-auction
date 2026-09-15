import { availableStorage } from '../persistence/available-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicClient } from 'viem';
import type { CalendarWorldwideDay } from '../discovery/calendar-evidence';
import type { PublicAuctionRead } from '../discovery/load-public-auction';
import {
  executeCommitTransaction,
  executeRecommitTransaction,
  readFreshCommitState,
  StaleCommitContextError,
  type CommitOperationProgress,
  type CommitOperationResult,
  type FreshCommitState,
} from './commit-transaction';
import {
  executeCancelCommitTransaction,
  executeRevealBidTransaction,
  type CancelOperationProgress,
  type CancelOperationResult,
  type RevealOperationProgress,
  type RevealOperationResult,
} from './cancel-reveal-transaction';
import {
  effectiveMinimumBidQuantity,
  effectiveMinimumBidRate,
  formatContractBidRatePercent,
  validateCommitBidInput,
  type ValidatedCommitBid,
} from '../domain/commit-domain';
import { calculateEscrowLockMinor } from '../domain/escrow-lock';
import { getPreferredIssuanceCurrency, setPreferredIssuanceCurrency } from '../domain/issuance-currency-preference';
import { preferredIssuanceCurrency } from '../oracle/multi-currency-evidence';
import { unresolvedBidderActionBlocker } from './bidder-transaction-safety';
import { createReceiptPresentation, type ReceiptPresentationModel } from '../receipts/presentation';
import { validateRevealMaterial } from '../receipts/reveal-material';
import {
  listStoredRevealMaterials,
  listTransactionAttempts,
  receiptMatchesContext,
  TransactionAttemptPersistenceError,
  type ReceiptStorage,
  type StoredRevealMaterialV1,
  type TransactionAttemptV1,
} from '../receipts/receipt-store';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import type { WalletState } from '../wallet/wallet-state';
import { friendlyErrorMessage } from '../chain/contract-errors';
import { showErrorToast, showSuccessToast, showWarningToast } from '../ui/toast';

export { unresolvedBidderActionBlocker } from './bidder-transaction-safety';

const ZERO_HASH = `0x${'0'.repeat(64)}`;

export const reportBidderActionFailure = (error: unknown): string => {
  if (error instanceof TransactionAttemptPersistenceError) {
    showWarningToast(error.message, 'Transaction submitted; tracking unavailable');
    return error.message;
  }
  const message =
    error instanceof StaleCommitContextError
      ? 'The wallet, venue or auction route changed. The prepared operation was discarded without retrying.'
      : friendlyErrorMessage(error);
  showErrorToast(message, 'Transaction failed');
  return message;
};

type ReceiptPhase = 'committed' | 'cancelled' | 'reveal-ready' | 'revealed';

export type BidderActionEvidence =
  | { readonly kind: 'loading' }
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'available'; readonly fresh: FreshCommitState }
  | {
      readonly kind: 'receipt';
      readonly phase: ReceiptPhase;
      readonly fresh: FreshCommitState;
      readonly receipt: ReceiptPresentationModel;
      readonly revealMaterialKey: string;
      readonly reconciliationMessage: string | null;
    }
  | { readonly kind: 'inactive-receipt'; readonly message: string }
  | { readonly kind: 'missing-receipt'; readonly liveCommitHash: string }
  | { readonly kind: 'failure'; readonly message: string };

export type BidderActionProgress =
  | { readonly operation: 'commit' | 'recommit'; readonly value: CommitOperationProgress }
  | { readonly operation: 'cancellation'; readonly value: CancelOperationProgress }
  | { readonly operation: 'reveal'; readonly value: RevealOperationProgress };

export type BidderActionResult = CommitOperationResult | CancelOperationResult | RevealOperationResult;

interface LifecycleToastCopy {
  readonly confirmedTitle: string;
  readonly confirmedDescription: string;
  readonly pendingTitle: string;
}

export const reportBidderActionResult = (result: BidderActionResult, copy: LifecycleToastCopy): void => {
  if (result.reconciliation === 'confirmed') {
    showSuccessToast(copy.confirmedDescription, copy.confirmedTitle);
    return;
  }
  showWarningToast(
    result.reconciliationMessage ?? 'The transaction is confirmed, but the live auction state is still reconciling.',
    copy.pendingTitle,
  );
};

export interface BidderActionController {
  readonly evidence: BidderActionEvidence;
  readonly quantity: string;
  readonly bidRatePercent: string;
  readonly issuanceCurrency: number | null;
  readonly referenceCurrency: number | null;
  readonly changedBidMode: boolean;
  readonly validation:
    | { readonly ok: true; readonly bid: ValidatedCommitBid }
    | { readonly ok: false; readonly message: string }
    | null;
  readonly progress: BidderActionProgress | null;
  readonly result: BidderActionResult | null;
  readonly failure: string | null;
  readonly transactionNotice: string | null;
  readonly busy: boolean;
  readonly setQuantity: (value: string) => void;
  readonly setBidRatePercent: (value: string) => void;
  readonly setIssuanceCurrency: (value: number) => void;
  readonly setReferenceCurrency: (value: number) => void;
  readonly startChangedBid: () => void;
  readonly stopChangedBid: () => void;
  readonly submitCommit: () => Promise<void>;
  readonly cancelCommit: () => Promise<void>;
  readonly recommitStored: () => Promise<void>;
  readonly recommitChanged: () => Promise<void>;
  readonly revealBid: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

interface Input {
  readonly auction: PublicAuctionRead;
  readonly calendarDay: CalendarWorldwideDay | null;
  readonly walletState: WalletState;
  readonly profile: ResolvedVenueReadProfile | null;
  readonly publicClient: PublicClient | null;
  readonly contextToken: string;
  readonly isContextCurrent: (token: string) => boolean;
}

const localStorageBoundary = (): ReceiptStorage => {
  const probed = availableStorage();
  if (!probed.ok) throw new Error(`Browser receipt storage is unavailable: ${probed.reason}`);
  return probed.storage;
};

const latestAttempt = (attempts: readonly TransactionAttemptV1[]): TransactionAttemptV1 | null =>
  [...attempts].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1) ?? null;

const latestConfirmed = (
  attempts: readonly TransactionAttemptV1[],
  kinds: readonly TransactionAttemptV1['kind'][],
): TransactionAttemptV1 | null =>
  latestAttempt(attempts.filter((attempt) => attempt.state === 'confirmed' && kinds.includes(attempt.kind)));

export interface RevealActivityEntry {
  readonly record: { readonly key: string; readonly stored: StoredRevealMaterialV1 };
  readonly attempts: readonly TransactionAttemptV1[];
}

export const selectMostRecentRevealed = (entries: readonly RevealActivityEntry[]): RevealActivityEntry | null =>
  entries
    .map((entry) => ({ entry, confirmedReveal: latestConfirmed(entry.attempts, ['reveal']) }))
    .filter(
      (entry): entry is { entry: RevealActivityEntry; confirmedReveal: TransactionAttemptV1 } =>
        entry.confirmedReveal !== null,
    )
    .sort((left, right) => right.confirmedReveal.updatedAt.localeCompare(left.confirmedReveal.updatedAt))[0]?.entry ??
  null;

const validateStoredRecord = async (
  record: { readonly key: string; readonly stored: StoredRevealMaterialV1 },
  promisLoadMinor: bigint,
): Promise<{ readonly key: string; readonly stored: StoredRevealMaterialV1 }> => ({
  key: record.key,
  stored: {
    ...record.stored,
    material: await validateRevealMaterial(record.stored.material, { promisLoadMinor }),
  },
});

const buildReceipt = (input: {
  readonly selected: { readonly key: string; readonly stored: StoredRevealMaterialV1 };
  readonly records: readonly { readonly key: string; readonly stored: StoredRevealMaterialV1 }[];
  readonly fresh: FreshCommitState;
  readonly profile: ResolvedVenueReadProfile;
  readonly storage: ReceiptStorage;
}): { readonly receipt: ReceiptPresentationModel; readonly attempts: readonly TransactionAttemptV1[] } => {
  const attempts = input.records.flatMap(({ key }) => [...listTransactionAttempts(input.storage, key)]);
  return {
    attempts,
    receipt: createReceiptPresentation({
      material: input.selected.stored.material,
      attempts,
      ...(input.profile.explorerUrl === null ? {} : { explorer: { explorerUrl: input.profile.explorerUrl } }),
      commitBondMinor: input.fresh.params.commitBondMinor,
      revealLockMinor: calculateEscrowLockMinor({
        quantity: BigInt(input.selected.stored.material.quantity),
        promisLoadMinor: input.fresh.params.promisLoadMinor,
        bidRate: BigInt(input.selected.stored.material.bidRate),
      }),
      currentRevealDeadline: input.fresh.schedule.revealEnd,
    }),
  };
};

export const initialBidRatePercent = (minimumBidRate: number): string =>
  formatContractBidRatePercent(effectiveMinimumBidRate(minimumBidRate)).replace('%', '');

export const bidderActionResetKey = (auction: PublicAuctionRead, calendarDay: CalendarWorldwideDay | null): string =>
  [
    auction.worldwideDay,
    auction.venue.kind,
    auction.venue.kind === 'delivered' ? auction.venue.auction.stage : '',
    calendarDay?.venueReceipt ?? '',
    calendarDay?.venueParticipation ?? '',
  ].join(':');

export const useBidderActionController = (input: Input): BidderActionController => {
  const { auction, calendarDay, walletState, profile, publicClient, contextToken, isContextCurrent } = input;
  const [evidence, setEvidence] = useState<BidderActionEvidence>({ kind: 'loading' });
  const [quantity, setQuantityState] = useState('');
  const [bidRatePercent, setBidRatePercentState] = useState('');
  const [issuanceCurrency, setIssuanceCurrencyState] = useState<number | null>(null);
  const [referenceCurrency, setReferenceCurrencyState] = useState<number | null>(null);
  const [changedBidMode, setChangedBidMode] = useState(false);
  const [progress, setProgress] = useState<BidderActionProgress | null>(null);
  const [result, setResult] = useState<BidderActionController['result']>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [transactionNotice, setTransactionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const operationInFlight = useRef(false);
  const resetKeyRef = useRef<string | null>(null);
  const unpersistedAttempt = useRef<TransactionAttemptV1 | null>(null);

  const supported = walletState.kind === 'connected-supported' && profile !== null && publicClient !== null;
  const bidder = walletState.kind === 'connected-supported' ? walletState.connection.address : null;
  const resetKey = `${contextToken}:${bidderActionResetKey(auction, calendarDay)}`;

  const refresh = useCallback(
    async (showLoading = false) => {
      if (showLoading) setEvidence({ kind: 'loading' });
      setTransactionNotice(null);
      if (walletState.kind === 'disconnected' || walletState.kind === 'discovering') {
        setEvidence({ kind: 'blocked', message: 'Connect a wallet on the active venue to manage a sealed bid.' });
        return;
      }
      if (walletState.kind === 'connected-unsupported') {
        setEvidence({
          kind: 'blocked',
          message: 'Switch the wallet to a supported venue. No bidder transaction is available on this chain.',
        });
        return;
      }
      if (!supported || !bidder || !profile || !publicClient) {
        setEvidence({ kind: 'blocked', message: 'The active wallet and venue context is not transaction-capable.' });
        return;
      }
      if (
        auction.venue.kind !== 'delivered' ||
        calendarDay?.venueReceipt === 'delivery-pending' ||
        calendarDay?.venueParticipation === 'skipped' ||
        calendarDay?.venueParticipation === 'not-applicable'
      ) {
        setEvidence({
          kind: 'blocked',
          message: "Bidding can't start until the active venue receives the auction schedule.",
        });
        return;
      }

      try {
        const fresh = await readFreshCommitState({ publicClient, profile, bidder, worldwideDay: auction.worldwideDay });
        if (!isContextCurrent(contextToken)) return;
        const storage = localStorageBoundary();
        const allRecords = await listStoredRevealMaterials(storage);
        const records = allRecords.filter(
          ({ stored }) =>
            stored.material.worldwideDay === Number(auction.worldwideDay) &&
            receiptMatchesContext(stored.material, {
              chainId: profile.chainId,
              deploymentId: profile.deploymentId,
              auctionProxy: profile.addresses.intexAuction,
              bidder,
            }),
        );
        if (!isContextCurrent(contextToken)) return;

        const ephemeralAttempt = unpersistedAttempt.current;
        const withActivity = records
          .map((record) => {
            const storedAttempts = listTransactionAttempts(storage, record.key);
            return {
              record,
              attempts:
                ephemeralAttempt?.revealMaterialKey === record.key
                  ? [
                      ...storedAttempts.filter((attempt) => attempt.attemptId !== ephemeralAttempt.attemptId),
                      ephemeralAttempt,
                    ]
                  : storedAttempts,
            };
          })
          .filter(({ attempts }) => attempts.length > 0);
        const unresolvedNotice = unresolvedBidderActionBlocker(fresh, withActivity);
        if (unresolvedNotice !== null) {
          setTransactionNotice(
            ephemeralAttempt === null
              ? unresolvedNotice
              : `Transaction submitted; local tracking unavailable. ${unresolvedNotice}`,
          );
        } else if (ephemeralAttempt !== null) {
          unpersistedAttempt.current = null;
        }

        if (fresh.liveCommitHash !== ZERO_HASH) {
          const rawSelected = records.find(({ stored }) => stored.material.commitHash === fresh.liveCommitHash);
          if (!rawSelected) {
            const inactive = allRecords.some(({ stored }) => stored.material.commitHash === fresh.liveCommitHash);
            setEvidence(
              inactive
                ? {
                    kind: 'inactive-receipt',
                    message: 'The matching receipt belongs to another wallet, chain or deployment context.',
                  }
                : { kind: 'missing-receipt', liveCommitHash: fresh.liveCommitHash },
            );
            return;
          }
          const selected = await validateStoredRecord(rawSelected, fresh.params.promisLoadMinor);
          const built = buildReceipt({ selected, records, fresh, profile, storage });
          const latestRelevant = latestConfirmed(built.attempts, ['commit', 'recommit']);
          const reconciliationMessage = latestRelevant?.lastReconciliationError ?? null;
          setQuantityState(String(selected.stored.material.quantity));
          setBidRatePercentState(formatContractBidRatePercent(selected.stored.material.bidRate).replace('%', ''));
          setIssuanceCurrencyState(
            selected.stored.material.issuanceCurrency ??
              preferredIssuanceCurrency(
                fresh.params.issuanceCurrencies,
                fresh.params.referenceCurrency,
                getPreferredIssuanceCurrency(),
              ),
          );
          setReferenceCurrencyState(selected.stored.material.referenceCurrency);
          setEvidence({
            kind: 'receipt',
            phase: fresh.stage === 'revealing-bids' ? 'reveal-ready' : 'committed',
            fresh,
            receipt: built.receipt,
            revealMaterialKey: selected.key,
            reconciliationMessage,
          });
          return;
        }

        const selectedActivity = [...withActivity]
          .sort((a, b) =>
            (latestAttempt(a.attempts)?.updatedAt ?? '').localeCompare(latestAttempt(b.attempts)?.updatedAt ?? ''),
          )
          .at(-1);

        if (fresh.bidderRevealed || fresh.bidLock.status === 'locked') {
          const revealed = selectMostRecentRevealed(withActivity);
          if (revealed) {
            const selected = await validateStoredRecord(revealed.record, fresh.params.promisLoadMinor);
            const built = buildReceipt({ selected, records, fresh, profile, storage });
            const latestReveal = latestConfirmed(built.attempts, ['reveal']);
            setEvidence({
              kind: 'receipt',
              phase: 'revealed',
              fresh,
              receipt: built.receipt,
              revealMaterialKey: revealed.record.key,
              reconciliationMessage: latestReveal?.lastReconciliationError ?? null,
            });
            return;
          }
        }

        if (fresh.stage === 'committing-bids' && selectedActivity) {
          const cancellations = withActivity.flatMap(({ record, attempts }) =>
            attempts
              .filter((attempt) => attempt.kind === 'cancellation' && attempt.state === 'confirmed')
              .map((attempt) => ({ record, attempt })),
          );
          const latestCancellation = [...cancellations]
            .sort((left, right) => left.attempt.updatedAt.localeCompare(right.attempt.updatedAt))
            .at(-1);
          const latestCommit = latestConfirmed(
            withActivity.flatMap(({ attempts }) => [...attempts]),
            ['commit', 'recommit'],
          );
          if (
            latestCancellation &&
            (latestCommit === null || latestCancellation.attempt.updatedAt > latestCommit.updatedAt)
          ) {
            const selected = await validateStoredRecord(latestCancellation.record, fresh.params.promisLoadMinor);
            const built = buildReceipt({ selected, records, fresh, profile, storage });
            setQuantityState(String(selected.stored.material.quantity));
            setBidRatePercentState(formatContractBidRatePercent(selected.stored.material.bidRate).replace('%', ''));
            setIssuanceCurrencyState(
              selected.stored.material.issuanceCurrency ??
                preferredIssuanceCurrency(
                  fresh.params.issuanceCurrencies,
                  fresh.params.referenceCurrency,
                  getPreferredIssuanceCurrency(),
                ),
            );
            setReferenceCurrencyState(selected.stored.material.referenceCurrency);
            setEvidence({
              kind: 'receipt',
              phase: 'cancelled',
              fresh,
              receipt: built.receipt,
              revealMaterialKey: latestCancellation.record.key,
              reconciliationMessage: latestCancellation.attempt.lastReconciliationError ?? null,
            });
            return;
          }
        }

        if (fresh.stage !== 'committing-bids') {
          setEvidence({
            kind: 'blocked',
            message:
              fresh.stage === 'revealing-bids'
                ? 'No live commitment exists for this bidder in the reveal stage.'
                : 'The active venue is not currently accepting bidder actions.',
          });
          return;
        }
        setQuantityState((current) => current || String(effectiveMinimumBidQuantity(fresh.params.minIntexBidQuantity)));
        setBidRatePercentState((current) => current || initialBidRatePercent(fresh.params.minIntexBidRate));
        setIssuanceCurrencyState(
          (current) =>
            current ??
            preferredIssuanceCurrency(
              fresh.params.issuanceCurrencies,
              fresh.params.referenceCurrency,
              getPreferredIssuanceCurrency(),
            ),
        );
        setReferenceCurrencyState((current) => current ?? fresh.params.referenceCurrency);
        setEvidence({ kind: 'available', fresh });
      } catch (error) {
        if (!isContextCurrent(contextToken)) return;
        setTransactionNotice(null);
        setEvidence({ kind: 'failure', message: error instanceof Error ? error.message : String(error) });
      }
    },
    [auction, bidder, calendarDay, contextToken, isContextCurrent, profile, publicClient, supported, walletState.kind],
  );

  useEffect(() => {
    const shouldReset = resetKeyRef.current !== resetKey;
    resetKeyRef.current = resetKey;
    if (shouldReset) {
      generation.current += 1;
      unpersistedAttempt.current = null;
      setProgress(null);
      setResult(null);
      setFailure(null);
      setTransactionNotice(null);
      setBusy(false);
      setChangedBidMode(false);
      setQuantityState('');
      setBidRatePercentState('');
      setIssuanceCurrencyState(null);
      setReferenceCurrencyState(null);
    }
    void refresh(shouldReset);
  }, [refresh, resetKey]);

  const freshForForm =
    evidence.kind === 'available' || (evidence.kind === 'receipt' && evidence.phase === 'cancelled')
      ? evidence.fresh
      : null;
  const validation = useMemo(() => {
    if (!freshForForm) return null;
    try {
      return {
        ok: true as const,
        bid: validateCommitBidInput({
          quantity,
          bidRatePercent,
          constraints: {
            minQuantity: freshForForm.params.minIntexBidQuantity,
            minBidRate: freshForForm.params.minIntexBidRate,
            promisLoadMinor: freshForForm.params.promisLoadMinor,
          },
        }),
      };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
    }
  }, [bidRatePercent, freshForForm, quantity]);

  const changeInput = (setter: (value: string) => void, value: string) => {
    generation.current += 1;
    setFailure(null);
    setResult(null);
    setter(value);
  };
  const operationContext = () => {
    if (!profile || !bidder) throw new Error('The active bidder context is unavailable.');
    return {
      token: contextToken,
      chainId: profile.chainId,
      deploymentId: profile.deploymentId,
      auctionProxy: profile.addresses.intexAuction,
      bidder,
      worldwideDay: auction.worldwideDay,
    };
  };

  const run = async (operation: () => Promise<BidderActionResult>, toastCopy: LifecycleToastCopy) => {
    if (operationInFlight.current || busy) return;
    const activeGeneration = generation.current;
    operationInFlight.current = true;
    setBusy(true);
    setFailure(null);
    setResult(null);
    setProgress(null);
    try {
      const completed = await operation();
      if (!isContextCurrent(contextToken) || activeGeneration !== generation.current) return;
      setProgress(null);
      setResult(completed);
      reportBidderActionResult(completed, toastCopy);
      await refresh();
    } catch (error) {
      if (!isContextCurrent(contextToken) || activeGeneration !== generation.current) return;
      if (error instanceof TransactionAttemptPersistenceError) unpersistedAttempt.current = error.attempt;
      setProgress(null);
      setFailure(reportBidderActionFailure(error));
      await refresh();
    } finally {
      operationInFlight.current = false;
      if (isContextCurrent(contextToken) && activeGeneration === generation.current) setBusy(false);
    }
  };

  const baseInput = () => {
    if (!profile || !publicClient || walletState.kind !== 'connected-supported')
      throw new Error('The bidder context is unavailable.');
    return {
      publicClient,
      walletProvider: walletState.connection.provider.provider,
      profile,
      context: operationContext(),
      storage: localStorageBoundary(),
      isContextCurrent: (token: string) => isContextCurrent(token),
    };
  };

  const submitCommit = async () => {
    if (
      !(evidence.kind === 'available' || (evidence.kind === 'receipt' && evidence.phase === 'cancelled')) ||
      !validation?.ok
    )
      return;
    await run(
      () =>
        executeCommitTransaction({
          ...baseInput(),
          quantity,
          bidRatePercent,
          ...(issuanceCurrency === null ? {} : { issuanceCurrency }),
          ...(referenceCurrency === null ? {} : { referenceCurrency }),
          onProgress: (value) => setProgress({ operation: 'commit', value }),
        }),
      {
        confirmedTitle: 'Commit confirmed',
        confirmedDescription: 'Your sealed bid commitment is confirmed on-chain.',
        pendingTitle: 'Commit transaction confirmed',
      },
    );
  };

  const cancelCommit = async () => {
    if (evidence.kind !== 'receipt' || evidence.phase !== 'committed') return;
    await run(
      () =>
        executeCancelCommitTransaction({
          ...baseInput(),
          onProgress: (value) => setProgress({ operation: 'cancellation', value }),
        }),
      {
        confirmedTitle: 'Commit cancelled',
        confirmedDescription: 'Your commitment was cancelled and its commit bond was returned.',
        pendingTitle: 'Cancellation transaction confirmed',
      },
    );
  };

  const recommitStored = async () => {
    if (evidence.kind !== 'receipt' || evidence.phase !== 'cancelled') return;
    const storedQuantity = String(evidence.receipt.quantity);
    const storedRate = formatContractBidRatePercent(evidence.receipt.contractBidRate).replace('%', '');
    const storedIssuanceCurrency = evidence.receipt.issuanceCurrency;
    const storedReferenceCurrency = evidence.receipt.referenceCurrency;
    await run(
      () =>
        executeRecommitTransaction({
          ...baseInput(),
          quantity: storedQuantity,
          bidRatePercent: storedRate,
          ...(storedIssuanceCurrency === null ? {} : { issuanceCurrency: storedIssuanceCurrency }),
          ...(storedReferenceCurrency === null ? {} : { referenceCurrency: storedReferenceCurrency }),
          onProgress: (value) => setProgress({ operation: 'recommit', value }),
        }),
      {
        confirmedTitle: 'Recommit confirmed',
        confirmedDescription: 'Your sealed bid commitment is confirmed on-chain.',
        pendingTitle: 'Recommit transaction confirmed',
      },
    );
  };

  const recommitChanged = async () => {
    if (evidence.kind !== 'receipt' || evidence.phase !== 'cancelled' || !changedBidMode || !validation?.ok) return;
    await run(
      () =>
        executeRecommitTransaction({
          ...baseInput(),
          quantity,
          bidRatePercent,
          ...(issuanceCurrency === null ? {} : { issuanceCurrency }),
          ...(referenceCurrency === null ? {} : { referenceCurrency }),
          onProgress: (value) => setProgress({ operation: 'recommit', value }),
        }),
      {
        confirmedTitle: 'Recommit confirmed',
        confirmedDescription: 'Your sealed bid commitment is confirmed on-chain.',
        pendingTitle: 'Recommit transaction confirmed',
      },
    );
  };

  const revealBid = async () => {
    if (evidence.kind !== 'receipt' || evidence.phase !== 'reveal-ready') return;
    await run(
      () =>
        executeRevealBidTransaction({
          ...baseInput(),
          onProgress: (value) => setProgress({ operation: 'reveal', value }),
        }),
      {
        confirmedTitle: 'Bid revealed',
        confirmedDescription: 'Your sealed bid reveal is confirmed on-chain.',
        pendingTitle: 'Reveal transaction confirmed',
      },
    );
  };

  return {
    evidence,
    quantity,
    bidRatePercent,
    issuanceCurrency,
    referenceCurrency,
    changedBidMode,
    validation,
    progress,
    result,
    failure,
    transactionNotice,
    busy,
    setQuantity: (value) => changeInput(setQuantityState, value),
    setBidRatePercent: (value) => changeInput(setBidRatePercentState, value),
    setIssuanceCurrency: (value) => {
      generation.current += 1;
      setFailure(null);
      setResult(null);
      setPreferredIssuanceCurrency(value);
      setIssuanceCurrencyState(value);
    },
    setReferenceCurrency: (value) => {
      generation.current += 1;
      setFailure(null);
      setResult(null);
      setReferenceCurrencyState(value);
    },
    startChangedBid: () => {
      generation.current += 1;
      setChangedBidMode(true);
      setFailure(null);
    },
    stopChangedBid: () => {
      generation.current += 1;
      setChangedBidMode(false);
      setFailure(null);
    },
    submitCommit,
    cancelCommit,
    recommitStored,
    recommitChanged,
    revealBid,
    refresh,
  };
};
