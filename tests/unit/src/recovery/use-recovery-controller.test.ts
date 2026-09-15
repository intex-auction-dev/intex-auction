import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { RecoveryAttemptV1 } from '@/recovery/recovery-attempt';
import { latestRecoveryAttempt } from '@/recovery/recovery-attempt';
import type { RecoveryItem } from '@/recovery/recovery-domain';
import {
  buildRecoveryDisplay,
  isRecoveryAttemptRetryable,
  unresolvedRecoveryAttemptNotice,
} from '@/recovery/use-recovery-controller';

const attempt = (state: RecoveryAttemptV1['state'], overrides: Partial<RecoveryAttemptV1> = {}): RecoveryAttemptV1 => ({
  schemaVersion: 1,
  attemptId: state,
  recoveryItemKey: 'item',
  chainId: 31337,
  deploymentId: 'local',
  path: 'escrow-unfinalized-refund',
  worldwideDay: '20260804',
  bidder: '0x1111111111111111111111111111111111111111',
  auctionContract: '0x2222222222222222222222222222222222222222',
  escrowContract: '0x3333333333333333333333333333333333333333',
  paymentToken: '0x4444444444444444444444444444444444444444',
  custody: 'current',
  expectedReturnedAmount: 10n,
  expectedBurnedAmount: 0n,
  transactionHash: `0x${'a'.repeat(64)}`,
  state,
  submittedAt: '2026-08-17T03:40:00.000Z',
  updatedAt: '2026-08-17T03:40:00.000Z',
  ...overrides,
});

const item: RecoveryItem = {
  key: 'item',
  path: 'escrow-unfinalized-refund',
  worldwideDay: '20260804' as RecoveryItem['worldwideDay'],
  bidder: '0x1111111111111111111111111111111111111111' as Address,
  auctionContract: '0x2222222222222222222222222222222222222222' as Address,
  escrowContract: '0x3333333333333333333333333333333333333333' as Address,
  paymentToken: '0x4444444444444444444444444444444444444444' as Address,
  paymentTokenDecimals: 18,
  paymentTokenSymbol: 'wCOEN',
  custody: 'current',
  returnedAmount: 10n,
  burnedAmount: 0n,
  claimableAt: 100n,
  latestBlockTimestamp: 100n,
  availability: 'claimable',
  explanation: 'Fresh contract state says this recovery is claimable.',
};

describe('recovery retry safety', () => {
  it('keeps submitted, unknown or dropped attempts unresolved in lifecycle tracking', () => {
    expect(isRecoveryAttemptRetryable(attempt('submitted'))).toBe(false);
    expect(isRecoveryAttemptRetryable(attempt('unknown'))).toBe(false);
    expect(isRecoveryAttemptRetryable(attempt('dropped'))).toBe(false);
  });

  it.each(['submitted', 'unknown', 'dropped'] as const)(
    'surfaces a %s attempt as diagnostic history without changing fresh contract authority',
    (state) => {
      const notice = unresolvedRecoveryAttemptNotice(attempt(state));
      expect(notice).toMatch(/unresolved network result/i);
      expect(notice).toMatch(/fresh contract state below is authoritative/i);
    },
  );

  it('includes the last status-check error in the unresolved notice', () => {
    expect(
      unresolvedRecoveryAttemptNotice(attempt('unknown', { lastReconciliationError: 'RPC timed out.' })),
    ).toContain('Last status check: RPC timed out.');
  });

  it('does not surface terminal attempts as unresolved', () => {
    expect(unresolvedRecoveryAttemptNotice(attempt('reverted'))).toBeNull();
    expect(unresolvedRecoveryAttemptNotice(attempt('confirmed'))).toBeNull();
    expect(unresolvedRecoveryAttemptNotice(attempt('replaced'))).toBeNull();
  });

  it('retries only terminal reverted or wallet-replaced attempts after a fresh claimable read', () => {
    expect(isRecoveryAttemptRetryable(attempt('reverted'))).toBe(true);
    expect(isRecoveryAttemptRetryable(attempt('replaced'))).toBe(true);
    expect(isRecoveryAttemptRetryable(attempt('confirmed'))).toBe(false);
  });

  it('does not retry the original leg of a repriced transaction chain', () => {
    expect(isRecoveryAttemptRetryable(attempt('replaced', { replacementAttemptId: 'successor' }))).toBe(false);
  });

  it('selects the repriced successor even if the original was updated later', () => {
    const original = attempt('replaced', {
      attemptId: 'original',
      replacementAttemptId: 'successor',
      updatedAt: '2026-08-17T03:42:00.000Z',
    });
    const successor = attempt('submitted', {
      attemptId: 'successor',
      submittedAt: '2026-08-17T03:41:00.000Z',
      updatedAt: '2026-08-17T03:41:00.000Z',
    });
    expect(latestRecoveryAttempt([original, successor], 'item')?.attemptId).toBe('successor');
  });

  it.each(['submitted', 'unknown', 'dropped', 'confirmed'] as const)(
    'keeps a fresh claimable recovery actionable despite a persisted %s attempt',
    (state) => {
      const display = buildRecoveryDisplay({
        index: { items: [item], issues: [] } as never,
        attempts: [attempt(state)],
        activeItemKey: null,
        progress: null,
      });
      expect(display.records).toHaveLength(1);
      expect(display.records[0]?.status).toBe('claimable');
      expect(display.records[0]?.claimableItem).toBe(item);
    },
  );

  it('does not create live recovery rows from local transaction history alone', () => {
    const display = buildRecoveryDisplay({
      index: { items: [], issues: [] } as never,
      attempts: [attempt('submitted')],
      activeItemKey: null,
      progress: null,
    });
    expect(display.records).toEqual([]);
  });
});
