import type { Hash, PublicClient, TransactionReceipt } from 'viem';

export type TransactionConfirmationState = 'replaced' | 'confirmed' | 'reverted' | 'dropped' | 'unknown';

export class StalledTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StalledTransactionError';
  }
}

const STALL_CHECK_DELAY_MS = 15_000;
const STALL_RECHECK_INTERVAL_MS = 10_000;
// Require repeated nonce gaps before abandoning a transaction wait to tolerate RPC propagation.
const STALL_OBSERVATIONS = 3;

const nonceAheadOfChainAdvice = (from: string, walletNonce: number, chainNonce: number): string =>
  `was signed with nonce ${walletNonce}, but ${from} is at nonce ${chainNonce} on this endpoint, so it cannot be mined until the missing earlier transactions arrive. Either the wallet is counting from a nonce ahead of the chain, which happens after a chain reset and is fixed by clearing the wallet's activity data for this network, or an earlier transaction from this account is stuck and must be resubmitted or replaced in the wallet. This transaction is not cancelled and can still be mined later if the gap is filled.`;

// Stop waiting only after the grace period confirms a Safe proposal or unbroadcast transaction.
const unknownTransactionAdvice = (label: string): string =>
  `The ${label.toLowerCase()} transaction was not observed on the active venue. This is expected for a smart-contract wallet such as a Safe or other multisig, where the submission records a proposal that must be signed and executed by the required owners before it settles on chain, so this application cannot confirm it from here. It can also mean the wallet did not broadcast the transaction. Your reveal material is already saved locally, so no bid was lost. Check the transaction in your wallet, complete any required multisig approvals, and reload this page once it has executed on chain.`;

export type PendingTransactionClass = 'known' | 'unknown';

export const classifyPendingTransaction = async (
  publicClient: PublicClient,
  hash: Hash,
): Promise<PendingTransactionClass> => {
  try {
    await publicClient.getTransaction({ hash });
    return 'known';
  } catch (error) {
    // Transport failures remain retryable; only TransactionNotFoundError proves the node lacks the hash.
    const name = error instanceof Error ? error.name : '';
    return name === 'TransactionNotFoundError' ? 'unknown' : 'known';
  }
};

export const describeStalledTransaction = async (publicClient: PublicClient, hash: Hash): Promise<string | null> => {
  try {
    const transaction = await publicClient.getTransaction({ hash });
    if (transaction.blockNumber !== null) return null;
    const chainNonce = await publicClient.getTransactionCount({
      address: transaction.from,
      blockTag: 'latest',
    });
    if (transaction.nonce <= chainNonce) return null;
    return nonceAheadOfChainAdvice(transaction.from, transaction.nonce, chainNonce);
  } catch {
    return null;
  }
};

// Receipt waiting must fail truthfully for persistent nonce gaps rather than timing out indefinitely.
export const waitForMinedTransaction = async (input: {
  readonly publicClient: PublicClient;
  readonly hash: Hash;
  readonly confirmations: number;
  readonly label: string;
  readonly onReplaced?: (replacement: unknown) => void;
  readonly stallCheckDelayMs?: number;
  readonly stallRecheckIntervalMs?: number;
  readonly stallObservations?: number;
}): Promise<TransactionReceipt> => {
  let settled = false;
  let cancelSleep: (() => void) | null = null;
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancelSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const receipt = input.publicClient.waitForTransactionReceipt({
    hash: input.hash,
    confirmations: input.confirmations,
    pollingInterval: 1_000,
    ...(input.onReplaced === undefined ? {} : { onReplaced: input.onReplaced }),
  });
  const stop = (): void => {
    settled = true;
    cancelSleep?.();
  };
  receipt.then(stop, stop);
  const watchdog = async (): Promise<null> => {
    await sleep(input.stallCheckDelayMs ?? STALL_CHECK_DELAY_MS);
    const required = input.stallObservations ?? STALL_OBSERVATIONS;
    let observations = 0;
    let unknownObservations = 0;
    while (!settled) {
      const message = await describeStalledTransaction(input.publicClient, input.hash);
      observations = message === null ? 0 : observations + 1;
      if (message !== null && observations >= required) {
        throw new StalledTransactionError(`${input.label} transaction ${input.hash} ${message}`);
      }
      if (message === null) {
        const pending = await classifyPendingTransaction(input.publicClient, input.hash);
        unknownObservations = pending === 'unknown' ? unknownObservations + 1 : 0;
        if (unknownObservations >= required) {
          throw new StalledTransactionError(unknownTransactionAdvice(input.label));
        }
      } else {
        unknownObservations = 0;
      }
      await sleep(input.stallRecheckIntervalMs ?? STALL_RECHECK_INTERVAL_MS);
    }
    return null;
  };
  try {
    const raced = await Promise.race([receipt, watchdog()]);
    return raced ?? (await receipt);
  } catch (error) {
    if (error instanceof StalledTransactionError) throw error;
    const message = await describeStalledTransaction(input.publicClient, input.hash);
    if (message !== null) throw new StalledTransactionError(`${input.label} transaction ${input.hash} ${message}`);
    throw error;
  } finally {
    stop();
  }
};

