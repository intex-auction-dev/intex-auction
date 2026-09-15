import { createWalletClient, custom, defineChain, getAddress, type Address, type Hash, type PublicClient } from 'viem';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import { submitWalletWrite } from '../chain/transaction-confirmation';
import type { Eip1193Provider } from '../wallet/eip1193';
import { parseWalletAccounts, parseWalletChainId } from '../wallet/eip1193';
import { fromViemPublicClient } from '../protocol/read-client';
import { VenueAuctionAdapter } from '../protocol/venue-adapter';
import {
  createRecoveryAttempt,
  persistRecoveryReconciliationError,
  saveRecoveryAttempt,
  waitForRecoveryAttempt,
  type RecoveryAttemptStorage,
  type RecoveryAttemptV1,
} from './recovery-attempt';
import type { RecoveryItem } from './recovery-domain';
import { refreshRecoveryItem, sameRecoveryEconomics } from './recovery-index';
import { bufferedGasLimit } from '../domain/transaction-gas';

export class RecoveryPreflightError extends Error {}
export class StaleRecoveryContextError extends Error {}

export interface RecoveryWalletClient {
  writeContract(request: unknown): Promise<Hash>;
}

export type RecoveryOperationProgress =
  | { readonly kind: 'awaiting-wallet' }
  | { readonly kind: 'submitted'; readonly transactionHash: Hash }
  | { readonly kind: 'confirming'; readonly transactionHash: Hash }
  | { readonly kind: 'reconciling'; readonly transactionHash: Hash }
  | { readonly kind: 'confirmed'; readonly transactionHash: Hash };

export interface RecoveryOperationResult {
  readonly item: RecoveryItem;
  readonly transactionHash: Hash;
  readonly attempt: RecoveryAttemptV1;
  readonly reconciliation: 'confirmed' | 'unavailable' | 'mismatch';
  readonly reconciliationMessage: string | null;
  readonly commitBondReleasedEventObserved: boolean;
  readonly fundsRefundedEventObserved: boolean;
  readonly proceedsBurnedEventObserved: boolean;
}

interface RecoveryReceiptEvidence {
  readonly released: boolean;
  readonly refunded: boolean;
  readonly burned: boolean;
  readonly unexpectedRefund: boolean;
  readonly unexpectedBurn: boolean;
}

const requireCurrentContext = (input: {
  readonly contextToken: string;
  readonly isContextCurrent: (token: string) => boolean;
}): void => {
  if (!input.isContextCurrent(input.contextToken)) {
    throw new StaleRecoveryContextError('Wallet, venue or auction context changed during recovery.');
  }
};

const createRecoveryWalletClient = (input: {
  readonly walletProvider?: Eip1193Provider;
  readonly walletClient?: RecoveryWalletClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly caller: Address;
}): RecoveryWalletClient => {
  if (input.walletClient) return input.walletClient;
  if (!input.walletProvider) throw new RecoveryPreflightError('A connected wallet provider is required.');
  return createWalletClient({
    account: input.caller,
    chain: defineChain({
      id: input.profile.chainId,
      name: input.profile.name,
      nativeCurrency: { name: 'Venue native currency', symbol: 'NATIVE', decimals: 18 },
      rpcUrls: { default: { http: [...input.profile.rpcUrls] } },
    }),
    transport: custom(input.walletProvider, { retryCount: 0 }),
  }) as unknown as RecoveryWalletClient;
};

const readWalletContext = async (input: {
  readonly walletProvider?: Eip1193Provider;
  readonly caller: Address;
  readonly chainId: number;
}): Promise<void> => {
  if (!input.walletProvider) return;
  const [chainRaw, accountsRaw] = await Promise.all([
    input.walletProvider.request({ method: 'eth_chainId' }),
    input.walletProvider.request({ method: 'eth_accounts' }),
  ]);
  if (parseWalletChainId(chainRaw) !== input.chainId) {
    throw new RecoveryPreflightError('The wallet is no longer connected to the selected venue chain.');
  }
  const accounts = parseWalletAccounts(accountsRaw);
  if (accounts.length === 0 || getAddress(accounts[0]!) !== getAddress(input.caller)) {
    throw new RecoveryPreflightError('The wallet account changed before recovery submission.');
  }
};

const reconciliationFailure = (item: RecoveryItem, events: RecoveryReceiptEvidence): string | null => {
  if (item.path === 'auction-commit-bond' || item.path === 'escrow-abandoned-commit-bond') {
    return events.released
      ? null
      : 'The confirmed claim is missing exact CommitBondReleased evidence for the recorded bidder and amount.';
  }
  if (events.unexpectedRefund || events.unexpectedBurn) {
    return 'The confirmed claim emitted refund or burn evidence with an unexpected amount.';
  }
  if (item.returnedAmount > 0n && !events.refunded) {
    return 'The confirmed claim is missing exact FundsRefunded evidence for the recorded bidder and amount.';
  }
  if (item.returnedAmount === 0n && events.refunded) {
    return 'The confirmed claim unexpectedly emitted a nonzero refund for a zero-return recovery.';
  }
  if (item.burnedAmount > 0n && !events.burned) {
    return 'The confirmed claim is missing exact ProceedsBurned evidence for the recorded bidder and amount.';
  }
  if (item.burnedAmount === 0n && events.burned) {
    return 'The confirmed claim unexpectedly burned proceeds.';
  }
  return null;
};

