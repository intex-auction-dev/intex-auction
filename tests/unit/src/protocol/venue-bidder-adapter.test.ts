import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { VenueAuctionAdapter } from '@/protocol/venue-adapter';
import type { AuctionReadClient } from '@/protocol/read-client';
import type { VenueDeploymentProfile } from '@/chain/deployment-profile';
import { parseWorldwideDayKey } from '@/domain/protocol-time';

const ADDRESS = (digit: string): Address => `0x${digit.repeat(40)}` as Address;
const AUCTION = ADDRESS('1');
const ESCROW = ADDRESS('2');
const ROUTER = ADDRESS('3');
const NFT = ADDRESS('4');
const TOKEN = ADDRESS('5');
const BIDDER = ADDRESS('6');
const HISTORICAL_ESCROW = ADDRESS('7');
const HISTORICAL_AUCTION = ADDRESS('8');
const HISTORICAL_TOKEN = ADDRESS('9');
const COMMIT_HASH = `0x${'a'.repeat(64)}` as Hex;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const ABI = parseAbi([
  'event BidCommitted(uint32 indexed worldwideDay,address indexed bidder,bytes32 commitHash)',
  'event BidRevealed(uint32 indexed worldwideDay,address indexed bidder,uint16 indexed issuanceCurrency,uint16 quantity,uint32 bidRate)',
  'event CommitCancelled(uint32 indexed worldwideDay,address indexed bidder)',
]) as Abi;
const ESCROW_ABI = parseAbi([
  'event FundsLocked(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event CommitBondReleased(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event FundsRefunded(bytes32 indexed receiveId,uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event ProceedsBurned(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
]) as Abi;
const key = (contract: Address, functionName: string): string => `${contract.toLowerCase()}:${functionName}`;
const parsedDay = parseWorldwideDayKey('20260803');
if (!parsedDay.ok) throw new Error('Invalid test WorldwideDay.');
const DAY = parsedDay.value;

class FakeClient implements AuctionReadClient {
  constructor(private readonly reads: ReadonlyMap<string, unknown>) {}

  async readContract(request: { address: Address; abi: Abi; functionName: string }): Promise<unknown> {
    const lookup = key(request.address, request.functionName);
    if (!this.reads.has(lookup)) throw new Error(`Missing fake read: ${lookup}`);
    return this.reads.get(lookup);
  }

  async getChainId(): Promise<number> {
    return 31337;
  }
  async getBalance(): Promise<bigint> {
    return 0n;
  }
  async getBlockNumber(): Promise<bigint> {
    return 1n;
  }
  async getBlock({ blockNumber }: { blockNumber: bigint }): Promise<unknown> {
    return { number: blockNumber, hash: `0x${'1'.repeat(64)}`, timestamp: 1n };
  }
  async getBytecode(): Promise<Hex | undefined> {
    return '0x6000';
  }
  async getLogs(): Promise<readonly unknown[]> {
    return [];
  }
}

const profile = (): VenueDeploymentProfile => ({
  chainId: 31337,
  addresses: {
    intexAuction: AUCTION,
    escrowAdapter: ESCROW,
    targetRouter: ROUTER,
    intexNFT1155: NFT,
    paymentToken: TOKEN,
  },
  abis: {
    intexAuction: ABI,
    escrowAdapter: ESCROW_ABI,
    targetRouter: [] as Abi,
    intexNFT1155: [] as Abi,
    paymentToken: [] as Abi,
  },
});

const auctionInfo = {
  schedule: { commitEnd: 100n, revealEnd: 200n, issuanceEnd: 300n },
  params: {
    prices: [{ isoCode: 840, entryPriceMinor: 100n, floorPriceMinor: 100n, callPriceMinor: 200n }],
    promisLoadMinor: 1_000n,
    minIntexBidRate: 1,
    minIntexBidQuantity: 1,
    commitBondMinor: 10n,
  },
};

const bidderReads = (bondAmount: bigint = 10n): Map<string, unknown> =>
  new Map<string, unknown>([
    [key(AUCTION, 'getAuctionStage'), 0],
    [key(AUCTION, 'getAuctionInfo'), auctionInfo],
    [key(AUCTION, 'committedBidsByHash'), ZERO_HASH],
    [key(AUCTION, 'revealedBidsByBidder'), false],
    [key(AUCTION, 'escrowContract'), ESCROW],
    [key(ESCROW, 'intexAuctionContract'), AUCTION],
    [key(ESCROW, 'paymentToken'), TOKEN],
    [key(ESCROW, 'getCommitBond'), { amount: bondAmount, lockedAt: 50n }],
    [key(ESCROW, 'getBidLock'), { lockedAmount: 0n, lockedAt: 0n, status: 0, failedRefund: 0n, splitRecorded: false }],
    [key(TOKEN, 'balanceOf'), 100n],
    [key(TOKEN, 'allowance'), 10n],
    [key(TOKEN, 'decimals'), 18],
    [key(TOKEN, 'symbol'), 'wCOEN'],
  ]);

