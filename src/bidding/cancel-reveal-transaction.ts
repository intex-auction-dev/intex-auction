import { createWalletClient, custom, defineChain, getAddress, type Address, type Hash, type PublicClient } from 'viem';
import {
  listStoredRevealMaterials,
  saveTransactionAttempt,
  type ReceiptStorage,
  type StoredRevealMaterialV1,
} from '../receipts/receipt-store';
import { validateRevealMaterial, type RevealMaterialV1 } from '../receipts/reveal-material';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider } from '../wallet/eip1193';
import {
  CommitPreflightError,
  StaleCommitContextError,
  readFreshCommitState,
  type CommitContextIdentity,
  type FreshCommitState,
} from './commit-transaction';
import { calculateEscrowLockMinor, UINT128_MAX } from '../domain/escrow-lock';
import { fromViemPublicClient } from '../protocol/read-client';
import { VenueAuctionAdapter } from '../protocol/venue-adapter';
import {
  createTransactionAttempt,
  persistTransactionReconciliationError,
  waitForTransactionAttempt,
} from './transaction-attempt';
import {
  describeRejectedResubmission,
  isAlreadyBroadcastError,
  submitWalletWrite,
} from '../chain/transaction-confirmation';
import { bufferedGasLimit } from '../domain/transaction-gas';

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hash;

export interface BidderActionWalletClient {
  writeContract(request: unknown): Promise<Hash>;
}

export type ActionReconciliation = 'confirmed' | 'unavailable' | 'mismatch';

export type CancelOperationProgress =
  | { readonly kind: 'cancel-submitted'; readonly transactionHash: Hash }
  | { readonly kind: 'cancel-confirming'; readonly transactionHash: Hash }
  | { readonly kind: 'reconciling' }
  | { readonly kind: 'confirmed'; readonly returnedBondAmount: bigint };

export interface CancelOperationResult {
  readonly material: RevealMaterialV1;
  readonly revealMaterialKey: string;
  readonly cancellationTransactionHash: Hash;
  readonly returnedBondAmount: bigint;
  readonly reconciliation: ActionReconciliation;
  readonly reconciliationMessage: string | null;
  readonly commitCancelledEventObserved: boolean;
  readonly commitBondReleasedEventObserved: boolean;
}

export type RevealOperationProgress =
  | { readonly kind: 'approval-required'; readonly amount: bigint; readonly spender: Address }
  | { readonly kind: 'approval-submitted'; readonly transactionHash: Hash }
  | { readonly kind: 'approval-confirming'; readonly transactionHash: Hash }
  | { readonly kind: 'ready-to-reveal' }
  | { readonly kind: 'reveal-submitted'; readonly transactionHash: Hash }
  | { readonly kind: 'reveal-confirming'; readonly transactionHash: Hash }
  | { readonly kind: 'reconciling' }
  | { readonly kind: 'confirmed'; readonly lockedAmount: bigint };

export interface RevealOperationResult {
  readonly material: RevealMaterialV1;
  readonly revealMaterialKey: string;
  readonly approvalTransactionHash: Hash | null;
  readonly revealTransactionHash: Hash;
  readonly fullLockAmount: bigint;
  readonly effectiveBalance: bigint;
  readonly liveBondContribution: bigint;
  readonly reconciliation: ActionReconciliation;
  readonly reconciliationMessage: string | null;
  readonly bidRevealedEventObserved: boolean;
  readonly fundsLockedEventObserved: boolean;
  readonly commitBondReleasedEventObserved: boolean;
}

const currentContext = (input: {
  readonly context: CommitContextIdentity;
  readonly isContextCurrent: (token: string) => boolean;
}): void => {
  if (!input.isContextCurrent(input.context.token)) {
    throw new StaleCommitContextError('Wallet, venue or auction context changed during the bidder operation.');
  }
};

const createActionWalletClient = (input: {
  readonly walletProvider?: Eip1193Provider;
  readonly walletClient?: BidderActionWalletClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly context: CommitContextIdentity;
}): BidderActionWalletClient => {
  if (input.walletClient) return input.walletClient;
  if (!input.walletProvider) throw new CommitPreflightError('A connected wallet provider is required.');
  return createWalletClient({
    account: input.context.bidder,
    chain: defineChain({
      id: input.context.chainId,
      name: input.profile.name,
      nativeCurrency: { name: 'Venue native currency', symbol: 'NATIVE', decimals: 18 },
      rpcUrls: { default: { http: [...input.profile.rpcUrls] } },
    }),
    transport: custom(input.walletProvider, { retryCount: 0 }),
  }) as unknown as BidderActionWalletClient;
};

