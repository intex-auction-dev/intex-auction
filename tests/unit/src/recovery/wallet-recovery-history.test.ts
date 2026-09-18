import { describe, expect, it } from 'vitest';
import { getAddress, parseAbi, type Address, type Hex } from 'viem';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { AuctionReadClient } from '@/protocol/read-client';
import { loadWalletRecoveryHistory, type WalletRecoveryHistoryStorage } from '@/recovery/wallet-recovery-history';

const ABI = parseAbi([
  'event BidCommitted(uint32 indexed worldwideDay,address indexed bidder,bytes32 commitHash)',
  'event CommitCancelled(uint32 indexed worldwideDay,address indexed bidder)',
  'event BidRevealed(uint32 indexed worldwideDay,address indexed bidder,uint16 indexed quantity,uint32 bidRate)',
  'event AuctionStageUpdated(uint32 indexed worldwideDay,uint8 stage)',
  'event AuctionClearingExecuted(uint32 indexed worldwideDay,uint32 clearingRate)',
  'event EscrowWired(address indexed previous,address indexed current)',
  'event CommitBondLocked(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event CommitBondReleased(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event FundsLocked(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event FundsRefunded(bytes32 indexed receiveId,uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event ProceedsBurned(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event AuctionEscrowFinalized(bytes32 indexed receiveId,uint32 indexed worldwideDay,uint128 totalRefunded,uint128 totalPaid,uint32 bidsProcessed)',
  'event BidderRefundFailed(bytes32 indexed receiveId,uint32 indexed worldwideDay,address indexed bidder,bytes reason)',
  'event FinalizationNoOp(uint32 indexed worldwideDay,uint32 bidsProcessed)',
  'event Wired(address intexAuctionOld,address intexAuctionNew,address compactOld,address compactNew,address paymentTokenOld,address paymentTokenNew)',
  'function intexAuctionContract() view returns (address)',
  'function paymentToken() view returns (address)',
  'function COMMIT_BOND_ABANDON_DELAY() view returns (uint32)',
  'function UNFINALIZED_REFUND_DELAY() view returns (uint32)',
  'function POST_FINALIZE_REFUND_DELAY() view returns (uint32)',
]);

const AUCTION = '0x1111111111111111111111111111111111111111' as Address;
const ESCROW = '0x2222222222222222222222222222222222222222' as Address;
const OLD_ESCROW = '0x6666666666666666666666666666666666666666' as Address;
const ROUTER = '0x3333333333333333333333333333333333333333' as Address;
const NFT = '0x4444444444444444444444444444444444444444' as Address;
const PAYMENT = '0x5555555555555555555555555555555555555555' as Address;
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const hashFor = (block: bigint, salt = 0): Hex => `0x${(block + BigInt(salt)).toString(16).padStart(64, '0')}` as Hex;
const txFor = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;

const profile = (deploymentId = 'venue-v1'): ResolvedVenueReadProfile => ({
  id: 'venue',
  name: 'Venue',
  deploymentId,
  deploymentBlock: 5n,
  chainId: 31_337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['/rpc'],
  explorerUrl: null,
  confirmationDepth: 2,
  logBatchSize: 3,
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
    escrowAdapter: ABI,
    targetRouter: [],
    intexNFT1155: [],
    paymentToken: [],
  },
});

interface TestLogInput {
  readonly family: string;
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly args: Record<string, unknown>;
  readonly transactionHash?: Hex;
  readonly transactionIndex?: number;
  readonly logIndex?: number;
}

const testLog = (input: TestLogInput): unknown => ({
  args: input.args,
  blockNumber: input.blockNumber,
  blockHash: hashFor(input.blockNumber),
  transactionHash: input.transactionHash ?? txFor((input.logIndex ?? 1).toString(16).slice(-1)),
  transactionIndex: input.transactionIndex ?? 0,
  logIndex: input.logIndex ?? 0,
  removed: false,
});

