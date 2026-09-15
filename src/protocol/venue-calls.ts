import { getAddress, type Address, type Hash, type Hex } from 'viem';
import { asHash, asHexBytes, asUint, asUintNumber } from '../chain/abi-coerce';
import type { VenueDeploymentProfile } from '../chain/deployment-profile';
import type { WorldwideDayKey } from '../domain/protocol-time';
import { dayNumber } from './venue-decode';
import type { VenueRecoveryPath } from './profile-types';

export const buildApprovalCall = (
  profile: VenueDeploymentProfile,
  input: {
    readonly token: Address;
    readonly spender: Address;
    readonly amount: bigint;
  },
) => ({
  address: getAddress(input.token),
  abi: profile.abis.paymentToken,
  functionName: 'approve',
  args: [getAddress(input.spender), asUint(input.amount, 256, 'Approval amount')] as const,
});

export const buildCommitCall = (profile: VenueDeploymentProfile, worldwideDay: WorldwideDayKey, commitHash: Hash) => ({
  address: profile.addresses.intexAuction,
  abi: profile.abis.intexAuction,
  functionName: 'commitBid',
  args: [asUintNumber(dayNumber(worldwideDay), 32, 'Commit WorldwideDay'), asHash(commitHash, 'Commit hash')] as const,
});

export const buildCancelCommitCall = (profile: VenueDeploymentProfile, worldwideDay: WorldwideDayKey) => ({
  address: profile.addresses.intexAuction,
  abi: profile.abis.intexAuction,
  functionName: 'cancelCommit',
  args: [asUintNumber(dayNumber(worldwideDay), 32, 'Cancellation WorldwideDay')] as const,
});

export const buildRevealCall = (
  profile: VenueDeploymentProfile,
  input: {
    readonly worldwideDay: WorldwideDayKey;
    readonly quantity: number;
    readonly bidRate: number;
    readonly issuanceCurrency: number;
    readonly referenceCurrency: number;
    readonly chainId: number;
    readonly signature: Hex;
  },
) => {
  const day = asUintNumber(dayNumber(input.worldwideDay), 32, 'Reveal WorldwideDay');
  const quantity = asUintNumber(input.quantity, 16, 'Reveal quantity');
  const bidRate = asUintNumber(input.bidRate, 32, 'Reveal bid rate');
  const chainId = asUintNumber(input.chainId, 64, 'Reveal chain id');
  const signature = asHexBytes(input.signature, 'Reveal signature');
  const args = [
    day,
    quantity,
    bidRate,
    asUintNumber(input.issuanceCurrency, 16, 'Reveal issuance currency'),
    asUintNumber(input.referenceCurrency, 16, 'Reveal reference currency'),
    chainId,
    signature,
  ];
  return {
    address: profile.addresses.intexAuction,
    abi: profile.abis.intexAuction,
    functionName: 'revealBid',
    args,
  };
};

export const buildRecoveryCall = (
  profile: VenueDeploymentProfile,
  input: {
    readonly path: VenueRecoveryPath;
    readonly worldwideDay: WorldwideDayKey;
    readonly bidder: Address;
    readonly auctionContract: Address;
    readonly escrowContract: Address;
  },
) => {
  const auctionSide = input.path === 'auction-commit-bond';
  return {
    address: getAddress(auctionSide ? input.auctionContract : input.escrowContract),
    abi: auctionSide ? profile.abis.intexAuction : profile.abis.escrowAdapter,
    functionName: auctionSide
      ? 'claimCommitBond'
      : input.path === 'escrow-abandoned-commit-bond'
        ? 'claimAbandonedCommitBond'
        : 'claimRefund',
    args: [asUintNumber(dayNumber(input.worldwideDay), 32, 'Recovery WorldwideDay'), getAddress(input.bidder)] as const,
  };
};
