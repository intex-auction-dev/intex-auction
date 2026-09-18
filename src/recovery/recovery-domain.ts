import { getAddress, type Address } from 'viem';
import type { WorldwideDayKey } from '../domain/protocol-time';
import type {
  VenueAuctionEscrowState,
  VenueBidLockState,
  VenueBidLockStatus,
  VenueCommitBondState,
  VenueRecoveryContractConstants,
  VenueRecoveryPath,
} from '../protocol/profile-types';
import type { VenueAuctionStage } from '../protocol/read-model';

export type RecoveryPath = VenueRecoveryPath;
export type RecoveryAvailability = 'waiting' | 'claimable';

export interface RecoveryContractConstants extends VenueRecoveryContractConstants {
  readonly unrevealedBondLockPeriod: bigint;
}

export type RecoveryCommitBond = VenueCommitBondState;
export type RecoveryBidLockStatus = VenueBidLockStatus;
export type RecoveryBidLock = VenueBidLockState;
export type RecoveryAuctionEscrowState = VenueAuctionEscrowState;

export interface RecoveryItem {
  readonly key: string;
  readonly path: RecoveryPath;
  readonly worldwideDay: WorldwideDayKey;
  readonly bidder: Address;
  readonly auctionContract: Address;
  readonly escrowContract: Address;
  readonly paymentToken: Address;
  readonly paymentTokenDecimals: number;
  readonly paymentTokenSymbol: string;
  readonly custody: 'current' | 'historical';
  readonly returnedAmount: bigint;
  readonly burnedAmount: bigint;
  readonly claimableAt: bigint | null;
  readonly latestBlockTimestamp: bigint;
  readonly availability: RecoveryAvailability;
  readonly explanation: string;
}

export class RecoveryProjectionError extends Error {}

const deadlineAvailability = (latest: bigint, claimableAt: bigint | null): RecoveryAvailability =>
  claimableAt === null || latest >= claimableAt ? 'claimable' : 'waiting';

export const recoveryItemKey = (input: {
  readonly chainId: number;
  readonly deploymentId: string;
  readonly path: RecoveryPath;
  readonly worldwideDay: WorldwideDayKey;
  readonly bidder: Address;
  readonly contract: Address;
}): string =>
  [
    input.chainId,
    encodeURIComponent(input.deploymentId),
    input.path,
    input.worldwideDay,
    getAddress(input.bidder).toLowerCase(),
    getAddress(input.contract).toLowerCase(),
  ].join(':');

export const projectAuctionCommitBondRecovery = (input: {
  readonly chainId: number;
  readonly deploymentId: string;
  readonly worldwideDay: WorldwideDayKey;
  readonly bidder: Address;
  readonly auctionContract: Address;
  readonly escrowContract: Address;
  readonly paymentToken: Address;
  readonly paymentTokenDecimals: number;
  readonly paymentTokenSymbol: string;
  readonly custody: 'current' | 'historical';
  readonly stage: VenueAuctionStage;
  readonly revealEnd: bigint;
  readonly latestBlockTimestamp: bigint;
  readonly bond: RecoveryCommitBond;
  readonly unrevealedBondLockPeriod: bigint;
}): RecoveryItem | null => {
  if (input.bond.amount === 0n) return null;
  if (input.stage === 'committing-bids' || input.stage === 'revealing-bids') return null;
  const claimableAt = input.stage === 'cancelled' ? null : input.revealEnd + input.unrevealedBondLockPeriod;
  const explanation =
    input.stage === 'cancelled'
      ? 'The cancelled auction can release this live commit bond immediately through the auction contract.'
      : 'The bidder did not reveal. The auction contract can release the live bond after the stored reveal deadline plus the reviewed lock period.';
  return {
    key: recoveryItemKey({
      chainId: input.chainId,
      deploymentId: input.deploymentId,
      path: 'auction-commit-bond',
      worldwideDay: input.worldwideDay,
      bidder: input.bidder,
      contract: input.auctionContract,
    }),
    path: 'auction-commit-bond',
    worldwideDay: input.worldwideDay,
    bidder: getAddress(input.bidder),
    auctionContract: getAddress(input.auctionContract),
    escrowContract: getAddress(input.escrowContract),
    paymentToken: getAddress(input.paymentToken),
    paymentTokenDecimals: input.paymentTokenDecimals,
    paymentTokenSymbol: input.paymentTokenSymbol,
    custody: input.custody,
    returnedAmount: input.bond.amount,
    burnedAmount: 0n,
    claimableAt,
    latestBlockTimestamp: input.latestBlockTimestamp,
    availability: deadlineAvailability(input.latestBlockTimestamp, claimableAt),
    explanation,
  };
};

