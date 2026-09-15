import { getAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { parseWorldwideDayKey, toUtcTimestamp, type UtcTimestamp, type WorldwideDayKey } from '../domain/protocol-time';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import { BID_RATE_SCALE } from '../domain/escrow-lock';
import type { AuctionReadClient } from '../protocol/read-client';
import type { VenueAuctionSnapshot } from '../protocol/profile-types';
import { decodeVenueAuctionStage, type VenueAuctionStage } from '../protocol/read-model';
import { namespaceKey, pruneSupersededRecords } from '../persistence/namespace-key';
import { browserStorage } from '../persistence/available-storage';
import { LogPageScanError, LogPageScanInterruptedError, scanLogPages } from '../chain/scan-log-pages';

const CACHE_SCHEMA_VERSION = 2;
const CACHE_PREFIX = 'itx-acn:venue-log';

export type VenueLogEventFamily = 'BidRevealed' | 'AuctionReaped';

export interface VenueBidRevealRecord {
  worldwideDay: WorldwideDayKey;
  bidder: Address;
  quantity: number;
  bidRate: number;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number | null;
  logIndex: number;
  timestamp: UtcTimestamp;
}

export interface VenueAuctionReapRecord {
  worldwideDay: WorldwideDayKey;
  remaining: bigint;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number | null;
  logIndex: number;
}

export interface VenueLiveBidRecord {
  bidder: Address;
  quantity: number;
  bidRate: number;
  timestamp: UtcTimestamp;
  insertionIndex: number;
}

export interface VenueLiveBidSnapshot {
  stage: VenueAuctionStage;
  bids: readonly VenueLiveBidRecord[];
  authoritativeClearingRate: bigint | null;
}

export type VenueLogCacheStatus =
  | 'cache-hit'
  | 'cache-extended'
  | 'cold-scan'
  | 'rebuilt-invalid-cache'
  | 'rebuilt-after-reorg'
  | 'storage-unavailable'
  | 'storage-write-failed';

export interface VenueBidLogHistory {
  confirmedThroughBlock: bigint;
  bidReveals: readonly VenueBidRevealRecord[];
  reaps: readonly VenueAuctionReapRecord[];
  reapStatus: 'not-observed' | 'partial' | 'complete';
  cacheStatus: Readonly<Record<VenueLogEventFamily, VenueLogCacheStatus>>;
}

export interface VenueDemandEvidence {
  logs: VenueBidLogHistory;
  live: VenueLiveBidSnapshot;
}

export interface VenueDemandReadOptions {
  liveAuction?: Pick<VenueAuctionSnapshot, 'worldwideDay' | 'stage'> & {
    result: Pick<VenueAuctionSnapshot['result'], 'auctionClearingRate'>;
  };
}

type VenueDemandLiveAuction = NonNullable<VenueDemandReadOptions['liveAuction']>;

export interface VenueLogStorage {
  readonly length?: number;
  key?(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class VenueLogScanError extends Error {
  constructor(
    message: string,
    readonly eventFamily: VenueLogEventFamily,
    readonly fromBlock: bigint,
    readonly toBlock: bigint,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class VenueLogScanAbortedError extends Error {}

interface BlockSnapshot {
  hash: Hex;
  timestamp: UtcTimestamp;
}

interface LogProvenance {
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number | null;
  logIndex: number;
}

interface StoredEnvelope<T> {
  schemaVersion: number;
  chainId: number;
  deploymentId: string;
  auctionProxy: Address;
  eventFamily: VenueLogEventFamily;
  worldwideDay: WorldwideDayKey;
  lastCompletelyScannedBlock: string;
  checkpointBlockHash: Hex;
  records: readonly T[];
}

interface CachedFamily<T> {
  lastCompletelyScannedBlock: bigint;
  checkpointBlockHash: Hex;
  records: readonly T[];
}

interface FamilyCodec<T, S> {
  eventFamily: VenueLogEventFamily;
  decode(log: unknown, expectedDay: WorldwideDayKey, blocks: BlockReader): Promise<T>;
  serialize(record: T): S;
  deserialize(value: unknown): T;
  worldwideDay(record: T): WorldwideDayKey;
  blockNumber(record: T): bigint;
  key(record: T): string;
  compare(left: T, right: T): number;
}

interface FamilyScanResult<T> {
  records: readonly T[];
  status: VenueLogCacheStatus;
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
};

const asBigint = (value: unknown, label: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an integer.`);
};

const asUnsignedBigint = (value: unknown, label: string): bigint => {
  const result = asBigint(value, label);
  if (result < 0n) throw new RangeError(`${label} must be unsigned.`);
  return result;
};

const asSafeNumber = (value: unknown, label: string): number => {
  const result = asBigint(value, label);
  if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return Number(result);
};

const asOptionalSafeNumber = (value: unknown, label: string): number | null =>
  value === undefined || value === null ? null : asSafeNumber(value, label);

const asHex32 = (value: unknown, label: string): Hex => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a 32-byte hex value.`);
  }
  return value as Hex;
};

const asWorldwideDay = (value: unknown, label: string): WorldwideDayKey => {
  const raw = asSafeNumber(value, label).toString().padStart(8, '0');
  const parsed = parseWorldwideDayKey(raw);
  if (!parsed.ok) throw new TypeError(`${label} must be a valid WorldwideDay key.`);
  return parsed.value;
};

const eventFromAbi = (abi: Abi, name: VenueLogEventFamily): AbiEvent => {
  const event = abi.find((entry) => entry.type === 'event' && entry.name === name);
  if (event?.type !== 'event') throw new TypeError(`Venue ABI is missing ${name}.`);
  return event;
};

const checkedSignal = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new VenueLogScanAbortedError('Venue log scan was superseded.');
};

const parseProvenance = (value: unknown, label: string): LogProvenance & { args: Record<string, unknown> } => {
  const raw = asRecord(value, label);
  if (raw.removed === true) throw new TypeError(`${label} must not be a removed log.`);
  return {
    args: asRecord(raw.args, `${label} args`),
    blockNumber: asUnsignedBigint(raw.blockNumber, `${label} blockNumber`),
    blockHash: asHex32(raw.blockHash, `${label} blockHash`),
    transactionHash: asHex32(raw.transactionHash, `${label} transactionHash`),
    transactionIndex: asOptionalSafeNumber(raw.transactionIndex, `${label} transactionIndex`),
    logIndex: asSafeNumber(raw.logIndex, `${label} logIndex`),
  };
};

const compareProvenance = (
  left: Pick<LogProvenance, 'blockNumber' | 'transactionIndex' | 'logIndex'>,
  right: Pick<LogProvenance, 'blockNumber' | 'transactionIndex' | 'logIndex'>,
): number => {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
  const leftTransaction = left.transactionIndex ?? Number.MAX_SAFE_INTEGER;
  const rightTransaction = right.transactionIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftTransaction !== rightTransaction) return leftTransaction - rightTransaction;
  return left.logIndex - right.logIndex;
};

class BlockReader {
  private readonly cache = new Map<bigint, Promise<BlockSnapshot>>();

  constructor(private readonly client: AuctionReadClient) {}

  read(blockNumber: bigint): Promise<BlockSnapshot> {
    let pending = this.cache.get(blockNumber);
    if (!pending) {
      pending = this.client
        .getBlock({ blockNumber })
        .then((value) => {
          const raw = asRecord(value, `block ${blockNumber}`);
          if (
            raw.number !== undefined &&
            raw.number !== null &&
            asUnsignedBigint(raw.number, 'block number') !== blockNumber
          ) {
            throw new TypeError(`Block ${blockNumber} returned a different block number.`);
          }
          return {
            hash: asHex32(raw.hash, `block ${blockNumber} hash`),
            timestamp: toUtcTimestamp(asUnsignedBigint(raw.timestamp, `block ${blockNumber} timestamp`)),
          };
        })
        .catch((error: unknown) => {
          this.cache.delete(blockNumber);
          throw error;
        });
      this.cache.set(blockNumber, pending);
    }
    return pending;
  }
}

export const venueLogCacheKey = (
  profile: ResolvedVenueReadProfile,
  eventFamily: VenueLogEventFamily,
  worldwideDay: WorldwideDayKey,
): string =>
  namespaceKey({
    prefix: CACHE_PREFIX,
    version: CACHE_SCHEMA_VERSION,
    chainId: profile.chainId,
    deploymentId: profile.deploymentId,
    contract: getAddress(profile.addresses.intexAuction),
    segments: [eventFamily, worldwideDay],
  });

const bidCodec: FamilyCodec<VenueBidRevealRecord, Record<string, unknown>> = {
  eventFamily: 'BidRevealed',
  async decode(value, expectedDay, blocks) {
    const log = parseProvenance(value, 'BidRevealed log');
    const worldwideDay = asWorldwideDay(log.args.worldwideDay, 'BidRevealed worldwideDay');
    if (worldwideDay !== expectedDay) throw new TypeError('BidRevealed WWD disagrees with the requested route.');
    const quantity = asSafeNumber(log.args.quantity, 'BidRevealed quantity');
    const bidRate = asSafeNumber(log.args.bidRate, 'BidRevealed bidRate');
    if (quantity <= 0 || quantity > 65_535)
      throw new RangeError('BidRevealed quantity must fit uint16 and be positive.');
    if (bidRate <= 0 || bidRate > Number(BID_RATE_SCALE))
      throw new RangeError('BidRevealed bid rate must be within the reviewed 1e6 scale.');
    const block = await blocks.read(log.blockNumber);
    if (block.hash.toLowerCase() !== log.blockHash.toLowerCase()) {
      throw new TypeError('BidRevealed block hash disagrees with the current block.');
    }
    return {
      worldwideDay,
      bidder: getAddress(String(log.args.bidder)),
      quantity,
      bidRate,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      timestamp: block.timestamp,
    };
  },
  serialize: (record) => ({
    ...record,
    blockNumber: record.blockNumber.toString(),
    timestamp: record.timestamp.toString(),
  }),
  deserialize(value) {
    const raw = asRecord(value, 'cached BidRevealed record');
    const quantity = asSafeNumber(raw.quantity, 'cached BidRevealed quantity');
    const bidRate = asSafeNumber(raw.bidRate, 'cached BidRevealed bidRate');
    if (quantity <= 0 || quantity > 65_535) throw new RangeError('Cached bid quantity is invalid.');
    if (bidRate <= 0 || bidRate > Number(BID_RATE_SCALE)) throw new RangeError('Cached bid rate is invalid.');
    return {
      worldwideDay: asWorldwideDay(raw.worldwideDay, 'cached BidRevealed worldwideDay'),
      bidder: getAddress(String(raw.bidder)),
      quantity,
      bidRate,
      blockNumber: asUnsignedBigint(raw.blockNumber, 'cached BidRevealed blockNumber'),
      blockHash: asHex32(raw.blockHash, 'cached BidRevealed blockHash'),
      transactionHash: asHex32(raw.transactionHash, 'cached BidRevealed transactionHash'),
      transactionIndex: asOptionalSafeNumber(raw.transactionIndex, 'cached BidRevealed transactionIndex'),
      logIndex: asSafeNumber(raw.logIndex, 'cached BidRevealed logIndex'),
      timestamp: toUtcTimestamp(asUnsignedBigint(raw.timestamp, 'cached BidRevealed timestamp')),
    };
  },
  worldwideDay: (record) => record.worldwideDay,
  blockNumber: (record) => record.blockNumber,
  key: (record) => `${record.transactionHash.toLowerCase()}:${record.logIndex}`,
  compare: compareProvenance,
};

const reapCodec: FamilyCodec<VenueAuctionReapRecord, Record<string, unknown>> = {
  eventFamily: 'AuctionReaped',
  async decode(value, expectedDay, blocks) {
    const log = parseProvenance(value, 'AuctionReaped log');
    const worldwideDay = asWorldwideDay(log.args.worldwideDay, 'AuctionReaped worldwideDay');
    if (worldwideDay !== expectedDay) throw new TypeError('AuctionReaped WWD disagrees with the requested route.');
    const block = await blocks.read(log.blockNumber);
    if (block.hash.toLowerCase() !== log.blockHash.toLowerCase()) {
      throw new TypeError('AuctionReaped block hash disagrees with the current block.');
    }
    return {
      worldwideDay,
      remaining: asUnsignedBigint(log.args.remaining, 'AuctionReaped remaining'),
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
    };
  },
  serialize: (record) => ({
    ...record,
    remaining: record.remaining.toString(),
    blockNumber: record.blockNumber.toString(),
  }),
  deserialize(value) {
    const raw = asRecord(value, 'cached AuctionReaped record');
    return {
      worldwideDay: asWorldwideDay(raw.worldwideDay, 'cached AuctionReaped worldwideDay'),
      remaining: asUnsignedBigint(raw.remaining, 'cached AuctionReaped remaining'),
      blockNumber: asUnsignedBigint(raw.blockNumber, 'cached AuctionReaped blockNumber'),
      blockHash: asHex32(raw.blockHash, 'cached AuctionReaped blockHash'),
      transactionHash: asHex32(raw.transactionHash, 'cached AuctionReaped transactionHash'),
      transactionIndex: asOptionalSafeNumber(raw.transactionIndex, 'cached AuctionReaped transactionIndex'),
      logIndex: asSafeNumber(raw.logIndex, 'cached AuctionReaped logIndex'),
    };
  },
  worldwideDay: (record) => record.worldwideDay,
  blockNumber: (record) => record.blockNumber,
  key: (record) => `${record.transactionHash.toLowerCase()}:${record.logIndex}`,
  compare: compareProvenance,
};

const parseEnvelope = <T, S>(
  rawJson: string,
  profile: ResolvedVenueReadProfile,
  codec: FamilyCodec<T, S>,
  worldwideDay: WorldwideDayKey,
): CachedFamily<T> => {
  const raw = asRecord(JSON.parse(rawJson), `${codec.eventFamily} cache`);
  if (
    raw.schemaVersion !== CACHE_SCHEMA_VERSION ||
    raw.chainId !== profile.chainId ||
    raw.deploymentId !== profile.deploymentId ||
    getAddress(String(raw.auctionProxy)) !== getAddress(profile.addresses.intexAuction) ||
    raw.eventFamily !== codec.eventFamily ||
    raw.worldwideDay !== worldwideDay
  ) {
    throw new TypeError(`${codec.eventFamily} cache namespace is incompatible.`);
  }
  const lastCompletelyScannedBlock = asUnsignedBigint(
    raw.lastCompletelyScannedBlock,
    `${codec.eventFamily} last scanned block`,
  );
  const records = asArray(raw.records, `${codec.eventFamily} cache records`).map(codec.deserialize);
  if (records.some((record) => codec.worldwideDay(record) !== worldwideDay)) {
    throw new TypeError(`${codec.eventFamily} cache contains records for another WorldwideDay.`);
  }
  if (
    records.some(
      (record) =>
        codec.blockNumber(record) < profile.deploymentBlock || codec.blockNumber(record) > lastCompletelyScannedBlock,
    )
  ) {
    throw new TypeError(`${codec.eventFamily} cache record lies outside its completed scan range.`);
  }
  const keys = new Set(records.map(codec.key));
  if (keys.size !== records.length) throw new TypeError(`${codec.eventFamily} cache contains duplicate records.`);
  return {
    lastCompletelyScannedBlock,
    checkpointBlockHash: asHex32(raw.checkpointBlockHash, `${codec.eventFamily} checkpoint hash`),
    records,
  };
};

const envelopeJson = <T, S>(
  profile: ResolvedVenueReadProfile,
  codec: FamilyCodec<T, S>,
  worldwideDay: WorldwideDayKey,
  lastCompletelyScannedBlock: bigint,
  checkpointBlockHash: Hex,
  records: readonly T[],
): string =>
  JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    chainId: profile.chainId,
    deploymentId: profile.deploymentId,
    auctionProxy: getAddress(profile.addresses.intexAuction),
    eventFamily: codec.eventFamily,
    worldwideDay,
    lastCompletelyScannedBlock: lastCompletelyScannedBlock.toString(),
    checkpointBlockHash,
    records: records.map(codec.serialize),
  } satisfies StoredEnvelope<S>);

