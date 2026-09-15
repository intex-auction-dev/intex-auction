import { describe, expect, it } from 'vitest';
import type { Hash, PublicClient, TransactionReceipt } from 'viem';
import {
  classifyPendingTransaction,
  describeRejectedResubmission,
  describeStalledTransaction,
  isAlreadyBroadcastError,
  StalledTransactionError,
  submitWalletWrite,
  waitForMinedTransaction,
  waitForTransactionConfirmation,
  type TransactionConfirmationAdapter,
  type TransactionConfirmationState,
} from '@/chain/transaction-confirmation';

const HASH = `0x${'a'.repeat(64)}` as Hash;
const REPLACEMENT_HASH = `0x${'b'.repeat(64)}` as Hash;
// Generic sender fixture (well-known Anvil account index 0); not tied to any real wallet.
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SUCCESS_RECEIPT = {
  status: 'success',
  transactionHash: REPLACEMENT_HASH,
  logs: [],
} as unknown as TransactionReceipt;

type Attempt = {
  readonly transactionHash: Hash;
  readonly state: 'submitted' | TransactionConfirmationState;
  readonly error?: string;
};

const adapter = (transitions: Attempt[]): TransactionConfirmationAdapter<Attempt> => ({
  transactionHash: (attempt) => attempt.transactionHash,
  update: (attempt, state, _now, error) => {
    const next = { ...attempt, state, ...(error === undefined ? {} : { error }) };
    transitions.push(next);
    return next;
  },
  reprice: (attempt, replacementHash) => {
    transitions.push({ ...attempt, state: 'replaced' });
    const next: Attempt = { transactionHash: replacementHash, state: 'submitted' };
    transitions.push(next);
    return next;
  },
});

const replacementClient = (reason: 'repriced' | 'cancelled' | 'replaced'): PublicClient =>
  ({
    waitForTransactionReceipt: async ({ onReplaced }: { onReplaced?: (replacement: unknown) => void }) => {
      onReplaced?.({ reason, transaction: { hash: REPLACEMENT_HASH } });
      return SUCCESS_RECEIPT;
    },
  }) as unknown as PublicClient;

const wait = (input: {
  readonly publicClient: PublicClient;
  readonly label?: string;
  readonly transitions?: Attempt[];
}) => {
  const transitions = input.transitions ?? [];
  return {
    transitions,
    result: waitForTransactionConfirmation({
      publicClient: input.publicClient,
      initialAttempt: { transactionHash: HASH, state: 'submitted' },
      confirmations: 2,
      label: input.label ?? 'Commit',
      now: () => '2026-08-17T18:30:00.000Z',
      adapter: adapter(transitions),
    }),
  };
};

