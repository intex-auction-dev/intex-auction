import { hexToBytes, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { asBigint, asRecord, asSafeNumber, asWorldwideDayKey, eventFromAbi } from '../chain/abi-coerce';
import { createPublicReadClient } from '../chain/create-public-read-client';
import { scanLogPages } from '../chain/scan-log-pages';
import { withRpcDiagnostics } from '../chain/rpc-diagnostics';
import { CALENDAR_WINDOW_DAYS, shiftWorldwideDay, type WorldwideDayKey } from '../domain/protocol-time';
import type {
  ResolvedOutbeReadProfile,
  ResolvedVenueReadProfile,
} from '../runtime-config/load-reviewed-runtime-config';
import { fromViemPublicClient, type AuctionReadClient } from '../protocol/read-client';
import { OutbeAuctionAdapter } from '../protocol/origin-adapter';
import { VenueAuctionAdapter } from '../protocol/venue-adapter';
import { OriginWorldwideDayNotFoundError, VenueAuctionNotFoundError } from '../chain/revert-classify';
import type {
  CanonicalSeriesSnapshot,
  GlobalAuctionSnapshot,
  OriginTerminalEvidence,
  VenueAuctionSnapshot,
  WorldwideDaySnapshot,
} from '../protocol/profile-types';
import { classifyPublicReadFailure, type PublicReadFailure } from './load-public-auction';
import type {
  GlobalAuctionStage,
  VenueAuctionStage,
  WorldwideDayLifecycle,
  WorldwideDayType,
} from '../protocol/read-model';

export const CALENDAR_WORKERS = 6;
const ROUTER_BODY_VERSION = 1;
const ROUTER_MESSAGE_TYPES = new Set<number>([3, 4, 5]);
const ROUTER_FIXED_LENGTHS = new Map<number, number>([
  [4, 6],
  [5, 22],
]);
const ROUTER_STAGE_START_HEAD_LENGTH = 70;
const ROUTER_STAGE_START_ROW_LENGTH = 26;
const ROUTER_STAGE_START_PRICE_COUNT_OFFSET = 69;
const ROUTER_STAGE_START_MAX_PRICE_COUNT = 6;

export type CalendarFailureAuthority = 'metadosis' | 'desis' | 'origin-router' | 'intex' | 'venue';

export interface CalendarEvidenceFailure extends PublicReadFailure {
  authority: CalendarFailureAuthority;
}

export type CalendarOriginRecord =
  | { kind: 'retained'; snapshot: WorldwideDaySnapshot }
  | { kind: 'not-found' }
  | { kind: 'cleaned-history-unavailable'; finalLifecycle: 'completed' | 'failed' }
  | { kind: 'failure'; failure: CalendarEvidenceFailure };

export type GlobalTerminalDisposition =
  | 'none'
  | 'active'
  | 'cleared'
  | 'cleared-sale'
  | 'cleared-no-sale'
  | 'cancelled-red'
  | 'cancelled-unpriced'
  | 'overdue';

export interface CalendarGlobalAuction {
  stage: GlobalAuctionStage | null;
  terminalDisposition: GlobalTerminalDisposition;
  totalBids: bigint | null;
  venueBids: bigint | null;
  grossIncludedDemand: bigint | null;
  clearingRate: bigint | null;
  issuedIntexCount: bigint | null;
  offeredQuantity: bigint | null;
  offeredQuantityEvidence: 'unavailable' | 'sold-out' | 'same-transaction-unused-supply';
}

export type CalendarVenueParticipation = 'included' | 'skipped' | 'not-applicable' | 'unknown';

export type OriginDeliveryState = 'not-observed' | 'dispatched' | 'parked' | 'flushed';

export interface CalendarOriginDelivery {
  stageStart: OriginDeliveryState;
  clearing: OriginDeliveryState;
  result: OriginDeliveryState;
}

export type CalendarVenueReceipt =
  | 'not-applicable'
  | 'not-observed'
  | 'delivery-pending'
  | 'stage-received'
  | 'result-received'
  | 'delivered';

export type CalendarScheduleAvailability =
  | { kind: 'pending' }
  | { kind: 'not-applicable' }
  | { kind: 'unavailable' }
  | { kind: 'available'; schedule: VenueAuctionSnapshot['schedule'] };

export interface CalendarWorldwideDay {
  worldwideDay: WorldwideDayKey;
  originRecord: CalendarOriginRecord;
  lifecycle: WorldwideDayLifecycle | null;
  dayType: WorldwideDayType | null;
  terminalDisposition: OriginTerminalEvidence['disposition'] | null;
  globalAuction: CalendarGlobalAuction;
  venueParticipation: CalendarVenueParticipation;
  originDelivery: CalendarOriginDelivery;
  venueReceipt: CalendarVenueReceipt;
  venueStage: VenueAuctionStage | null;
  scheduleAvailability: CalendarScheduleAvailability;
  venueAuction: VenueAuctionSnapshot | null;
  canonicalSeries: CanonicalSeriesSnapshot | null;
  failures: readonly CalendarEvidenceFailure[];
}

export interface CalendarRangeRead {
  start: WorldwideDayKey;
  end: WorldwideDayKey;
  days: readonly CalendarWorldwideDay[];
  failures: readonly CalendarEvidenceFailure[];
}

export interface CalendarRangeReaders {
  originClient: AuctionReadClient;
  venueClient: AuctionReadClient;
  originAdapter: Pick<
    OutbeAuctionAdapter,
    | 'validateDeployment'
    | 'readRetainedWorldwideDays'
    | 'readWorldwideDay'
    | 'readWorldwideDayState'
    | 'readTerminalEvidence'
    | 'readGlobalAuction'
    | 'readCanonicalSeries'
  >;
  venueAdapter: Pick<VenueAuctionAdapter, 'validateDeployment' | 'readAuction'>;
}

export type OriginCalendarReaders = Pick<CalendarRangeReaders, 'originClient'> & {
  originAdapter: CalendarRangeReaders['originAdapter'];
};
export type VenueCalendarReaders = Pick<CalendarRangeReaders, 'venueClient' | 'venueAdapter'> & {
  venuePublicClient: PublicClient;
};

interface DecodedLog {
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

interface OriginEventIndex {
  cleaned: Map<WorldwideDayKey, 'completed' | 'failed'>;
  terminalCandidates: Set<WorldwideDayKey>;
}

interface ClearingEvidence {
  kind: 'sale' | 'no-sale';
  grossIncludedDemand: bigint;
  issuedIntexCount: bigint;
  clearingRate: bigint | null;
  unusedPromis: bigint | null;
}

interface DesisEventIndex {
  candidates: Set<WorldwideDayKey>;
  skipped: Set<WorldwideDayKey>;
  cancelled: Set<WorldwideDayKey>;
  cancelledUnpriced: Set<WorldwideDayKey>;
  overdue: Set<WorldwideDayKey>;
  clearing: Map<WorldwideDayKey, ClearingEvidence>;
}

interface RouterEventIndex {
  delivery: Map<WorldwideDayKey, CalendarOriginDelivery>;
  failures: CalendarEvidenceFailure[];
}

interface VenueEventIndex {
  candidates: Set<WorldwideDayKey>;
  stageReceived: Set<WorldwideDayKey>;
  resultReceived: Set<WorldwideDayKey>;
}

const emptyGlobalAuction = (): CalendarGlobalAuction => ({
  stage: null,
  terminalDisposition: 'none',
  totalBids: null,
  venueBids: null,
  grossIncludedDemand: null,
  clearingRate: null,
  issuedIntexCount: null,
  offeredQuantity: null,
  offeredQuantityEvidence: 'unavailable',
});

const emptyOriginDelivery = (): CalendarOriginDelivery => ({
  stageStart: 'not-observed',
  clearing: 'not-observed',
  result: 'not-observed',
});

const calendarFailure = (authority: CalendarFailureAuthority, error: unknown): CalendarEvidenceFailure => ({
  authority,
  ...classifyPublicReadFailure(error),
});

const decodedLog = (value: unknown, label: string): DecodedLog => {
  const raw = asRecord(value, label);
  const args = asRecord(raw.args, `${label} args`);
  const transactionHash = raw.transactionHash;
  if (typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    throw new TypeError(`${label} transaction hash is invalid.`);
  }
  return {
    args,
    blockNumber: asBigint(raw.blockNumber, `${label} block number`),
    transactionHash: transactionHash as Hex,
    logIndex: asSafeNumber(raw.logIndex, `${label} log index`),
  };
};

const logOrder = (left: DecodedLog, right: DecodedLog): number => {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
  return left.logIndex - right.logIndex;
};

const inRange = (worldwideDay: WorldwideDayKey, expected: ReadonlySet<WorldwideDayKey>): boolean =>
  expected.has(worldwideDay);

const scan = async (
  client: AuctionReadClient,
  address: Address,
  abi: Abi,
  eventName: string,
  fromBlock: bigint,
  toBlock: bigint,
  logBatchSize: number,
  readRetryCount: number,
  args?: Readonly<Record<string, unknown>>,
): Promise<DecodedLog[]> => {
  const logs = await scanLogPages<DecodedLog>({
    client,
    address,
    event: eventFromAbi(abi, eventName),
    ...(args ? { args } : {}),
    fromBlock,
    toBlock,
    pageSize: logBatchSize,
    retryCount: readRetryCount,
    errorMessage: ({ fromBlock: pageFrom, toBlock: pageTo }) =>
      `${eventName} scan failed for blocks ${pageFrom}-${pageTo}.`,
    decodeLog: (value) => decodedLog(value, `${eventName} log`),
    resultKey: (log) => `${log.transactionHash}:${log.logIndex}`,
    compare: logOrder,
  });
  return [...logs];
};

const currentHead = (client: AuctionReadClient): Promise<bigint> => client.getBlockNumber();

const boundedMap = async <T, R>(values: readonly T[], worker: (value: T) => Promise<R>): Promise<R[]> => {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CALENDAR_WORKERS, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) result[index] = await worker(value);
    }
  });
  await Promise.all(workers);
  return result;
};

