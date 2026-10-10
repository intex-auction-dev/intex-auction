import { describe, expect, it } from 'vitest';
import { deriveRecoveryTimes } from '../../../../../dev/local-chain/scripts/local/controls/control-status.mjs';

const DAY = 86_400n;
const input = (overrides = {}) => ({
  auction: { schedule: { revealEnd: 1_000n } },
  bond: { amount: 10n, lockedAt: 500n },
  lock: { lockedAmount: 20n, lockedAt: 700n, status: 1, splitRecorded: false },
  escrow: { finalized: false, finalizedAt: 0n },
  revealed: false,
  unrevealedBondDelay: DAY,
  abandonedBondDelay: 30n * DAY,
  unfinalizedRefundDelay: 3n * DAY,
  postFinalizeRefundDelay: 3n * DAY,
  ...overrides,
});

describe('deriveRecoveryTimes', () => {
  it('derives the independent no-reveal and abandoned-bond clocks', () => {
    expect(deriveRecoveryTimes(input())).toMatchObject({
      recoveryClaimableAt: 1_000n + DAY,
      abandonedBondClaimableAt: 500n + 30n * DAY,
    });
  });

  it('removes both bond clocks after reveal or bond resolution', () => {
    expect(deriveRecoveryTimes(input({ revealed: true }))).toMatchObject({
      recoveryClaimableAt: null,
      abandonedBondClaimableAt: null,
    });
    expect(deriveRecoveryTimes(input({ bond: { amount: 0n, lockedAt: 500n } }))).toMatchObject({
      recoveryClaimableAt: null,
      abandonedBondClaimableAt: null,
    });
  });

  it('uses the bidder lock time while escrow is unfinalized', () => {
    expect(deriveRecoveryTimes(input()).escrowRecoveryClaimableAt).toBe(700n + 3n * DAY);
  });

  it('uses the short post-finalize clock when the bidder split is recorded', () => {
    expect(
      deriveRecoveryTimes(
        input({
          lock: { lockedAmount: 20n, lockedAt: 700n, status: 1, splitRecorded: true },
          escrow: { finalized: true, finalizedAt: 900n },
        }),
      ).escrowRecoveryClaimableAt,
    ).toBe(900n + 3n * DAY);
  });

  it('uses the post-finalize refund clock for a finalized no-split lock', () => {
    expect(
      deriveRecoveryTimes(
        input({
          escrow: { finalized: true, finalizedAt: 900n },
        }),
      ).escrowRecoveryClaimableAt,
    ).toBe(900n + 3n * DAY);
  });

  it('removes the escrow clock when no active bidder lock remains', () => {
    expect(
      deriveRecoveryTimes(
        input({
          lock: { lockedAmount: 20n, lockedAt: 700n, status: 2, splitRecorded: true },
        }),
      ).escrowRecoveryClaimableAt,
    ).toBeNull();
    expect(deriveRecoveryTimes(input({ lock: null })).escrowRecoveryClaimableAt).toBeNull();
  });
});
