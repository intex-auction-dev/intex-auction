import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { parseWorldwideDayKey } from '@/domain/protocol-time';
import { decodeVenueAuctionEscrowState, decodeVenueBidLock, decodeVenueCommitBond } from '@/protocol/venue-decode';
import {
  projectAbandonedCommitBondRecovery,
  projectAuctionCommitBondRecovery,
  projectEscrowRefundRecovery,
  type RecoveryContractConstants,
} from '@/recovery/recovery-domain';

const bidder = '0x1111111111111111111111111111111111111111' as Address;
const auctionContract = '0x2222222222222222222222222222222222222222' as Address;
const escrowContract = '0x3333333333333333333333333333333333333333' as Address;
const paymentToken = '0x4444444444444444444444444444444444444444' as Address;
const parsedDay = parseWorldwideDayKey('20260804');
if (!parsedDay.ok) throw new Error('Invalid test WorldwideDay.');
const DAY = parsedDay.value;

const constants: RecoveryContractConstants = {
  unrevealedBondLockPeriod: 86_400n,
  abandonedCommitBondDelay: 2_592_000n,
  unfinalizedRefundDelay: 259_200n,
  postFinalizeRefundDelay: 259_200n,
};

const base = {
  chainId: 31_337,
  deploymentId: 'local',
  worldwideDay: DAY,
  bidder,
  auctionContract,
  escrowContract,
  paymentToken,
  paymentTokenDecimals: 18,
  paymentTokenSymbol: 'wCOEN',
  custody: 'current' as const,
};

const locked = (overrides: Partial<ReturnType<typeof decodeVenueBidLock>> = {}) => ({
  lockedAmount: 1_000n,
  lockedAt: 10_000n,
  status: 'locked' as const,
  failedRefund: 0n,
  splitRecorded: false,
  ...overrides,
});

const escrowState = (overrides: Partial<ReturnType<typeof decodeVenueAuctionEscrowState>> = {}) => ({
  totalLocked: 1_000n,
  lockCount: 1n,
  finalizedAt: 0n,
  finalized: false,
  ...overrides,
});