const scanOriginEvents = async (
  client: AuctionReadClient,
  profile: ResolvedOutbeReadProfile,
  toBlock: bigint,
  dayNumbers: readonly number[],
  expected: ReadonlySet<WorldwideDayKey>,
): Promise<OriginEventIndex> => {
  const [missed, forfeited, cleaned] = await Promise.all([
    scan(
      client,
      profile.addresses.metadosis,
      profile.abis.metadosis,
      'WorldwideDayMissedOffering',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.metadosis,
      profile.abis.metadosis,
      'WorldwideDayCapacityForfeited',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.metadosis,
      profile.abis.metadosis,
      'WorldwideDayCleanedUp',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
  ]);
  const terminalCandidates = new Set<WorldwideDayKey>();
  for (const log of [...missed, ...forfeited]) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'Metadosis event worldwideDay');
    if (inRange(day, expected)) terminalCandidates.add(day);
  }
  const cleanedIndex = new Map<WorldwideDayKey, 'completed' | 'failed'>();
  for (const log of cleaned) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'WorldwideDayCleanedUp worldwideDay');
    if (!inRange(day, expected)) continue;
    const finalStatus = asSafeNumber(log.args.finalStatus, 'WorldwideDayCleanedUp finalStatus');
    if (finalStatus !== 6 && finalStatus !== 7) {
      throw new TypeError('WorldwideDayCleanedUp finalStatus must be Completed or Failed.');
    }
    cleanedIndex.set(day, finalStatus === 6 ? 'completed' : 'failed');
  }
  return { cleaned: cleanedIndex, terminalCandidates };
};

const latestByDay = (logs: readonly DecodedLog[]): Map<WorldwideDayKey, DecodedLog> => {
  const index = new Map<WorldwideDayKey, DecodedLog>();
  for (const log of logs) {
    index.set(asWorldwideDayKey(log.args.worldwideDay, 'event worldwideDay'), log);
  }
  return index;
};

