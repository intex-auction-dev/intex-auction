import { decodeEnumTag } from './enum-tag';
import { calculateEscrowLockMinor } from './escrow-lock';

export type IntexLifecycle = 'issued' | 'qualified' | 'called' | 'expired';
export type IntexTokenStatus = 'issued' | 'settled';
export type TargetAuctionResult = 'awaiting-result' | 'sale' | 'no-sale' | 'cancelled' | 'no-auction';
export type SeriesProvisioning = 'awaiting-series' | 'provisioned' | 'not-applicable-no-sale';
export type RecipientDelivery =
  | 'not-applicable-no-sale'
  | 'awaiting-issuance-instructions'
  | 'deferred'
  | 'delivered'
  | 'not-a-winner'
  | 'unknown';

export interface BidderFinalizationEvidence {
  lockedAmount: bigint;
  lockStatus: 'none' | 'locked' | 'finalized';
  wonCount: bigint;
  promisLoadMinor: bigint;
  clearingRate: bigint;
  issuanceInstructionsReceived: boolean;
  deliveryDeferred: boolean;
  deliveryObserved: boolean;
  noSale?: boolean;
  exactRefundedAmount?: bigint;
  exactPaidAmount?: bigint;
  recoveredAmount?: bigint;
  burnedAmount?: bigint;
}

export type BidderEconomics =
  | { kind: 'no-bid-lock' }
  | { kind: 'pending'; lockedAmount: bigint }
  | { kind: 'unknown'; lockedAmount: bigint; reason: string }
  | {
      kind: 'finalized';
      lockedAmount: bigint;
      paidAmount: bigint;
      refundedAmount: bigint;
      burnedAmount: bigint;
      wonCount: bigint;
      source: 'normal-finalization' | 'recovery';
    };

export const decodeIntexLifecycle = (tag: number): IntexLifecycle =>
  decodeEnumTag('Intex lifecycle', tag, { 0: 'issued', 1: 'qualified', 2: 'called', 3: 'expired' });

export const decodeIntexTokenStatus = (tag: number): IntexTokenStatus =>
  decodeEnumTag('Intex token status', tag, { 0: 'issued', 1: 'settled' });

export const targetAuctionResult = (
  stage: 'committing-bids' | 'revealing-bids' | 'issuance' | 'completed' | 'cancelled',
  issuedIntexCount: number,
): TargetAuctionResult => {
  if (stage === 'cancelled') return 'cancelled';
  if (stage !== 'completed') return 'awaiting-result';
  return issuedIntexCount === 0 ? 'no-sale' : 'sale';
};

export const deriveSeriesProvisioning = (
  result: TargetAuctionResult,
  targetSeriesCount: number,
): SeriesProvisioning => {
  if (result === 'no-sale') return 'not-applicable-no-sale';
  if (result === 'no-auction') return 'awaiting-series';
  return targetSeriesCount > 0 ? 'provisioned' : 'awaiting-series';
};

export const isTargetSeriesExpired = (input: {
  lifecycle: IntexLifecycle;
  calledAt: bigint;
  intexCallPeriod: bigint;
  latestBlockTimestamp: bigint;
}): boolean => input.lifecycle === 'called' && input.latestBlockTimestamp > input.calledAt + input.intexCallPeriod;

export const deriveRecipientDelivery = (input: {
  result: TargetAuctionResult;
  seriesProvisioned: boolean;
  issuanceInstructionsReceived: boolean;
  deferred: boolean;
  deliveredEvent: boolean;
  wonCount: bigint;
  bidderEconomics: BidderEconomics | null;
}): RecipientDelivery => {
  if (input.result === 'no-sale') return 'not-applicable-no-sale';
  if (input.result === 'no-auction') return 'unknown';
  if (input.result !== 'sale') return 'unknown';
  if (!input.seriesProvisioned || !input.issuanceInstructionsReceived) {
    return 'awaiting-issuance-instructions';
  }
  if (input.deferred) return 'deferred';
  if (input.wonCount > 0n && input.deliveredEvent) return 'delivered';
  if (
    input.bidderEconomics?.kind === 'finalized' &&
    input.bidderEconomics.refundedAmount === input.bidderEconomics.lockedAmount
  ) {
    return 'not-a-winner';
  }
  return 'unknown';
};

export const deriveBidderEconomics = (input: BidderFinalizationEvidence): BidderEconomics => {
  if (input.lockStatus === 'none') return { kind: 'no-bid-lock' };
  if (input.lockStatus === 'locked') return { kind: 'pending', lockedAmount: input.lockedAmount };

  if (input.exactRefundedAmount !== undefined || input.exactPaidAmount !== undefined) {
    if (input.exactRefundedAmount === undefined || input.exactPaidAmount === undefined) {
      throw new TypeError('Exact finalization evidence must include both refunded and paid amounts.');
    }
    if (input.exactRefundedAmount + input.exactPaidAmount !== input.lockedAmount) {
      throw new RangeError('Exact finalization economics do not reconcile with the bidder lock.');
    }
    return {
      kind: 'finalized',
      lockedAmount: input.lockedAmount,
      paidAmount: 0n,
      refundedAmount: input.exactRefundedAmount,
      burnedAmount: input.exactPaidAmount,
      wonCount: input.wonCount,
      source: 'recovery',
    };
  }

  if (input.recoveredAmount !== undefined || input.burnedAmount !== undefined) {
    const refundedAmount = input.recoveredAmount ?? 0n;
    const burnedAmount = input.burnedAmount ?? 0n;
    if (refundedAmount < 0n || burnedAmount < 0n || refundedAmount + burnedAmount !== input.lockedAmount) {
      throw new RangeError('Recovery economics must exactly partition the bidder lock.');
    }
    return {
      kind: 'finalized',
      lockedAmount: input.lockedAmount,
      paidAmount: 0n,
      refundedAmount,
      burnedAmount,
      wonCount: input.wonCount,
      source: 'recovery',
    };
  }

  if (input.noSale) {
    return {
      kind: 'finalized',
      lockedAmount: input.lockedAmount,
      paidAmount: 0n,
      refundedAmount: input.lockedAmount,
      burnedAmount: 0n,
      wonCount: 0n,
      source: 'normal-finalization',
    };
  }

  if (!input.issuanceInstructionsReceived || input.deliveryDeferred) {
    return {
      kind: 'unknown',
      lockedAmount: input.lockedAmount,
      reason: 'Bidder finalization is complete, but recipient issuance evidence is unresolved.',
    };
  }
  if (input.wonCount > 0n && !input.deliveryObserved) {
    return {
      kind: 'unknown',
      lockedAmount: input.lockedAmount,
      reason: 'Delivered allocation has not been reconciled with target issuance evidence.',
    };
  }

  const paidAmount =
    input.wonCount === 0n
      ? 0n
      : calculateEscrowLockMinor({
          quantity: input.wonCount,
          promisLoadMinor: input.promisLoadMinor,
          bidRate: input.clearingRate,
        });
  if (paidAmount > input.lockedAmount) {
    throw new RangeError('Authoritative paid amount exceeds the bidder lock.');
  }
  return {
    kind: 'finalized',
    lockedAmount: input.lockedAmount,
    paidAmount,
    refundedAmount: input.lockedAmount - paidAmount,
    burnedAmount: 0n,
    wonCount: input.wonCount,
    source: 'normal-finalization',
  };
};
