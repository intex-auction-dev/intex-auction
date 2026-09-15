import type { Address, Hash, Hex } from 'viem';
import type { DurationSeconds, UtcTimestamp, WorldwideDayKey } from '../domain/protocol-time';
import type { GlobalAuctionStage, VenueAuctionStage, WorldwideDayLifecycle, WorldwideDayType } from './read-model';

export interface WorldwideDaySnapshot {
  worldwideDay: WorldwideDayKey;
  lifecycle: WorldwideDayLifecycle;
  dayType: WorldwideDayType;
  formingStart: UtcTimestamp;
  formingEnd: UtcTimestamp;
  lookbackEnd: UtcTimestamp;
  offeringEnd: UtcTimestamp;
  scheduledProcessTime: UtcTimestamp;
  previousVwap: bigint;
  currentVwap: bigint;
}

export type OriginTerminalDisposition = 'missed-offering' | 'capacity-forfeiture';

export interface OriginTerminalEvidence {
  disposition: OriginTerminalDisposition;
  valueRouted: bigint;
  carryOverBefore: bigint;
  carryOverAfter: bigint;
  retirement: 'not-present' | 'requested';
  blockNumber: bigint;
}

export type WorldwideDayReadState =
  | { kind: 'retained'; snapshot: WorldwideDaySnapshot; terminal: OriginTerminalEvidence | null }
  | { kind: 'not-found' }
  | {
      kind: 'history-unavailable';
      terminal: OriginTerminalEvidence | null;
      cleanedFinalLifecycle: 'completed' | 'failed' | null;
    };

export interface GlobalAuctionSnapshot {
  stage: GlobalAuctionStage;
  totalBids: bigint;
  venueBids: bigint;
  venueIntakeComplete: boolean;
  venueInTargetSnapshot: boolean;
}

export interface OraclePriceSnapshot {
  timestamp: UtcTimestamp;
  rate: bigint;
  volume: bigint;
}

export interface OracleExchangeRate {
  pair: { base: string; quote: string };
  rate: bigint;
  lastBlock: bigint;
  lastTimestamp: UtcTimestamp;
}

export interface OracleSettlementCurrency {
  isoCode: number;
  denomination: string;
}

export interface OraclePriceHistory {
  pair: { base: string; quote: string };
  requestedCount: number;
  pointsNewestFirst: readonly OraclePriceSnapshot[];
}

export interface CanonicalSeriesSnapshot {
  seriesId: Hex;
  promisLoadMinor: bigint;
  entryPriceMinor: bigint;
  floorPriceMinor: bigint;
  issuedIntexCount: number;
  callWindowDays: number;
  callThresholdDays: number;
  callPriceMinor: bigint;
  state: number;
  issuedAt: UtcTimestamp;
  calledAt: UtcTimestamp;
  intexCallPeriod: DurationSeconds;
  issuanceCurrency: number;
  referenceCurrency: number;
  worldwideDay?: WorldwideDayKey;
  costAmountMinor?: bigint;
}

export interface VenueAuctionSnapshot {
  worldwideDay: WorldwideDayKey;
  stage: VenueAuctionStage;
  dayType: Exclude<WorldwideDayType, 'unknown'>;
  paymentToken: Address;
  schedule: {
    commitEnd: UtcTimestamp;
    revealEnd: UtcTimestamp;
    issuanceEnd: UtcTimestamp;
  };
  params: {
    issuanceCurrency: number;
    issuanceCurrencies?: readonly number[];
    issuanceEntryPrices?: readonly bigint[];
    strikeAmountsMinor?: readonly bigint[];
    oraclePairIds?: readonly number[];
    referenceCurrency: number;
    referenceCurrencies?: readonly number[];
    referenceEntryPrices?: readonly bigint[];
    promisLoadMinor: bigint;
    minIntexBidRate: number;
    minIntexBidQuantity: number;
    entryPriceMinor: bigint;
    floorPriceMinor: bigint;
    callPriceMinor: bigint;
    commitBondMinor: bigint;
    callTrigger: {
      windowDays: number;
      thresholdDays: number;
      intexCallPeriod: DurationSeconds;
    };
  };
  runningCounts: {
    committedBids: number;
    revealedBids: number;
  };
  result: {
    auctionClearingRate: bigint;
    wonBidsCount: number;
    issuedIntexCount: number;
    issuedIntexLoadedPromis: bigint;
  };
}

export type VenueBidLockStatus = 'none' | 'locked' | 'finalized';
export type VenueRecoveryPath =
  | 'auction-commit-bond'
  | 'escrow-abandoned-commit-bond'
  | 'escrow-unfinalized-refund'
  | 'escrow-failed-split-refund'
  | 'escrow-no-split-refund';

export interface VenueCommitBondState {
  readonly amount: bigint;
  readonly lockedAt: bigint;
}

export interface VenueBidLockState {
  readonly lockedAmount: bigint;
  readonly lockedAt: bigint;
  readonly status: VenueBidLockStatus;
  readonly failedRefund: bigint;
  readonly splitRecorded: boolean;
}

export interface VenueAuctionEscrowState {
  readonly totalLocked: bigint;
  readonly lockCount: bigint;
  readonly finalizedAt: bigint;
  readonly finalized: boolean;
}

export interface VenueRecoveryContractConstants {
  readonly abandonedCommitBondDelay: bigint;
  readonly unfinalizedRefundDelay: bigint;
  readonly postFinalizeRefundDelay: bigint;
  readonly noSplitRefundDelay: bigint;
}

export interface VenueEscrowBidderState {
  readonly auctionContract: Address;
  readonly paymentToken: Address;
  readonly paymentTokenDecimals: number;
  readonly paymentTokenSymbol: string;
  readonly bond: VenueCommitBondState;
  readonly bidLock: VenueBidLockState;
}

export interface VenueEscrowRecoveryState extends VenueEscrowBidderState {
  readonly constants: VenueRecoveryContractConstants;
  readonly escrowState: VenueAuctionEscrowState;
}

export interface VenueAuctionRecoveryState {
  readonly escrowContract: Address;
  readonly stage: VenueAuctionStage;
  readonly revealEnd: bigint;
  readonly unrevealedBondLockPeriod: bigint;
}

export interface VenueBidderState {
  readonly stage: VenueAuctionStage;
  readonly schedule: {
    readonly commitEnd: bigint;
    readonly revealEnd: bigint;
    readonly issuanceEnd: bigint;
  };
  readonly params: {
    readonly issuanceCurrencies: readonly number[];
    readonly issuanceEntryPrices: readonly bigint[];
    readonly strikeAmountsMinor: readonly bigint[];
    readonly oraclePairIds: readonly number[];
    readonly referenceCurrency: number;
    readonly referenceCurrencies: readonly number[];
    readonly referenceEntryPrices: readonly bigint[];
    readonly entryPriceMinor: bigint;
    readonly floorPriceMinor: bigint;
    readonly callPriceMinor: bigint;
    readonly promisLoadMinor: bigint;
    readonly minIntexBidRate: number;
    readonly minIntexBidQuantity: number;
    readonly commitBondMinor: bigint;
  };
  readonly liveCommitHash: Hash;
  readonly bidderRevealed: boolean;
  readonly escrowAdapter: Address;
  readonly escrowAuction: Address;
  readonly paymentToken: Address;
  readonly paymentTokenDecimals: number;
  readonly paymentTokenSymbol: string;
  readonly balance: bigint;
  readonly allowance: bigint;
  readonly bidderBondAmount: bigint;
  readonly bidderBondLockedAt: bigint;
  readonly bidLock: VenueBidLockState;
}