const adapterFor = (publicClient: PublicClient, profile: ResolvedVenueReadProfile): VenueAuctionAdapter =>
  new VenueAuctionAdapter(fromViemPublicClient(publicClient), profile);

const requireReviewedWiring = (state: FreshCommitState, profile: ResolvedVenueReadProfile): void => {
  if (
    getAddress(state.escrowAdapter) !== getAddress(profile.addresses.escrowAdapter) ||
    getAddress(state.escrowAuction) !== getAddress(profile.addresses.intexAuction) ||
    getAddress(state.paymentToken) !== getAddress(profile.addresses.paymentToken)
  ) {
    throw new CommitPreflightError(
      'The current auction, escrow adapter or payment token wiring does not match the reviewed venue profile.',
    );
  }
};

const sameReviewedState = (left: FreshCommitState, right: FreshCommitState): boolean =>
  left.escrowAdapter === right.escrowAdapter &&
  left.escrowAuction === right.escrowAuction &&
  left.paymentToken === right.paymentToken &&
  left.params.issuanceCurrencies.length === right.params.issuanceCurrencies.length &&
  left.params.issuanceCurrencies.every((currency, index) => currency === right.params.issuanceCurrencies[index]) &&
  left.params.issuanceEntryPrices.length === right.params.issuanceEntryPrices.length &&
  left.params.issuanceEntryPrices.every((value, index) => value === right.params.issuanceEntryPrices[index]) &&
  left.params.strikeAmountsMinor.length === right.params.strikeAmountsMinor.length &&
  left.params.strikeAmountsMinor.every((value, index) => value === right.params.strikeAmountsMinor[index]) &&
  left.params.oraclePairIds.length === right.params.oraclePairIds.length &&
  left.params.oraclePairIds.every((value, index) => value === right.params.oraclePairIds[index]) &&
  left.params.referenceCurrency === right.params.referenceCurrency &&
  left.params.referenceCurrencies.length === right.params.referenceCurrencies.length &&
  left.params.referenceCurrencies.every((currency, index) => currency === right.params.referenceCurrencies[index]) &&
  left.params.entryPriceMinor === right.params.entryPriceMinor &&
  left.params.floorPriceMinor === right.params.floorPriceMinor &&
  left.params.callPriceMinor === right.params.callPriceMinor &&
  left.params.promisLoadMinor === right.params.promisLoadMinor &&
  left.params.minIntexBidRate === right.params.minIntexBidRate &&
  left.params.minIntexBidQuantity === right.params.minIntexBidQuantity &&
  left.params.commitBondMinor === right.params.commitBondMinor &&
  left.schedule.commitEnd === right.schedule.commitEnd &&
  left.schedule.revealEnd === right.schedule.revealEnd &&
  left.schedule.issuanceEnd === right.schedule.issuanceEnd;

const materialMatchesContext = (material: RevealMaterialV1, context: CommitContextIdentity): boolean =>
  material.chainId === context.chainId &&
  material.deploymentId === context.deploymentId &&
  getAddress(material.auctionProxy) === getAddress(context.auctionProxy) &&
  getAddress(material.bidder) === getAddress(context.bidder) &&
  material.worldwideDay === Number(context.worldwideDay);

export const selectLiveRevealMaterial = async (input: {
  readonly storage: ReceiptStorage;
  readonly context: CommitContextIdentity;
  readonly liveCommitHash: Hash;
  readonly promisLoadMinor: bigint;
}): Promise<{ readonly key: string; readonly stored: StoredRevealMaterialV1 }> => {
  if (input.liveCommitHash === ZERO_HASH) throw new CommitPreflightError('No live commitment exists for this bidder.');
  const records = await listStoredRevealMaterials(input.storage);
  const sameHash = records.filter(({ stored }) => stored.material.commitHash === input.liveCommitHash);
  const match = sameHash.find(({ stored }) => materialMatchesContext(stored.material, input.context));
  if (!match) {
    if (sameHash.length > 0) {
      throw new CommitPreflightError('The matching receipt belongs to another wallet, chain or deployment context.');
    }
    throw new CommitPreflightError('The live commitment has no exact matching reveal receipt in this browser.');
  }
  const material = await validateRevealMaterial(match.stored.material, { promisLoadMinor: input.promisLoadMinor });
  if (!materialMatchesContext(material, input.context) || material.commitHash !== input.liveCommitHash) {
    throw new CommitPreflightError('Stored reveal material does not match the active bidder commitment.');
  }
  return { key: match.key, stored: { ...match.stored, material } };
};