const scanPages = async <T, S>(
  client: AuctionReadClient,
  profile: ResolvedVenueReadProfile,
  codec: FamilyCodec<T, S>,
  worldwideDay: WorldwideDayKey,
  fromBlock: bigint,
  toBlock: bigint,
  blocks: BlockReader,
  signal?: AbortSignal,
): Promise<readonly T[]> => {
  try {
    const records = await scanLogPages<T>({
      client,
      address: profile.addresses.intexAuction,
      event: eventFromAbi(profile.abis.intexAuction, codec.eventFamily),
      args: { worldwideDay: Number(worldwideDay) },
      fromBlock,
      toBlock,
      pageSize: profile.logBatchSize,
      retryCount: profile.readRetryCount,
      ...(signal === undefined ? {} : { signal }),
      errorMessage: ({ fromBlock: pageFrom, toBlock: pageTo }) =>
        `${codec.eventFamily} scan failed for blocks ${pageFrom}-${pageTo}.`,
      decodeLog: (log) => codec.decode(log, worldwideDay, blocks),
      resultKey: codec.key,
      compare: codec.compare,
    });
    checkedSignal(signal);
    return records;
  } catch (error) {
    if (error instanceof LogPageScanInterruptedError) throw new VenueLogScanAbortedError(error.message);
    if (error instanceof LogPageScanError) {
      throw new VenueLogScanError(error.message, codec.eventFamily, error.fromBlock, error.toBlock, {
        cause: error.cause,
      });
    }
    throw error;
  }
};