const scanDesisEvents = async (
  client: AuctionReadClient,
  profile: ResolvedOutbeReadProfile,
  toBlock: bigint,
  venueChainId: number,
  dayNumbers: readonly number[],
  expected: ReadonlySet<WorldwideDayKey>,
): Promise<DesisEventIndex> => {
  const [created, cancelled, cancelledUnpriced, overdue, cleared, clearedEmpty, unused, skipped] = await Promise.all([
    scan(
      client,
      profile.addresses.desis,
      profile.abis.desis,
      'AuctionCreated',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.desis,
      profile.abis.desis,
      'AuctionCancelledRedDay',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.desis,
      profile.abis.desis,
      'AuctionCancelledUnpriced',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.desis,
      profile.abis.desis,
      'AuctionOverdue',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.desis,
      profile.abis.desis,
      'AuctionCleared',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.desis,
      profile.abis.desis,
      'AuctionClearedEmpty',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.desis,
      profile.abis.desis,
      'UnusedSupplyReported',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.desis,
      profile.abis.desis,
      'ChainSkipped',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers, srcChainId: venueChainId },
    ),
  ]);
  const candidates = new Set<WorldwideDayKey>();
  for (const log of [
    ...created,
    ...cancelled,
    ...cancelledUnpriced,
    ...overdue,
    ...cleared,
    ...clearedEmpty,
    ...skipped,
  ]) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'Desis event worldwideDay');
    if (inRange(day, expected)) candidates.add(day);
  }
  const skippedDays = new Set<WorldwideDayKey>();
  for (const log of skipped) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'ChainSkipped worldwideDay');
    if (inRange(day, expected)) skippedDays.add(day);
  }
  const cancelledDays = new Set<WorldwideDayKey>();
  for (const log of cancelled) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'AuctionCancelledRedDay worldwideDay');
    if (inRange(day, expected)) cancelledDays.add(day);
  }
  const cancelledUnpricedDays = new Set<WorldwideDayKey>();
  for (const log of cancelledUnpriced) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'AuctionCancelledUnpriced worldwideDay');
    if (inRange(day, expected)) cancelledUnpricedDays.add(day);
  }
  const overdueDays = new Set<WorldwideDayKey>();
  for (const log of overdue) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'AuctionOverdue worldwideDay');
    if (inRange(day, expected)) overdueDays.add(day);
  }

  const unusedByTransaction = new Map<Hex, DecodedLog>();
  for (const log of unused) unusedByTransaction.set(log.transactionHash, log);
  const clearing = new Map<WorldwideDayKey, ClearingEvidence>();
  for (const [day, log] of latestByDay(cleared)) {
    if (!inRange(day, expected)) continue;
    const unusedLog = unusedByTransaction.get(log.transactionHash);
    if (unusedLog) {
      const unusedDay = asWorldwideDayKey(unusedLog.args.worldwideDay, 'UnusedSupplyReported worldwideDay');
      if (unusedDay !== day) throw new TypeError('UnusedSupplyReported transaction context has a different WWD.');
    }
    clearing.set(day, {
      kind: 'sale',
      grossIncludedDemand: asBigint(log.args.totalDemand, 'AuctionCleared totalDemand'),
      issuedIntexCount: asBigint(log.args.issuedIntexCount, 'AuctionCleared issuedIntexCount'),
      clearingRate: asBigint(log.args.clearingRate, 'AuctionCleared clearingRate'),
      unusedPromis: unusedLog ? asBigint(unusedLog.args.unusedPromis, 'UnusedSupplyReported unusedPromis') : null,
    });
  }
  for (const [day, log] of latestByDay(clearedEmpty)) {
    if (!inRange(day, expected)) continue;
    clearing.set(day, {
      kind: 'no-sale',
      grossIncludedDemand: asBigint(log.args.totalDemand, 'AuctionClearedEmpty totalDemand'),
      issuedIntexCount: 0n,
      clearingRate: null,
      unusedPromis: null,
    });
  }
  return {
    candidates,
    skipped: skippedDays,
    cancelled: cancelledDays,
    cancelledUnpriced: cancelledUnpricedDays,
    overdue: overdueDays,
    clearing,
  };
};

const routerPayloadDay = (payload: Hex, expectedMessageType: number): WorldwideDayKey => {
  const bytes = hexToBytes(payload);
  if (bytes[0] !== ROUTER_BODY_VERSION || bytes[1] !== expectedMessageType) {
    throw new TypeError('OriginRouter payload has an incompatible version or message type.');
  }
  if (expectedMessageType === 3) {
    const priceCount = bytes[ROUTER_STAGE_START_PRICE_COUNT_OFFSET] ?? ROUTER_STAGE_START_MAX_PRICE_COUNT + 1;
    if (
      priceCount > ROUTER_STAGE_START_MAX_PRICE_COUNT ||
      bytes.length !== ROUTER_STAGE_START_HEAD_LENGTH + ROUTER_STAGE_START_ROW_LENGTH * priceCount
    ) {
      throw new TypeError('OriginRouter payload type 3 has incompatible length.');
    }
  } else {
    const expectedLength = ROUTER_FIXED_LENGTHS.get(expectedMessageType);
    if (expectedLength === undefined || bytes.length !== expectedLength) {
      throw new TypeError(`OriginRouter payload type ${expectedMessageType} has incompatible length.`);
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return asWorldwideDayKey(view.getUint32(2, false), 'OriginRouter payload worldwideDay');
};

const parkedMessageTuple = (
  value: unknown,
): {
  dstChainId: number;
  sent: boolean;
  payload: Hex;
} => {
  const raw = Array.isArray(value)
    ? { dstChainId: value[0], sent: value[2], payload: value[3] }
    : asRecord(value, 'OriginRouter.parkedMessage');
  const payload = raw.payload;
  if (typeof payload !== 'string' || !/^0x[0-9a-fA-F]*$/.test(payload)) {
    throw new TypeError('OriginRouter.parkedMessage payload is invalid.');
  }
  if (typeof raw.sent !== 'boolean') throw new TypeError('OriginRouter.parkedMessage sent must be boolean.');
  return {
    dstChainId: asSafeNumber(raw.dstChainId, 'OriginRouter.parkedMessage dstChainId'),
    sent: raw.sent,
    payload: payload as Hex,
  };
};

const deliveryField = (messageType: number): keyof CalendarOriginDelivery => {
  if (messageType === 3) return 'stageStart';
  if (messageType === 4) return 'clearing';
  if (messageType === 5) return 'result';
  throw new RangeError(`Unsupported auction router message type ${messageType}.`);
};

const mergeDelivery = (current: OriginDeliveryState, next: OriginDeliveryState): OriginDeliveryState => {
  // Ranking encodes DECISION 2: a leg parked or flushed on-chain must always win over a bare
  // `*Sent` event. Every `_sendOrPark` site emits its `*Sent` unconditionally with sendId==0 on the
  // parked path (OriginRouter.sol:190,268-398,510), so a surviving `*Sent` can never outrank real
  // MessageParked evidence into looking dispatched.
  const rank: Record<OriginDeliveryState, number> = {
    'not-observed': 0,
    dispatched: 1,
    parked: 2,
    flushed: 3,
  };
  return rank[next] >= rank[current] ? next : current;
};

const scanRouterEvents = async (
  client: AuctionReadClient,
  profile: ResolvedOutbeReadProfile,
  toBlock: bigint,
  venueChainId: number,
  dayNumbers: readonly number[],
  expected: ReadonlySet<WorldwideDayKey>,
): Promise<RouterEventIndex> => {
  const [stageSent, resultSent, parked, resent] = await Promise.all([
    scan(
      client,
      profile.addresses.originRouter,
      profile.abis.originRouter,
      'AuctionStageSent',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.originRouter,
      profile.abis.originRouter,
      'AuctionResultSent',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.originRouter,
      profile.abis.originRouter,
      'MessageParked',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { dstChainId: venueChainId },
    ),
    scan(
      client,
      profile.addresses.originRouter,
      profile.abis.originRouter,
      'ParkedMessageResent',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { dstChainId: venueChainId },
    ),
  ]);
  const delivery = new Map<WorldwideDayKey, CalendarOriginDelivery>();
  const failures: CalendarEvidenceFailure[] = [];
  const update = (day: WorldwideDayKey, field: keyof CalendarOriginDelivery, state: OriginDeliveryState) => {
    if (!inRange(day, expected)) return;
    const current = delivery.get(day) ?? emptyOriginDelivery();
    delivery.set(day, { ...current, [field]: mergeDelivery(current[field], state) });
  };

  // DECISION 2: classify MessageParked evidence FIRST, so a bare `*Sent` for the same (day, leg) can
  // only ever fill a leg still 'not-observed' — never overwrite parked/flushed. `parked` here records
  // exactly which (day, field) legs were parked; a `*Sent` that names one of those is not dispatched.
  const parkedLegs = new Set<string>();
  const resentIndices = new Set(resent.map((log) => asBigint(log.args.idx, 'ParkedMessageResent idx').toString()));
  await boundedMap(parked, async (log) => {
    const index = asBigint(log.args.idx, 'MessageParked idx');
    const messageType = asSafeNumber(log.args.msgType, 'MessageParked msgType');
    if (!ROUTER_MESSAGE_TYPES.has(messageType)) return;
    try {
      const parkedMessage = parkedMessageTuple(
        await client.readContract({
          address: profile.addresses.originRouter,
          abi: profile.abis.originRouter,
          functionName: 'parkedMessage',
          args: [index],
        }),
      );
      if (parkedMessage.dstChainId !== venueChainId) {
        throw new TypeError('OriginRouter parked-message destination disagrees with its event.');
      }
      const day = routerPayloadDay(parkedMessage.payload, messageType);
      const field = deliveryField(messageType);
      const state = parkedMessage.sent || resentIndices.has(index.toString()) ? 'flushed' : 'parked';
      parkedLegs.add(`${day}:${field}`);
      update(day, field, state);
    } catch (error) {
      failures.push(calendarFailure('origin-router', error));
    }
  });

  const markSent = (day: WorldwideDayKey, field: keyof CalendarOriginDelivery) => {
    // A `*Sent` event dispatches a leg only when no MessageParked exists for it. sendId is never used
    // to classify delivery: parked ⇒ sendId==0 is confirmed, the converse is unresolved (bridge-dependent).
    if (parkedLegs.has(`${day}:${field}`)) return;
    update(day, field, 'dispatched');
  };
  for (const log of stageSent) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'AuctionStageSent worldwideDay');
    const messageType = asSafeNumber(log.args.stageType, 'AuctionStageSent stageType');
    if (messageType === 3 || messageType === 4) markSent(day, deliveryField(messageType));
  }
  for (const log of resultSent) {
    markSent(asWorldwideDayKey(log.args.worldwideDay, 'AuctionResultSent worldwideDay'), 'result');
  }

  return { delivery, failures };
};

