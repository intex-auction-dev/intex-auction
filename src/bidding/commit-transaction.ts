import { probeStorage } from '../persistence/available-storage';
import {
  createWalletClient,
  defineChain,
  custom,
  getAddress,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import type { WorldwideDayKey } from '../domain/protocol-time';
import {
  describeRejectedResubmission,
  isAlreadyBroadcastError,
  submitWalletWrite,
} from '../chain/transaction-confirmation';
import {
  listStoredRevealMaterials,
  persistRevealMaterial,
  saveTransactionAttempt,
  type ReceiptStorage,
  type StoredRevealMaterialV1,
  type TransactionAttemptKind,
} from '../receipts/receipt-store';
import {
  buildRevealBidTypedData,
  createRevealMaterial,
  validateRevealMaterial,
  type RevealMaterialV1,
} from '../receipts/reveal-material';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider } from '../wallet/eip1193';
import { validateCommitBidInput, type ValidatedCommitBid } from '../domain/commit-domain';
import { fromViemPublicClient } from '../protocol/read-client';
import { IncompatibleWiringError } from '../chain/revert-classify';
import { VenueAuctionAdapter } from '../protocol/venue-adapter';
import type { VenueBidderState, VenueBidLockStatus } from '../protocol/profile-types';
import {
  createTransactionAttempt,
  persistTransactionReconciliationError,
  waitForTransactionAttempt,
} from './transaction-attempt';
import { bufferedGasLimit } from '../domain/transaction-gas';

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hash;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const SUPPORTED_ISSUANCE_CURRENCIES = Object.freeze(Array.from({ length: 999 }, (_, index) => index + 1));

export const WHITELIST_INELIGIBLE_MESSAGE =
  'This wallet is not on the auction whitelist and cannot commit a bid. Ask the deployment operator to add it, then reconnect.';