const discardCache = (storage: VenueLogStorage | null, key: string): void => {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* advisory storage */
  }
};

const mergeRecords = <T, S>(codec: FamilyCodec<T, S>, retained: readonly T[], scanned: readonly T[]): readonly T[] => {
  const unique = new Map<string, T>();
  for (const record of [...retained, ...scanned]) unique.set(codec.key(record), record);
  return [...unique.values()].sort(codec.compare);
};

const scanFamily = async <T, S>(
  client: AuctionReadClient,
  profile: ResolvedVenueReadProfile,
  codec: FamilyCodec<T, S>,
  worldwideDay: WorldwideDayKey,
  confirmedHead: bigint,
  blocks: BlockReader,
  storage: VenueLogStorage | null,
  signal?: AbortSignal,
): Promise<FamilyScanResult<T>> => {
  const key = venueLogCacheKey(profile, codec.eventFamily, worldwideDay);
  let cached: CachedFamily<T> | null = null;
  let invalidCache = false;
  let reorg = false;
  let storageReadable = storage !== null;

  if (storage) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      storageReadable = false;
      storage = null;
    }
    if (raw !== null) {
      try {
        cached = parseEnvelope(raw, profile, codec, worldwideDay);
      } catch {
        invalidCache = true;
        discardCache(storage, key);
      }
    }
  }

  if (cached) {
    if (cached.lastCompletelyScannedBlock > confirmedHead) {
      reorg = true;
      cached = null;
      discardCache(storage, key);
    } else {
      const checkpoint = await blocks.read(cached.lastCompletelyScannedBlock);
      if (checkpoint.hash.toLowerCase() !== cached.checkpointBlockHash.toLowerCase()) {
        reorg = true;
        cached = null;
        discardCache(storage, key);
      }
    }
  }

  if (cached && cached.lastCompletelyScannedBlock === confirmedHead) {
    return { records: [...cached.records].sort(codec.compare), status: 'cache-hit' };
  }

  const deploymentBlock = profile.deploymentBlock;
  let scanFrom = deploymentBlock;
  let retained: readonly T[] = [];
  if (cached) {
    const overlap = BigInt(profile.confirmationDepth);
    scanFrom =
      cached.lastCompletelyScannedBlock >= overlap ? cached.lastCompletelyScannedBlock - overlap + 1n : deploymentBlock;
    if (scanFrom < deploymentBlock) scanFrom = deploymentBlock;
    retained = cached.records.filter((record) => codec.blockNumber(record) < scanFrom);
  }

  const scanned = await scanPages(client, profile, codec, worldwideDay, scanFrom, confirmedHead, blocks, signal);
  checkedSignal(signal);
  const records = mergeRecords(codec, retained, scanned);
  const checkpoint = await blocks.read(confirmedHead);
  checkedSignal(signal);

  let status: VenueLogCacheStatus = cached
    ? 'cache-extended'
    : reorg
      ? 'rebuilt-after-reorg'
      : invalidCache
        ? 'rebuilt-invalid-cache'
        : storageReadable
          ? 'cold-scan'
          : 'storage-unavailable';

  if (storage) {
    try {
      storage.setItem(key, envelopeJson(profile, codec, worldwideDay, confirmedHead, checkpoint.hash, records));
    } catch {
      status = 'storage-write-failed';
      storageReadable = false;
    }
  }
  return { records, status };
};

