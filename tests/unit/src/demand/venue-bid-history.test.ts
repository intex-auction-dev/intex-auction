import { describe, expect, it } from 'vitest';
import { parseAbi, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { AuctionReadClient } from '@/protocol/read-client';
import {
  loadVenueBidLogHistory,
  loadVenueDemandEvidence,
  readVenueLiveBids,
  venueLogCacheKey,
  VenueLogScanError,
  type VenueLogStorage,
} from '@/demand/venue-bid-history';
import { parseWorldwideDayKey, type WorldwideDayKey } from '@/domain/protocol-time';

const ABI = parseAbi([
  'event BidRevealed(uint32 indexed worldwideDay,address indexed bidder,uint16 indexed quantity,uint32 bidRate)',
  'event AuctionReaped(uint32 indexed worldwideDay,uint256 remaining)',
]);
const AUCTION = '0x1111111111111111111111111111111111111111' as Address;
const ESCROW = '0x2222222222222222222222222222222222222222' as Address;
const ROUTER = '0x3333333333333333333333333333333333333333' as Address;
const NFT = '0x4444444444444444444444444444444444444444' as Address;
const PAYMENT = '0x5555555555555555555555555555555555555555' as Address;
const BIDDER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BIDDER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const dayParsed = parseWorldwideDayKey('20260804');
if (!dayParsed.ok) throw new Error('Invalid test day.');
const DAY = dayParsed.value;

const hashFor = (block: bigint): Hex => `0x${block.toString(16).padStart(64, '0')}` as Hex;
const txFor = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;

const profile = (overrides: Partial<ResolvedVenueReadProfile> = {}): ResolvedVenueReadProfile => ({
  id: 'venue',
  name: 'Venue',
  deploymentId: 'venue-v1',
  deploymentBlock: 1n,
  chainId: 31337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['/rpc'],
  explorerUrl: null,
  confirmationDepth: 2,
  logBatchSize: 5,
  requestTimeoutMs: 10_000,
  readRetryCount: 1,
  addresses: {
    intexAuction: AUCTION,
    escrowAdapter: ESCROW,
    targetRouter: ROUTER,
    intexNFT1155: NFT,
    paymentToken: PAYMENT,
  },
  abis: {
    intexAuction: ABI,
    escrowAdapter: [],
    targetRouter: [],
    intexNFT1155: [],
    paymentToken: [],
  },
  ...overrides,
});

const bidLog = ({
  blockNumber,
  bidder = BIDDER_A,
  quantity = 2,
  bidRate = 800_000,
  transactionHash = txFor('a'),
  transactionIndex = 0,
  logIndex = 0,
}: {
  blockNumber: bigint;
  bidder?: Address;
  quantity?: number;
  bidRate?: number;
  transactionHash?: Hex;
  transactionIndex?: number | null;
  logIndex?: number;
}): unknown => ({
  args: { worldwideDay: Number(DAY), bidder, quantity, bidRate },
  blockNumber,
  blockHash: hashFor(blockNumber),
  transactionHash,
  transactionIndex,
  logIndex,
  removed: false,
});

const reapLog = (blockNumber: bigint, remaining: bigint): unknown => ({
  args: { worldwideDay: Number(DAY), remaining },
  blockNumber,
  blockHash: hashFor(blockNumber),
  transactionHash: txFor('f'),
  transactionIndex: 0,
  logIndex: 0,
  removed: false,
});

class MemoryStorage implements VenueLogStorage {
  readonly values = new Map<string, string>();
  readonly setCalls: Array<{ key: string; value: string }> = [];
  readonly removeCalls: string[] = [];
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota');
    this.setCalls.push({ key, value });
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.removeCalls.push(key);
    this.values.delete(key);
  }
}

class FakeClient implements AuctionReadClient {
  latest = 20n;
  readonly requests: Array<{ event: string; fromBlock: bigint; toBlock: bigint }> = [];
  readonly blockCalls = new Map<bigint, number>();
  readonly failures = new Map<string, number>();
  readonly blockFailures = new Map<bigint, number>();
  readonly blockHashes = new Map<bigint, Hex>();
  readonly readCalls: string[] = [];
  liveStage: unknown = 1;
  liveDetails: unknown = [{ result: { auctionClearingRate: 0n } }, []];

  constructor(readonly logs: Readonly<Record<string, readonly unknown[]>>) {}