describe('venue bidder adapter', () => {
  it('normalizes only the bidder preflight reads and validates reviewed wiring', async () => {
    const adapter = new VenueAuctionAdapter(new FakeClient(bidderReads()), profile());

    await expect(adapter.readBidderState(DAY, BIDDER)).resolves.toEqual(
      expect.objectContaining({
        stage: 'committing-bids',
        liveCommitHash: ZERO_HASH,
        bidderRevealed: false,
        escrowAdapter: getAddress(ESCROW),
        escrowAuction: getAddress(AUCTION),
        paymentToken: getAddress(TOKEN),
        paymentTokenDecimals: 18,
        paymentTokenSymbol: 'wCOEN',
        balance: 100n,
        allowance: 10n,
        bidderBondAmount: 10n,
        bidderBondLockedAt: 50n,
        bidLock: { lockedAmount: 0n, lockedAt: 0n, status: 'none', failedRefund: 0n, splitRecorded: false },
      }),
    );
  });

  it('rejects bidder tuple fields wider than their Solidity widths', async () => {
    const adapter = new VenueAuctionAdapter(new FakeClient(bidderReads(1n << 128n)), profile());
    await expect(adapter.readBidderState(DAY, BIDDER)).rejects.toThrow('uint128');
  });

  it('builds the reviewed reveal call for multi-issuance-usd-reference', () => {
    const adapter = new VenueAuctionAdapter(new FakeClient(new Map()), profile());
    expect(
      adapter.buildRevealCall({
        worldwideDay: DAY,
        quantity: 2,
        bidRate: 500_000,
        issuanceCurrency: 949,
        referenceCurrency: 840,
        chainId: 31337,
        signature: '0x1234',
      }),
    ).toMatchObject({
      address: AUCTION,
      functionName: 'revealBid',
      args: [20260803, 2, 500_000, 949, 840, 31337, '0x1234'],
    });
  });

  it('keeps historical recovery reads and writes on the explicit escrow epoch', async () => {
    const reads = new Map<string, unknown>([
      [key(HISTORICAL_ESCROW, 'intexAuctionContract'), HISTORICAL_AUCTION],
      [key(HISTORICAL_ESCROW, 'paymentToken'), HISTORICAL_TOKEN],
      [key(HISTORICAL_ESCROW, 'COMMIT_BOND_ABANDON_DELAY'), 10n],
      [key(HISTORICAL_ESCROW, 'UNFINALIZED_REFUND_DELAY'), 20n],
      [key(HISTORICAL_ESCROW, 'POST_FINALIZE_REFUND_DELAY'), 30n],
      [key(HISTORICAL_ESCROW, 'NO_SPLIT_REFUND_DELAY'), 40n],
      [key(HISTORICAL_ESCROW, 'getCommitBond'), [10n, 50n]],
      [key(HISTORICAL_ESCROW, 'getBidLock'), [20n, 60n, 1, 0n, false]],
      [key(HISTORICAL_ESCROW, 'auctionEscrowState'), [20n, 1n, 0n, false]],
      [key(HISTORICAL_TOKEN, 'decimals'), 18],
      [key(HISTORICAL_TOKEN, 'symbol'), 'OLD'],
    ]);
    const adapter = new VenueAuctionAdapter(new FakeClient(reads), profile());

    await expect(adapter.readEscrowRecoveryState(HISTORICAL_ESCROW, DAY, BIDDER)).resolves.toEqual(
      expect.objectContaining({
        auctionContract: getAddress(HISTORICAL_AUCTION),
        paymentToken: getAddress(HISTORICAL_TOKEN),
        paymentTokenSymbol: 'OLD',
        bond: { amount: 10n, lockedAt: 50n },
        bidLock: { lockedAmount: 20n, lockedAt: 60n, status: 'locked', failedRefund: 0n, splitRecorded: false },
      }),
    );
    expect(
      adapter.buildRecoveryCall({
        path: 'escrow-no-split-refund',
        worldwideDay: DAY,
        bidder: BIDDER,
        auctionContract: AUCTION,
        escrowContract: HISTORICAL_ESCROW,
      }),
    ).toMatchObject({ address: HISTORICAL_ESCROW, functionName: 'claimRefund', args: [20260803, BIDDER] });
  });

  it('decodes typed receipt evidence at the adapter boundary', () => {
    const topics = encodeEventTopics({
      abi: ABI,
      eventName: 'BidCommitted',
      args: { worldwideDay: 20260803, bidder: BIDDER },
    });
    const receipt = {
      logs: [
        {
          address: AUCTION,
          topics,
          data: encodeAbiParameters([{ type: 'bytes32' }], [COMMIT_HASH]),
        },
      ],
    } as TransactionReceipt;
    const adapter = new VenueAuctionAdapter(new FakeClient(new Map()), profile());

    expect(
      adapter.readCommitReceiptEvidence(receipt, {
        worldwideDay: DAY,
        bidder: BIDDER,
        commitHash: COMMIT_HASH,
      }),
    ).toEqual({ committed: true });
  });
});
