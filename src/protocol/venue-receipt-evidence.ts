import { decodeEventLog, getAddress, type Abi, type Address, type Hash, type TransactionReceipt } from 'viem';
import { asAddress, asHash, asUint, asUintNumber } from '../chain/abi-coerce';
import type { VenueDeploymentProfile } from '../chain/deployment-profile';
import { dayNumber } from './venue-decode';
import type { WorldwideDayKey } from '../domain/protocol-time';

const decodedReceiptEvent = (
  abi: Abi,
  log: TransactionReceipt['logs'][number],
): { readonly eventName: string; readonly args: Record<string, unknown> } | null => {
  try {
    return decodeEventLog({ abi, data: log.data, topics: log.topics } as never) as unknown as {
      readonly eventName: string;
      readonly args: Record<string, unknown>;
    };
  } catch {
    return null;
  }
};

const receiptEventObserved = (input: {
  readonly receipt: TransactionReceipt;
  readonly address: Address;
  readonly abi: Abi;
  readonly eventName: string;
  readonly matches: (args: Record<string, unknown>) => boolean;
}): boolean =>
  input.receipt.logs.some((log) => {
    try {
      if (getAddress(log.address) !== getAddress(input.address)) return false;
      const decoded = decodedReceiptEvent(input.abi, log);
      return decoded?.eventName === input.eventName && input.matches(decoded.args);
    } catch {
      return false;
    }
  });

export const readCommitReceiptEvidence = (
  profile: VenueDeploymentProfile,
  receipt: TransactionReceipt,
  expected: {
    readonly worldwideDay: WorldwideDayKey;
    readonly bidder: Address;
    readonly commitHash: Hash;
  },
): { readonly committed: boolean } => ({
  committed: receiptEventObserved({
    receipt,
    address: profile.addresses.intexAuction,
    abi: profile.abis.intexAuction,
    eventName: 'BidCommitted',
    matches: (args) =>
      asUintNumber(args.worldwideDay, 32, 'BidCommitted WorldwideDay') === dayNumber(expected.worldwideDay) &&
      asAddress(args.bidder, 'BidCommitted bidder') === getAddress(expected.bidder) &&
      asHash(args.commitHash, 'BidCommitted commit hash') === asHash(expected.commitHash, 'Expected commit hash'),
  }),
});

export const readCancellationReceiptEvidence = (
  profile: VenueDeploymentProfile,
  receipt: TransactionReceipt,
  expected: {
    readonly worldwideDay: WorldwideDayKey;
    readonly bidder: Address;
    readonly escrowContract: Address;
    readonly bondAmount: bigint;
  },
): { readonly cancelled: boolean; readonly released: boolean } => ({
  cancelled: receiptEventObserved({
    receipt,
    address: profile.addresses.intexAuction,
    abi: profile.abis.intexAuction,
    eventName: 'CommitCancelled',
    matches: (args) =>
      asUintNumber(args.worldwideDay, 32, 'CommitCancelled WorldwideDay') === dayNumber(expected.worldwideDay) &&
      asAddress(args.bidder, 'CommitCancelled bidder') === getAddress(expected.bidder),
  }),
  released: receiptEventObserved({
    receipt,
    address: expected.escrowContract,
    abi: profile.abis.escrowAdapter,
    eventName: 'CommitBondReleased',
    matches: (args) =>
      asUintNumber(args.worldwideDay, 32, 'CommitBondReleased WorldwideDay') === dayNumber(expected.worldwideDay) &&
      asAddress(args.bidder, 'CommitBondReleased bidder') === getAddress(expected.bidder) &&
      asUint(args.amount, 128, 'CommitBondReleased amount') === expected.bondAmount,
  }),
});