  async readContract(request: { address: Address; abi: Abi; functionName: string }): Promise<unknown> {
    this.readCalls.push(request.functionName);
    if (request.functionName === 'getAuctionStage') return this.liveStage;
    if (request.functionName === 'getAuctionDetails') return this.liveDetails;
    throw new Error(`Unexpected read ${request.functionName}`);
  }
  async getChainId(): Promise<number> {
    return 31337;
  }
  async getBalance(): Promise<bigint> {
    return 0n;
  }
  async getBlockNumber(): Promise<bigint> {
    return this.latest;
  }
  async getBlock(request: { blockNumber: bigint }): Promise<unknown> {
    this.blockCalls.set(request.blockNumber, (this.blockCalls.get(request.blockNumber) ?? 0) + 1);
    const remainingFailures = this.blockFailures.get(request.blockNumber) ?? 0;
    if (remainingFailures > 0) {
      this.blockFailures.set(request.blockNumber, remainingFailures - 1);
      throw new Error(`temporary block ${request.blockNumber}`);
    }
    return {
      number: request.blockNumber,
      hash: this.blockHashes.get(request.blockNumber) ?? hashFor(request.blockNumber),
      timestamp: 1_700_000_000n + request.blockNumber,
    };
  }
  async getBytecode(): Promise<Hex | undefined> {
    return '0x6000';
  }
  async getLogs(request: {
    event: AbiEvent;
    fromBlock: bigint;
    toBlock: bigint | 'latest';
  }): Promise<readonly unknown[]> {
    if (request.toBlock === 'latest') throw new Error('Explicit block head required.');
    const key = `${request.event.name}:${request.fromBlock}-${request.toBlock}`;
    this.requests.push({ event: request.event.name, fromBlock: request.fromBlock, toBlock: request.toBlock });
    const remainingFailures = this.failures.get(key) ?? 0;
    if (remainingFailures > 0) {
      this.failures.set(key, remainingFailures - 1);
      throw new Error(`temporary ${key}`);
    }
    const toBlock = request.toBlock;
    return (this.logs[request.event.name] ?? []).filter((value) => {
      const blockNumber = (value as { blockNumber: bigint }).blockNumber;
      return blockNumber >= request.fromBlock && blockNumber <= toBlock;
    });
  }
}

