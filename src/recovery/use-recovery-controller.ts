import { availableStorage } from '../persistence/available-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address, Hash, PublicClient } from 'viem';
import type { WorldwideDayKey } from '../domain/protocol-time';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import type { WalletState } from '../wallet/wallet-state';
import { showErrorToast, showSuccessToast, showWarningToast } from '../ui/toast';
import {
  latestRecoveryAttempt,
  listRecoveryAttempts,
  RecoveryAttemptPersistenceError,
  type RecoveryAttemptStorage,
  type RecoveryAttemptV1,
} from './recovery-attempt';
import { recoveryPathLabel, type RecoveryItem, type RecoveryPath } from './recovery-domain';
import { loadWalletRecoveryIndex, type RecoveryIndexIssue, type WalletRecoveryIndex } from './recovery-index';
import {
  executeRecoveryTransaction,
  StaleRecoveryContextError,
  type RecoveryOperationProgress,
  type RecoveryOperationResult,
} from './recovery-transaction';

export type RecoveryDisplayStatus =
  | 'waiting'
  | 'claimable'
  | 'awaiting-wallet'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'reconciliation-pending'
  | 'read-failure'
  | 'incompatible-historical-contract';

export interface RecoveryDisplayRecord {
  readonly key: string;
  readonly worldwideDay: WorldwideDayKey;
  readonly path: RecoveryPath;
  readonly label: string;
  readonly bidder: Address;
  readonly auctionContract: Address;
  readonly escrowContract: Address;
  readonly paymentToken: Address;
  readonly paymentTokenDecimals: number | null;
  readonly paymentTokenSymbol: string | null;
  readonly custody: 'current' | 'historical';
  readonly returnedAmount: bigint;
  readonly burnedAmount: bigint;
  readonly claimableAt: bigint | null;
  readonly latestBlockTimestamp: bigint | null;
  readonly explanation: string;
  readonly status: RecoveryDisplayStatus;
  readonly transactionHash: Hash | null;
  readonly reconciliationError: string | null;
  readonly claimableItem: RecoveryItem | null;
}

export interface RecoveryDisplayIssue {
  readonly key: string;
  readonly worldwideDay: WorldwideDayKey | null;
  readonly escrowContract: Address | null;
  readonly status: Extract<RecoveryDisplayStatus, 'read-failure' | 'incompatible-historical-contract'>;
  readonly message: string;
}

export type RecoveryControllerEvidence =
  | { readonly kind: 'blocked'; readonly message: string }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded';
      readonly index: WalletRecoveryIndex;
      readonly records: readonly RecoveryDisplayRecord[];
      readonly issues: readonly RecoveryDisplayIssue[];
      readonly storageWarning: string | null;
    }
  | { readonly kind: 'failure'; readonly message: string };

export interface RecoveryController {
  readonly evidence: RecoveryControllerEvidence;
  readonly busy: boolean;
  readonly activeItemKey: string | null;
  readonly failure: string | null;
  readonly result: RecoveryOperationResult | null;
  readonly refresh: () => Promise<void>;
  readonly claim: (item: RecoveryItem) => Promise<void>;
}

interface Input {
  readonly walletState: WalletState;
  readonly profile: ResolvedVenueReadProfile | null;
  readonly publicClient: PublicClient | null;
  readonly worldwideDay: WorldwideDayKey;
  readonly contextToken: string;
  readonly isContextCurrent: (token: string) => boolean;
}

class VolatileRecoveryAttemptStorage implements RecoveryAttemptStorage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const volatileRecoveryAttemptStorage = new VolatileRecoveryAttemptStorage();

const recoveryAttemptStorage = (): { readonly storage: RecoveryAttemptStorage; readonly warning: string | null } => {
  const probed = availableStorage();
  if (probed.ok) return { storage: probed.storage, warning: null };
  return {
    storage: volatileRecoveryAttemptStorage,
    warning: `Browser recovery history storage is unavailable; transaction history is session-only. ${probed.reason}`,
  };
};

export const isRecoveryAttemptRetryable = (attempt: RecoveryAttemptV1 | null): boolean =>
  attempt !== null &&
  (attempt.state === 'reverted' || (attempt.state === 'replaced' && attempt.replacementAttemptId === undefined));

export const unresolvedRecoveryAttemptNotice = (attempt: RecoveryAttemptV1 | null): string | null => {
  if (attempt === null || (attempt.state !== 'submitted' && attempt.state !== 'unknown' && attempt.state !== 'dropped'))
    return null;
  const lastCheck =
    attempt.lastReconciliationError === undefined ? '' : ` Last status check: ${attempt.lastReconciliationError}`;
  return `Local transaction history contains a recovery attempt with an unresolved network result. Fresh contract state below is authoritative; the earlier transaction may still settle or be replaced in your wallet.${lastCheck}`;
};