export const executeCancelCommitTransaction = async (input: {
  readonly publicClient: PublicClient;
  readonly walletProvider?: Eip1193Provider;
  readonly walletClient?: BidderActionWalletClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly context: CommitContextIdentity;
  readonly storage: ReceiptStorage;
  readonly isContextCurrent: (token: string) => boolean;
  readonly onProgress?: (progress: CancelOperationProgress) => void;
  readonly now?: () => string;
}): Promise<CancelOperationResult> => {
  const now = input.now ?? (() => new Date().toISOString());
  const adapter = adapterFor(input.publicClient, input.profile);
  currentContext(input);
  const readFresh = (): Promise<FreshCommitState> =>
    readFreshCommitState({
      publicClient: input.publicClient,
      profile: input.profile,
      bidder: input.context.bidder,
      worldwideDay: input.context.worldwideDay,
    });
  const prepared = await readFresh();
  currentContext(input);
  requireReviewedWiring(prepared, input.profile);
  if (prepared.stage !== 'committing-bids')
    throw new CommitPreflightError('Commit cancellation is only available during the commit stage.');
  if (prepared.liveCommitHash === ZERO_HASH)
    throw new CommitPreflightError('This bidder has no live commitment to cancel.');
  if (prepared.bidderRevealed) throw new CommitPreflightError('A revealed bid cannot be cancelled.');
  const selected = await selectLiveRevealMaterial({
    storage: input.storage,
    context: input.context,
    liveCommitHash: prepared.liveCommitHash,
    promisLoadMinor: prepared.params.promisLoadMinor,
  });
  currentContext(input);

  const fresh = await readFresh();
  currentContext(input);
  requireReviewedWiring(fresh, input.profile);
  if (
    !sameReviewedState(prepared, fresh) ||
    fresh.stage !== 'committing-bids' ||
    fresh.liveCommitHash !== selected.stored.material.commitHash ||
    fresh.bidderRevealed ||
    fresh.bidderBondAmount !== prepared.bidderBondAmount
  ) {
    throw new CommitPreflightError('The bidder commitment or reviewed venue state changed before cancellation.');
  }

  const cancelRequest = { account: input.context.bidder, ...adapter.buildCancelCommitCall(input.context.worldwideDay) };
  await input.publicClient.simulateContract(cancelRequest as never);
  const cancelGas = await input.publicClient.estimateContractGas(cancelRequest as never);
  (cancelRequest as { gas?: bigint }).gas = bufferedGasLimit(cancelGas);
  currentContext(input);
  const walletClient = createActionWalletClient(input);
  const transactionHash = await submitWalletWrite({
    submit: () => walletClient.writeContract(cancelRequest),
    publicClient: input.publicClient,
    sender: input.context.bidder,
    label: 'cancellation',
  });
  input.onProgress?.({ kind: 'cancel-submitted', transactionHash });
  let attempt = saveTransactionAttempt(
    input.storage,
    createTransactionAttempt({
      kind: 'cancellation',
      revealMaterialKey: selected.key,
      transactionHash,
      now: now(),
    }),
  );
  input.onProgress?.({ kind: 'cancel-confirming', transactionHash });
  const waited = await waitForTransactionAttempt({
    publicClient: input.publicClient,
    storage: input.storage,
    initialAttempt: attempt,
    confirmations: input.profile.confirmationDepth,
    label: 'Cancellation',
    now,
  });
  attempt = waited.attempt;
  const finalHash = attempt.transactionHash ?? transactionHash;
  currentContext(input);

  input.onProgress?.({ kind: 'reconciling' });
  let reconciliation: ActionReconciliation = 'confirmed';
  let reconciliationMessage: string | null = null;
  const events = adapter.readCancellationReceiptEvidence(waited.receipt, {
    worldwideDay: input.context.worldwideDay,
    bidder: input.context.bidder,
    escrowContract: prepared.escrowAdapter,
    bondAmount: prepared.bidderBondAmount,
  });
  try {
    const reconciled = await readFresh();
    currentContext(input);
    if (
      reconciled.liveCommitHash !== ZERO_HASH ||
      reconciled.bidderBondAmount !== 0n ||
      reconciled.bidderRevealed ||
      !events.cancelled ||
      (prepared.bidderBondAmount > 0n && !events.released)
    ) {
      reconciliation = 'mismatch';
      reconciliationMessage =
        'The confirmed cancellation does not yet reconcile with commitment, bond and cancellation-event evidence.';
      attempt = persistTransactionReconciliationError({
        storage: input.storage,
        attempt,
        message: reconciliationMessage,
        now: now(),
        kind: 'contract-mismatch',
      });
    }
  } catch (error) {
    if (error instanceof StaleCommitContextError) throw error;
    reconciliation = 'unavailable';
    reconciliationMessage = error instanceof Error ? error.message : String(error);
    attempt = persistTransactionReconciliationError({
      storage: input.storage,
      attempt,
      message: reconciliationMessage,
      now: now(),
    });
  }
  void attempt;
  if (reconciliation === 'confirmed')
    input.onProgress?.({ kind: 'confirmed', returnedBondAmount: prepared.bidderBondAmount });
  return {
    material: selected.stored.material,
    revealMaterialKey: selected.key,
    cancellationTransactionHash: finalHash,
    returnedBondAmount: prepared.bidderBondAmount,
    reconciliation,
    reconciliationMessage,
    commitCancelledEventObserved: events.cancelled,
    commitBondReleasedEventObserved: events.released,
  };
};