const scanVenueEvents = async (
  client: AuctionReadClient,
  profile: ResolvedVenueReadProfile,
  toBlock: bigint,
  dayNumbers: readonly number[],
  expected: ReadonlySet<WorldwideDayKey>,
): Promise<VenueEventIndex> => {
  const [stageUpdated, stageReceived, resultReceived, reaped] = await Promise.all([
    scan(
      client,
      profile.addresses.intexAuction,
      profile.abis.intexAuction,
      'AuctionStageUpdated',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.targetRouter,
      profile.abis.targetRouter,
      'AuctionStageReceived',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.targetRouter,
      profile.abis.targetRouter,
      'AuctionResultReceived',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
    scan(
      client,
      profile.addresses.intexAuction,
      profile.abis.intexAuction,
      'AuctionReaped',
      profile.deploymentBlock,
      toBlock,
      profile.logBatchSize,
      profile.readRetryCount,
      { worldwideDay: dayNumbers },
    ),
  ]);
  const candidates = new Set<WorldwideDayKey>();
  const stages = new Set<WorldwideDayKey>();
  const results = new Set<WorldwideDayKey>();
  for (const log of [...stageUpdated, ...stageReceived, ...resultReceived, ...reaped]) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'venue event worldwideDay');
    if (inRange(day, expected)) candidates.add(day);
  }
  for (const log of stageReceived) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'AuctionStageReceived worldwideDay');
    if (inRange(day, expected)) stages.add(day);
  }
  for (const log of resultReceived) {
    const day = asWorldwideDayKey(log.args.worldwideDay, 'AuctionResultReceived worldwideDay');
    if (inRange(day, expected)) results.add(day);
  }
  return { candidates, stageReceived: stages, resultReceived: results };
};

const currentOriginRecords = async (
  days: readonly WorldwideDayKey[],
  adapter: CalendarRangeReaders['originAdapter'],
): Promise<Map<WorldwideDayKey, WorldwideDaySnapshot | null | CalendarEvidenceFailure>> => {
  const result = new Map<WorldwideDayKey, WorldwideDaySnapshot | null | CalendarEvidenceFailure>();
  await boundedMap(days, async (day) => {
    try {
      result.set(day, await adapter.readWorldwideDay(day));
    } catch (error) {
      result.set(day, error instanceof OriginWorldwideDayNotFoundError ? null : calendarFailure('metadosis', error));
    }
  });
  return result;
};

const retainedOriginRecords = async (
  days: readonly WorldwideDayKey[],
  expected: ReadonlySet<WorldwideDayKey>,
  adapter: CalendarRangeReaders['originAdapter'],
): Promise<{
  value: Map<WorldwideDayKey, WorldwideDaySnapshot | null | CalendarEvidenceFailure>;
  failure: CalendarEvidenceFailure | null;
}> => {
  try {
    const retained = await adapter.readRetainedWorldwideDays();
    return {
      value: await currentOriginRecords(
        retained.filter((day) => expected.has(day)),
        adapter,
      ),
      failure: null,
    };
  } catch (error) {
    const failure = calendarFailure('metadosis', error);
    return {
      value: new Map(days.map((day) => [day, failure] as const)),
      failure,
    };
  }
};

const terminalEvidence = async (
  candidates: ReadonlySet<WorldwideDayKey>,
  adapter: CalendarRangeReaders['originAdapter'],
): Promise<Map<WorldwideDayKey, OriginTerminalEvidence | null | CalendarEvidenceFailure>> => {
  const result = new Map<WorldwideDayKey, OriginTerminalEvidence | null | CalendarEvidenceFailure>();
  await boundedMap([...candidates], async (day) => {
    try {
      result.set(day, await adapter.readTerminalEvidence(day));
    } catch (error) {
      result.set(day, calendarFailure('metadosis', error));
    }
  });
  return result;
};

const globalSnapshots = async (
  candidates: ReadonlySet<WorldwideDayKey>,
  venueChainId: number,
  adapter: CalendarRangeReaders['originAdapter'],
): Promise<Map<WorldwideDayKey, GlobalAuctionSnapshot | CalendarEvidenceFailure>> => {
  const result = new Map<WorldwideDayKey, GlobalAuctionSnapshot | CalendarEvidenceFailure>();
  await boundedMap([...candidates], async (day) => {
    try {
      result.set(day, await adapter.readGlobalAuction(day, venueChainId));
    } catch (error) {
      result.set(day, calendarFailure('desis', error));
    }
  });
  return result;
};

const canonicalSeries = async (
  candidates: ReadonlySet<WorldwideDayKey>,
  _adapter: CalendarRangeReaders['originAdapter'],
): Promise<Map<WorldwideDayKey, CanonicalSeriesSnapshot | null | CalendarEvidenceFailure>> => {
  const result = new Map<WorldwideDayKey, CanonicalSeriesSnapshot | null | CalendarEvidenceFailure>();
  for (const day of candidates) result.set(day, null);
  return result;
};