export const browserVenueLogStorage = (): VenueLogStorage | null => {
  const storage = browserStorage();
  pruneSupersededRecords(storage, CACHE_PREFIX, CACHE_SCHEMA_VERSION);
  return storage;
};

export const loadVenueBidLogHistory = async (
  client: AuctionReadClient,
  profile: ResolvedVenueReadProfile,
  worldwideDay: WorldwideDayKey,
  storage: VenueLogStorage | null = browserVenueLogStorage(),
  signal?: AbortSignal,
): Promise<VenueBidLogHistory> => {
  const latest = await client.getBlockNumber();
  const depth = BigInt(profile.confirmationDepth);
  const confirmedHead = latest > depth ? latest - depth : 0n;
  const blocks = new BlockReader(client);
  const [bidReveals, reaps] = await Promise.all([
    scanFamily(client, profile, bidCodec, worldwideDay, confirmedHead, blocks, storage, signal),
    scanFamily(client, profile, reapCodec, worldwideDay, confirmedHead, blocks, storage, signal),
  ]);
  const latestReap = reaps.records.at(-1);
  return {
    confirmedThroughBlock: confirmedHead,
    bidReveals: bidReveals.records,
    reaps: reaps.records,
    reapStatus: latestReap ? (latestReap.remaining === 0n ? 'complete' : 'partial') : 'not-observed',
    cacheStatus: { BidRevealed: bidReveals.status, AuctionReaped: reaps.status },
  };
};