describe('venue bid log history', () => {
  it('uses configured pages, confirmed head, deterministic order, deduplication, and one timestamp read per block', async () => {
    const duplicate = bidLog({ blockNumber: 5n, transactionHash: txFor('b'), transactionIndex: null, logIndex: 3 });
    const client = new FakeClient({
      BidRevealed: [
        duplicate,
        duplicate,
        bidLog({ blockNumber: 5n, bidder: BIDDER_B, transactionHash: txFor('c'), transactionIndex: null, logIndex: 1 }),
      ],
      AuctionReaped: [reapLog(12n, 0n)],
    });
    const storage = new MemoryStorage();
    const result = await loadVenueBidLogHistory(client, profile(), DAY, storage);

    expect(result.confirmedThroughBlock).toBe(18n);
    expect(client.requests.filter((request) => request.event === 'BidRevealed')).toEqual([
      { event: 'BidRevealed', fromBlock: 1n, toBlock: 5n },
      { event: 'BidRevealed', fromBlock: 6n, toBlock: 10n },
      { event: 'BidRevealed', fromBlock: 11n, toBlock: 15n },
      { event: 'BidRevealed', fromBlock: 16n, toBlock: 18n },
    ]);
    expect(result.bidReveals.map((record) => record.logIndex)).toEqual([1, 3]);
    expect(client.blockCalls.get(5n)).toBe(1);
    expect(result.reapStatus).toBe('complete');
    expect(storage.setCalls).toHaveLength(2);
  });

  it('retries a temporary page failure without arbitrary delay', async () => {
    const client = new FakeClient({ BidRevealed: [], AuctionReaped: [] });
    client.failures.set('BidRevealed:6-10', 1);
    await expect(loadVenueBidLogHistory(client, profile(), DAY, new MemoryStorage())).resolves.toBeDefined();
    expect(
      client.requests.filter((request) => request.event === 'BidRevealed' && request.fromBlock === 6n),
    ).toHaveLength(2);
  });

  it('retries transient block hydration within the configured page budget', async () => {
    const client = new FakeClient({ BidRevealed: [bidLog({ blockNumber: 5n })], AuctionReaped: [] });
    client.blockFailures.set(5n, 1);
    await expect(loadVenueBidLogHistory(client, profile(), DAY, new MemoryStorage())).resolves.toBeDefined();
    expect(client.blockCalls.get(5n)).toBe(2);
  });

  it('leaves the existing family cursor unchanged after a permanent page failure', async () => {
    const client = new FakeClient({ BidRevealed: [bidLog({ blockNumber: 5n })], AuctionReaped: [] });
    const storage = new MemoryStorage();
    await loadVenueBidLogHistory(client, profile(), DAY, storage);
    const key = venueLogCacheKey(profile(), 'BidRevealed', DAY);
    const before = storage.getItem(key);
    client.latest = 25n;
    client.failures.set('BidRevealed:17-21', 2);

    await expect(loadVenueBidLogHistory(client, profile(), DAY, storage)).rejects.toBeInstanceOf(VenueLogScanError);
    expect(storage.getItem(key)).toBe(before);
  });

  it('overlaps the confirmation window and deduplicates while extending a valid cursor', async () => {
    const client = new FakeClient({ BidRevealed: [bidLog({ blockNumber: 17n })], AuctionReaped: [] });
    const storage = new MemoryStorage();
    await loadVenueBidLogHistory(client, profile(), DAY, storage);
    client.latest = 25n;
    (client.logs.BidRevealed as unknown[]).push?.(
      bidLog({
        blockNumber: 22n,
        bidder: BIDDER_B,
        transactionHash: txFor('d'),
        logIndex: 1,
      }),
    );
    const result = await loadVenueBidLogHistory(client, profile(), DAY, storage);

    expect(client.requests.some((request) => request.event === 'BidRevealed' && request.fromBlock === 17n)).toBe(true);
    expect(result.bidReveals).toHaveLength(2);
    expect(result.cacheStatus.BidRevealed).toBe('cache-extended');
  });

  it('discards malformed storage and safely rebuilds from deployment block', async () => {
    const client = new FakeClient({ BidRevealed: [], AuctionReaped: [] });
    const storage = new MemoryStorage();
    const key = venueLogCacheKey(profile(), 'BidRevealed', DAY);
    storage.values.set(key, '{bad json');
    const result = await loadVenueBidLogHistory(client, profile(), DAY, storage);
    expect(result.cacheStatus.BidRevealed).toBe('rebuilt-invalid-cache');
    expect(storage.removeCalls).toContain(key);
    expect(client.requests.some((request) => request.event === 'BidRevealed' && request.fromBlock === 1n)).toBe(true);
  });

  it('detects checkpoint hash mismatch and performs the documented full rescan', async () => {
    const client = new FakeClient({ BidRevealed: [bidLog({ blockNumber: 5n })], AuctionReaped: [] });
    const storage = new MemoryStorage();
    await loadVenueBidLogHistory(client, profile(), DAY, storage);
    client.latest = 25n;
    client.blockHashes.set(18n, txFor('9'));
    client.requests.length = 0;
    const result = await loadVenueBidLogHistory(client, profile(), DAY, storage);
    expect(result.cacheStatus.BidRevealed).toBe('rebuilt-after-reorg');
    expect(client.requests.some((request) => request.event === 'BidRevealed' && request.fromBlock === 1n)).toBe(true);
  });

  it('renders current in-memory evidence while refusing to advance storage after a write failure', async () => {
    const client = new FakeClient({ BidRevealed: [bidLog({ blockNumber: 5n })], AuctionReaped: [] });
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const result = await loadVenueBidLogHistory(client, profile(), DAY, storage);
    expect(result.bidReveals).toHaveLength(1);
    expect(result.cacheStatus.BidRevealed).toBe('storage-write-failed');
    expect(storage.values.size).toBe(0);
  });

  it('namespaces route-scoped cursors by WWD as well as deployment and event family', () => {
    const other = '20260805' as WorldwideDayKey;
    expect(venueLogCacheKey(profile(), 'BidRevealed', DAY)).not.toBe(venueLogCacheKey(profile(), 'BidRevealed', other));
  });

  it('escapes the deployment id and lower-cases the contract in the cache key', () => {
    // These two rules were previously missing here while receipt and recovery storage
    // applied them, so the same deployment was namespaced two different ways.
    const key = venueLogCacheKey({ ...profile(), deploymentId: 'bsc:main' }, 'BidRevealed', DAY);
    const [, , version, chainId, deploymentId, contract] = key.split(':');
    expect(version).toBe('v2');
    expect(chainId).toBe('31337');
    expect(deploymentId).toBe('bsc%3Amain');
    expect(contract).toBe(contract?.toLowerCase());
  });

  it('reuses a fresh selected-auction stage for live ladder evidence', async () => {
    const client = new FakeClient({ BidRevealed: [], AuctionReaped: [] });
    client.liveDetails = [
      { result: { auctionClearingRate: 0n } },
      [
        {
          bidderAddress: BIDDER_A,
          intexQuantity: 2,
          intexBidRate: 600_000,
          timestamp: 1_700_000_050n,
        },
      ],
    ];

    const result = await loadVenueDemandEvidence(client, profile(), DAY, new MemoryStorage(), undefined, {
      liveAuction: {
        worldwideDay: DAY,
        stage: 'revealing-bids',
        result: { auctionClearingRate: 700_000n },
      },
    });

    expect(client.readCalls).toEqual(['getAuctionDetails']);
    expect(result.live.stage).toBe('revealing-bids');
    expect(result.live.authoritativeClearingRate).toBe(700_000n);
  });
});

describe('live venue bid reads', () => {
  it('validates the live array and authoritative clearing result', async () => {
    const client = new FakeClient({ BidRevealed: [], AuctionReaped: [] });
    client.liveStage = 3;
    client.liveDetails = [
      { result: { auctionClearingRate: 750_000n } },
      [
        { bidderAddress: BIDDER_A, intexBidRate: 800_000, intexQuantity: 2, timestamp: 1_700_000_005 },
        { bidderAddress: BIDDER_B, intexBidRate: 700_000, intexQuantity: 3, timestamp: 1_700_000_006 },
      ],
    ];
    const result = await readVenueLiveBids(client, profile(), DAY);
    expect(result.stage).toBe('completed');
    expect(result.authoritativeClearingRate).toBe(750_000n);
    expect(result.bids.map((bid) => bid.insertionIndex)).toEqual([0, 1]);
  });
});
