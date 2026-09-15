import { describe, expect, it } from 'vitest';
import type { Address, Hash, PublicClient, TransactionReceipt } from 'viem';
import { parseWorldwideDayKey } from '@/domain/protocol-time';
import {
  createRecoveryAttempt,
  latestRecoveryAttempt,
  listRecoveryAttempts,
  persistRecoveryReconciliationError,
  saveRecoveryAttempt,
  validateRecoveryAttempt,
  waitForRecoveryAttempt,
  type RecoveryAttemptStorage,
} from '@/recovery/recovery-attempt';
import type { RecoveryItem } from '@/recovery/recovery-domain';

class MemoryStorage implements RecoveryAttemptStorage {
  private readonly values = new Map<string, string>();
  get length() {
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

const parsedDay = parseWorldwideDayKey('20260804');
if (!parsedDay.ok) throw new Error('Invalid test WorldwideDay.');

const item: RecoveryItem = {
  key: '31337:local:escrow-unfinalized-refund:20260804:bidder:escrow',
  path: 'escrow-unfinalized-refund',
  worldwideDay: parsedDay.value,
  bidder: '0x1111111111111111111111111111111111111111' as Address,
  auctionContract: '0x2222222222222222222222222222222222222222' as Address,
  escrowContract: '0x3333333333333333333333333333333333333333' as Address,
  paymentToken: '0x4444444444444444444444444444444444444444' as Address,
  paymentTokenDecimals: 18,
  paymentTokenSymbol: 'wCOEN',
  custody: 'historical',
  returnedAmount: 1_000n,
  burnedAmount: 0n,
  claimableAt: 100n,
  latestBlockTimestamp: 100n,
  availability: 'claimable',
  explanation: 'test',
};
const hash = `0x${'a'.repeat(64)}` as Hash;
const replacementHash = `0x${'b'.repeat(64)}` as Hash;

const attempt = () =>
  createRecoveryAttempt({
    item,
    chainId: 31_337,
    deploymentId: 'local',
    transactionHash: hash,
    now: '2026-08-04T20:00:00.000Z',
  });

const replacementClient = (): PublicClient => {
  const receipt = { status: 'success', transactionHash: replacementHash, logs: [] } as unknown as TransactionReceipt;
  return {
    waitForTransactionReceipt: async ({ onReplaced }: { onReplaced?: (replacement: unknown) => void }) => {
      onReplaced?.({
        reason: 'repriced',
        replacedTransaction: {
          hash,
          from: item.bidder,
          to: item.escrowContract,
          nonce: 1,
          value: 0n,
          input: '0x1234',
        },
        transaction: {
          hash: replacementHash,
          from: item.bidder,
          to: item.escrowContract,
          nonce: 1,
          value: 0n,
          input: '0x1234',
        },
        transactionReceipt: receipt,
      });
      return receipt;
    },
  } as unknown as PublicClient;
};

describe('recovery transaction attempts', () => {
  it('persists independently from reveal receipts and restores by active context', () => {
    const storage = new MemoryStorage();
    const saved = saveRecoveryAttempt(storage, attempt());
    expect(saved.recoveryItemKey).toBe(item.key);
    expect(saved.expectedReturnedAmount).toBe(1_000n);
    expect(saved.paymentTokenDecimals).toBe(18);
    expect(saved.paymentTokenSymbol).toBe('wCOEN');
    expect(saved.custody).toBe('historical');
    expect(
      listRecoveryAttempts(storage, {
        chainId: 31_337,
        deploymentId: 'local',
        bidder: item.bidder,
      }),
    ).toEqual([saved]);
    expect(
      listRecoveryAttempts(storage, {
        chainId: 1,
        deploymentId: 'other',
        bidder: item.bidder,
      }),
    ).toEqual([]);
  });

  it('accepts legacy attempts without token display metadata', () => {
    const { paymentTokenDecimals: _decimals, paymentTokenSymbol: _symbol, ...legacy } = attempt();
    expect(validateRecoveryAttempt(legacy)).toMatchObject({ paymentToken: item.paymentToken.toLowerCase() });
  });

  it('rejects identity mutation but permits state and reconciliation updates', () => {
    const storage = new MemoryStorage();
    const saved = saveRecoveryAttempt(storage, attempt());
    expect(() => saveRecoveryAttempt(storage, { ...saved, expectedBurnedAmount: 1n })).toThrow(
      'identity cannot be changed',
    );
    const reconciled = persistRecoveryReconciliationError({
      storage,
      attempt: saved,
      message: 'missing event',
      now: '2026-08-04T20:01:00.000Z',
    });
    expect(reconciled).toMatchObject({ state: 'confirmed', lastReconciliationError: 'missing event' });
  });

  it('rejects malformed hashes, states and economics', () => {
    expect(() => validateRecoveryAttempt({ ...attempt(), transactionHash: '0x1' })).toThrow(TypeError);
    expect(() => validateRecoveryAttempt({ ...attempt(), state: 'success' })).toThrow(TypeError);
    expect(() => validateRecoveryAttempt({ ...attempt(), expectedReturnedAmount: '-1' })).toThrow(TypeError);
    expect(() => validateRecoveryAttempt({ ...attempt(), custody: 'guessed' })).toThrow(TypeError);
  });

  it('persists the complete recovery identity across a repriced replacement', async () => {
    const storage = new MemoryStorage();
    const initial = saveRecoveryAttempt(storage, attempt());
    const result = await waitForRecoveryAttempt({
      publicClient: replacementClient(),
      storage,
      initialAttempt: initial,
      confirmations: 2,
      now: (() => {
        let count = 0;
        return () => `2026-08-04T20:0${count++}:00.000Z`;
      })(),
    });
    const attempts = listRecoveryAttempts(storage);
    expect(result.attempt).toMatchObject({
      transactionHash: replacementHash,
      state: 'confirmed',
      recoveryItemKey: initial.recoveryItemKey,
      chainId: initial.chainId,
      deploymentId: initial.deploymentId,
      path: initial.path,
      worldwideDay: initial.worldwideDay,
      bidder: initial.bidder,
      auctionContract: initial.auctionContract,
      escrowContract: initial.escrowContract,
      paymentToken: initial.paymentToken,
      paymentTokenDecimals: initial.paymentTokenDecimals,
      paymentTokenSymbol: initial.paymentTokenSymbol,
      custody: initial.custody,
      expectedReturnedAmount: initial.expectedReturnedAmount,
      expectedBurnedAmount: initial.expectedBurnedAmount,
    });
    expect(
      attempts.some((entry) => entry.state === 'replaced' && entry.replacementAttemptId === result.attempt.attemptId),
    ).toBe(true);
    expect(latestRecoveryAttempt(attempts, item.key)?.transactionHash).toBe(replacementHash);
  });

  it('retains confirmed receipts with reconciliation errors', () => {
    const storage = new MemoryStorage();
    const saved = saveRecoveryAttempt(storage, attempt());
    const updated = persistRecoveryReconciliationError({
      storage,
      attempt: saved,
      message: 'bidder lock remained active',
      now: '2026-08-04T20:02:00.000Z',
    });
    expect(updated.state).toBe('confirmed');
    expect(updated.lastReconciliationError).toBe('bidder lock remained active');
  });
});