export const readRevealReceiptEvidence = (
  profile: VenueDeploymentProfile,
  receipt: TransactionReceipt,
  expected: {
    readonly worldwideDay: WorldwideDayKey;
    readonly bidder: Address;
    readonly escrowContract: Address;
    readonly issuanceCurrency: number;
    readonly quantity: number;
    readonly bidRate: number;
    readonly lockAmount: bigint;
    readonly bondAmount: bigint;
  },
): { readonly revealed: boolean; readonly locked: boolean; readonly released: boolean } => ({
  revealed: receiptEventObserved({
    receipt,
    address: profile.addresses.intexAuction,
    abi: profile.abis.intexAuction,
    eventName: 'BidRevealed',
    matches: (args) =>
      asUintNumber(args.worldwideDay, 32, 'BidRevealed WorldwideDay') === dayNumber(expected.worldwideDay) &&
      asAddress(args.bidder, 'BidRevealed bidder') === getAddress(expected.bidder) &&
      asUintNumber(args.issuanceCurrency, 16, 'BidRevealed issuance currency') === expected.issuanceCurrency &&
      asUintNumber(args.quantity, 16, 'BidRevealed quantity') === expected.quantity &&
      asUintNumber(args.bidRate, 32, 'BidRevealed bid rate') === expected.bidRate,
  }),
  locked: receiptEventObserved({
    receipt,
    address: expected.escrowContract,
    abi: profile.abis.escrowAdapter,
    eventName: 'FundsLocked',
    matches: (args) =>
      asUintNumber(args.worldwideDay, 32, 'FundsLocked WorldwideDay') === dayNumber(expected.worldwideDay) &&
      asAddress(args.bidder, 'FundsLocked bidder') === getAddress(expected.bidder) &&
      asUint(args.amount, 128, 'FundsLocked amount') === expected.lockAmount,
  }),
  released: receiptEventObserved({
    receipt,
    address: expected.escrowContract,
    abi: profile.abis.escrowAdapter,
    eventName: 'CommitBondReleased',
    matches: (args) =>
      asUintNumber(args.worldwideDay, 32, 'CommitBondReleased WorldwideDay') === dayNumber(expected.worldwideDay) &&
      asAddress(args.bidder, 'CommitBondReleased bidder') === getAddress(expected.bidder) &&
      asUint(args.amount, 128, 'CommitBondReleased amount') === expected.bondAmount,
  }),
});

export const readRecoveryReceiptEvidence = (
  profile: VenueDeploymentProfile,
  receipt: TransactionReceipt,
  expected: {
    readonly worldwideDay: WorldwideDayKey;
    readonly bidder: Address;
    readonly escrowContract: Address;
    readonly returnedAmount: bigint;
    readonly burnedAmount: bigint;
  },
): {
  readonly released: boolean;
  readonly refunded: boolean;
  readonly burned: boolean;
  readonly unexpectedRefund: boolean;
  readonly unexpectedBurn: boolean;
} => {
  const exact = (eventName: 'CommitBondReleased' | 'FundsRefunded' | 'ProceedsBurned', amount: bigint): boolean =>
    receiptEventObserved({
      receipt,
      address: expected.escrowContract,
      abi: profile.abis.escrowAdapter,
      eventName,
      matches: (args) =>
        asUintNumber(args.worldwideDay, 32, `${eventName} WorldwideDay`) === dayNumber(expected.worldwideDay) &&
        asAddress(args.bidder, `${eventName} bidder`) === getAddress(expected.bidder) &&
        asUint(args.amount, 128, `${eventName} amount`) === amount,
    });
  const unexpected = (eventName: 'FundsRefunded' | 'ProceedsBurned', amount: bigint): boolean =>
    receipt.logs.some((log) => {
      try {
        if (getAddress(log.address) !== getAddress(expected.escrowContract)) return false;
        const decoded = decodedReceiptEvent(profile.abis.escrowAdapter, log);
        return (
          decoded?.eventName === eventName &&
          asUintNumber(decoded.args.worldwideDay, 32, `${eventName} WorldwideDay`) ===
            dayNumber(expected.worldwideDay) &&
          asAddress(decoded.args.bidder, `${eventName} bidder`) === getAddress(expected.bidder) &&
          asUint(decoded.args.amount, 128, `${eventName} amount`) !== amount
        );
      } catch {
        return false;
      }
    });
  return {
    released: exact('CommitBondReleased', expected.returnedAmount),
    refunded: exact('FundsRefunded', expected.returnedAmount),
    burned: exact('ProceedsBurned', expected.burnedAmount),
    unexpectedRefund: unexpected('FundsRefunded', expected.returnedAmount),
    unexpectedBurn: unexpected('ProceedsBurned', expected.burnedAmount),
  };
};