export const projectAbandonedCommitBondRecovery = (input: {
  readonly chainId: number;
  readonly deploymentId: string;
  readonly worldwideDay: WorldwideDayKey;
  readonly bidder: Address;
  readonly auctionContract: Address;
  readonly escrowContract: Address;
  readonly paymentToken: Address;
  readonly paymentTokenDecimals: number;
  readonly paymentTokenSymbol: string;
  readonly custody: 'current' | 'historical';
  readonly latestBlockTimestamp: bigint;
  readonly bond: RecoveryCommitBond;
  readonly delay: bigint;
}): RecoveryItem | null => {
  if (input.bond.amount === 0n) return null;
  if (input.bond.lockedAt === 0n) throw new RecoveryProjectionError('A live commit bond must expose lockedAt.');
  const claimableAt = input.bond.lockedAt + input.delay;
  return {
    key: recoveryItemKey({
      chainId: input.chainId,
      deploymentId: input.deploymentId,
      path: 'escrow-abandoned-commit-bond',
      worldwideDay: input.worldwideDay,
      bidder: input.bidder,
      contract: input.escrowContract,
    }),
    path: 'escrow-abandoned-commit-bond',
    worldwideDay: input.worldwideDay,
    bidder: getAddress(input.bidder),
    auctionContract: getAddress(input.auctionContract),
    escrowContract: getAddress(input.escrowContract),
    paymentToken: getAddress(input.paymentToken),
    paymentTokenDecimals: input.paymentTokenDecimals,
    paymentTokenSymbol: input.paymentTokenSymbol,
    custody: input.custody,
    returnedAmount: input.bond.amount,
    burnedAmount: 0n,
    claimableAt,
    latestBlockTimestamp: input.latestBlockTimestamp,
    availability: deadlineAvailability(input.latestBlockTimestamp, claimableAt),
    explanation:
      input.custody === 'historical'
        ? 'This historical escrow still owns the live bond after auction wiring changed. Recovery must target that escrow directly.'
        : 'The escrow-local abandoned-bond path remains independent of the auction contract and its current stage.',
  };
};

export const projectEscrowRefundRecovery = (input: {
  readonly chainId: number;
  readonly deploymentId: string;
  readonly worldwideDay: WorldwideDayKey;
  readonly bidder: Address;
  readonly auctionContract: Address;
  readonly escrowContract: Address;
  readonly paymentToken: Address;
  readonly paymentTokenDecimals: number;
  readonly paymentTokenSymbol: string;
  readonly custody: 'current' | 'historical';
  readonly latestBlockTimestamp: bigint;
  readonly lock: RecoveryBidLock;
  readonly escrowState: RecoveryAuctionEscrowState;
  readonly constants: Pick<RecoveryContractConstants, 'unfinalizedRefundDelay' | 'postFinalizeRefundDelay'>;
}): RecoveryItem | null => {
  if (input.lock.status !== 'locked') return null;
  let path: Extract<
    RecoveryPath,
    'escrow-unfinalized-refund' | 'escrow-failed-split-refund' | 'escrow-no-split-refund'
  >;
  let claimableAt: bigint;
  let returnedAmount: bigint;
  let burnedAmount: bigint;
  let explanation: string;

  if (!input.escrowState.finalized) {
    path = 'escrow-unfinalized-refund';
    claimableAt = input.lock.lockedAt + input.constants.unfinalizedRefundDelay;
    returnedAmount = input.lock.lockedAmount;
    burnedAmount = 0n;
    explanation =
      'This bidder lock was never finalized. The full locked principal becomes recoverable after the unfinalized safety delay.';
  } else if (input.lock.splitRecorded) {
    path = 'escrow-failed-split-refund';
    claimableAt = input.escrowState.finalizedAt + input.constants.postFinalizeRefundDelay;
    returnedAmount = input.lock.failedRefund;
    burnedAmount = input.lock.lockedAmount - input.lock.failedRefund;
    explanation =
      'Aggregate finalization completed, but this bidder retains a live lock with a validated failed split. The recorded refund is returned and the remainder is burned.';
  } else {
    path = 'escrow-no-split-refund';
    claimableAt = input.escrowState.finalizedAt + input.constants.postFinalizeRefundDelay;
    returnedAmount = input.lock.lockedAmount;
    burnedAmount = 0n;
    explanation =
      'Aggregate finalization completed without a validated split for this bidder. The full principal remains blocked until the finalization timestamp plus the reviewed post-finalize refund delay.';
  }

  return {
    key: recoveryItemKey({
      chainId: input.chainId,
      deploymentId: input.deploymentId,
      path,
      worldwideDay: input.worldwideDay,
      bidder: input.bidder,
      contract: input.escrowContract,
    }),
    path,
    worldwideDay: input.worldwideDay,
    bidder: getAddress(input.bidder),
    auctionContract: getAddress(input.auctionContract),
    escrowContract: getAddress(input.escrowContract),
    paymentToken: getAddress(input.paymentToken),
    paymentTokenDecimals: input.paymentTokenDecimals,
    paymentTokenSymbol: input.paymentTokenSymbol,
    custody: input.custody,
    returnedAmount,
    burnedAmount,
    claimableAt,
    latestBlockTimestamp: input.latestBlockTimestamp,
    availability: deadlineAvailability(input.latestBlockTimestamp, claimableAt),
    explanation,
  };
};

export const recoveryPathLabel = (path: RecoveryPath): string => {
  switch (path) {
    case 'auction-commit-bond':
      return 'Auction commit-bond claim';
    case 'escrow-abandoned-commit-bond':
      return 'Historical escrow bond claim';
    case 'escrow-unfinalized-refund':
      return 'Never-finalized escrow refund';
    case 'escrow-failed-split-refund':
      return 'Failed-split escrow refund';
    case 'escrow-no-split-refund':
      return 'No-split escrow refund';
  }
};