const AUCTION_WHITELIST_ABI = [
  { type: 'function', name: 'whitelist', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const IWHITELIST_ABI = [
  {
    type: 'function',
    name: 'isWhitelisted',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

export class StaleCommitContextError extends Error {}
export class CommitPreflightError extends Error {}

export interface CommitContextIdentity {
  readonly token: string;
  readonly chainId: number;
  readonly deploymentId: string;
  readonly auctionProxy: Address;
  readonly bidder: Address;
  readonly worldwideDay: WorldwideDayKey;
}

export type BidLockStatus = VenueBidLockStatus;
export type FreshCommitState = VenueBidderState;

export type CommitOperationProgress =
  | { readonly kind: 'requesting-signature' }
  | { readonly kind: 'persisting-receipt' }
  | { readonly kind: 'approval-required'; readonly amount: bigint; readonly spender: Address }
  | { readonly kind: 'approval-submitted'; readonly transactionHash: Hash }
  | { readonly kind: 'approval-confirming'; readonly transactionHash: Hash }
  | { readonly kind: 'ready-to-commit' }
  | { readonly kind: 'commit-submitted'; readonly transactionHash: Hash }
  | { readonly kind: 'commit-confirming'; readonly transactionHash: Hash }
  | { readonly kind: 'reconciling' }
  | { readonly kind: 'confirmed'; readonly commitHash: Hash };

export interface CommitWalletClient {
  signTypedData(request: unknown): Promise<Hex>;
  writeContract(request: unknown): Promise<Hash>;
}

export interface CommitOperationResult {
  readonly kind: 'commit' | 'recommit';
  readonly material: RevealMaterialV1;
  readonly revealMaterialKey: string;
  readonly validatedBid: ValidatedCommitBid;
  readonly approvalTransactionHash: Hash | null;
  readonly commitTransactionHash: Hash;
  readonly reconciliation: 'confirmed' | 'unavailable' | 'mismatch';
  readonly reconciliationMessage: string | null;
  readonly bidCommittedEventObserved: boolean;
}

const contextIsCurrent = (input: {
  readonly context: CommitContextIdentity;
  readonly isContextCurrent: (token: string) => boolean;
}): void => {
  if (!input.isContextCurrent(input.context.token)) {
    throw new StaleCommitContextError('Wallet, venue or auction context changed during the commit operation.');
  }
};

const assertStorageAvailable = (storage: ReceiptStorage): void => {
  const probe = probeStorage(storage);
  if (!probe.ok) {
    throw new CommitPreflightError(`Browser receipt storage is unavailable: ${probe.reason}`);
  }
};

const adapterFor = (publicClient: PublicClient, profile: ResolvedVenueReadProfile): VenueAuctionAdapter =>
  new VenueAuctionAdapter(fromViemPublicClient(publicClient), profile);

const requireWhitelistEligibility = async (input: {
  readonly publicClient: PublicClient;
  readonly auctionProxy: Address;
  readonly bidder: Address;
}): Promise<void> => {
  const registry = (await input.publicClient.readContract({
    address: input.auctionProxy,
    abi: AUCTION_WHITELIST_ABI,
    functionName: 'whitelist',
  })) as Address;
  if (registry === ZERO_ADDRESS) return;
  const eligible = (await input.publicClient.readContract({
    address: registry,
    abi: IWHITELIST_ABI,
    functionName: 'isWhitelisted',
    args: [input.bidder],
  })) as boolean;
  if (!eligible) {
    throw new CommitPreflightError(WHITELIST_INELIGIBLE_MESSAGE);
  }
};

export const readFreshCommitState = async (input: {
  readonly publicClient: PublicClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly bidder: Address;
  readonly worldwideDay: WorldwideDayKey;
}): Promise<FreshCommitState> => {
  try {
    const state = await adapterFor(input.publicClient, input.profile).readBidderState(input.worldwideDay, input.bidder);
    return {
      ...state,
      params: {
        ...state.params,
        issuanceCurrencies: SUPPORTED_ISSUANCE_CURRENCIES,
        issuanceEntryPrices: [],
        strikeAmountsMinor: [],
        oraclePairIds: [],
      },
    };
  } catch (error) {
    if (error instanceof IncompatibleWiringError) throw new CommitPreflightError(error.message);
    throw error;
  }
};

const requireCommitOpen = (state: FreshCommitState): void => {
  if (state.stage !== 'committing-bids') {
    throw new CommitPreflightError('The venue is no longer accepting sealed bids.');
  }
  if (state.liveCommitHash !== ZERO_HASH) {
    throw new CommitPreflightError('This bidder already has a live commitment for the selected WorldwideDay.');
  }
  if (state.bidderRevealed) {
    throw new CommitPreflightError('This bidder has already revealed for the selected WorldwideDay.');
  }
};

const samePreparedState = (prepared: FreshCommitState, fresh: FreshCommitState): boolean =>
  prepared.escrowAdapter === fresh.escrowAdapter &&
  prepared.escrowAuction === fresh.escrowAuction &&
  prepared.paymentToken === fresh.paymentToken &&
  prepared.params.issuanceCurrencies.length === fresh.params.issuanceCurrencies.length &&
  prepared.params.issuanceCurrencies.every((currency, index) => currency === fresh.params.issuanceCurrencies[index]) &&
  prepared.params.issuanceEntryPrices.length === fresh.params.issuanceEntryPrices.length &&
  prepared.params.issuanceEntryPrices.every((value, index) => value === fresh.params.issuanceEntryPrices[index]) &&
  prepared.params.strikeAmountsMinor.length === fresh.params.strikeAmountsMinor.length &&
  prepared.params.strikeAmountsMinor.every((value, index) => value === fresh.params.strikeAmountsMinor[index]) &&
  prepared.params.oraclePairIds.length === fresh.params.oraclePairIds.length &&
  prepared.params.oraclePairIds.every((value, index) => value === fresh.params.oraclePairIds[index]) &&
  prepared.params.referenceCurrency === fresh.params.referenceCurrency &&
  prepared.params.referenceCurrencies.length === fresh.params.referenceCurrencies.length &&
  prepared.params.referenceCurrencies.every(
    (currency, index) => currency === fresh.params.referenceCurrencies[index],
  ) &&
  prepared.params.entryPriceMinor === fresh.params.entryPriceMinor &&
  prepared.params.floorPriceMinor === fresh.params.floorPriceMinor &&
  prepared.params.callPriceMinor === fresh.params.callPriceMinor &&
  prepared.params.promisLoadMinor === fresh.params.promisLoadMinor &&
  prepared.params.minIntexBidRate === fresh.params.minIntexBidRate &&
  prepared.params.minIntexBidQuantity === fresh.params.minIntexBidQuantity &&
  prepared.params.commitBondMinor === fresh.params.commitBondMinor &&
  prepared.schedule.commitEnd === fresh.schedule.commitEnd &&
  prepared.schedule.revealEnd === fresh.schedule.revealEnd &&
  prepared.schedule.issuanceEnd === fresh.schedule.issuanceEnd;

const matchingReusableMaterial = async (input: {
  readonly storage: ReceiptStorage;
  readonly context: CommitContextIdentity;
  readonly bid: ValidatedCommitBid;
  readonly adapterProfile: string;
  readonly issuanceCurrency?: number;
  readonly referenceCurrency?: number;
  readonly promisLoadMinor: bigint;
}): Promise<{ readonly key: string; readonly stored: StoredRevealMaterialV1 } | null> => {
  const records = await listStoredRevealMaterials(input.storage);
  const match = records.find(({ stored }) => {
    const material = stored.material;
    return (
      material.chainId === input.context.chainId &&
      material.deploymentId === input.context.deploymentId &&
      material.auctionProxy === getAddress(input.context.auctionProxy) &&
      material.bidder === getAddress(input.context.bidder) &&
      material.worldwideDay === Number(input.context.worldwideDay) &&
      material.quantity === input.bid.quantity &&
      material.bidRate === input.bid.bidRate &&
      material.adapterProfile === input.adapterProfile &&
      material.issuanceCurrency === input.issuanceCurrency &&
      material.referenceCurrency === input.referenceCurrency
    );
  });
  if (!match) return null;
  const material = await validateRevealMaterial(match.stored.material, {
    promisLoadMinor: input.promisLoadMinor,
  });
  return { key: match.key, stored: { ...match.stored, material } };
};

export const executeCommitTransaction = async (input: {
  readonly publicClient: PublicClient;
  readonly walletProvider?: Eip1193Provider;
  readonly walletClient?: CommitWalletClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly context: CommitContextIdentity;
  readonly storage: ReceiptStorage;
  readonly quantity: string;
  readonly bidRatePercent: string;
  readonly issuanceCurrency?: number;
  readonly referenceCurrency?: number;
  readonly isContextCurrent: (token: string) => boolean;
  readonly onProgress?: (progress: CommitOperationProgress) => void;
  readonly now?: () => string;
  readonly transactionKind?: Extract<TransactionAttemptKind, 'commit' | 'recommit'>;
}): Promise<CommitOperationResult> => {
  const transactionKind = input.transactionKind ?? 'commit';
  const now = input.now ?? (() => new Date().toISOString());
  const adapter = adapterFor(input.publicClient, input.profile);
  assertStorageAvailable(input.storage);
  contextIsCurrent(input);
  await requireWhitelistEligibility({
    publicClient: input.publicClient,
    auctionProxy: input.context.auctionProxy,
    bidder: input.context.bidder,
  });
  contextIsCurrent(input);
  const issuanceCurrency = input.issuanceCurrency;
  if (
    !Number.isSafeInteger(issuanceCurrency) ||
    issuanceCurrency === undefined ||
    issuanceCurrency < 1 ||
    issuanceCurrency > 999
  ) {
    throw new CommitPreflightError(
      'Issuance currency must be an integer from 1 through 999 for the pinned IntexAuction profile.',
    );
  }

  const readFresh = (): Promise<FreshCommitState> =>
    readFreshCommitState({
      publicClient: input.publicClient,
      profile: input.profile,
      bidder: input.context.bidder,
      worldwideDay: input.context.worldwideDay,
    });
  const prepared = await readFresh();
  contextIsCurrent(input);
  requireCommitOpen(prepared);
  const adapterProfile = input.profile.adapterProfile ?? 'multi-issuance-usd-reference';
  const referenceCurrency = input.referenceCurrency ?? prepared.params.referenceCurrency;
  if (referenceCurrency === 0) {
    throw new CommitPreflightError('The reviewed profile requires a priced reference currency.');
  }
  if (!prepared.params.referenceCurrencies.includes(referenceCurrency)) {
    throw new CommitPreflightError('The selected reference currency is not priced for this auction day.');
  }

  const validatedBid = validateCommitBidInput({
    quantity: input.quantity,
    bidRatePercent: input.bidRatePercent,
    constraints: {
      minQuantity: prepared.params.minIntexBidQuantity,
      minBidRate: prepared.params.minIntexBidRate,
      promisLoadMinor: prepared.params.promisLoadMinor,
    },
  });

  const walletClient: CommitWalletClient =
    input.walletClient ??
    (() => {
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
      }) as unknown as CommitWalletClient;
    })();
  const reusable = await matchingReusableMaterial({
    storage: input.storage,
    context: input.context,
    bid: validatedBid,
    adapterProfile,
    issuanceCurrency,
    referenceCurrency,
    promisLoadMinor: prepared.params.promisLoadMinor,
  });
  let material: RevealMaterialV1;
  let persisted: { readonly key: string; readonly stored: StoredRevealMaterialV1 };
  if (reusable !== null) {
    material = reusable.stored.material;
    persisted = reusable;
  } else {
    input.onProgress?.({ kind: 'requesting-signature' });
    const typedData = buildRevealBidTypedData({
      issuanceCurrency,
      referenceCurrency,
      chainId: input.context.chainId,
      auctionProxy: input.context.auctionProxy,
      bidder: input.context.bidder,
      worldwideDay: Number(input.context.worldwideDay),
      quantity: validatedBid.quantity,
      bidRate: validatedBid.bidRate,
    });
    const signature = (await walletClient.signTypedData({
      account: input.context.bidder,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    } as never)) as Hex;
    contextIsCurrent(input);
    material = await createRevealMaterial(
      {
        deploymentId: input.context.deploymentId,
        chainId: input.context.chainId,
        auctionProxy: input.context.auctionProxy,
        bidder: input.context.bidder,
        worldwideDay: Number(input.context.worldwideDay),
        quantity: validatedBid.quantity,
        bidRate: validatedBid.bidRate,
        issuanceCurrency,
        referenceCurrency,
        signature,
        createdAt: now(),
      },
      { promisLoadMinor: prepared.params.promisLoadMinor },
    );
    input.onProgress?.({ kind: 'persisting-receipt' });
    const saved = await persistRevealMaterial({
      storage: input.storage,
      material,
      authoritativeParameters: { promisLoadMinor: prepared.params.promisLoadMinor },
    });
    if (!saved.ok) {
      throw new CommitPreflightError(`Reveal material was not safely persisted: ${saved.message}`);
    }
    material = saved.stored.material;
    persisted = saved;
  }
  contextIsCurrent(input);

  const approval = await readFresh();
  contextIsCurrent(input);
  requireCommitOpen(approval);
  if (!samePreparedState(prepared, approval)) {
    throw new CommitPreflightError(
      'Auction parameters, schedule or contract wiring changed before approval preparation.',
    );
  }

  let approvalTransactionHash: Hash | null = null;
  if (approval.params.commitBondMinor > 0n && approval.allowance < approval.params.commitBondMinor) {
    if (approval.balance < approval.params.commitBondMinor) {
      throw new CommitPreflightError('Payment-token balance is insufficient for the exact commit bond.');
    }
    input.onProgress?.({
      kind: 'approval-required',
      amount: approval.params.commitBondMinor,
      spender: approval.escrowAdapter,
    });
    try {
      const approvalRequest = {
        account: input.context.bidder,
        ...adapter.buildApprovalCall({
          token: approval.paymentToken,
          spender: approval.escrowAdapter,
          amount: approval.params.commitBondMinor,
        }),
      };
      await input.publicClient.simulateContract(approvalRequest as never);
      const approvalGas = await input.publicClient.estimateContractGas(approvalRequest as never);
      (approvalRequest as { gas?: bigint }).gas = bufferedGasLimit(approvalGas);
      contextIsCurrent(input);
      const preSubmitState = await readFresh();
      if (preSubmitState.allowance < approval.params.commitBondMinor) {
        approvalTransactionHash = await walletClient.writeContract(approvalRequest);
      }
    } catch (approvalError) {
      if (isAlreadyBroadcastError(approvalError)) {
        const recovered = await readFresh();
        if (recovered.allowance >= approval.params.commitBondMinor) {
          approvalTransactionHash = null;
        } else {
          throw new CommitPreflightError(
            await describeRejectedResubmission({
              publicClient: input.publicClient,
              sender: input.context.bidder,
              context:
                'The commit-bond approval could not be submitted and the allowance is still insufficient for the exact commit bond.',
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
      // The approval is a broadcast that moves the bidder's own allowance, so it gets the
      // same durable attempt record as the commit. Without it, an approval that is mined
      // while the commit fails leaves no trace in the receipt's transaction history, and
      // the recovery UI cannot explain the spent gas or the outstanding allowance.
      const approvalAttempt = saveTransactionAttempt(
        input.storage,
        createTransactionAttempt({
          kind: 'approval',
          revealMaterialKey: persisted.key,
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
    contextIsCurrent(input);
  }

  const fresh = await readFresh();
  contextIsCurrent(input);
  requireCommitOpen(fresh);
  if (!samePreparedState(prepared, fresh)) {
    throw new CommitPreflightError('Auction parameters, schedule or contract wiring changed after bid preparation.');
  }
  if (fresh.params.commitBondMinor > 0n) {
    if (fresh.balance < fresh.params.commitBondMinor) {
      throw new CommitPreflightError('Payment-token balance became insufficient before commit submission.');
    }
    if (fresh.allowance < fresh.params.commitBondMinor) {
      throw new CommitPreflightError('The fresh payment-token allowance is insufficient for the exact commit bond.');
    }
  }

  input.onProgress?.({ kind: 'ready-to-commit' });
  const commitRequest = {
    account: input.context.bidder,
    ...adapter.buildCommitCall(input.context.worldwideDay, material.commitHash),
  };
  await input.publicClient.simulateContract(commitRequest as never);
  const commitGas = await input.publicClient.estimateContractGas(commitRequest as never);
  (commitRequest as { gas?: bigint }).gas = bufferedGasLimit(commitGas);
  contextIsCurrent(input);
  const commitTransactionHash = await submitWalletWrite({
    submit: () => walletClient.writeContract(commitRequest),
    publicClient: input.publicClient,
    sender: input.context.bidder,
    label: transactionKind,
  });
  input.onProgress?.({ kind: 'commit-submitted', transactionHash: commitTransactionHash });
  let commitAttempt = saveTransactionAttempt(
    input.storage,
    createTransactionAttempt({
      kind: transactionKind,
      revealMaterialKey: persisted.key,
      transactionHash: commitTransactionHash,
      now: now(),
    }),
  );
  input.onProgress?.({ kind: 'commit-confirming', transactionHash: commitTransactionHash });
  const commitWait = await waitForTransactionAttempt({
    publicClient: input.publicClient,
    storage: input.storage,
    initialAttempt: commitAttempt,
    confirmations: input.profile.confirmationDepth,
    label: transactionKind === 'recommit' ? 'Recommit' : 'Commit',
    now,
  });
  commitAttempt = commitWait.attempt;
  const finalCommitTransactionHash = commitAttempt.transactionHash ?? commitTransactionHash;
  contextIsCurrent(input);

  input.onProgress?.({ kind: 'reconciling' });
  let reconciliation: CommitOperationResult['reconciliation'] = 'confirmed';
  let reconciliationMessage: string | null = null;
  try {
    const reconciled = await readFresh();
    contextIsCurrent(input);
    const commitmentMatches = reconciled.liveCommitHash === material.commitHash;
    const bondMatches =
      prepared.params.commitBondMinor === 0n
        ? reconciled.bidderBondAmount === 0n
        : reconciled.bidderBondAmount === prepared.params.commitBondMinor;
    if (!commitmentMatches || !bondMatches) {
      reconciliation = 'mismatch';
      reconciliationMessage =
        'The confirmed transaction receipt does not yet reconcile with bidder-level commitment and bond state.';
      commitAttempt = persistTransactionReconciliationError({
        storage: input.storage,
        attempt: commitAttempt,
        message: reconciliationMessage,
        now: now(),
        kind: 'contract-mismatch',
      });
    }
  } catch (error) {
    if (error instanceof StaleCommitContextError) throw error;
    reconciliation = 'unavailable';
    reconciliationMessage = error instanceof Error ? error.message : String(error);
    commitAttempt = persistTransactionReconciliationError({
      storage: input.storage,
      attempt: commitAttempt,
      message: reconciliationMessage,
      now: now(),
    });
  }

  if (reconciliation === 'confirmed') {
    input.onProgress?.({ kind: 'confirmed', commitHash: material.commitHash });
  }
  return {
    kind: transactionKind,
    material,
    revealMaterialKey: persisted.key,
    validatedBid,
    approvalTransactionHash,
    commitTransactionHash: finalCommitTransactionHash,
    reconciliation,
    reconciliationMessage,
    bidCommittedEventObserved: adapter.readCommitReceiptEvidence(commitWait.receipt, {
      worldwideDay: input.context.worldwideDay,
      bidder: input.context.bidder,
      commitHash: material.commitHash,
    }).committed,
  };
};

export type RecommitTransactionInput = Omit<Parameters<typeof executeCommitTransaction>[0], 'transactionKind'>;

export const executeRecommitTransaction = (input: RecommitTransactionInput): Promise<CommitOperationResult> =>
  executeCommitTransaction({ ...input, transactionKind: 'recommit' });
