import { describe, expect, it } from 'vitest';
import type { Hash, PublicClient, TransactionReceipt } from 'viem';
import { persistRevealMaterial } from '@/receipts/receipt-store';
import {
  listTransactionAttempts,
  saveTransactionAttempt,
  TransactionAttemptPersistenceError,
} from '@/receipts/receipt-store';
import { createTestMaterial, MemoryStorage } from '../receipts/test-fixtures';
import {
  createTransactionAttempt,
  persistTransactionReconciliationError,
  waitForTransactionAttempt,
} from '@/bidding/transaction-attempt';

const HASH = `0x${'a'.repeat(64)}` as Hash;
const REPLACEMENT_HASH = `0x${'b'.repeat(64)}` as Hash;
const RECEIPT = {
  status: 'success',
  transactionHash: REPLACEMENT_HASH,
  logs: [],
} as unknown as TransactionReceipt;

class AttemptWriteFailureStorage extends MemoryStorage {
  failAttempts = false;

  override setItem(key: string, value: string): void {
    if (this.failAttempts && key.startsWith('itx-acn:transaction-attempt:v1:')) {
      throw new Error('attempt write failed');
    }
    super.setItem(key, value);
  }
}

const setup = async () => {
  const storage = new MemoryStorage();
  const material = await createTestMaterial();
  const persisted = await persistRevealMaterial({
    storage,
    material,
    authoritativeParameters: { promisLoadMinor: 1_000n },
  });
  if (!persisted.ok) throw new Error(persisted.message);
  const initial = saveTransactionAttempt(
    storage,
    createTransactionAttempt({
      kind: 'commit',
      revealMaterialKey: persisted.key,
      transactionHash: HASH,
      now: '2026-08-17T03:20:00.000Z',
    }),
  );
  return { storage, initial, revealMaterialKey: persisted.key };
};

const replacementClient = (): PublicClient =>
  ({
    waitForTransactionReceipt: async ({ onReplaced }: { onReplaced?: (replacement: unknown) => void }) => {
      onReplaced?.({
        reason: 'repriced',
        replacedTransaction: {
          hash: HASH,
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          nonce: 1,
          value: 0n,
          input: '0x1234',
        },
        transaction: {
          hash: REPLACEMENT_HASH,
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          nonce: 1,
          value: 0n,
          input: '0x1234',
        },
        transactionReceipt: RECEIPT,
      });
      return RECEIPT;
    },
  }) as unknown as PublicClient;

describe('transaction attempts', () => {
  it('persists and links the receipt-specific successor for a repriced transaction', async () => {
    const { storage, initial, revealMaterialKey } = await setup();
    const result = await waitForTransactionAttempt({
      publicClient: replacementClient(),
      storage,
      initialAttempt: initial,
      confirmations: 1,
      label: 'Commit',
      now: () => '2026-08-17T03:21:00.000Z',
    });

    const attempts = listTransactionAttempts(storage, revealMaterialKey);
    expect(result.attempt).toMatchObject({ transactionHash: REPLACEMENT_HASH, state: 'confirmed' });
    expect(attempts.map((attempt) => attempt.state)).toEqual(['replaced', 'confirmed']);
    expect(attempts[0]?.replacementAttemptId).toBe(attempts[1]?.attemptId);
  });

  it('rejects an attempt without a transaction hash before waiting', async () => {
    const { storage, initial } = await setup();
    const { transactionHash: _transactionHash, ...initialWithoutHash } = initial;
    const publicClient = {
      waitForTransactionReceipt: async () => {
        throw new Error('wait should not run');
      },
    } as unknown as PublicClient;

    await expect(
      waitForTransactionAttempt({
        publicClient,
        storage,
        initialAttempt: initialWithoutHash,
        confirmations: 1,
        label: 'Commit',
        now: () => '2026-08-17T03:21:30.000Z',
      }),
    ).rejects.toThrow('Transaction attempt has no transaction hash.');
  });

  it('does not persist a transient reconciliation read failure as authoritative transaction state', async () => {
    const { storage, initial, revealMaterialKey } = await setup();
    const confirmed = persistTransactionReconciliationError({
      storage,
      attempt: initial,
      message: 'RPC read timed out after receipt confirmation.',
      now: '2026-08-17T03:23:30.000Z',
    });

    expect(confirmed).toMatchObject({ state: 'confirmed' });
    expect(confirmed.lastReconciliationError).toBeUndefined();
    expect(listTransactionAttempts(storage, revealMaterialKey).at(-1)?.lastReconciliationError).toBeUndefined();
  });

  it('ignores legacy reconciliation errors on confirmed attempts', async () => {
    const { storage, initial, revealMaterialKey } = await setup();
    const confirmed = saveTransactionAttempt(storage, {
      ...initial,
      state: 'confirmed',
      updatedAt: '2026-08-17T03:23:45.000Z',
      lastReconciliationError: 'Legacy RPC reconciliation timeout.',
    });

    expect(confirmed.lastReconciliationError).toBeUndefined();
    expect(listTransactionAttempts(storage, revealMaterialKey).at(-1)?.lastReconciliationError).toBeUndefined();
  });

  it('ignores corrupt local transaction history instead of blocking contract-derived actions', async () => {
    const { storage, revealMaterialKey } = await setup();
    storage.setItem('itx-acn:transaction-attempt:v1:corrupt', '{not-json');
    expect(listTransactionAttempts(storage, revealMaterialKey)).toEqual([]);
  });

  it('surfaces the returned transaction hash when local attempt storage fails', async () => {
    const storage = new AttemptWriteFailureStorage();
    const material = await createTestMaterial();
    const persisted = await persistRevealMaterial({
      storage,
      material,
      authoritativeParameters: { promisLoadMinor: 1_000n },
    });
    if (!persisted.ok) throw new Error(persisted.message);
    storage.failAttempts = true;
    const attempt = createTransactionAttempt({
      kind: 'commit',
      revealMaterialKey: persisted.key,
      transactionHash: HASH,
      now: '2026-08-17T03:24:00.000Z',
    });

    try {
      saveTransactionAttempt(storage, attempt);
      throw new Error('Expected transaction tracking persistence to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionAttemptPersistenceError);
      const failure = error as TransactionAttemptPersistenceError;
      expect(failure.attempt).toEqual(attempt);
      expect(failure.message).toContain(HASH);
      expect(failure.message).toContain('may already be submitted');
    }
  });
});