describe('bidder recovery projection', () => {
  it('returns no item without a live bond or lock', () => {
    expect(
      projectAuctionCommitBondRecovery({
        ...base,
        stage: 'completed',
        revealEnd: 100n,
        latestBlockTimestamp: 100_000n,
        bond: { amount: 0n, lockedAt: 0n },
        unrevealedBondLockPeriod: constants.unrevealedBondLockPeriod,
      }),
    ).toBeNull();
    expect(
      projectEscrowRefundRecovery({
        ...base,
        latestBlockTimestamp: 100_000n,
        lock: { ...locked(), status: 'finalized' },
        escrowState: escrowState(),
        constants,
      }),
    ).toBeNull();
  });

  it('classifies auction-side unrevealed bond at the exact stored reveal deadline', () => {
    const waiting = projectAuctionCommitBondRecovery({
      ...base,
      stage: 'completed',
      revealEnd: 1_000n,
      latestBlockTimestamp: 87_399n,
      bond: { amount: 75n, lockedAt: 500n },
      unrevealedBondLockPeriod: constants.unrevealedBondLockPeriod,
    });
    const claimable = projectAuctionCommitBondRecovery({
      ...base,
      stage: 'completed',
      revealEnd: 1_000n,
      latestBlockTimestamp: 87_400n,
      bond: { amount: 75n, lockedAt: 500n },
      unrevealedBondLockPeriod: constants.unrevealedBondLockPeriod,
    });
    expect(waiting).toMatchObject({
      availability: 'waiting',
      claimableAt: 87_400n,
      returnedAmount: 75n,
      burnedAmount: 0n,
    });
    expect(claimable).toMatchObject({ availability: 'claimable', claimableAt: 87_400n });
  });

  it('uses a snapped-forward revealEnd rather than an original receipt deadline', () => {
    const item = projectAuctionCommitBondRecovery({
      ...base,
      stage: 'issuance',
      revealEnd: 20_000n,
      latestBlockTimestamp: 106_399n,
      bond: { amount: 50n, lockedAt: 1n },
      unrevealedBondLockPeriod: constants.unrevealedBondLockPeriod,
    });
    expect(item?.claimableAt).toBe(106_400n);
    expect(item?.availability).toBe('waiting');
  });

  it('makes a cancelled auction bond immediately claimable', () => {
    expect(
      projectAuctionCommitBondRecovery({
        ...base,
        stage: 'cancelled',
        revealEnd: 999_999n,
        latestBlockTimestamp: 10n,
        bond: { amount: 50n, lockedAt: 1n },
        unrevealedBondLockPeriod: constants.unrevealedBondLockPeriod,
      }),
    ).toMatchObject({ availability: 'claimable', claimableAt: null, returnedAmount: 50n });
  });

  it('classifies escrow-local abandoned bond at the exact 30-day boundary', () => {
    const waiting = projectAbandonedCommitBondRecovery({
      ...base,
      custody: 'historical',
      latestBlockTimestamp: 2_601_999n,
      bond: { amount: 40n, lockedAt: 10_000n },
      delay: constants.abandonedCommitBondDelay,
    });
    const claimable = projectAbandonedCommitBondRecovery({
      ...base,
      custody: 'historical',
      latestBlockTimestamp: 2_602_000n,
      bond: { amount: 40n, lockedAt: 10_000n },
      delay: constants.abandonedCommitBondDelay,
    });
    expect(waiting).toMatchObject({ availability: 'waiting', claimableAt: 2_602_000n, custody: 'historical' });
    expect(claimable).toMatchObject({ availability: 'claimable', returnedAmount: 40n, burnedAmount: 0n });
  });

  it('classifies never-finalized full-principal recovery at the exact 72-hour boundary', () => {
    const waiting = projectEscrowRefundRecovery({
      ...base,
      latestBlockTimestamp: 269_199n,
      lock: locked(),
      escrowState: escrowState(),
      constants,
    });
    const claimable = projectEscrowRefundRecovery({
      ...base,
      latestBlockTimestamp: 269_200n,
      lock: locked(),
      escrowState: escrowState(),
      constants,
    });
    expect(waiting).toMatchObject({
      path: 'escrow-unfinalized-refund',
      availability: 'waiting',
      returnedAmount: 1_000n,
      burnedAmount: 0n,
    });
    expect(claimable).toMatchObject({ availability: 'claimable', claimableAt: 269_200n });
  });

  it('uses the never-finalized path for a skipped venue candidate', () => {
    const item = projectEscrowRefundRecovery({
      ...base,
      latestBlockTimestamp: 269_200n,
      lock: locked(),
      escrowState: escrowState({ lockCount: 99n }),
      constants,
    });
    expect(item?.path).toBe('escrow-unfinalized-refund');
  });

  it('classifies finalized failed split and exact return/burn economics', () => {
    const state = escrowState({ finalized: true, finalizedAt: 20_000n });
    const waiting = projectEscrowRefundRecovery({
      ...base,
      latestBlockTimestamp: 279_199n,
      lock: locked({ failedRefund: 250n, splitRecorded: true }),
      escrowState: state,
      constants,
    });
    const claimable = projectEscrowRefundRecovery({
      ...base,
      latestBlockTimestamp: 279_200n,
      lock: locked({ failedRefund: 250n, splitRecorded: true }),
      escrowState: state,
      constants,
    });
    expect(waiting).toMatchObject({
      path: 'escrow-failed-split-refund',
      availability: 'waiting',
      returnedAmount: 250n,
      burnedAmount: 750n,
    });
    expect(claimable).toMatchObject({ availability: 'claimable', claimableAt: 279_200n });
  });

  it('preserves a zero returned amount and full burned remainder', () => {
    expect(
      projectEscrowRefundRecovery({
        ...base,
        latestBlockTimestamp: 279_200n,
        lock: locked({ failedRefund: 0n, splitRecorded: true }),
        escrowState: escrowState({ finalized: true, finalizedAt: 20_000n }),
        constants,
      }),
    ).toMatchObject({ returnedAmount: 0n, burnedAmount: 1_000n, availability: 'claimable' });
  });

  it('blocks finalized-without-split until the exact post-finalize (72-hour) boundary, refunding full principal', () => {
    const state = escrowState({ finalized: true, finalizedAt: 20_000n });
    const waiting = projectEscrowRefundRecovery({
      ...base,
      latestBlockTimestamp: 279_199n,
      lock: locked(),
      escrowState: state,
      constants,
    });
    const claimable = projectEscrowRefundRecovery({
      ...base,
      latestBlockTimestamp: 279_200n,
      lock: locked(),
      escrowState: state,
      constants,
    });
    expect(waiting).toMatchObject({
      path: 'escrow-no-split-refund',
      availability: 'waiting',
      claimableAt: 279_200n,
      returnedAmount: 1_000n,
      burnedAmount: 0n,
    });
    expect(claimable).toMatchObject({ availability: 'claimable', claimableAt: 279_200n });
  });

  it('does not treat aggregate finalization or historical hasLocks as bidder completion', () => {
    const item = projectEscrowRefundRecovery({
      ...base,
      latestBlockTimestamp: 279_200n,
      lock: locked({ failedRefund: 600n, splitRecorded: true }),
      escrowState: escrowState({ finalized: true, finalizedAt: 20_000n, lockCount: 100n }),
      constants,
    });
    expect(item).toMatchObject({ path: 'escrow-failed-split-refund', returnedAmount: 600n, burnedAmount: 400n });
  });
});

describe('recovery tuple validation', () => {
  it('accepts reviewed object and tuple shapes', () => {
    expect(decodeVenueCommitBond([5n, 10n])).toEqual({ amount: 5n, lockedAt: 10n });
    expect(decodeVenueBidLock([1_000n, 10n, 1, 100n, true])).toEqual({
      lockedAmount: 1_000n,
      lockedAt: 10n,
      status: 'locked',
      failedRefund: 100n,
      splitRecorded: true,
    });
    expect(decodeVenueAuctionEscrowState([1_000n, 1n, 20n, true])).toEqual({
      totalLocked: 1_000n,
      lockCount: 1n,
      finalizedAt: 20n,
      finalized: true,
    });
  });

  it('rejects malformed RPC tuples and unsupported enums', () => {
    expect(() => decodeVenueCommitBond(['bad', 1n])).toThrow(TypeError);
    expect(() => decodeVenueBidLock([1n, 1n, 3, 0n, false])).toThrow('not supported');
    expect(() => decodeVenueAuctionEscrowState([1n, 1n, 0n, true])).toThrow('must expose finalizedAt');
  });

  it('rejects arithmetic bounds and impossible bidder states', () => {
    expect(() => decodeVenueBidLock([1n << 128n, 1n, 1, 0n, false])).toThrow(RangeError);
    expect(() => decodeVenueBidLock([100n, 1n, 1, 101n, true])).toThrow('exceeds the locked amount');
    expect(() => decodeVenueBidLock([100n, 1n, 1, 10n, false])).toThrow('without validated split');
    expect(() => decodeVenueBidLock([0n, 0n, 1, 0n, false])).toThrow('nonzero amount and timestamp');
  });
});