describe('transaction confirmation', () => {
  it('continues a repriced transaction through the replacement attempt', async () => {
    const { result, transitions } = wait({ publicClient: replacementClient('repriced') });

    await expect(result).resolves.toMatchObject({
      receipt: SUCCESS_RECEIPT,
      attempt: { transactionHash: REPLACEMENT_HASH, state: 'confirmed' },
    });
    expect(transitions.map(({ transactionHash, state }) => ({ transactionHash, state }))).toEqual([
      { transactionHash: HASH, state: 'replaced' },
      { transactionHash: REPLACEMENT_HASH, state: 'submitted' },
      { transactionHash: REPLACEMENT_HASH, state: 'confirmed' },
    ]);
  });

  it('rejects a wallet cancellation instead of confirming the replacement', async () => {
    const { result, transitions } = wait({ publicClient: replacementClient('cancelled'), label: 'Commit' });

    await expect(result).rejects.toThrow(
      `Commit transaction was cancelled in the wallet. Replacement transaction: ${REPLACEMENT_HASH}.`,
    );
    expect(transitions).toEqual([
      {
        transactionHash: HASH,
        state: 'replaced',
        error: `Commit transaction was cancelled in the wallet. Replacement transaction: ${REPLACEMENT_HASH}.`,
      },
    ]);
  });

  it('rejects a different same-nonce replacement instead of confirming it', async () => {
    const { result, transitions } = wait({ publicClient: replacementClient('replaced'), label: 'Recovery' });

    await expect(result).rejects.toThrow(
      `Recovery transaction was superseded by a different wallet transaction. Replacement transaction: ${REPLACEMENT_HASH}.`,
    );
    expect(transitions).toEqual([
      {
        transactionHash: HASH,
        state: 'replaced',
        error: `Recovery transaction was superseded by a different wallet transaction. Replacement transaction: ${REPLACEMENT_HASH}.`,
      },
    ]);
  });

  it('persists a reverted receipt as reverted', async () => {
    const publicClient = {
      waitForTransactionReceipt: async () => ({ status: 'reverted', transactionHash: HASH, logs: [] }),
    } as unknown as PublicClient;
    const { result, transitions } = wait({ publicClient, label: 'Reveal' });

    await expect(result).rejects.toThrow('Reveal transaction reverted.');
    expect(transitions).toEqual([{ transactionHash: HASH, state: 'reverted' }]);
  });

  it('classifies a dropped wait error as dropped and rethrows it', async () => {
    const error = Object.assign(new Error('receipt unavailable'), { code: 'TRANSACTION_DROPPED' });
    const publicClient = {
      waitForTransactionReceipt: async () => {
        throw error;
      },
    } as unknown as PublicClient;
    const { result, transitions } = wait({ publicClient });

    await expect(result).rejects.toBe(error);
    expect(transitions).toEqual([
      {
        transactionHash: HASH,
        state: 'dropped',
        error: 'receipt unavailable',
      },
    ]);
  });

  it('classifies an ordinary wait error as unknown and rethrows it', async () => {
    const error = new Error('transport unavailable');
    const publicClient = {
      waitForTransactionReceipt: async () => {
        throw error;
      },
    } as unknown as PublicClient;
    const { result, transitions } = wait({ publicClient });

    await expect(result).rejects.toBe(error);
    expect(transitions).toEqual([
      {
        transactionHash: HASH,
        state: 'unknown',
        error: 'transport unavailable',
      },
    ]);
  });
});

const stalledClient = (input: {
  readonly nonce: number;
  readonly chainNonce: number;
  readonly blockNumber?: bigint | null;
}): PublicClient =>
  ({
    waitForTransactionReceipt: () =>
      new Promise(() => {
        /* never mined */
      }),
    getTransaction: async () => ({
      hash: HASH,
      from: SENDER,
      nonce: input.nonce,
      blockNumber: input.blockNumber ?? null,
    }),
    getTransactionCount: async () => input.chainNonce,
  }) as unknown as PublicClient;