const itemRecord = (
  item: RecoveryItem,
  attempt: RecoveryAttemptV1 | null,
  progress: RecoveryOperationProgress | null,
): RecoveryDisplayRecord => {
  let status: RecoveryDisplayStatus = item.availability;
  let transactionHash: Hash | null = attempt?.transactionHash ?? null;
  if (progress) {
    if (progress.kind === 'awaiting-wallet') status = 'awaiting-wallet';
    if (progress.kind === 'submitted') status = 'submitted';
    if (progress.kind === 'confirming') status = 'confirming';
    if (progress.kind === 'reconciling') status = 'reconciliation-pending';
    if (progress.kind === 'confirmed') status = 'confirmed';
    if ('transactionHash' in progress) transactionHash = progress.transactionHash;
  }
  const unresolvedNotice = unresolvedRecoveryAttemptNotice(attempt);
  return {
    key: item.key,
    worldwideDay: item.worldwideDay,
    path: item.path,
    label: recoveryPathLabel(item.path),
    bidder: item.bidder,
    auctionContract: item.auctionContract,
    escrowContract: item.escrowContract,
    paymentToken: item.paymentToken,
    paymentTokenDecimals: item.paymentTokenDecimals,
    paymentTokenSymbol: item.paymentTokenSymbol,
    custody: item.custody,
    returnedAmount: item.returnedAmount,
    burnedAmount: item.burnedAmount,
    claimableAt: item.claimableAt,
    latestBlockTimestamp: item.latestBlockTimestamp,
    explanation: item.explanation,
    status,
    transactionHash,
    reconciliationError:
      unresolvedNotice ??
      (attempt?.lastReconciliationError === undefined
        ? null
        : `Local transaction history: ${attempt.lastReconciliationError}`),
    claimableItem: item.availability === 'claimable' ? item : null,
  };
};

const issueRecord = (entry: RecoveryIndexIssue): RecoveryDisplayIssue => ({
  key: entry.key,
  worldwideDay: entry.worldwideDay,
  escrowContract: entry.escrowContract,
  status: entry.kind,
  message: entry.message,
});

export const buildRecoveryDisplay = (input: {
  readonly index: WalletRecoveryIndex;
  readonly attempts: readonly RecoveryAttemptV1[];
  readonly activeItemKey: string | null;
  readonly progress: RecoveryOperationProgress | null;
}): { readonly records: readonly RecoveryDisplayRecord[]; readonly issues: readonly RecoveryDisplayIssue[] } => {
  const records: RecoveryDisplayRecord[] = input.index.items.map((item) =>
    itemRecord(
      item,
      latestRecoveryAttempt(input.attempts, item.key),
      input.activeItemKey === item.key ? input.progress : null,
    ),
  );
  records.sort((left, right) => {
    if (left.worldwideDay !== right.worldwideDay) return left.worldwideDay.localeCompare(right.worldwideDay);
    const rank = (status: RecoveryDisplayStatus): number =>
      status === 'claimable'
        ? 0
        : status === 'waiting'
          ? 1
          : status === 'reconciliation-pending'
            ? 2
            : status === 'submitted' || status === 'confirming' || status === 'awaiting-wallet'
              ? 3
              : status === 'read-failure' || status === 'incompatible-historical-contract'
                ? 4
                : 5;
    const difference = rank(left.status) - rank(right.status);
    return difference === 0 ? left.path.localeCompare(right.path) : difference;
  });
  return { records, issues: input.index.issues.map(issueRecord) };
};

