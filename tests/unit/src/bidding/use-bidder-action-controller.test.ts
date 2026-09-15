import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/ui/toast';
import { StaleCommitContextError, type FreshCommitState } from '@/bidding/commit-transaction';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import {
  bidderActionResetKey,
  initialBidRatePercent,
  reportBidderActionFailure,
  reportBidderActionResult,
  selectMostRecentRevealed,
  unresolvedBidderActionBlocker,
  type RevealActivityEntry,
} from '@/bidding/use-bidder-action-controller';
import type { TransactionAttemptV1 } from '@/receipts/receipt-store';

afterEach(() => {
  vi.restoreAllMocks();
});

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const LIVE_HASH = `0x${'a'.repeat(64)}`;

const activityEntry = (
  key: string,
  updatedAt: string,
  state: 'confirmed' | 'submitted' = 'confirmed',
): RevealActivityEntry => ({
  record: { key, stored: { material: { bidRate: key.includes('8%') ? 80_000 : 55_000 } } as never },
  attempts: [
    {
      schemaVersion: 1,
      attemptId: key,
      revealMaterialKey: key,
      kind: 'reveal',
      state,
      submittedAt: updatedAt,
      updatedAt,
    },
  ],
});

const actionEntry = (attempts: readonly TransactionAttemptV1[], commitHash = LIVE_HASH): RevealActivityEntry => ({
  record: {
    key: 'receipt:test',
    stored: {
      material: {
        commitHash,
        quantity: 2,
        bidRate: 500_000,
      },
    } as never,
  },
  attempts,
});

const attempt = (
  kind: TransactionAttemptV1['kind'],
  state: TransactionAttemptV1['state'],
  overrides: Partial<TransactionAttemptV1> = {},
): TransactionAttemptV1 => ({
  schemaVersion: 1,
  attemptId: `${kind}-${state}`,
  revealMaterialKey: 'receipt:test',
  kind,
  state,
  transactionHash: `0x${'b'.repeat(64)}`,
  submittedAt: '2026-08-17T03:30:00.000Z',
  updatedAt: '2026-08-17T03:30:00.000Z',
  ...overrides,
});

const freshState = (overrides: Partial<FreshCommitState> = {}): FreshCommitState =>
  ({
    stage: 'committing-bids',
    schedule: { commitEnd: 1n, revealEnd: 2n, issuanceEnd: 3n },
    params: {
      issuanceCurrencies: [840],
      issuanceEntryPrices: [],
      strikeAmountsMinor: [],
      oraclePairIds: [],
      referenceCurrency: 840,
      entryPriceMinor: 0n,
      floorPriceMinor: 0n,
      callPriceMinor: 0n,
      promisLoadMinor: 1_000n,
      minIntexBidRate: 1,
      minIntexBidQuantity: 1,
      commitBondMinor: 10n,
    },
    liveCommitHash: ZERO_HASH as `0x${string}`,
    bidderRevealed: false,
    escrowAdapter: '0x1111111111111111111111111111111111111111',
    escrowAuction: '0x2222222222222222222222222222222222222222',
    paymentToken: '0x3333333333333333333333333333333333333333',
    paymentTokenDecimals: 18,
    paymentTokenSymbol: 'wCOEN',
    balance: 100n,
    allowance: 0n,
    bidderBondAmount: 0n,
    bidderBondLockedAt: 0n,
    bidLock: { lockedAmount: 0n, lockedAt: 0n, status: 'none', failedRefund: 0n, splitRecorded: false },
    ...overrides,
  }) as FreshCommitState;

const auctionSnapshot = (stage: 'committing-bids' | 'revealing-bids', totalBids: bigint): PublicAuctionRead =>
  ({
    worldwideDay: '20260804',
    venue: { kind: 'delivered', auction: { stage, totalBids } },
  }) as unknown as PublicAuctionRead;