const venueSnapshots = async (
  candidates: ReadonlySet<WorldwideDayKey>,
  adapter: CalendarRangeReaders['venueAdapter'],
): Promise<Map<WorldwideDayKey, VenueAuctionSnapshot | null | CalendarEvidenceFailure>> => {
  const result = new Map<WorldwideDayKey, VenueAuctionSnapshot | null | CalendarEvidenceFailure>();
  await boundedMap([...candidates], async (day) => {
    try {
      result.set(day, await adapter.readAuction(day));
    } catch (error) {
      result.set(day, error instanceof VenueAuctionNotFoundError ? null : calendarFailure('venue', error));
    }
  });
  return result;
};

const isFailure = (value: unknown): value is CalendarEvidenceFailure =>
  typeof value === 'object' && value !== null && 'authority' in value && 'kind' in value;

const originNoAuction = (terminal: OriginTerminalEvidence | null): boolean => terminal !== null;

const globalDisposition = (
  events: DesisEventIndex,
  day: WorldwideDayKey,
  stage: GlobalAuctionStage | null,
): GlobalTerminalDisposition => {
  const clearing = events.clearing.get(day);
  if (clearing?.kind === 'sale') return 'cleared-sale';
  if (clearing?.kind === 'no-sale') return 'cleared-no-sale';
  if (events.cancelled.has(day)) return 'cancelled-red';
  // An unpriced day is cancelled and dispatched RED on-chain (desis/runtime.rs:475-497), but it was
  // briefed with a limit so Metadosis still classifies it GREEN — it is NOT a red day. Keep it distinct
  // from cancelled-red so the UI never claims the day type was red.
  if (events.cancelledUnpriced.has(day)) return 'cancelled-unpriced';
  if (events.overdue.has(day)) return 'overdue';
  if (stage === 'cleared') return 'cleared';
  if (stage && stage !== 'none') return 'active';
  return 'none';
};