export const readVenueLiveBids = async (
  client: AuctionReadClient,
  profile: ResolvedVenueReadProfile,
  worldwideDay: WorldwideDayKey,
  liveAuction?: VenueDemandLiveAuction,
): Promise<VenueLiveBidSnapshot> => {
  const args = [Number(worldwideDay)] as const;
  const [stage, detailsRaw] = await Promise.all([
    liveAuction && liveAuction.worldwideDay === worldwideDay
      ? Promise.resolve(liveAuction.stage)
      : client
          .readContract({
            address: profile.addresses.intexAuction,
            abi: profile.abis.intexAuction,
            functionName: 'getAuctionStage',
            args,
          })
          .then((stageRaw) => decodeVenueAuctionStage(asSafeNumber(stageRaw, 'Venue auction stage'))),
    client.readContract({
      address: profile.addresses.intexAuction,
      abi: profile.abis.intexAuction,
      functionName: 'getAuctionDetails',
      args,
    }),
  ]);
  const details = asArray(detailsRaw, 'IntexAuction.getAuctionDetails');
  if (details.length !== 2) throw new TypeError('IntexAuction.getAuctionDetails returned an incompatible tuple.');
  const auction = asRecord(details[0], 'IntexAuction auction data');
  const result = asRecord(auction.result, 'IntexAuction auction result');
  const bids = asArray(details[1], 'IntexAuction live bid array').map((value, insertionIndex): VenueLiveBidRecord => {
    const bid = asRecord(value, `IntexAuction live bid ${insertionIndex}`);
    const quantity = asSafeNumber(bid.intexQuantity, `live bid ${insertionIndex} quantity`);
    const bidRate = asSafeNumber(bid.intexBidRate, `live bid ${insertionIndex} rate`);
    if (quantity <= 0 || quantity > 65_535) throw new RangeError('Live bid quantity must fit uint16 and be positive.');
    if (bidRate <= 0 || bidRate > Number(BID_RATE_SCALE))
      throw new RangeError('Live bid rate must use the reviewed 1e6 scale.');
    return {
      bidder: getAddress(String(bid.bidderAddress)),
      quantity,
      bidRate,
      timestamp: toUtcTimestamp(asUnsignedBigint(bid.timestamp, `live bid ${insertionIndex} timestamp`)),
      insertionIndex,
    };
  });
  const clearingRate = asUnsignedBigint(result.auctionClearingRate, 'Auction result clearing rate');
  if (clearingRate > BID_RATE_SCALE) throw new RangeError('Auction clearing rate exceeds the reviewed 1e6 scale.');
  const authoritativeClearingRate =
    liveAuction && liveAuction.worldwideDay === worldwideDay ? liveAuction.result.auctionClearingRate : clearingRate;
  if (authoritativeClearingRate > BID_RATE_SCALE)
    throw new RangeError('Auction clearing rate exceeds the reviewed 1e6 scale.');
  return {
    stage,
    bids,
    authoritativeClearingRate: authoritativeClearingRate === 0n ? null : authoritativeClearingRate,
  };
};

export const loadVenueDemandEvidence = async (
  client: AuctionReadClient,
  profile: ResolvedVenueReadProfile,
  worldwideDay: WorldwideDayKey,
  storage: VenueLogStorage | null = browserVenueLogStorage(),
  signal?: AbortSignal,
  options: VenueDemandReadOptions = {},
): Promise<VenueDemandEvidence> => {
  const [logs, live] = await Promise.all([
    loadVenueBidLogHistory(client, profile, worldwideDay, storage, signal),
    readVenueLiveBids(client, profile, worldwideDay, options.liveAuction),
  ]);
  checkedSignal(signal);
  return { logs, live };
};