describe('bidder action defaults', () => {
  it('starts at the effective contract minimum without a frontend rate floor', () => {
    expect(initialBidRatePercent(0)).toBe('0.0001');
    expect(initialBidRatePercent(50_000)).toBe('5');
    expect(initialBidRatePercent(75_000)).toBe('7.5');
  });

  it('does not reset bidder UI for live snapshot churn inside the same stage', () => {
    const firstRevealPoll = bidderActionResetKey(auctionSnapshot('revealing-bids', 3n), null);
    const nextRevealPoll = bidderActionResetKey(auctionSnapshot('revealing-bids', 4n), null);
    const commitStage = bidderActionResetKey(auctionSnapshot('committing-bids', 3n), null);

    expect(nextRevealPoll).toBe(firstRevealPoll);
    expect(commitStage).not.toBe(firstRevealPoll);
  });

  it('shows the receipt of the most recently revealed bid, not an older one', () => {
    const olderEightPercent = activityEntry('old-8%', '2026-08-12T10:00:00.000Z');
    const freshFivePointFive = activityEntry('fresh-5.5%', '2026-08-12T10:05:00.000Z');
    expect(selectMostRecentRevealed([olderEightPercent, freshFivePointFive])).toBe(freshFivePointFive);
    expect(selectMostRecentRevealed([freshFivePointFive, olderEightPercent])).toBe(freshFivePointFive);
  });

  it('ignores revealed bids that are not yet confirmed', () => {
    const confirmed = activityEntry('fresh-5.5%', '2026-08-12T10:05:00.000Z');
    const pending = activityEntry('fresh-5.5%', '2026-08-12T10:05:00.000Z', 'submitted');
    expect(selectMostRecentRevealed([pending])).toBeNull();
    expect(selectMostRecentRevealed([pending, confirmed])).toBe(confirmed);
  });
});

describe('persisted bidder transaction diagnostics', () => {
  it.each(['approval', 'commit', 'cancellation', 'recommit', 'reveal'] as const)(
    'never lets a local %s attempt block actions derived from fresh contract state',
    (kind) => {
      const entry = actionEntry([attempt(kind, 'unknown')]);
      expect(unresolvedBidderActionBlocker(freshState(), [entry])).toBeNull();
      expect(
        unresolvedBidderActionBlocker(
          freshState({
            stage: 'revealing-bids',
            liveCommitHash: LIVE_HASH as `0x${string}`,
            bidderBondAmount: 10n,
          }),
          [entry],
        ),
      ).toBeNull();
    },
  );

  it.each(['submitted', 'unknown', 'dropped'] as const)(
    'ignores persisted %s network-resolution status when deciding whether the UI is actionable',
    (state) => {
      expect(
        unresolvedBidderActionBlocker(freshState({ allowance: 0n }), [actionEntry([attempt('approval', state)])]),
      ).toBeNull();
    },
  );
});

describe('bidder action toasts', () => {
  it('shows transaction errors in the global toast', () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('toast-id');

    expect(reportBidderActionFailure(new Error('RPC request failed.'))).toBe('RPC request failed.');
    expect(error).toHaveBeenCalledWith('Transaction failed', {
      description: 'RPC request failed.',
      duration: 8_000,
    });
  });

  it('keeps stale-context errors customer-safe', () => {
    vi.spyOn(toast, 'error').mockReturnValue('toast-id');

    expect(reportBidderActionFailure(new StaleCommitContextError())).toContain('prepared operation was discarded');
  });

  it('shows a success toast only after lifecycle state reconciles', () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    reportBidderActionResult({ reconciliation: 'confirmed', reconciliationMessage: null } as never, {
      confirmedTitle: 'Commit cancelled',
      confirmedDescription: 'Your commitment was cancelled and its commit bond was returned.',
      pendingTitle: 'Cancellation transaction confirmed',
    });

    expect(success).toHaveBeenCalledWith('Commit cancelled', {
      description: 'Your commitment was cancelled and its commit bond was returned.',
      duration: 5_000,
    });
  });

  it('uses a warning toast when the transaction confirmed but reconciliation is pending', () => {
    const warning = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    reportBidderActionResult(
      { reconciliation: 'mismatch', reconciliationMessage: 'Live state has not caught up.' } as never,
      {
        confirmedTitle: 'Commit cancelled',
        confirmedDescription: 'Your commitment was cancelled and its commit bond was returned.',
        pendingTitle: 'Cancellation transaction confirmed',
      },
    );

    expect(warning).toHaveBeenCalledWith('Cancellation transaction confirmed', {
      description: 'Live state has not caught up.',
      duration: 7_000,
    });
  });
});