export const loadCalendarRangeWithReaders = async (
  originProfile: ResolvedOutbeReadProfile,
  venueProfile: ResolvedVenueReadProfile,
  readers: CalendarRangeReaders,
  days: readonly WorldwideDayKey[],
): Promise<CalendarRangeRead> => {
  if (days.length !== CALENDAR_WINDOW_DAYS || new Set(days).size !== CALENDAR_WINDOW_DAYS) {
    throw new RangeError(`Calendar range must contain exactly ${CALENDAR_WINDOW_DAYS} unique WorldwideDay keys.`);
  }
  if (days.some((day, index) => index > 0 && day !== shiftWorldwideDay(days[index - 1]!, 1))) {
    throw new RangeError(`Calendar range must contain ${CALENDAR_WINDOW_DAYS} contiguous WorldwideDay keys.`);
  }
  const start = days[0];
  const end = days[days.length - 1];
  if (!start || !end) throw new RangeError('Calendar range is empty.');
  const expected = new Set(days);
  const dayNumbers = days.map(Number);
  const rangeFailures: CalendarEvidenceFailure[] = [];

  const deploymentChecks = await Promise.allSettled([
    readers.originAdapter.validateDeployment(),
    readers.venueAdapter.validateDeployment(),
  ]);
  const originValidationFailure =
    deploymentChecks[0].status === 'rejected' ? calendarFailure('metadosis', deploymentChecks[0].reason) : null;
  const venueValidationFailure =
    deploymentChecks[1].status === 'rejected' ? calendarFailure('venue', deploymentChecks[1].reason) : null;
  if (originValidationFailure) rangeFailures.push(originValidationFailure);
  if (venueValidationFailure) rangeFailures.push(venueValidationFailure);

  const originHead = originValidationFailure
    ? Promise.reject(originValidationFailure)
    : currentHead(readers.originClient);
  const venueHead = venueValidationFailure ? Promise.reject(venueValidationFailure) : currentHead(readers.venueClient);

  const [originEventsResult, desisEventsResult, routerEventsResult, venueEventsResult, originRecordsResult] =
    await Promise.all([
      originHead
        .then((head) => scanOriginEvents(readers.originClient, originProfile, head, dayNumbers, expected))
        .then(
          (value) => ({ value, failure: null }),
          (error) => ({ value: null, failure: originValidationFailure ?? calendarFailure('metadosis', error) }),
        ),
      originHead
        .then((head) =>
          scanDesisEvents(readers.originClient, originProfile, head, venueProfile.chainId, dayNumbers, expected),
        )
        .then(
          (value) => ({ value, failure: null }),
          (error) => ({ value: null, failure: originValidationFailure ?? calendarFailure('desis', error) }),
        ),
      originHead
        .then((head) =>
          scanRouterEvents(readers.originClient, originProfile, head, venueProfile.chainId, dayNumbers, expected),
        )
        .then(
          (value) => ({ value, failure: null }),
          (error) => ({ value: null, failure: originValidationFailure ?? calendarFailure('origin-router', error) }),
        ),
      venueHead
        .then((head) => scanVenueEvents(readers.venueClient, venueProfile, head, dayNumbers, expected))
        .then(
          (value) => ({ value, failure: null }),
          (error) => ({ value: null, failure: venueValidationFailure ?? calendarFailure('venue', error) }),
        ),
      originValidationFailure
        ? Promise.resolve({
            value: new Map(days.map((day) => [day, originValidationFailure] as const)),
            failure: null,
          })
        : retainedOriginRecords(days, expected, readers.originAdapter),
    ]);

  for (const result of [originEventsResult, desisEventsResult, routerEventsResult, venueEventsResult]) {
    if (result.failure) rangeFailures.push(result.failure);
  }
  if (originRecordsResult.failure) rangeFailures.push(originRecordsResult.failure);
  const originRecords = originRecordsResult.value;
  const originEvents = originEventsResult.value ?? { cleaned: new Map(), terminalCandidates: new Set() };
  const desisEvents = desisEventsResult.value ?? {
    candidates: new Set(),
    skipped: new Set(),
    cancelled: new Set(),
    cancelledUnpriced: new Set(),
    overdue: new Set(),
    clearing: new Map(),
  };
  const routerEvents = routerEventsResult.value ?? { delivery: new Map(), failures: [] };
  rangeFailures.push(...routerEvents.failures);
  const venueEvents = venueEventsResult.value ?? {
    candidates: new Set(),
    stageReceived: new Set(),
    resultReceived: new Set(),
  };

  const saleDays = new Set<WorldwideDayKey>();
  for (const [day, evidence] of desisEvents.clearing) {
    if (evidence.kind === 'sale') saleDays.add(day);
  }
  const [terminal, global, series] = await Promise.all([
    terminalEvidence(originEvents.terminalCandidates, readers.originAdapter),
    globalSnapshots(desisEvents.candidates, venueProfile.chainId, readers.originAdapter),
    canonicalSeries(saleDays, readers.originAdapter),
  ]);

  const applicableVenueDays = new Set<WorldwideDayKey>([
    ...desisEvents.candidates,
    ...routerEvents.delivery.keys(),
    ...venueEvents.candidates,
  ]);
  const venueReadCandidates = new Set<WorldwideDayKey>([...routerEvents.delivery.keys(), ...venueEvents.candidates]);
  for (const day of days) {
    const terminalValue = terminal.get(day);
    if (terminalValue && !isFailure(terminalValue) && originNoAuction(terminalValue)) {
      applicableVenueDays.delete(day);
      venueReadCandidates.delete(day);
    }
    if (desisEvents.skipped.has(day)) venueReadCandidates.delete(day);
  }
  const venues: Map<WorldwideDayKey, VenueAuctionSnapshot | null | CalendarEvidenceFailure> = venueValidationFailure
    ? new Map([...applicableVenueDays].map((day) => [day, venueValidationFailure]))
    : await venueSnapshots(venueReadCandidates, readers.venueAdapter);

  const cells = days.map((day): CalendarWorldwideDay => {
    const failures: CalendarEvidenceFailure[] = [];
    const rawOrigin = originRecords.get(day) ?? null;
    const cleaned = originEvents.cleaned.get(day);
    let originRecord: CalendarOriginRecord;
    let lifecycle: WorldwideDayLifecycle | null = null;
    let dayType: WorldwideDayType | null = null;
    if (isFailure(rawOrigin)) {
      originRecord = { kind: 'failure', failure: rawOrigin };
      failures.push(rawOrigin);
    } else if (rawOrigin) {
      originRecord = { kind: 'retained', snapshot: rawOrigin };
      lifecycle = rawOrigin.lifecycle;
      dayType = rawOrigin.dayType;
    } else if (cleaned) {
      originRecord = { kind: 'cleaned-history-unavailable', finalLifecycle: cleaned };
      lifecycle = cleaned;
    } else if (originEventsResult.failure) {
      const failure = originEventsResult.failure;
      originRecord = { kind: 'failure', failure };
      failures.push(failure);
    } else {
      originRecord = { kind: 'not-found' };
    }

    const terminalValue = terminal.get(day) ?? null;
    const terminalEvidenceValue = isFailure(terminalValue) ? null : terminalValue;
    if (isFailure(terminalValue)) failures.push(terminalValue);

    const globalValue = global.get(day) ?? null;
    const globalSnapshot = isFailure(globalValue) ? null : globalValue;
    if (isFailure(globalValue)) failures.push(globalValue);
    const clearing = desisEvents.clearing.get(day);
    const seriesValue = series.get(day) ?? null;
    const canonical = isFailure(seriesValue) ? null : seriesValue;
    if (isFailure(seriesValue)) failures.push(seriesValue);
    const disposition = globalDisposition(desisEvents, day, globalSnapshot?.stage ?? null);
    let offeredQuantity: bigint | null = null;
    let offeredQuantityEvidence: CalendarGlobalAuction['offeredQuantityEvidence'] = 'unavailable';
    if (clearing?.kind === 'sale') {
      if (clearing.unusedPromis === null) {
        offeredQuantity = clearing.issuedIntexCount;
        offeredQuantityEvidence = 'sold-out';
      } else if (canonical && canonical.promisLoadMinor > 0n) {
        offeredQuantity = clearing.issuedIntexCount + clearing.unusedPromis / canonical.promisLoadMinor;
        offeredQuantityEvidence = 'same-transaction-unused-supply';
      }
    }
    const globalAuction: CalendarGlobalAuction = {
      ...emptyGlobalAuction(),
      stage: globalSnapshot?.stage ?? null,
      terminalDisposition: disposition,
      totalBids: globalSnapshot?.totalBids ?? null,
      venueBids: globalSnapshot?.venueBids ?? null,
      grossIncludedDemand: clearing?.grossIncludedDemand ?? null,
      clearingRate: clearing?.clearingRate ?? null,
      issuedIntexCount: clearing?.issuedIntexCount ?? null,
      offeredQuantity,
      offeredQuantityEvidence,
    };

    const terminalNoAuction = originNoAuction(terminalEvidenceValue);
    const venueParticipation: CalendarVenueParticipation = terminalNoAuction
      ? 'not-applicable'
      : desisEvents.skipped.has(day)
        ? 'skipped'
        : globalSnapshot?.venueInTargetSnapshot
          ? 'included'
          : 'unknown';
    const venueValue = venues.get(day) ?? null;
    const venueAuction = isFailure(venueValue) ? null : venueValue;
    if (isFailure(venueValue)) failures.push(venueValue);
    const delivery = routerEvents.delivery.get(day) ?? emptyOriginDelivery();
    let venueReceipt: CalendarVenueReceipt;
    let scheduleAvailability: CalendarScheduleAvailability;
    if (terminalNoAuction || venueParticipation === 'skipped') {
      venueReceipt = 'not-applicable';
      scheduleAvailability = { kind: 'not-applicable' };
    } else if (venueAuction) {
      venueReceipt = venueEvents.resultReceived.has(day)
        ? 'result-received'
        : venueEvents.stageReceived.has(day)
          ? 'stage-received'
          : 'delivered';
      scheduleAvailability = { kind: 'available', schedule: venueAuction.schedule };
    } else if (isFailure(venueValue)) {
      venueReceipt = 'not-observed';
      scheduleAvailability = { kind: 'unavailable' };
    } else if (applicableVenueDays.has(day)) {
      venueReceipt = 'delivery-pending';
      scheduleAvailability = { kind: 'pending' };
    } else {
      venueReceipt = 'not-observed';
      scheduleAvailability = { kind: 'unavailable' };
    }

    return {
      worldwideDay: day,
      originRecord,
      lifecycle,
      dayType,
      terminalDisposition: terminalEvidenceValue?.disposition ?? null,
      globalAuction,
      venueParticipation,
      originDelivery: delivery,
      venueReceipt,
      venueStage: venueAuction?.stage ?? null,
      scheduleAvailability,
      venueAuction,
      canonicalSeries: canonical,
      failures,
    };
  });

  return { start, end, days: cells, failures: rangeFailures };
};

