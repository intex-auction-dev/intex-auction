import { asBoolean, asSafeNumber, asUint, tupleValue } from '../chain/abi-coerce';
import type { WorldwideDayKey } from '../domain/protocol-time';
import { decodeWorldwideDayType, type WorldwideDayType } from './read-model';
import type {
  VenueAuctionEscrowState,
  VenueBidLockState,
  VenueBidLockStatus,
  VenueCommitBondState,
} from './profile-types';

export const dayNumber = (worldwideDay: WorldwideDayKey): number => Number(worldwideDay);

export const asVenueDayType = (value: unknown): Exclude<WorldwideDayType, 'unknown'> => {
  const dayType = decodeWorldwideDayType(asSafeNumber(value, 'Venue worldwide-day state'));
  if (dayType === 'unknown') {
    throw new RangeError('A delivered venue auction cannot persist an unknown WorldwideDay state.');
  }
  return dayType;
};

export const decodeVenueCommitBond = (value: unknown): VenueCommitBondState => ({
  amount: asUint(tupleValue(value, 'amount', 0, 'CommitBond'), 128, 'CommitBond amount'),
  lockedAt: asUint(tupleValue(value, 'lockedAt', 1, 'CommitBond'), 32, 'CommitBond lockedAt'),
});

export const decodeVenueBidLock = (value: unknown): VenueBidLockState => {
  const rawStatus = asUint(tupleValue(value, 'status', 2, 'BidLock'), 8, 'BidLock status');
  const status: VenueBidLockStatus =
    rawStatus === 0n
      ? 'none'
      : rawStatus === 1n
        ? 'locked'
        : rawStatus === 2n
          ? 'finalized'
          : (() => {
              throw new RangeError('BidLock status is not supported by the reviewed profile.');
            })();
  const lock: VenueBidLockState = {
    lockedAmount: asUint(tupleValue(value, 'lockedAmount', 0, 'BidLock'), 128, 'BidLock lockedAmount'),
    lockedAt: asUint(tupleValue(value, 'lockedAt', 1, 'BidLock'), 32, 'BidLock lockedAt'),
    status,
    failedRefund: asUint(tupleValue(value, 'failedRefund', 3, 'BidLock'), 128, 'BidLock failedRefund'),
    splitRecorded: asBoolean(tupleValue(value, 'splitRecorded', 4, 'BidLock'), 'BidLock splitRecorded'),
  };
  if (
    lock.status === 'none' &&
    (lock.lockedAmount !== 0n || lock.lockedAt !== 0n || lock.failedRefund !== 0n || lock.splitRecorded)
  ) {
    throw new TypeError('A none BidLock contains active fields.');
  }
  if (lock.status === 'locked' && (lock.lockedAmount === 0n || lock.lockedAt === 0n)) {
    throw new TypeError('A live BidLock must contain a nonzero amount and timestamp.');
  }
  if (lock.failedRefund > lock.lockedAmount) throw new RangeError('BidLock failedRefund exceeds the locked amount.');
  if (!lock.splitRecorded && lock.failedRefund !== 0n) {
    throw new TypeError('BidLock failedRefund is present without validated split evidence.');
  }
  return lock;
};

export const decodeVenueAuctionEscrowState = (value: unknown): VenueAuctionEscrowState => {
  const state: VenueAuctionEscrowState = {
    totalLocked: asUint(
      tupleValue(value, 'totalLocked', 0, 'AuctionEscrowState'),
      128,
      'AuctionEscrowState totalLocked',
    ),
    lockCount: asUint(tupleValue(value, 'lockCount', 1, 'AuctionEscrowState'), 32, 'AuctionEscrowState lockCount'),
    finalizedAt: asUint(
      tupleValue(value, 'finalizedAt', 2, 'AuctionEscrowState'),
      32,
      'AuctionEscrowState finalizedAt',
    ),
    finalized: asBoolean(tupleValue(value, 'finalized', 3, 'AuctionEscrowState'), 'AuctionEscrowState finalized'),
  };
  if (state.finalized && state.finalizedAt === 0n) throw new TypeError('A finalized escrow must expose finalizedAt.');
  if (!state.finalized && state.finalizedAt !== 0n)
    throw new TypeError('An unfinalized escrow cannot expose finalizedAt.');
  return state;
};
