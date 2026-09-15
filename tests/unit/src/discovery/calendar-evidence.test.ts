import { describe, expect, it } from 'vitest';
import { parseAbi, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import {
  applyVenueCalendarOverlay,
  loadCalendarRangeWithReaders,
  loadOriginCalendarRangeWithReaders,
  type OriginCalendarReaders,
  type CalendarRangeReaders,
} from '@/discovery/calendar-evidence';
import { OriginWorldwideDayNotFoundError, VenueAuctionNotFoundError } from '@/chain/revert-classify';
import type { AuctionReadClient } from '@/protocol/read-client';
import type {
  CanonicalSeriesSnapshot,
  GlobalAuctionSnapshot,
  OriginTerminalEvidence,
  VenueAuctionSnapshot,
  WorldwideDaySnapshot,
} from '@/protocol/profile-types';
import {
  contiguousWorldwideDayWindow,
  parseWorldwideDayKey,
  shiftWorldwideDay,
  toDurationSeconds,
  toUtcTimestamp,
  type WorldwideDayKey,
} from '@/domain/protocol-time';
import type { ResolvedOutbeReadProfile, ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';

const address = (digit: string): Address => `0x${digit.repeat(40)}` as Address;
const METADOSIS = address('1');
const DESIS = address('2');
const COEN = address('0');
const USD_QUOTE = address('b');
const ORIGIN_ROUTER = address('3');
const ORACLE = address('4');
const INTEX = address('5');
const AUCTION = address('6');
const ESCROW = address('7');
const TARGET_ROUTER = address('8');
const NFT = address('9');
const PAYMENT = address('a');
const TX_A = `0x${'a'.repeat(64)}` as Hex;
const TX_B = `0x${'b'.repeat(64)}` as Hex;
const TX_C = `0x${'c'.repeat(64)}` as Hex;

const originAbi = parseAbi([
  'event WorldwideDayMissedOffering(uint32 indexed worldwideDay,uint256 dayMetadosisLimit,uint256 carryOverBefore,uint256 carryOverAfter,uint8 retirementOutcome,uint64 blockNumber)',
  'event WorldwideDayCapacityForfeited(uint32 indexed worldwideDay,uint32 maxRetainedWorldwideDays,uint32 retainedCountBefore,uint256 dayMetadosisLimit,uint256 carryOverBefore,uint256 carryOverAfter,bytes32 sealedCollectionRoot,uint32 forfeitedTributeCount,uint256 forfeitedTributeNominal,uint64 sourceGeneration,uint64 retiredGeneration,uint8 retirementOutcome,uint64 blockNumber)',
  'event WorldwideDayCleanedUp(uint32 indexed worldwideDay,uint8 finalStatus)',
  'event AuctionCreated(uint32 indexed worldwideDay)',
  'event AuctionCancelledRedDay(uint32 indexed worldwideDay)',
  'event AuctionOverdue(uint32 indexed worldwideDay)',
  'event AuctionCleared(uint32 indexed worldwideDay,uint32 issuedIntexCount,uint32 clearingRate,uint64 totalDemand)',
  'event AuctionClearedEmpty(uint32 indexed worldwideDay,uint64 totalDemand)',
  'event UnusedSupplyReported(uint32 indexed worldwideDay,uint256 unusedPromis)',
  'event ChainSkipped(uint32 indexed worldwideDay,uint32 indexed srcChainId)',
  'event AuctionStageSent(bytes32 indexed sendId,uint32 indexed worldwideDay,uint8 stageType)',
  'event AuctionResultSent(bytes32 indexed sendId,uint32 indexed worldwideDay,uint32 issuedIntexCount,uint64 clearingRate)',
  'event SendParked(uint256 indexed idx,uint32 indexed dstChainId,uint8 msgType)',
  'event PendingSendFlushed(uint256 indexed idx,uint32 indexed dstChainId,bytes32 sendId)',
]);

const venueAbi = parseAbi([
  'event AuctionStageUpdated(uint32 indexed worldwideDay,uint8 auctionStage,uint32 timestamp,string reason)',
  'event AuctionReaped(uint32 indexed worldwideDay,uint256 remaining)',
  'event AuctionStageReceived(uint32 indexed srcChainId,uint32 indexed worldwideDay,uint8 stageType)',
  'event AuctionResultReceived(uint32 indexed srcChainId,uint32 indexed worldwideDay,uint32 issuedIntexCount,uint64 clearingRate)',
]);

const wwd = (raw: string): WorldwideDayKey => {
  const parsed = parseWorldwideDayKey(raw);
  if (!parsed.ok) throw new Error(`Invalid test WWD ${raw}`);
  return parsed.value;
};

const log = (args: Record<string, unknown>, transactionHash: Hex = TX_A, logIndex = 0): unknown => ({
  args,
  blockNumber: 10n,
  transactionHash,
  logIndex,
});

class LogClient implements AuctionReadClient {
  readonly logRequests: Array<{ event: string; fromBlock: bigint; toBlock: bigint }> = [];

  constructor(
    private readonly logs: ReadonlyMap<string, readonly unknown[]>,
    private readonly parked: ReadonlyMap<string, unknown> = new Map(),
  ) {}

  async readContract(request: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown> {
    if (request.functionName === 'parkedSend') {
      const index = request.args?.[0];
      const value = this.parked.get(String(index));
      if (value === undefined) throw new Error(`Missing parked send ${String(index)}`);
      return value;
    }
    throw new Error(`Unexpected read ${request.functionName}`);
  }

  async getChainId(): Promise<number> {
    return 31337;
  }
  async getBalance(): Promise<bigint> {
    return 0n;
  }
  async getBlockNumber(): Promise<bigint> {
    return 100n;
  }
  async getBytecode(): Promise<Hex | undefined> {
    return '0x6000';
  }
  async getBlock(request: { blockNumber: bigint }): Promise<unknown> {
    return { number: request.blockNumber, hash: `0x${'1'.repeat(64)}`, timestamp: 1n };
  }
  async getLogs(request: {
    event: AbiEvent;
    fromBlock: bigint;
    toBlock: bigint | 'latest';
  }): Promise<readonly unknown[]> {
    if (request.toBlock === 'latest') throw new Error('Calendar scans must use an explicit head.');
    this.logRequests.push({ event: request.event.name, fromBlock: request.fromBlock, toBlock: request.toBlock });
    return this.logs.get(request.event.name) ?? [];
  }
}

const snapshot = (
  day: WorldwideDayKey,
  lifecycle: WorldwideDaySnapshot['lifecycle'],
  dayType: WorldwideDaySnapshot['dayType'],
): WorldwideDaySnapshot => ({
  worldwideDay: day,
  lifecycle,
  dayType,
  formingStart: toUtcTimestamp(1n),
  formingEnd: toUtcTimestamp(2n),
  lookbackEnd: toUtcTimestamp(3n),
  offeringEnd: toUtcTimestamp(4n),
  scheduledProcessTime: toUtcTimestamp(5n),
  previousVwap: 1n,
  currentVwap: 2n,
});

const globalSnapshot = (overrides: Partial<GlobalAuctionSnapshot> = {}): GlobalAuctionSnapshot => ({
  stage: 'cleared',
  totalBids: 20n,
  venueBids: 7n,
  venueIntakeComplete: true,
  venueInTargetSnapshot: true,
  ...overrides,
});

const seriesSnapshot = (day: WorldwideDayKey, promisLoadMinor = 100n): CanonicalSeriesSnapshot => ({
  seriesId: `0x${Number(day).toString(16).padStart(28, '0')}`,
  promisLoadMinor,
  entryPriceMinor: 100n,
  floorPriceMinor: 80n,
  issuedIntexCount: 10,
  callWindowDays: 30,
  callThresholdDays: 15,
  callPriceMinor: 120n,
  state: 1,
  issuedAt: toUtcTimestamp(10n),
  calledAt: toUtcTimestamp(0n),
  intexCallPeriod: toDurationSeconds(86_400n),
  issuanceCurrency: 840,
  referenceCurrency: 840,
});

const venueSnapshot = (day: WorldwideDayKey): VenueAuctionSnapshot => ({
  worldwideDay: day,
  stage: 'completed',
  dayType: 'green',
  paymentToken: PAYMENT,
  schedule: {
    commitEnd: toUtcTimestamp(100n),
    revealEnd: toUtcTimestamp(200n),
    issuanceEnd: toUtcTimestamp(300n),
  },
  params: {
    issuanceCurrency: 840,
    referenceCurrency: 840,
    promisLoadMinor: 100n,
    minIntexBidRate: 500_000,
    minIntexBidQuantity: 1,
    entryPriceMinor: 100n,
    floorPriceMinor: 80n,
    callPriceMinor: 120n,
    commitBondMinor: 10n,
    callTrigger: { windowDays: 30, thresholdDays: 15, intexCallPeriod: toDurationSeconds(86_400n) },
  },
  runningCounts: { committedBids: 2, revealedBids: 2 },
  result: { auctionClearingRate: 750_000n, wonBidsCount: 2, issuedIntexCount: 10, issuedIntexLoadedPromis: 1_000n },
});

const originProfile = (): ResolvedOutbeReadProfile => ({
  id: 'origin',
  name: 'Outbe',
  deploymentId: 'local-origin',
  deploymentBlock: 1n,
  chainId: 31337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['/rpc'],
  explorerUrl: null,
  confirmationDepth: 1,
  logBatchSize: 2_000,
  requestTimeoutMs: 10_000,
  readRetryCount: 1,
  addresses: { metadosis: METADOSIS, desis: DESIS, originRouter: ORIGIN_ROUTER, oracle: ORACLE, intex: INTEX },
  abis: { metadosis: originAbi, desis: originAbi, originRouter: originAbi, oracle: [], intex: [] },
  oraclePair: { base: COEN, quote: USD_QUOTE },
});

const venueProfile = (): ResolvedVenueReadProfile => ({
  id: 'venue',
  name: 'Local venue',
  deploymentId: 'local-venue',
  deploymentBlock: 1n,
  chainId: 31337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['/rpc'],
  explorerUrl: null,
  confirmationDepth: 1,
  logBatchSize: 2_000,
  requestTimeoutMs: 10_000,
  readRetryCount: 1,
  adapterProfile: 'multi-issuance-usd-reference',
  addresses: {
    intexAuction: AUCTION,
    escrowAdapter: ESCROW,
    targetRouter: TARGET_ROUTER,
    intexNFT1155: NFT,
    paymentToken: PAYMENT,
  },
  abis: { intexAuction: venueAbi, escrowAdapter: [], targetRouter: venueAbi, intexNFT1155: [], paymentToken: [] },
});

const resultPayload = (day: WorldwideDayKey): Hex => {
  const header = '0105';
  const dayHex = Number(day).toString(16).padStart(8, '0');
  return `0x${header}${dayHex}${'00'.repeat(16)}` as Hex;
};

const stageStartPayload = (day: WorldwideDayKey, priceCount: number): Hex => {
  const head = [
    '01',
    '03',
    Number(day).toString(16).padStart(8, '0'),
    '00000000',
    '00000000',
    '00000000',
    '00'.repeat(16),
    '00000000',
    '00000000',
    '00000000',
    '00000000',
    '0000',
    '00'.repeat(16),
    '00',
    priceCount.toString(16).padStart(2, '0'),
  ].join('');
  return `0x${head}${'00'.repeat(26).repeat(priceCount)}` as Hex;
};

describe('Phase 4 calendar evidence', () => {
  it('keeps authorities separate and joins demand evidence only by clearing transaction', async () => {
    const partial = wwd('20260804');
    const failedGreen = wwd('20260805');
    const cleaned = wwd('20260806');
    const terminal = wwd('20260807');
    const skipped = wwd('20260808');
    const soldOut = wwd('20260809');
    const noSale = wwd('20260810');
    const deliveryPending = wwd('20260811');
    const parked = wwd('20260812');
    const flushed = wwd('20260813');
    const days = contiguousWorldwideDayWindow(wwd('20260701'), 90);

    const originLogs = new Map<string, readonly unknown[]>([
      ['WorldwideDayMissedOffering', [log({ worldwideDay: Number(terminal) })]],
      ['WorldwideDayCleanedUp', [log({ worldwideDay: Number(cleaned), finalStatus: 6 })]],
      [
        'AuctionCreated',
        [partial, skipped, soldOut, noSale, deliveryPending, parked, flushed].map((day, index) =>
          log({ worldwideDay: Number(day) }, TX_A, index),
        ),
      ],
      [
        'AuctionCleared',
        [
          log(
            { worldwideDay: Number(partial), issuedIntexCount: 10, clearingRate: 750_000, totalDemand: 18 },
            TX_A,
            10,
          ),
          log({ worldwideDay: Number(soldOut), issuedIntexCount: 8, clearingRate: 800_000, totalDemand: 8 }, TX_B, 11),
        ],
      ],
      [
        'UnusedSupplyReported',
        [
          log({ worldwideDay: Number(partial), unusedPromis: 250n }, TX_A, 11),
          log({ worldwideDay: Number(soldOut), unusedPromis: 9_999n }, TX_C, 12),
        ],
      ],
      ['AuctionClearedEmpty', [log({ worldwideDay: Number(noSale), totalDemand: 3 }, TX_C, 13)]],
      ['ChainSkipped', [log({ worldwideDay: Number(skipped), srcChainId: 31337 })]],
      [
        'SendParked',
        [
          log({ idx: 1n, dstChainId: 31337, msgType: 5 }, TX_A, 20),
          log({ idx: 2n, dstChainId: 31337, msgType: 5 }, TX_B, 21),
        ],
      ],
      ['PendingSendFlushed', [log({ idx: 2n, dstChainId: 31337, sendId: `0x${'1'.repeat(64)}` }, TX_B, 22)]],
    ]);
    const venueLogs = new Map<string, readonly unknown[]>([
      ['AuctionStageReceived', [log({ srcChainId: 31337, worldwideDay: Number(partial), stageType: 3 })]],
      [
        'AuctionResultReceived',
        [log({ srcChainId: 31337, worldwideDay: Number(partial), issuedIntexCount: 10, clearingRate: 750_000 })],
      ],
      ['AuctionStageUpdated', [log({ worldwideDay: Number(partial), auctionStage: 3, timestamp: 1, reason: 'done' })]],
    ]);
    const originClient = new LogClient(
      originLogs,
      new Map([
        ['1', { dstChainId: 31337, gasLimit: 1n, sent: false, payload: resultPayload(parked) }],
        ['2', { dstChainId: 31337, gasLimit: 1n, sent: true, payload: resultPayload(flushed) }],
      ]),
    );
    const venueClient = new LogClient(venueLogs);

    const records = new Map<WorldwideDayKey, WorldwideDaySnapshot>([
      [partial, snapshot(partial, 'completed', 'green')],
      [failedGreen, snapshot(failedGreen, 'failed', 'green')],
      [terminal, snapshot(terminal, 'failed', 'unknown')],
      [skipped, snapshot(skipped, 'completed', 'green')],
      [soldOut, snapshot(soldOut, 'completed', 'green')],
      [noSale, snapshot(noSale, 'completed', 'green')],
      [deliveryPending, snapshot(deliveryPending, 'completed', 'green')],
      [parked, snapshot(parked, 'completed', 'green')],
      [flushed, snapshot(flushed, 'completed', 'green')],
    ]);
    const terminalReceipt: OriginTerminalEvidence = {
      disposition: 'missed-offering',
      valueRouted: 0n,
      carryOverBefore: 1n,
      carryOverAfter: 1n,
      retirement: 'not-present',
      blockNumber: 10n,
    };
    const globals = new Map<WorldwideDayKey, GlobalAuctionSnapshot>([
      [partial, globalSnapshot()],
      [skipped, globalSnapshot({ stage: 'cleared' })],
      [soldOut, globalSnapshot()],
      [noSale, globalSnapshot()],
      [deliveryPending, globalSnapshot({ stage: 'started' })],
      [parked, globalSnapshot()],
      [flushed, globalSnapshot()],
    ]);
    const series = new Map<string, CanonicalSeriesSnapshot>([
      [`0x${Number(partial).toString(16).padStart(28, '0')}`, seriesSnapshot(partial)],
      [`0x${Number(soldOut).toString(16).padStart(28, '0')}`, seriesSnapshot(soldOut)],
      [`0x${Number(parked).toString(16).padStart(28, '0')}`, seriesSnapshot(parked)],
      [`0x${Number(flushed).toString(16).padStart(28, '0')}`, seriesSnapshot(flushed)],
    ]);
    const venues = new Map<WorldwideDayKey, VenueAuctionSnapshot>([[partial, venueSnapshot(partial)]]);
    const venueReads: WorldwideDayKey[] = [];

    const readers: CalendarRangeReaders = {
      originClient,
      venueClient,
      originAdapter: {
        validateDeployment: async () => undefined,
        readRetainedWorldwideDays: async () => [...records.keys()],
        readWorldwideDay: async (day) => {
          const value = records.get(day);
          if (!value) throw new OriginWorldwideDayNotFoundError('missing');
          return value;
        },
        readWorldwideDayState: async () => {
          throw new Error('not used');
        },
        readTerminalEvidence: async (day) => (day === terminal ? terminalReceipt : null),
        readGlobalAuction: async (day) =>
          globals.get(day) ?? globalSnapshot({ stage: 'none', venueInTargetSnapshot: false }),
        readCanonicalSeries: async (id) => series.get(id) ?? null,
      },
      venueAdapter: {
        validateDeployment: async () => undefined,
        readAuction: async (day) => {
          venueReads.push(day);
          const value = venues.get(day);
          if (!value) throw new VenueAuctionNotFoundError('missing');
          return value;
        },
      },
    };

    const originRange = await loadOriginCalendarRangeWithReaders(
      originProfile(),
      venueProfile().chainId,
      readers,
      days,
    );
    const result = await applyVenueCalendarOverlay(originProfile(), venueProfile(), readers, originRange);
    const byDay = new Map(result.days.map((cell) => [cell.worldwideDay, cell]));

    expect(byDay.get(partial)).toMatchObject({
      lifecycle: 'completed',
      dayType: 'green',
      venueParticipation: 'included',
      venueReceipt: 'result-received',
      venueStage: 'completed',
      globalAuction: {
        terminalDisposition: 'cleared-sale',
        grossIncludedDemand: 18n,
        offeredQuantity: null,
        offeredQuantityEvidence: 'unavailable',
      },
      scheduleAvailability: { kind: 'available' },
    });
    expect(byDay.get(failedGreen)).toMatchObject({ lifecycle: 'failed', dayType: 'green' });
    expect(byDay.get(cleaned)).toMatchObject({
      originRecord: { kind: 'cleaned-history-unavailable', finalLifecycle: 'completed' },
      lifecycle: 'completed',
      dayType: null,
    });
    expect(byDay.get(terminal)).toMatchObject({
      terminalDisposition: 'missed-offering',
      venueParticipation: 'not-applicable',
      venueReceipt: 'not-applicable',
      scheduleAvailability: { kind: 'not-applicable' },
    });
    expect(byDay.get(skipped)).toMatchObject({
      venueParticipation: 'skipped',
      venueReceipt: 'not-applicable',
      globalAuction: { terminalDisposition: 'cleared' },
    });
    expect(byDay.get(soldOut)?.globalAuction).toMatchObject({
      offeredQuantity: 8n,
      offeredQuantityEvidence: 'sold-out',
    });
    expect(byDay.get(noSale)?.globalAuction).toMatchObject({
      terminalDisposition: 'cleared-no-sale',
      grossIncludedDemand: 3n,
      offeredQuantity: null,
    });
    expect(byDay.get(deliveryPending)).toMatchObject({
      venueParticipation: 'included',
      venueReceipt: 'delivery-pending',
      scheduleAvailability: { kind: 'pending' },
    });
    expect(byDay.get(parked)?.originDelivery.result).toBe('parked');
    expect(byDay.get(flushed)?.originDelivery.result).toBe('flushed');
    expect(venueReads).not.toContain(deliveryPending);
    expect(venueReads).not.toContain(soldOut);
    expect(venueReads).toEqual(expect.arrayContaining([partial, parked, flushed]));
    expect(result.days).toHaveLength(90);
  });

  it('decodes variable-length parked AUCTION_STAGE_START payloads and rejects malformed lengths', async () => {
    const parkedDay = wwd('20260812');
    const flushedDay = wwd('20260813');
    const malformedDay = wwd('20260814');
    const days = contiguousWorldwideDayWindow(wwd('20260701'), 90);

    const originLogs = new Map<string, readonly unknown[]>([
      [
        'AuctionCreated',
        [parkedDay, flushedDay, malformedDay].map((day, index) => log({ worldwideDay: Number(day) }, TX_A, index)),
      ],
      [
        'SendParked',
        [
          log({ idx: 1n, dstChainId: 31337, msgType: 3 }, TX_A, 20),
          log({ idx: 2n, dstChainId: 31337, msgType: 3 }, TX_B, 21),
          log({ idx: 3n, dstChainId: 31337, msgType: 3 }, TX_C, 22),
        ],
      ],
      ['PendingSendFlushed', [log({ idx: 2n, dstChainId: 31337, sendId: `0x${'1'.repeat(64)}` }, TX_B, 23)]],
    ]);
    const originClient = new LogClient(
      originLogs,
      new Map([
        ['1', { dstChainId: 31337, gasLimit: 1n, sent: false, payload: stageStartPayload(parkedDay, 1) }],
        ['2', { dstChainId: 31337, gasLimit: 1n, sent: true, payload: stageStartPayload(flushedDay, 3) }],
        ['3', { dstChainId: 31337, gasLimit: 1n, sent: false, payload: `${stageStartPayload(malformedDay, 0)}0000` }],
      ]),
    );
    const venueClient = new LogClient(new Map());
    const stageDays = [parkedDay, flushedDay, malformedDay];

    const readers: CalendarRangeReaders = {
      originClient,
      venueClient,
      originAdapter: {
        validateDeployment: async () => undefined,
        readRetainedWorldwideDays: async () => stageDays,
        readWorldwideDay: async (day) => {
          if (!stageDays.includes(day)) throw new OriginWorldwideDayNotFoundError('missing');
          return snapshot(day, 'completed', 'green');
        },
        readWorldwideDayState: async () => {
          throw new Error('not used');
        },
        readTerminalEvidence: async () => null,
        readGlobalAuction: async (day) =>
          stageDays.includes(day) ? globalSnapshot() : globalSnapshot({ stage: 'none', venueInTargetSnapshot: false }),
        readCanonicalSeries: async () => null,
      },
      venueAdapter: {
        validateDeployment: async () => undefined,
        readAuction: async () => {
          throw new VenueAuctionNotFoundError('missing');
        },
      },
    };

    const result = await loadCalendarRangeWithReaders(originProfile(), venueProfile(), readers, days);
    const byDay = new Map(result.days.map((cell) => [cell.worldwideDay, cell]));

    expect(byDay.get(parkedDay)?.originDelivery.stageStart).toBe('parked');
    expect(byDay.get(flushedDay)?.originDelivery.stageStart).toBe('flushed');
    expect(byDay.get(parkedDay)?.failures.some((failure) => failure.authority === 'origin-router')).toBe(false);
    expect(byDay.get(flushedDay)?.failures.some((failure) => failure.authority === 'origin-router')).toBe(false);
    const malformedCell = byDay.get(malformedDay);
    expect(malformedCell?.originDelivery.stageStart).toBe('not-observed');
    expect(result.failures.filter((failure) => failure.authority === 'origin-router')).toHaveLength(1);
  });

  it('pages every reviewed event scan at the configured batch size', async () => {
    const originClient = new LogClient(new Map());
    const venueClient = new LogClient(new Map());
    const origin = { ...originProfile(), logBatchSize: 25 };
    const venue = { ...venueProfile(), logBatchSize: 25 };
    const readers: CalendarRangeReaders = {
      originClient,
      venueClient,
      originAdapter: {
        validateDeployment: async () => undefined,
        readRetainedWorldwideDays: async () => [],
        readWorldwideDay: async () => {
          throw new OriginWorldwideDayNotFoundError('missing');
        },
        readWorldwideDayState: async () => {
          throw new OriginWorldwideDayNotFoundError('missing');
        },
        readTerminalEvidence: async () => null,
        readGlobalAuction: async () => globalSnapshot({ stage: 'none', venueInTargetSnapshot: false }),
        readCanonicalSeries: async () => null,
      },
      venueAdapter: {
        validateDeployment: async () => undefined,
        readAuction: async () => {
          throw new VenueAuctionNotFoundError('missing');
        },
      },
    };
    await loadCalendarRangeWithReaders(origin, venue, readers, contiguousWorldwideDayWindow(wwd('20260701'), 90));
    for (const request of [...originClient.logRequests, ...venueClient.logRequests]) {
      expect(request.toBlock - request.fromBlock + 1n).toBeLessThanOrEqual(25n);
    }
    expect(originClient.logRequests.some((request) => request.fromBlock === 1n && request.toBlock === 25n)).toBe(true);
    expect(originClient.logRequests.some((request) => request.fromBlock === 76n && request.toBlock === 100n)).toBe(
      true,
    );
  });

  it('rejects non-90-day or non-contiguous range input', async () => {
    const client = new LogClient(new Map());
    const readers = {
      originClient: client,
      venueClient: client,
      originAdapter: {} as CalendarRangeReaders['originAdapter'],
      venueAdapter: {} as CalendarRangeReaders['venueAdapter'],
    };
    await expect(
      loadCalendarRangeWithReaders(
        originProfile(),
        venueProfile(),
        readers,
        contiguousWorldwideDayWindow(wwd('20260801'), 89),
      ),
    ).rejects.toThrow('exactly 90 unique');

    const nonContiguous = [...contiguousWorldwideDayWindow(wwd('20260801'), 90)];
    nonContiguous[89] = shiftWorldwideDay(nonContiguous[89]!, 1);
    await expect(loadCalendarRangeWithReaders(originProfile(), venueProfile(), readers, nonContiguous)).rejects.toThrow(
      '90 contiguous',
    );
  });

  it('does not read an origin authority after deployment validation fails', async () => {
    const days = contiguousWorldwideDayWindow(wwd('20260801'), 90);
    const forbiddenClient = {
      readContract: async () => {
        throw new Error('origin read must not run');
      },
      getBalance: async () => {
        throw new Error('origin read must not run');
      },
      getChainId: async () => {
        throw new Error('origin read must not run');
      },
      getBlockNumber: async () => {
        throw new Error('origin read must not run');
      },
      getBlock: async () => {
        throw new Error('origin read must not run');
      },
      getBytecode: async () => {
        throw new Error('origin read must not run');
      },
      getLogs: async () => {
        throw new Error('origin read must not run');
      },
    } satisfies AuctionReadClient;
    const venueClient = new LogClient(new Map());
    const readers: CalendarRangeReaders = {
      originClient: forbiddenClient,
      venueClient,
      originAdapter: {
        validateDeployment: async () => {
          throw new Error('invalid origin deployment');
        },
        readRetainedWorldwideDays: async () => {
          throw new Error('origin read must not run');
        },
        readWorldwideDay: async () => {
          throw new Error('origin read must not run');
        },
        readWorldwideDayState: async () => {
          throw new Error('origin read must not run');
        },
        readTerminalEvidence: async () => {
          throw new Error('origin read must not run');
        },
        readGlobalAuction: async () => {
          throw new Error('origin read must not run');
        },
        readCanonicalSeries: async () => {
          throw new Error('origin read must not run');
        },
      },
      venueAdapter: {
        validateDeployment: async () => undefined,
        readAuction: async () => {
          throw new VenueAuctionNotFoundError('missing');
        },
      },
    };

    const result = await loadCalendarRangeWithReaders(originProfile(), venueProfile(), readers, days);
    expect(result.days.every((day) => day.originRecord.kind === 'failure')).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('invalid origin deployment'))).toBe(true);
    expect(venueClient.logRequests.length).toBeGreaterThan(0);
  });

  it('does not read a venue authority after deployment validation fails', async () => {
    const selected = wwd('20260804');
    const days = contiguousWorldwideDayWindow(wwd('20260801'), 90);
    const originClient = new LogClient(new Map([['AuctionCreated', [log({ worldwideDay: Number(selected) })]]]));
    const forbiddenVenueClient = {
      readContract: async () => {
        throw new Error('venue read must not run');
      },
      getBalance: async () => {
        throw new Error('venue read must not run');
      },
      getChainId: async () => {
        throw new Error('venue read must not run');
      },
      getBlockNumber: async () => {
        throw new Error('venue read must not run');
      },
      getBlock: async () => {
        throw new Error('venue read must not run');
      },
      getBytecode: async () => {
        throw new Error('venue read must not run');
      },
      getLogs: async () => {
        throw new Error('venue read must not run');
      },
    } satisfies AuctionReadClient;
    const readers: CalendarRangeReaders = {
      originClient,
      venueClient: forbiddenVenueClient,
      originAdapter: {
        validateDeployment: async () => undefined,
        readRetainedWorldwideDays: async () => [selected],
        readWorldwideDay: async (day) =>
          day === selected
            ? snapshot(day, 'completed', 'green')
            : Promise.reject(new OriginWorldwideDayNotFoundError('missing')),
        readWorldwideDayState: async () => {
          throw new Error('not used');
        },
        readTerminalEvidence: async () => null,
        readGlobalAuction: async () => globalSnapshot({ stage: 'started' }),
        readCanonicalSeries: async () => null,
      },
      venueAdapter: {
        validateDeployment: async () => {
          throw new Error('invalid venue deployment');
        },
        readAuction: async () => {
          throw new Error('venue read must not run');
        },
      },
    };

    const result = await loadCalendarRangeWithReaders(originProfile(), venueProfile(), readers, days);
    const cell = result.days.find((day) => day.worldwideDay === selected);
    expect(cell?.failures.some((failure) => failure.message.includes('invalid venue deployment'))).toBe(true);
    expect(result.failures.some((failure) => failure.message.includes('invalid venue deployment'))).toBe(true);
  });

  it('loads canonical origin evidence without constructing or reading a venue context', async () => {
    const selected = wwd('20260804');
    const days = contiguousWorldwideDayWindow(wwd('20260801'), 90);
    const originClient = new LogClient(new Map([['AuctionCreated', [log({ worldwideDay: Number(selected) })]]]));
    const readWorldwideDays: WorldwideDayKey[] = [];
    const readers: OriginCalendarReaders = {
      originClient,
      originAdapter: {
        validateDeployment: async () => undefined,
        readRetainedWorldwideDays: async () => [selected],
        readWorldwideDay: async (day) => {
          readWorldwideDays.push(day);
          return snapshot(day, 'completed', 'green');
        },
        readWorldwideDayState: async () => {
          throw new Error('not used');
        },
        readTerminalEvidence: async () => null,
        readGlobalAuction: async () => globalSnapshot({ stage: 'started', totalBids: 20n, venueBids: 7n }),
        readCanonicalSeries: async () => null,
      },
    };

    const result = await loadOriginCalendarRangeWithReaders(originProfile(), 31337, readers, days);
    const cell = result.days.find((day) => day.worldwideDay === selected);
    expect(cell?.originRecord.kind).toBe('retained');
    expect(cell?.venueAuction).toBeNull();
    expect(cell?.globalAuction.stage).toBe('started');
    expect(cell?.globalAuction.totalBids).toBe(20n);
    expect(cell?.globalAuction.venueBids).toBeNull();
    expect(readWorldwideDays).toEqual([selected]);
    expect(originClient.logRequests.every((request) => !request.event.includes('AuctionStage'))).toBe(true);
  });

  it('skips fabricated WWD-derived series reads for the multi-issuance profile', async () => {
    const selected = wwd('20260804');
    const days = contiguousWorldwideDayWindow(wwd('20260701'), 90);
    const originClient = new LogClient(
      new Map([
        ['AuctionCreated', [log({ worldwideDay: Number(selected) })]],
        [
          'AuctionCleared',
          [
            log(
              { worldwideDay: Number(selected), issuedIntexCount: 10, clearingRate: 750_000, totalDemand: 18 },
              TX_A,
              10,
            ),
          ],
        ],
        ['UnusedSupplyReported', [log({ worldwideDay: Number(selected), unusedPromis: 250n }, TX_A, 11)]],
      ]),
    );
    const venueClient = new LogClient(new Map());
    let canonicalSeriesReads = 0;
    const readers: CalendarRangeReaders = {
      originClient,
      venueClient,
      originAdapter: {
        validateDeployment: async () => undefined,
        readRetainedWorldwideDays: async () => [selected],
        readWorldwideDay: async (day) =>
          day === selected
            ? snapshot(day, 'completed', 'green')
            : Promise.reject(new OriginWorldwideDayNotFoundError('missing')),
        readWorldwideDayState: async () => {
          throw new Error('not used');
        },
        readTerminalEvidence: async () => null,
        readGlobalAuction: async () => globalSnapshot(),
        readCanonicalSeries: async () => {
          canonicalSeriesReads += 1;
          return seriesSnapshot(selected);
        },
      },
      venueAdapter: {
        validateDeployment: async () => undefined,
        readAuction: async () => {
          throw new VenueAuctionNotFoundError('missing');
        },
      },
    };

    const result = await loadCalendarRangeWithReaders(
      originProfile(),
      { ...venueProfile(), adapterProfile: 'multi-issuance-usd-reference' },
      readers,
      days,
    );
    const cell = result.days.find((day) => day.worldwideDay === selected);
    expect(cell?.canonicalSeries).toBeNull();
    expect(cell?.globalAuction.offeredQuantityEvidence).toBe('unavailable');
    expect(canonicalSeriesReads).toBe(0);
  });
});