export const loadOriginCalendarRangeWithReaders = async (
  originProfile: ResolvedOutbeReadProfile,
  referenceVenueChainId: number,
  readers: OriginCalendarReaders,
  days: readonly WorldwideDayKey[],
): Promise<CalendarRangeRead> => {
  if (days.length !== CALENDAR_WINDOW_DAYS || new Set(days).size !== CALENDAR_WINDOW_DAYS) {
    throw new RangeError(`Calendar range must contain exactly ${CALENDAR_WINDOW_DAYS} unique WorldwideDay keys.`);
  }
  if (days.some((day, index) => index > 0 && day !== shiftWorldwideDay(days[index - 1]!, 1))) {
    throw new RangeError(`Calendar range must contain ${CALENDAR_WINDOW_DAYS} contiguous WorldwideDay keys.`);
  }
  const start = days[0];
  const end = days[days.length - 1];
  if (!start || !end) throw new RangeError('Calendar range is empty.');
  const expected = new Set(days);
  const dayNumbers = days.map(Number);
  const rangeFailures: CalendarEvidenceFailure[] = [];

  let validationFailure: CalendarEvidenceFailure | null = null;
  try {
    await readers.originAdapter.validateDeployment();
  } catch (error) {
    validationFailure = calendarFailure('metadosis', error);
    rangeFailures.push(validationFailure);
  }

  const originHead = validationFailure ? Promise.reject(validationFailure) : currentHead(readers.originClient);
  const [originEventsResult, desisEventsResult, originRecordsResult] = await Promise.all([
    originHead
      .then((head) => scanOriginEvents(readers.originClient, originProfile, head, dayNumbers, expected))
      .then(
        (value) => ({ value, failure: null }),
        (error) => ({ value: null, failure: validationFailure ?? calendarFailure('metadosis', error) }),
      ),
    originHead
      .then((head) =>
        scanDesisEvents(readers.originClient, originProfile, head, referenceVenueChainId, dayNumbers, expected),
      )
      .then(
        (value) => ({ value, failure: null }),
        (error) => ({ value: null, failure: validationFailure ?? calendarFailure('desis', error) }),
      ),
    validationFailure
      ? Promise.resolve({
          value: new Map(days.map((day) => [day, validationFailure] as const)),
          failure: null,
        })
      : retainedOriginRecords(days, expected, readers.originAdapter),
  ]);

  for (const result of [originEventsResult, desisEventsResult]) {
    if (result.failure && result.failure !== validationFailure) rangeFailures.push(result.failure);
  }
  if (originRecordsResult.failure) rangeFailures.push(originRecordsResult.failure);
  const originRecords = originRecordsResult.value;
  const originEvents = originEventsResult.value ?? { cleaned: new Map(), terminalCandidates: new Set() };
  const desisEvents = desisEventsResult.value ?? {
    candidates: new Set(),
    skipped: new Set(),
    cancelled: new Set(),
    cancelledUnpriced: new Set(),
    overdue: new Set(),
    clearing: new Map(),
  };
  const saleDays = new Set<WorldwideDayKey>();
  for (const [day, evidence] of desisEvents.clearing) {
    if (evidence.kind === 'sale') saleDays.add(day);
  }
  const [terminal, global, series] = await Promise.all([
    terminalEvidence(originEvents.terminalCandidates, readers.originAdapter),
    globalSnapshots(desisEvents.candidates, referenceVenueChainId, readers.originAdapter),
    canonicalSeries(saleDays, readers.originAdapter),
  ]);

  const cells = days.map((day): CalendarWorldwideDay => {
    const failures: CalendarEvidenceFailure[] = [];
    const rawOrigin = originRecords.get(day) ?? null;
    const cleaned = originEvents.cleaned.get(day);
    let originRecord: CalendarOriginRecord;
    let lifecycle: WorldwideDayLifecycle | null = null;
    let dayType: WorldwideDayType | null = null;
    if (isFailure(rawOrigin)) {
      originRecord = { kind: 'failure', failure: rawOrigin };
      failures.push(rawOrigin);
    } else if (rawOrigin) {
      originRecord = { kind: 'retained', snapshot: rawOrigin };
      lifecycle = rawOrigin.lifecycle;
      dayType = rawOrigin.dayType;
    } else if (cleaned) {
      originRecord = { kind: 'cleaned-history-unavailable', finalLifecycle: cleaned };
      lifecycle = cleaned;
    } else if (originEventsResult.failure) {
      const failure = originEventsResult.failure;
      originRecord = { kind: 'failure', failure };
      failures.push(failure);
    } else {
      originRecord = { kind: 'not-found' };
    }

    const terminalValue = terminal.get(day) ?? null;
    const terminalEvidenceValue = isFailure(terminalValue) ? null : terminalValue;
    if (isFailure(terminalValue)) failures.push(terminalValue);
    const globalValue = global.get(day) ?? null;
    const globalSnapshot = isFailure(globalValue) ? null : globalValue;
    if (isFailure(globalValue)) failures.push(globalValue);
    const clearing = desisEvents.clearing.get(day);
    const seriesValue = series.get(day) ?? null;
    const canonical = isFailure(seriesValue) ? null : seriesValue;
    if (isFailure(seriesValue)) failures.push(seriesValue);
    const disposition = globalDisposition(desisEvents, day, globalSnapshot?.stage ?? null);
    let offeredQuantity: bigint | null = null;
    let offeredQuantityEvidence: CalendarGlobalAuction['offeredQuantityEvidence'] = 'unavailable';
    if (clearing?.kind === 'sale') {
      if (clearing.unusedPromis === null) {
        offeredQuantity = clearing.issuedIntexCount;
        offeredQuantityEvidence = 'sold-out';
      } else if (canonical && canonical.promisLoadMinor > 0n) {
        offeredQuantity = clearing.issuedIntexCount + clearing.unusedPromis / canonical.promisLoadMinor;
        offeredQuantityEvidence = 'same-transaction-unused-supply';
      }
    }
    const globalAuction: CalendarGlobalAuction = {
      ...emptyGlobalAuction(),
      stage: globalSnapshot?.stage ?? null,
      terminalDisposition: disposition,
      totalBids: globalSnapshot?.totalBids ?? null,
      venueBids: null,
      grossIncludedDemand: clearing?.grossIncludedDemand ?? null,
      clearingRate: clearing?.clearingRate ?? null,
      issuedIntexCount: clearing?.issuedIntexCount ?? null,
      offeredQuantity,
      offeredQuantityEvidence,
    };
    const noAuction = originNoAuction(terminalEvidenceValue);
    return {
      worldwideDay: day,
      originRecord,
      lifecycle,
      dayType,
      terminalDisposition: terminalEvidenceValue?.disposition ?? null,
      globalAuction,
      venueParticipation: noAuction ? 'not-applicable' : 'unknown',
      originDelivery: emptyOriginDelivery(),
      venueReceipt: noAuction ? 'not-applicable' : 'not-observed',
      venueStage: null,
      scheduleAvailability: noAuction ? { kind: 'not-applicable' } : { kind: 'unavailable' },
      venueAuction: null,
      canonicalSeries: canonical,
      failures,
    };
  });
  return { start, end, days: cells, failures: rangeFailures };
};