export const isAlreadyBroadcastError = (error: unknown): boolean =>
  /transaction already imported|already known|nonce too low/i.test(
    error instanceof Error ? error.message : String(error),
  );

export const describeRejectedResubmission = async (input: {
  readonly publicClient: PublicClient;
  readonly sender: `0x${string}`;
  readonly context: string;
  readonly error: unknown;
}): Promise<string> => {
  const chainNonce = await input.publicClient
    .getTransactionCount({ address: input.sender, blockTag: 'latest' })
    .catch(() => null);
  const underlying = input.error instanceof Error ? input.error.message : String(input.error);
  return (
    `${input.context} The node rejected it as a duplicate or reused nonce, so nothing new was broadcast` +
    `${chainNonce === null ? '' : ` (chain nonce ${chainNonce} for ${input.sender})`}. ` +
    'The wallet is counting from a different nonce than this endpoint. After a chain reset, clear the ' +
    "wallet's activity data for this network; otherwise wait for or replace this account's earlier pending " +
    `transaction before retrying. Wallet error: ${underlying.split('\n')[0] ?? underlying}`
  );
};

export const submitWalletWrite = async (input: {
  readonly submit: () => Promise<Hash>;
  readonly publicClient: PublicClient;
  readonly sender: `0x${string}`;
  readonly label: string;
}): Promise<Hash> => {
  try {
    return await input.submit();
  } catch (error) {
    if (!isAlreadyBroadcastError(error)) throw error;
    throw new Error(
      await describeRejectedResubmission({
        publicClient: input.publicClient,
        sender: input.sender,
        context: `The ${input.label} transaction was not submitted.`,
        error,
      }),
    );
  }
};

export interface TransactionConfirmationAdapter<TAttempt> {
  transactionHash(attempt: TAttempt): Hash;
  update(attempt: TAttempt, state: TransactionConfirmationState, now: string, error?: string): TAttempt;
  reprice(attempt: TAttempt, replacementHash: Hash, now: string): TAttempt;
}

type UnsafeReplacement = {
  readonly reason: 'cancelled' | 'replaced';
  readonly transactionHash: Hash;
};

const unsafeReplacementMessage = (label: string, replacement: UnsafeReplacement): string =>
  replacement.reason === 'cancelled'
    ? `${label} transaction was cancelled in the wallet. Replacement transaction: ${replacement.transactionHash}.`
    : `${label} transaction was superseded by a different wallet transaction. Replacement transaction: ${replacement.transactionHash}.`;

const waitFailureState = (error: unknown): 'dropped' | 'unknown' => {
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  const text =
    `${String(candidate.code ?? '')} ${String(candidate.name ?? '')} ${String(candidate.message ?? '')}`.toLowerCase();
  return text.includes('dropped') ? 'dropped' : 'unknown';
};

export const waitForTransactionConfirmation = async <TAttempt>(input: {
  readonly publicClient: PublicClient;
  readonly initialAttempt: TAttempt;
  readonly confirmations: number;
  readonly label: string;
  readonly now: () => string;
  readonly adapter: TransactionConfirmationAdapter<TAttempt>;
  readonly stallCheckDelayMs?: number;
}): Promise<{ readonly receipt: TransactionReceipt; readonly attempt: TAttempt }> => {
  let current = input.initialAttempt;
  const transactionHash = input.adapter.transactionHash(current);
  let unsafeReplacement: UnsafeReplacement | null = null;
  try {
    const receipt = await waitForMinedTransaction({
      publicClient: input.publicClient,
      hash: transactionHash,
      confirmations: input.confirmations,
      label: input.label,
      onReplaced: (replacement) => {
        const value = replacement as unknown as {
          reason: 'cancelled' | 'replaced' | 'repriced';
          transaction: { hash: Hash };
        };
        if (value.reason === 'repriced') {
          current = input.adapter.reprice(current, value.transaction.hash, input.now());
          return;
        }
        unsafeReplacement = { reason: value.reason, transactionHash: value.transaction.hash };
        current = input.adapter.update(
          current,
          'replaced',
          input.now(),
          unsafeReplacementMessage(input.label, unsafeReplacement),
        );
      },
      ...(input.stallCheckDelayMs === undefined ? {} : { stallCheckDelayMs: input.stallCheckDelayMs }),
    });
    if (unsafeReplacement !== null) throw new Error(unsafeReplacementMessage(input.label, unsafeReplacement));
    if (receipt.status === 'reverted') {
      current = input.adapter.update(current, 'reverted', input.now());
      throw new Error(`${input.label} transaction reverted.`);
    }
    current = input.adapter.update(current, 'confirmed', input.now());
    return { receipt, attempt: current };
  } catch (error) {
    if (unsafeReplacement !== null) throw error;
    if (error instanceof Error && error.message === `${input.label} transaction reverted.`) throw error;
    input.adapter.update(
      current,
      waitFailureState(error),
      input.now(),
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
};