class MemoryStorage implements WalletRecoveryHistoryStorage {
  readonly values = new Map<string, string>();
  readonly setCalls: string[] = [];
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.setCalls.push(key);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeClient implements AuctionReadClient {
  head = 20n;
  checkpointSalt = 0;
  escrowAuction: Address = AUCTION;
  readonly ranges: Array<{ family: string; address: Address; fromBlock: bigint; toBlock: bigint }> = [];
  readonly logs: TestLogInput[] = [];

  getChainId = async () => 31_337;
  getBalance = async () => 0n;
  getBlockNumber = async () => this.head;
  getBlock = async ({ blockNumber }: { blockNumber: bigint }) => ({
    number: blockNumber,
    hash: hashFor(blockNumber, blockNumber === this.head - 2n ? this.checkpointSalt : 0),
    timestamp: blockNumber * 10n,
  });
  getBytecode = async ({ address }: { address: Address }) =>
    address === ESCROW || address === OLD_ESCROW || address === AUCTION ? ('0x6000' as Hex) : undefined;
  readContract = async (request: { address: Address; functionName: string }) => {
    if (request.functionName === 'intexAuctionContract') return this.escrowAuction;
    if (request.functionName === 'paymentToken') return PAYMENT;
    if (request.functionName === 'COMMIT_BOND_ABANDON_DELAY') return 2_592_000n;
    if (request.functionName === 'UNFINALIZED_REFUND_DELAY') return 259_200n;
    if (request.functionName === 'POST_FINALIZE_REFUND_DELAY') return 259_200n;
    throw new Error(`Unexpected read ${request.functionName}`);
  };
  getLogs = async (request: {
    address: Address;
    event: { name: string };
    args?: Readonly<Record<string, unknown>>;
    fromBlock: bigint;
    toBlock: bigint | 'latest';
  }) => {
    const toBlock = request.toBlock === 'latest' ? this.head : request.toBlock;
    this.ranges.push({ family: request.event.name, address: request.address, fromBlock: request.fromBlock, toBlock });
    return this.logs
      .filter(
        (entry) =>
          entry.family === request.event.name &&
          entry.address === request.address &&
          entry.blockNumber >= request.fromBlock &&
          entry.blockNumber <= toBlock &&
          (request.args?.bidder === undefined || entry.args.bidder === request.args.bidder),
      )
      .map(testLog);
  };
}

const addCurrentWiring = (client: FakeClient) => {
  client.logs.push({
    family: 'EscrowWired',
    address: AUCTION,
    blockNumber: 5n,
    logIndex: 0,
    args: { previous: ZERO, current: ESCROW },
  });
  client.logs.push({
    family: 'Wired',
    address: ESCROW,
    blockNumber: 5n,
    logIndex: 1,
    args: {
      intexAuctionOld: ZERO,
      intexAuctionNew: AUCTION,
      compactOld: ZERO,
      compactNew: ROUTER,
      paymentTokenOld: ZERO,
      paymentTokenNew: PAYMENT,
    },
  });
};

describe('active-wallet recovery history', () => {
  it('starts at deployment, filters the active wallet and orders multiple WWD candidates', async () => {
    const client = new FakeClient();
    const storage = new MemoryStorage();
    addCurrentWiring(client);
    client.logs.push(
      {
        family: 'BidCommitted',
        address: AUCTION,
        blockNumber: 10n,
        logIndex: 2,
        args: { worldwideDay: 20260805, bidder: WALLET, commitHash: txFor('a') },
      },
      {
        family: 'BidCommitted',
        address: AUCTION,
        blockNumber: 8n,
        logIndex: 1,
        args: { worldwideDay: 20260804, bidder: WALLET, commitHash: txFor('b') },
      },
      {
        family: 'BidCommitted',
        address: AUCTION,
        blockNumber: 7n,
        logIndex: 0,
        args: { worldwideDay: 20260803, bidder: OTHER, commitHash: txFor('c') },
      },
      {
        family: 'FundsLocked',
        address: ESCROW,
        blockNumber: 11n,
        logIndex: 0,
        args: { worldwideDay: 20260805, bidder: WALLET, amount: 100n },
      },
    );
    const result = await loadWalletRecoveryHistory({ client, profile: profile(), wallet: WALLET, storage });
    expect(result.candidates).toEqual(['20260804', '20260805']);
    expect(
      result.events.filter((event) => event.bidder !== null).every((event) => event.bidder === getAddress(WALLET)),
    ).toBe(true);
    expect(result.events.map((event) => event.blockNumber)).toEqual(
      [...result.events.map((event) => event.blockNumber)].sort((a, b) => (a < b ? -1 : 1)),
    );
    expect(Math.min(...client.ranges.map((range) => Number(range.fromBlock)))).toBe(5);
    expect(result.cacheStatus).toBe('cold-scan');
  });

  it('tolerates duplicate logs and overlapping resumable pages', async () => {
    const client = new FakeClient();
    const storage = new MemoryStorage();
    addCurrentWiring(client);
    const duplicate = {
      family: 'CommitBondLocked',
      address: ESCROW,
      blockNumber: 12n,
      logIndex: 3,
      transactionHash: txFor('d'),
      args: { worldwideDay: 20260804, bidder: WALLET, amount: 10n },
    } satisfies TestLogInput;
    client.logs.push(duplicate, duplicate);
    const first = await loadWalletRecoveryHistory({ client, profile: profile(), wallet: WALLET, storage });
    expect(first.events.filter((event) => event.family === 'CommitBondLocked')).toHaveLength(1);
    client.head = 24n;
    client.logs.push({
      family: 'CommitBondReleased',
      address: ESCROW,
      blockNumber: 21n,
      logIndex: 0,
      args: { worldwideDay: 20260804, bidder: WALLET, amount: 10n },
    });
    const second = await loadWalletRecoveryHistory({ client, profile: profile(), wallet: WALLET, storage });
    expect(second.cacheStatus).toBe('cache-extended');
    expect(second.events.filter((event) => event.family === 'CommitBondLocked')).toHaveLength(1);
    expect(second.events.some((event) => event.family === 'CommitBondReleased')).toBe(true);
  });

  it('rebuilds malformed storage and a changed block-hash checkpoint', async () => {
    const client = new FakeClient();
    const storage = new MemoryStorage();
    addCurrentWiring(client);
    client.logs.push({
      family: 'BidCommitted',
      address: AUCTION,
      blockNumber: 8n,
      args: { worldwideDay: 20260804, bidder: WALLET, commitHash: txFor('a') },
    });
    await loadWalletRecoveryHistory({ client, profile: profile(), wallet: WALLET, storage });
    const key = [...storage.values.keys()][0]!;
    storage.values.set(key, '{bad json');
    const malformed = await loadWalletRecoveryHistory({ client, profile: profile(), wallet: WALLET, storage });
    expect(malformed.cacheStatus).toBe('rebuilt-invalid-cache');
    client.checkpointSalt = 10;
    const reorg = await loadWalletRecoveryHistory({ client, profile: profile(), wallet: WALLET, storage });
    expect(reorg.cacheStatus).toBe('rebuilt-after-reorg');
  });

  it('isolates wallet and deployment contexts in persistent storage', async () => {
    const client = new FakeClient();
    const storage = new MemoryStorage();
    addCurrentWiring(client);
    client.logs.push(
      {
        family: 'BidCommitted',
        address: AUCTION,
        blockNumber: 8n,
        args: { worldwideDay: 20260804, bidder: WALLET, commitHash: txFor('a') },
      },
      {
        family: 'BidCommitted',
        address: AUCTION,
        blockNumber: 9n,
        args: { worldwideDay: 20260805, bidder: OTHER, commitHash: txFor('b') },
      },
    );
    const active = await loadWalletRecoveryHistory({ client, profile: profile('one'), wallet: WALLET, storage });
    const inactive = await loadWalletRecoveryHistory({ client, profile: profile('two'), wallet: OTHER, storage });
    expect(active.candidates).toEqual(['20260804']);
    expect(inactive.candidates).toEqual(['20260805']);
    expect(storage.values.size).toBe(2);
  });

  it('retains a compatible historical escrow after current wiring rotation', async () => {
    const client = new FakeClient();
    const storage = new MemoryStorage();
    client.logs.push(
      {
        family: 'EscrowWired',
        address: AUCTION,
        blockNumber: 5n,
        logIndex: 0,
        args: { previous: ZERO, current: OLD_ESCROW },
      },
      {
        family: 'Wired',
        address: OLD_ESCROW,
        blockNumber: 5n,
        logIndex: 1,
        args: {
          intexAuctionOld: ZERO,
          intexAuctionNew: AUCTION,
          compactOld: ZERO,
          compactNew: ROUTER,
          paymentTokenOld: ZERO,
          paymentTokenNew: PAYMENT,
        },
      },
      {
        family: 'CommitBondLocked',
        address: OLD_ESCROW,
        blockNumber: 7n,
        logIndex: 0,
        args: { worldwideDay: 20260804, bidder: WALLET, amount: 50n },
      },
      {
        family: 'EscrowWired',
        address: AUCTION,
        blockNumber: 10n,
        logIndex: 0,
        args: { previous: OLD_ESCROW, current: ESCROW },
      },
      {
        family: 'Wired',
        address: ESCROW,
        blockNumber: 10n,
        logIndex: 1,
        args: {
          intexAuctionOld: ZERO,
          intexAuctionNew: AUCTION,
          compactOld: ZERO,
          compactNew: ROUTER,
          paymentTokenOld: ZERO,
          paymentTokenNew: PAYMENT,
        },
      },
    );
    const result = await loadWalletRecoveryHistory({ client, profile: profile(), wallet: WALLET, storage });
    expect(result.escrows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ escrowContract: OLD_ESCROW, custody: 'historical', compatible: true }),
        expect.objectContaining({ escrowContract: ESCROW, custody: 'current', compatible: true }),
      ]),
    );
    expect(result.wiringEpochs.some((epoch) => epoch.escrowContract === OLD_ESCROW)).toBe(true);
    expect(result.candidates).toEqual(['20260804']);
  });

  it('treats a same-address escrow as historical after its auction authority rotates', async () => {
    const client = new FakeClient();
    const storage = new MemoryStorage();
    client.escrowAuction = ROUTER;
    client.logs.push(
      {
        family: 'EscrowWired',
        address: AUCTION,
        blockNumber: 5n,
        logIndex: 0,
        args: { previous: ZERO, current: ESCROW },
      },
      {
        family: 'Wired',
        address: ESCROW,
        blockNumber: 5n,
        logIndex: 1,
        args: {
          intexAuctionOld: ZERO,
          intexAuctionNew: AUCTION,
          compactOld: ZERO,
          compactNew: ROUTER,
          paymentTokenOld: ZERO,
          paymentTokenNew: PAYMENT,
        },
      },
      {
        family: 'CommitBondLocked',
        address: ESCROW,
        blockNumber: 7n,
        logIndex: 0,
        args: { worldwideDay: 20260804, bidder: WALLET, amount: 50n },
      },
      {
        family: 'Wired',
        address: ESCROW,
        blockNumber: 10n,
        logIndex: 1,
        transactionHash: txFor('e'),
        args: {
          intexAuctionOld: AUCTION,
          intexAuctionNew: ROUTER,
          compactOld: ROUTER,
          compactNew: ROUTER,
          paymentTokenOld: PAYMENT,
          paymentTokenNew: PAYMENT,
        },
      },
    );
    const result = await loadWalletRecoveryHistory({ client, profile: profile(), wallet: WALLET, storage });
    expect(result.escrows).toContainEqual(
      expect.objectContaining({
        escrowContract: ESCROW,
        associatedAuction: AUCTION,
        custody: 'historical',
        compatible: true,
      }),
    );
  });
});