export const applyVenueCalendarOverlay = async (
  originProfile: ResolvedOutbeReadProfile,
  venueProfile: ResolvedVenueReadProfile,
  readers: CalendarRangeReaders,
  originRange: CalendarRangeRead,
): Promise<CalendarRangeRead> => {
  const expected = new Set(originRange.days.map((day) => day.worldwideDay));
  const dayNumbers = originRange.days.map((day) => Number(day.worldwideDay));
  const rangeFailures = [...originRange.failures];

  let venueValidationFailure: CalendarEvidenceFailure | null = null;
  try {
    await readers.venueAdapter.validateDeployment();
  } catch (error) {
    venueValidationFailure = calendarFailure('venue', error);
    rangeFailures.push(venueValidationFailure);
  }

  const originHead = currentHead(readers.originClient);
  const venueHead = venueValidationFailure ? Promise.reject(venueValidationFailure) : currentHead(readers.venueClient);
  const [desisEventsResult, routerEventsResult, venueEventsResult] = await Promise.all([
    originHead
      .then((head) =>
        scanDesisEvents(readers.originClient, originProfile, head, venueProfile.chainId, dayNumbers, expected),
      )
      .then(
        (value) => ({ value, failure: null }),
        (error) => ({ value: null, failure: calendarFailure('desis', error) }),
      ),
    originHead
      .then((head) =>
        scanRouterEvents(readers.originClient, originProfile, head, venueProfile.chainId, dayNumbers, expected),
      )
      .then(
        (value) => ({ value, failure: null }),
        (error) => ({ value: null, failure: calendarFailure('origin-router', error) }),
      ),
    venueHead
      .then((head) => scanVenueEvents(readers.venueClient, venueProfile, head, dayNumbers, expected))
      .then(
        (value) => ({ value, failure: null }),
        (error) => ({ value: null, failure: venueValidationFailure ?? calendarFailure('venue', error) }),
      ),
  ]);
  for (const result of [desisEventsResult, routerEventsResult, venueEventsResult]) {
    if (result.failure && result.failure !== venueValidationFailure) rangeFailures.push(result.failure);
  }
  const desisEvents = desisEventsResult.value ?? {
    candidates: new Set<WorldwideDayKey>(),
    skipped: new Set<WorldwideDayKey>(),
    cancelled: new Set<WorldwideDayKey>(),
    cancelledUnpriced: new Set<WorldwideDayKey>(),
    overdue: new Set<WorldwideDayKey>(),
    clearing: new Map<WorldwideDayKey, ClearingEvidence>(),
  };
  const routerEvents = routerEventsResult.value ?? {
    delivery: new Map<WorldwideDayKey, CalendarOriginDelivery>(),
    failures: [],
  };
  rangeFailures.push(...routerEvents.failures);
  const venueEvents = venueEventsResult.value ?? {
    candidates: new Set<WorldwideDayKey>(),
    stageReceived: new Set<WorldwideDayKey>(),
    resultReceived: new Set<WorldwideDayKey>(),
  };
  const global = await globalSnapshots(desisEvents.candidates, venueProfile.chainId, readers.originAdapter);
  const applicableVenueDays = new Set<WorldwideDayKey>([
    ...desisEvents.candidates,
    ...routerEvents.delivery.keys(),
    ...venueEvents.candidates,
  ]);
  const venueReadCandidates = new Set<WorldwideDayKey>([...routerEvents.delivery.keys(), ...venueEvents.candidates]);
  for (const day of originRange.days) {
    if (day.venueParticipation === 'not-applicable') {
      applicableVenueDays.delete(day.worldwideDay);
      venueReadCandidates.delete(day.worldwideDay);
    }
    if (desisEvents.skipped.has(day.worldwideDay)) venueReadCandidates.delete(day.worldwideDay);
  }
  const venues: Map<WorldwideDayKey, VenueAuctionSnapshot | null | CalendarEvidenceFailure> = venueValidationFailure
    ? new Map([...applicableVenueDays].map((day) => [day, venueValidationFailure]))
    : await venueSnapshots(venueReadCandidates, readers.venueAdapter);

  const days = originRange.days.map((day): CalendarWorldwideDay => {
    const failures = [...day.failures];
    const globalValue = global.get(day.worldwideDay) ?? null;
    const globalSnapshot = isFailure(globalValue) ? null : globalValue;
    if (isFailure(globalValue)) failures.push(globalValue);
    const globalAuction: CalendarGlobalAuction = globalSnapshot
      ? {
          ...day.globalAuction,
          stage: globalSnapshot.stage,
          totalBids: globalSnapshot.totalBids,
          venueBids: globalSnapshot.venueBids,
        }
      : day.globalAuction;
    const noAuction = day.venueParticipation === 'not-applicable';
    const venueParticipation: CalendarVenueParticipation = noAuction
      ? 'not-applicable'
      : desisEvents.skipped.has(day.worldwideDay)
        ? 'skipped'
        : globalSnapshot?.venueInTargetSnapshot
          ? 'included'
          : 'unknown';
    const venueValue = venues.get(day.worldwideDay) ?? null;
    const venueAuction = isFailure(venueValue) ? null : venueValue;
    if (isFailure(venueValue)) failures.push(venueValue);
    const originDelivery = routerEvents.delivery.get(day.worldwideDay) ?? emptyOriginDelivery();
    let venueReceipt: CalendarVenueReceipt;
    let scheduleAvailability: CalendarScheduleAvailability;
    if (noAuction || venueParticipation === 'skipped') {
      venueReceipt = 'not-applicable';
      scheduleAvailability = { kind: 'not-applicable' };
    } else if (venueAuction) {
      venueReceipt = venueEvents.resultReceived.has(day.worldwideDay)
        ? 'result-received'
        : venueEvents.stageReceived.has(day.worldwideDay)
          ? 'stage-received'
          : 'delivered';
      scheduleAvailability = { kind: 'available', schedule: venueAuction.schedule };
    } else if (isFailure(venueValue)) {
      venueReceipt = 'not-observed';
      scheduleAvailability = { kind: 'unavailable' };
    } else if (applicableVenueDays.has(day.worldwideDay)) {
      venueReceipt = 'delivery-pending';
      scheduleAvailability = { kind: 'pending' };
    } else {
      venueReceipt = 'not-observed';
      scheduleAvailability = { kind: 'unavailable' };
    }
    return {
      ...day,
      globalAuction,
      venueParticipation,
      originDelivery,
      venueReceipt,
      venueStage: venueAuction?.stage ?? null,
      scheduleAvailability,
      venueAuction,
      failures,
    };
  });
  return { ...originRange, days, failures: rangeFailures };
};

export const createOriginCalendarReaders = async (
  originProfile: ResolvedOutbeReadProfile,
): Promise<OriginCalendarReaders> => {
  const selected = await createPublicReadClient(originProfile);
  const originClient = withRpcDiagnostics(fromViemPublicClient(selected.client), 'calendar:origin');
  return {
    originClient,
    originAdapter: new OutbeAuctionAdapter(originClient, originProfile),
  };
};

export const createVenueCalendarReaders = async (
  venueProfile: ResolvedVenueReadProfile,
): Promise<VenueCalendarReaders> => {
  const selected = await createPublicReadClient(venueProfile);
  const venueClient = withRpcDiagnostics(fromViemPublicClient(selected.client), 'calendar:venue');
  return {
    venueClient,
    venuePublicClient: selected.client,
    venueAdapter: new VenueAuctionAdapter(venueClient, venueProfile),
  };
};