const validateRevealPreparedState = (state: FreshCommitState, selectedHash: Hash): void => {
  if (state.stage !== 'revealing-bids')
    throw new CommitPreflightError('The venue is not currently accepting bid reveals.');
  if (state.liveCommitHash !== selectedHash)
    throw new CommitPreflightError('The live commitment changed before reveal submission.');
  if (state.bidderRevealed) throw new CommitPreflightError('This bidder has already revealed.');
  if (state.bidLock.status !== 'none') throw new CommitPreflightError('This bidder already has an escrow bid lock.');
};

export const executeRevealBidTransaction = async (input: {
  readonly publicClient: PublicClient;
  readonly walletProvider?: Eip1193Provider;
  readonly walletClient?: BidderActionWalletClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly context: CommitContextIdentity;
  readonly storage: ReceiptStorage;
  readonly isContextCurrent: (token: string) => boolean;
  readonly onProgress?: (progress: RevealOperationProgress) => void;
  readonly now?: () => string;
}): Promise<RevealOperationResult> => {
  const now = input.now ?? (() => new Date().toISOString());
  const adapter = adapterFor(input.publicClient, input.profile);
  currentContext(input);
  const readFresh = (): Promise<FreshCommitState> =>
    readFreshCommitState({
      publicClient: input.publicClient,
      profile: input.profile,
      bidder: input.context.bidder,
      worldwideDay: input.context.worldwideDay,
    });
  const prepared = await readFresh();
  currentContext(input);
  requireReviewedWiring(prepared, input.profile);
  if (prepared.liveCommitHash === ZERO_HASH)
    throw new CommitPreflightError('This bidder has no live commitment to reveal.');
  const selected = await selectLiveRevealMaterial({
    storage: input.storage,
    context: input.context,
    liveCommitHash: prepared.liveCommitHash,
    promisLoadMinor: prepared.params.promisLoadMinor,
  });
  const material = selected.stored.material;
  if (!prepared.params.issuanceCurrencies.includes(material.issuanceCurrency)) {
    throw new CommitPreflightError('Reveal receipt issuance currency is no longer enabled by the auction contract.');
  }
  validateRevealPreparedState(prepared, material.commitHash);
  if (material.chainId !== input.context.chainId)
    throw new CommitPreflightError('Reveal material chain ID does not match the active chain.');
  if (material.quantity < prepared.params.minIntexBidQuantity || material.quantity <= 0) {
    throw new CommitPreflightError('Reveal quantity is below the current auction minimum.');
  }
  if (material.bidRate < prepared.params.minIntexBidRate || material.bidRate <= 0 || material.bidRate > 1_000_000) {
    throw new CommitPreflightError('Reveal bid rate is outside the current auction range.');
  }
  const fullLockAmount = calculateEscrowLockMinor({
    quantity: BigInt(material.quantity),
    promisLoadMinor: prepared.params.promisLoadMinor,
    bidRate: BigInt(material.bidRate),
  });
  if (fullLockAmount <= 0n || fullLockAmount > UINT128_MAX) {
    throw new CommitPreflightError('The calculated reveal lock is outside the supported range.');
  }
  const effectiveBalance = prepared.balance + prepared.bidderBondAmount;
  if (effectiveBalance < fullLockAmount) {
    throw new CommitPreflightError(
      'Wallet balance plus the live commit bond is insufficient for the full reveal lock.',
    );
  }

  const walletClient = createActionWalletClient(input);
  let approvalTransactionHash: Hash | null = null;
  if (prepared.allowance < fullLockAmount) {
    input.onProgress?.({ kind: 'approval-required', amount: fullLockAmount, spender: prepared.escrowAdapter });
    try {
      const approvalRequest = {
        account: input.context.bidder,
        ...adapter.buildApprovalCall({
          token: prepared.paymentToken,
          spender: prepared.escrowAdapter,
          amount: fullLockAmount,
        }),
      };
      await input.publicClient.simulateContract(approvalRequest as never);
      const approvalGas = await input.publicClient.estimateContractGas(approvalRequest as never);
      (approvalRequest as { gas?: bigint }).gas = bufferedGasLimit(approvalGas);
      currentContext(input);
      const preSubmitState = await readFresh();
      if (preSubmitState.allowance < fullLockAmount) {
        approvalTransactionHash = await walletClient.writeContract(approvalRequest);
      }
    } catch (approvalError) {
      if (isAlreadyBroadcastError(approvalError)) {
        const recovered = await readFresh();
        if (recovered.allowance >= fullLockAmount) {
          approvalTransactionHash = null;
        } else {
          throw new CommitPreflightError(
            await describeRejectedResubmission({
              publicClient: input.publicClient,
              sender: input.context.bidder,
              context:
                'The escrow approval could not be submitted and the allowance is still insufficient for the reveal lock.',
              error: approvalError,
            }),
          );
        }
      } else {
        throw approvalError;
      }
    }
    if (approvalTransactionHash) {
      input.onProgress?.({ kind: 'approval-submitted', transactionHash: approvalTransactionHash });
      // Mirrors the commit path: the reveal-stage approval is a broadcast against the
      // bidder's own allowance and needs the same durable attempt record, so a mined
      // approval remains visible if the reveal itself fails.
      const approvalAttempt = saveTransactionAttempt(
        input.storage,
        createTransactionAttempt({
          kind: 'approval',
          revealMaterialKey: selected.key,
          transactionHash: approvalTransactionHash,
          now: now(),
        }),
      );
      input.onProgress?.({ kind: 'approval-confirming', transactionHash: approvalTransactionHash });
      const approvalWait = await waitForTransactionAttempt({
        publicClient: input.publicClient,
        storage: input.storage,
        initialAttempt: approvalAttempt,
        confirmations: input.profile.confirmationDepth,
        label: 'Approval',
        now,
      });
      approvalTransactionHash = approvalWait.attempt.transactionHash ?? approvalTransactionHash;
      if (approvalWait.receipt.status === 'reverted') {
        throw new CommitPreflightError('Approval transaction reverted.');
      }
    }
    currentContext(input);
  }

  const fresh = await readFresh();
  currentContext(input);
  requireReviewedWiring(fresh, input.profile);
  if (
    !sameReviewedState(prepared, fresh) ||
    fresh.balance !== prepared.balance ||
    fresh.bidderBondAmount !== prepared.bidderBondAmount
  ) {
    throw new CommitPreflightError(
      'Auction state, bidder balance, live bond or contract wiring changed during reveal preparation.',
    );
  }
  validateRevealPreparedState(fresh, material.commitHash);
  if (fresh.balance + fresh.bidderBondAmount < fullLockAmount) {
    throw new CommitPreflightError('Effective balance became insufficient before reveal submission.');
  }
  if (fresh.allowance < fullLockAmount)
    throw new CommitPreflightError('The fresh allowance is insufficient for the full reveal lock.');

  input.onProgress?.({ kind: 'ready-to-reveal' });
  const revealRequest = {
    account: input.context.bidder,
    ...adapter.buildRevealCall({
      worldwideDay: input.context.worldwideDay,
      quantity: material.quantity,
      bidRate: material.bidRate,
      issuanceCurrency: material.issuanceCurrency,
      referenceCurrency: material.referenceCurrency,
      chainId: input.context.chainId,
      signature: material.signature,
    }),
  };
  await input.publicClient.simulateContract(revealRequest as never);
  const revealGas = await input.publicClient.estimateContractGas(revealRequest as never);
  (revealRequest as { gas?: bigint }).gas = bufferedGasLimit(revealGas);
  currentContext(input);
  const transactionHash = await submitWalletWrite({
    submit: () => walletClient.writeContract(revealRequest),
    publicClient: input.publicClient,
    sender: input.context.bidder,
    label: 'reveal',
  });
  input.onProgress?.({ kind: 'reveal-submitted', transactionHash });
  let revealAttempt = saveTransactionAttempt(
    input.storage,
    createTransactionAttempt({
      kind: 'reveal',
      revealMaterialKey: selected.key,
      transactionHash,
      now: now(),
    }),
  );
  input.onProgress?.({ kind: 'reveal-confirming', transactionHash });
  const waited = await waitForTransactionAttempt({
    publicClient: input.publicClient,
    storage: input.storage,
    initialAttempt: revealAttempt,
    confirmations: input.profile.confirmationDepth,
    label: 'Reveal',
    now,
  });
  revealAttempt = waited.attempt;
  const finalHash = revealAttempt.transactionHash ?? transactionHash;
  currentContext(input);

  input.onProgress?.({ kind: 'reconciling' });
  const events = adapter.readRevealReceiptEvidence(waited.receipt, {
    worldwideDay: input.context.worldwideDay,
    bidder: input.context.bidder,
    escrowContract: prepared.escrowAdapter,
    issuanceCurrency: material.issuanceCurrency,
    quantity: material.quantity,
    bidRate: material.bidRate,
    lockAmount: fullLockAmount,
    bondAmount: prepared.bidderBondAmount,
  });
  let reconciliation: ActionReconciliation = 'confirmed';
  let reconciliationMessage: string | null = null;
  try {
    const reconciled = await readFresh();
    currentContext(input);
    if (
      !reconciled.bidderRevealed ||
      reconciled.liveCommitHash !== ZERO_HASH ||
      reconciled.bidderBondAmount !== 0n ||
      reconciled.bidLock.status !== 'locked' ||
      reconciled.bidLock.lockedAmount !== fullLockAmount ||
      reconciled.bidLock.lockedAt <= 0n ||
      !events.revealed ||
      !events.locked ||
      (prepared.bidderBondAmount > 0n && !events.released)
    ) {
      reconciliation = 'mismatch';
      reconciliationMessage =
        'The confirmed reveal does not yet reconcile with revealed, commitment, bond, escrow-lock and event evidence.';
      revealAttempt = persistTransactionReconciliationError({
        storage: input.storage,
        attempt: revealAttempt,
        message: reconciliationMessage,
        now: now(),
        kind: 'contract-mismatch',
      });
    }
  } catch (error) {
    if (error instanceof StaleCommitContextError) throw error;
    reconciliation = 'unavailable';
    reconciliationMessage = error instanceof Error ? error.message : String(error);
    revealAttempt = persistTransactionReconciliationError({
      storage: input.storage,
      attempt: revealAttempt,
      message: reconciliationMessage,
      now: now(),
    });
  }
  void revealAttempt;
  if (reconciliation === 'confirmed') input.onProgress?.({ kind: 'confirmed', lockedAmount: fullLockAmount });
  return {
    material,
    revealMaterialKey: selected.key,
    approvalTransactionHash,
    revealTransactionHash: finalHash,
    fullLockAmount,
    effectiveBalance,
    liveBondContribution: prepared.bidderBondAmount,
    reconciliation,
    reconciliationMessage,
    bidRevealedEventObserved: events.revealed,
    fundsLockedEventObserved: events.locked,
    commitBondReleasedEventObserved: events.released,
  };
};