export const useRecoveryController = (input: Input): RecoveryController => {
  const { walletState, profile, publicClient, worldwideDay, contextToken, isContextCurrent } = input;
  const [evidence, setEvidence] = useState<RecoveryControllerEvidence>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<RecoveryOperationProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<RecoveryOperationResult | null>(null);
  const [attempts, setAttempts] = useState<readonly RecoveryAttemptV1[]>([]);
  const operationInFlight = useRef(false);
  const generation = useRef(0);
  const unpersistedAttempt = useRef<RecoveryAttemptV1 | null>(null);

  const bidder = walletState.kind === 'connected-supported' ? walletState.connection.address : null;
  const supported = bidder !== null && profile !== null && publicClient !== null;

  const refresh = useCallback(async () => {
    if (walletState.kind === 'disconnected' || walletState.kind === 'discovering') {
      setEvidence({ kind: 'blocked', message: 'Connect a wallet on the active venue to scan bidder recovery.' });
      return;
    }
    if (walletState.kind === 'connected-unsupported') {
      setEvidence({ kind: 'blocked', message: 'Switch the wallet to a supported venue to load its recovery index.' });
      return;
    }
    if (!supported || !bidder || !profile || !publicClient) {
      setEvidence({ kind: 'blocked', message: 'The active wallet and venue context is unavailable.' });
      return;
    }
    const activeGeneration = ++generation.current;
    setEvidence({ kind: 'loading' });
    try {
      const attemptStorage = recoveryAttemptStorage();
      const index = await loadWalletRecoveryIndex({
        publicClient,
        profile,
        wallet: bidder,
        candidateWorldwideDays: [worldwideDay],
      });
      if (!isContextCurrent(contextToken) || activeGeneration !== generation.current) return;
      let loadedAttempts: readonly RecoveryAttemptV1[] = [];
      let localHistoryWarning = attemptStorage.warning;
      try {
        loadedAttempts = listRecoveryAttempts(attemptStorage.storage, {
          chainId: profile.chainId,
          deploymentId: profile.deploymentId,
          bidder,
        });
      } catch (error) {
        localHistoryWarning = [
          localHistoryWarning,
          `Local recovery transaction history could not be read and was ignored. ${error instanceof Error ? error.message : String(error)}`,
        ]
          .filter((value): value is string => value !== null)
          .join(' ');
      }
      const ephemeralAttempt = unpersistedAttempt.current;
      if (ephemeralAttempt !== null) {
        if (index.items.some((item) => item.key === ephemeralAttempt.recoveryItemKey)) {
          loadedAttempts = [
            ...loadedAttempts.filter((attempt) => attempt.attemptId !== ephemeralAttempt.attemptId),
            ephemeralAttempt,
          ];
        } else {
          unpersistedAttempt.current = null;
        }
      }
      setAttempts(loadedAttempts);
      const display = buildRecoveryDisplay({ index, attempts: loadedAttempts, activeItemKey, progress });
      setEvidence({
        kind: 'loaded',
        index,
        records: display.records,
        issues: display.issues,
        storageWarning:
          [index.history.storageWarning, localHistoryWarning]
            .filter((value): value is string => value !== null)
            .join(' ') || null,
      });
    } catch (error) {
      if (!isContextCurrent(contextToken) || activeGeneration !== generation.current) return;
      setEvidence({ kind: 'failure', message: error instanceof Error ? error.message : String(error) });
    }
  }, [
    activeItemKey,
    bidder,
    contextToken,
    isContextCurrent,
    profile,
    progress,
    publicClient,
    supported,
    walletState.kind,
    worldwideDay,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset fires on context change only
  useEffect(() => {
    generation.current += 1;
    operationInFlight.current = false;
    unpersistedAttempt.current = null;
    setBusy(false);
    setActiveItemKey(null);
    setProgress(null);
    setFailure(null);
    setResult(null);
    setAttempts([]);
    void refresh();
  }, [contextToken]);

  const claim = useCallback(
    async (item: RecoveryItem) => {
      if (operationInFlight.current || busy || !profile || !publicClient || walletState.kind !== 'connected-supported')
        return;
      const activeGeneration = generation.current;
      operationInFlight.current = true;
      setBusy(true);
      setActiveItemKey(item.key);
      setProgress(null);
      setFailure(null);
      setResult(null);
      try {
        const completed = await executeRecoveryTransaction({
          publicClient,
          walletProvider: walletState.connection.provider.provider,
          profile,
          caller: walletState.connection.address,
          item,
          storage: recoveryAttemptStorage().storage,
          contextToken,
          isContextCurrent,
          onProgress: setProgress,
        });
        if (!isContextCurrent(contextToken) || activeGeneration !== generation.current) return;
        setProgress(null);
        setResult(completed);
        const label = recoveryPathLabel(item.path);
        if (completed.reconciliation === 'confirmed') {
          showSuccessToast('The recovery transaction is confirmed on-chain.', `${label} confirmed`);
        } else {
          showWarningToast(
            completed.reconciliationMessage ??
              'The transaction is confirmed, but the live recovery state is still reconciling.',
            `${label} transaction confirmed`,
          );
        }
        await refresh();
      } catch (error) {
        if (!isContextCurrent(contextToken) || activeGeneration !== generation.current) return;
        setProgress(null);
        if (error instanceof RecoveryAttemptPersistenceError) {
          unpersistedAttempt.current = error.attempt;
          setFailure(error.message);
          showWarningToast(error.message, 'Recovery submitted; tracking unavailable');
        } else {
          const message =
            error instanceof StaleRecoveryContextError
              ? 'The wallet or venue context changed. The prepared claim was discarded without retrying.'
              : error instanceof Error
                ? error.message
                : String(error);
          setFailure(message);
          showErrorToast(message, 'Recovery transaction failed');
        }
        await refresh();
      } finally {
        operationInFlight.current = false;
        if (isContextCurrent(contextToken) && activeGeneration === generation.current) setBusy(false);
      }
    },
    [busy, contextToken, isContextCurrent, profile, publicClient, refresh, walletState],
  );

  const derivedEvidence = useMemo<RecoveryControllerEvidence>(() => {
    if (evidence.kind !== 'loaded') return evidence;
    const display = buildRecoveryDisplay({ index: evidence.index, attempts, activeItemKey, progress });
    return { ...evidence, records: display.records, issues: display.issues };
  }, [activeItemKey, attempts, evidence, progress]);

  return { evidence: derivedEvidence, busy, activeItemKey, failure, result, refresh, claim };
};