describe('stalled transaction detection', () => {
  it('fails fast with wallet and chain nonces when the wallet nonce is ahead of the chain', async () => {
    const result = waitForMinedTransaction({
      publicClient: stalledClient({ nonce: 4, chainNonce: 2 }),
      hash: HASH,
      confirmations: 1,
      label: 'Approval',
      stallCheckDelayMs: 0,
      stallRecheckIntervalMs: 1,
      stallObservations: 2,
    });

    await expect(result).rejects.toBeInstanceOf(StalledTransactionError);
    await expect(result).rejects.toThrow(/signed with nonce 4/);
    await expect(result).rejects.toThrow(/is at nonce 2 on this endpoint/);
    await expect(result).rejects.toThrow(/clearing the wallet's activity data/);
    await expect(result).rejects.toThrow(/not cancelled and can still be mined later/);
  });

  it('keeps waiting for an ordinary pending transaction whose nonce is executable', async () => {
    const publicClient = stalledClient({ nonce: 2, chainNonce: 2 });
    const outcome = await Promise.race([
      waitForMinedTransaction({
        publicClient,
        hash: HASH,
        confirmations: 1,
        label: 'Approval',
        stallCheckDelayMs: 0,
        stallRecheckIntervalMs: 5,
      })
        .then(() => 'settled')
        .catch(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 60)),
    ]);

    expect(outcome).toBe('still-waiting');
  });

  it('waits through a single nonce-gap observation and only fails once the gap persists', async () => {
    let observations = 0;
    const publicClient = {
      waitForTransactionReceipt: () =>
        new Promise(() => {
          /* never mined */
        }),
      getTransaction: async () => {
        observations += 1;
        return {
          hash: HASH,
          from: SENDER,
          nonce: observations === 1 ? 4 : 2,
          blockNumber: null,
        };
      },
      getTransactionCount: async () => 2,
    } as unknown as PublicClient;

    const outcome = await Promise.race([
      waitForMinedTransaction({
        publicClient,
        hash: HASH,
        confirmations: 1,
        label: 'Approval',
        stallCheckDelayMs: 0,
        stallRecheckIntervalMs: 1,
        stallObservations: 2,
      })
        .then(() => 'settled')
        .catch((error: Error) => `failed: ${error.name}`),
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 60)),
    ]);

    expect(outcome).toBe('still-waiting');
    expect(observations).toBeGreaterThan(2);
  });

  it('reports no stall for a transaction that is already mined', async () => {
    await expect(
      describeStalledTransaction(stalledClient({ nonce: 4, chainNonce: 2, blockNumber: 160n }), HASH),
    ).resolves.toBeNull();
  });

  it('explains a rejected resubmission instead of reporting a revert', async () => {
    const error = new Error('RPC 0x7a69 Custom eth_sendRawTransaction: transaction already imported');

    expect(isAlreadyBroadcastError(error)).toBe(true);
    await expect(
      describeRejectedResubmission({
        publicClient: stalledClient({ nonce: 4, chainNonce: 2 }),
        sender: SENDER,
        context: 'The reveal transaction was not submitted.',
        error,
      }),
    ).resolves.toMatch(new RegExp(`nothing new was broadcast \\(chain nonce 2 for ${SENDER}\\)`));
  });

  it('converts a nonce-conflict rejection on any wallet write into an explanation', async () => {
    const error = new Error('RPC 0x7a69 Custom eth_sendRawTransaction: transaction already imported');
    const submission = submitWalletWrite({
      submit: () => Promise.reject(error),
      publicClient: stalledClient({ nonce: 4, chainNonce: 2 }),
      sender: SENDER,
      label: 'reveal',
    });

    await expect(submission).rejects.toThrow(/The reveal transaction was not submitted\./);
    await expect(submission).rejects.toThrow(/clear the wallet's activity data for this network/);
  });

  it('passes an unrelated wallet write failure through unchanged', async () => {
    const error = new Error('User rejected the request.');

    await expect(
      submitWalletWrite({
        submit: () => Promise.reject(error),
        publicClient: stalledClient({ nonce: 2, chainNonce: 2 }),
        sender: SENDER,
        label: 'reveal',
      }),
    ).rejects.toBe(error);
  });
});

const notFound = (): Error => Object.assign(new Error('Transaction not found.'), { name: 'TransactionNotFoundError' });

const unknownHashClient = (getTransaction: () => Promise<unknown>): PublicClient =>
  ({
    waitForTransactionReceipt: () =>
      new Promise(() => {
        /* never mined for this account */
      }),
    getTransaction,
    getTransactionCount: async () => 0,
  }) as unknown as PublicClient;

describe('smart-contract wallet (Safe) unobservable transaction', () => {
  it('classifies a node-unknown hash as unknown and a transport error as known', async () => {
    await expect(
      classifyPendingTransaction(
        unknownHashClient(async () => {
          throw notFound();
        }),
        HASH,
      ),
    ).resolves.toBe('unknown');
    await expect(
      classifyPendingTransaction(
        unknownHashClient(async () => {
          throw new Error('transport hiccup');
        }),
        HASH,
      ),
    ).resolves.toBe('known');
  });

  it('abandons a persistently node-unknown submission with a Safe-aware explanation', async () => {
    const result = waitForMinedTransaction({
      publicClient: unknownHashClient(async () => {
        throw notFound();
      }),
      hash: HASH,
      confirmations: 1,
      label: 'Commit',
      stallCheckDelayMs: 0,
      stallRecheckIntervalMs: 1,
      stallObservations: 2,
    });

    await expect(result).rejects.toBeInstanceOf(StalledTransactionError);
    await expect(result).rejects.toThrow(/was not observed on the active venue/);
    await expect(result).rejects.toThrow(/Safe or other multisig/);
    await expect(result).rejects.toThrow(/reveal material is already saved locally, so no bid was lost/);
  });

  it('does not abandon a transaction that is only transiently unreadable', async () => {
    const outcome = await Promise.race([
      waitForMinedTransaction({
        publicClient: unknownHashClient(async () => {
          throw new Error('transport hiccup');
        }),
        hash: HASH,
        confirmations: 1,
        label: 'Commit',
        stallCheckDelayMs: 0,
        stallRecheckIntervalMs: 1,
        stallObservations: 2,
      })
        .then(() => 'settled')
        .catch((error: Error) => `failed: ${error.name}`),
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 60)),
    ]);

    expect(outcome).toBe('still-waiting');
  });
});