export const executeRecoveryTransaction = async (input: {
  readonly publicClient: PublicClient;
  readonly walletProvider?: Eip1193Provider;
  readonly walletClient?: RecoveryWalletClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly caller: Address;
  readonly item: RecoveryItem;
  readonly storage: RecoveryAttemptStorage;
  readonly contextToken: string;
  readonly isContextCurrent: (token: string) => boolean;
  readonly onProgress?: (progress: RecoveryOperationProgress) => void;
  readonly now?: () => string;
}): Promise<RecoveryOperationResult> => {
  const now = input.now ?? (() => new Date().toISOString());
  const adapter = new VenueAuctionAdapter(fromViemPublicClient(input.publicClient), input.profile);
  requireCurrentContext(input);
  await readWalletContext({
    caller: input.caller,
    chainId: input.profile.chainId,
    ...(input.walletProvider === undefined ? {} : { walletProvider: input.walletProvider }),
  });
  requireCurrentContext(input);

  const prepared = await refreshRecoveryItem({
    publicClient: input.publicClient,
    profile: input.profile,
    item: input.item,
  });
  requireCurrentContext(input);
  if (!prepared) throw new RecoveryPreflightError('This recovery item is no longer active.');
  if (!sameRecoveryEconomics(input.item, prepared)) {
    throw new RecoveryPreflightError('Recovery state or economic outcome changed. Refresh before submitting.');
  }
  if (prepared.availability !== 'claimable') {
    throw new RecoveryPreflightError('The latest venue block has not reached the recovery deadline.');
  }

  await readWalletContext({
    caller: input.caller,
    chainId: input.profile.chainId,
    ...(input.walletProvider === undefined ? {} : { walletProvider: input.walletProvider }),
  });
  requireCurrentContext(input);
  const fresh = await refreshRecoveryItem({ publicClient: input.publicClient, profile: input.profile, item: prepared });
  requireCurrentContext(input);
  if (!fresh || !sameRecoveryEconomics(prepared, fresh) || fresh.availability !== 'claimable') {
    throw new RecoveryPreflightError('Recovery state changed during preflight. Nothing was submitted.');
  }

  const request = {
    account: input.caller,
    ...adapter.buildRecoveryCall({
      path: fresh.path,
      worldwideDay: fresh.worldwideDay,
      bidder: fresh.bidder,
      auctionContract: fresh.auctionContract,
      escrowContract: fresh.escrowContract,
    }),
  };
  await input.publicClient.simulateContract(request as never);
  const gas = await input.publicClient.estimateContractGas(request as never);
  (request as { gas?: bigint }).gas = bufferedGasLimit(gas);
  await readWalletContext({
    caller: input.caller,
    chainId: input.profile.chainId,
    ...(input.walletProvider === undefined ? {} : { walletProvider: input.walletProvider }),
  });
  requireCurrentContext(input);

  const walletClient = createRecoveryWalletClient(input);
  input.onProgress?.({ kind: 'awaiting-wallet' });
  const transactionHash = await submitWalletWrite({
    submit: () => walletClient.writeContract(request),
    publicClient: input.publicClient,
    sender: input.caller,
    label: 'recovery',
  });
  let attempt = saveRecoveryAttempt(
    input.storage,
    createRecoveryAttempt({
      item: fresh,
      chainId: input.profile.chainId,
      deploymentId: input.profile.deploymentId,
      transactionHash,
      now: now(),
    }),
  );
  input.onProgress?.({ kind: 'submitted', transactionHash });
  input.onProgress?.({ kind: 'confirming', transactionHash });
  const waited = await waitForRecoveryAttempt({
    publicClient: input.publicClient,
    storage: input.storage,
    initialAttempt: attempt,
    confirmations: input.profile.confirmationDepth,
    now,
  });
  attempt = waited.attempt;
  const finalHash = attempt.transactionHash;
  requireCurrentContext(input);
  input.onProgress?.({ kind: 'reconciling', transactionHash: finalHash });

  let reconciliation: RecoveryOperationResult['reconciliation'] = 'confirmed';
  let reconciliationMessage: string | null = null;
  const events = adapter.readRecoveryReceiptEvidence(waited.receipt, {
    worldwideDay: fresh.worldwideDay,
    bidder: fresh.bidder,
    escrowContract: fresh.escrowContract,
    returnedAmount: fresh.returnedAmount,
    burnedAmount: fresh.burnedAmount,
  });
  const eventFailure = reconciliationFailure(fresh, events);
  try {
    const reconciled = await refreshRecoveryItem({
      publicClient: input.publicClient,
      profile: input.profile,
      item: fresh,
    });
    requireCurrentContext(input);
    if (reconciled !== null || eventFailure !== null) {
      reconciliation = 'mismatch';
      reconciliationMessage = eventFailure ?? 'The confirmed claim did not clear the bidder-level bond or lock state.';
      attempt = persistRecoveryReconciliationError({
        storage: input.storage,
        attempt,
        message: reconciliationMessage,
        now: now(),
      });
    }
  } catch (error) {
    if (error instanceof StaleRecoveryContextError) throw error;
    reconciliation = 'unavailable';
    reconciliationMessage = error instanceof Error ? error.message : String(error);
    attempt = persistRecoveryReconciliationError({
      storage: input.storage,
      attempt,
      message: reconciliationMessage,
      now: now(),
    });
  }
  if (reconciliation === 'confirmed') input.onProgress?.({ kind: 'confirmed', transactionHash: finalHash });
  return {
    item: fresh,
    transactionHash: finalHash,
    attempt,
    reconciliation,
    reconciliationMessage,
    commitBondReleasedEventObserved: events.released,
    fundsRefundedEventObserved: events.refunded,
    proceedsBurnedEventObserved: events.burned,
  };
};
