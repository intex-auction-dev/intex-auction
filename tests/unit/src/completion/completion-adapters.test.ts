import { describe, expect, it } from 'vitest';
import { parseAbi, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { PAYMENT_TOKEN_DECIMALS } from '@/domain/protocol-constants';
import { CompletionVenueAdapter, type CompletionVenueProfile } from '@/completion/completion-adapters';
import type { AuctionReadClient } from '@/protocol/read-client';
import { parseWorldwideDayKey } from '@/domain/protocol-time';

const address = (digit: string): Address => `0x${digit.repeat(40)}` as Address;
const NFT = address('1');
const ROUTER = address('2');
const ESCROW = address('3');
const AUCTION = address('4');
const PAYMENT = address('5');

const nftAbi = parseAbi([
  'function seriesIdsByWorldwideDay(uint32) view returns (uint32[])',
  'function readData(uint32) view returns ((uint16 issuanceCurrency,uint16 referenceCurrency,uint32 issuedIntexCount,uint128 promisLoadMinor,uint64 entryPriceMinor,uint64 floorPriceMinor,uint64 callPriceMinor,(uint16 windowDays,uint16 thresholdDays,uint32 intexCallPeriod) callTrigger,uint32 issuedAt,uint32 calledAt,uint32 totalSupply,uint8 status,uint8 state,uint32 worldwideDay))',
  'function tokenIds(uint32) pure returns (uint256 issued,uint256 settled)',
  'function getSeriesPaginated(uint256,uint256) view returns (uint256[] series,uint256 total)',
  'function balanceOfBatch(address[],uint256[]) view returns (uint256[])',
  'function ownerBalances(uint32,address) view returns ((uint32 issued,uint32 settled))',
  'event IntexIssued(address indexed operator,uint256 indexed tokenId,address indexed to,uint256 quantity)',
]);
const routerAbi = parseAbi([
  'event IssuanceInstructionsReceived(uint32 indexed srcChainId,uint32 indexed seriesId,uint256 recipientsCount)',
  'event IssuanceParked(uint256 indexed idx,uint32 indexed seriesId,address indexed recipient,bytes reason)',
  'event ParkedIssuanceApplied(uint256 indexed idx,uint32 indexed seriesId)',
]);
const escrowAbi = parseAbi([
  'function getBidLock(uint32,address) view returns ((uint128 lockedAmount,uint32 lockedAt,uint8 status,uint128 failedRefund,bool splitRecorded))',
  'event FundsRefunded(bytes32 indexed receiveId,uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event ProceedsBurned(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
]);
const auctionAbi = parseAbi([
  'event BidRevealed(uint32 indexed worldwideDay,address indexed bidder,uint16 indexed quantity,uint32 bidRate,uint16 issuanceCurrency,uint16 referenceCurrency)',
]);

const profile = (): CompletionVenueProfile => ({
  chainId: 31337,
  deploymentBlock: 1n,
  logBatchSize: 100,
  addresses: {
    intexAuction: AUCTION,
    escrowAdapter: ESCROW,
    targetRouter: ROUTER,
    intexNFT1155: NFT,
    paymentToken: PAYMENT,
  },
  abis: {
    intexAuction: auctionAbi,
    escrowAdapter: escrowAbi,
    targetRouter: routerAbi,
    intexNFT1155: nftAbi,
    paymentToken: [] as Abi,
  },
});

const day = () => {
  const result = parseWorldwideDayKey('20260804');
  if (!result.ok) throw new Error('bad day');
  return result.value;
};

class FakeClient implements AuctionReadClient {
  constructor(
    private readonly read: (name: string, args: readonly unknown[]) => unknown,
    private readonly logs: (event: string, args?: Readonly<Record<string, unknown>>) => readonly unknown[] = () => [],
  ) {}
  async readContract(request: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown> {
    return this.read(request.functionName, request.args ?? []);
  }
  async getChainId(): Promise<number> {
    return 31337;
  }
  async getBalance(): Promise<bigint> {
    return 0n;
  }
  async getBlockNumber(): Promise<bigint> {
    return 10n;
  }
  async getBlock({ blockNumber }: { blockNumber: bigint }): Promise<unknown> {
    return { number: blockNumber, timestamp: 121n };
  }
  async getBytecode(): Promise<Hex | undefined> {
    return '0x6000';
  }
  async getLogs(request: {
    address: Address;
    event: AbiEvent;
    args?: Readonly<Record<string, unknown>>;
    fromBlock: bigint;
    toBlock: bigint | 'latest';
  }): Promise<readonly unknown[]> {
    return this.logs(request.event.name, request.args);
  }
}

const seriesData = (seriesId: number, state = 0) => ({
  issuanceCurrency: 840,
  referenceCurrency: 840,
  issuedIntexCount: 10,
  promisLoadMinor: 1_000n,
  entryPriceMinor: 10n,
  floorPriceMinor: 11n,
  callPriceMinor: 22n,
  callTrigger: { callWindow: 30n, callThreshold: 21n, callNoticePeriod: 20n },
  issuedAt: 1n,
  calledAt: state === 2 ? 100n : 0n,
  totalSupply: 10,
  status: 0,
  state,
  worldwideDay: 20260804,
  seriesId: `0x${seriesId.toString(16).padStart(28, '0')}`,
});

const sid = (value: number): Hex => `0x${value.toString(16).padStart(28, '0')}`;
const fromSid = (value: unknown): number => Number(BigInt(value as string));

describe('Phase 10 venue adapter', () => {
  it('reads the payment token decimals and symbol from the venue profile', async () => {
    const adapter = new CompletionVenueAdapter(
      new FakeClient((name) => {
        if (name === 'decimals') return 6n;
        if (name === 'symbol') return 'USDC';
        throw new Error(name);
      }),
      profile(),
    );
    await expect(adapter.readPaymentToken()).resolves.toEqual({ decimals: 6, symbol: 'USDC' });
  });

  it('falls back to wCOEN when the payment token symbol is empty', async () => {
    const adapter = new CompletionVenueAdapter(
      new FakeClient((name) => {
        if (name === 'decimals') return 18n;
        if (name === 'symbol') return '';
        throw new Error(name);
      }),
      profile(),
    );
    await expect(adapter.readPaymentToken()).resolves.toEqual({ decimals: PAYMENT_TOKEN_DECIMALS, symbol: 'wCOEN' });
  });

  it('reads one-to-many target series and strict lifecycle expiry inputs', async () => {
    const adapter = new CompletionVenueAdapter(
      new FakeClient((name, args) => {
        if (name === 'seriesIdsByWorldwideDay') return [sid(7), sid(9)];
        if (name === 'readData') return seriesData(fromSid(args[0]), fromSid(args[0]) === 9 ? 2 : 1);
        if (name === 'tokenIds') return [BigInt(fromSid(args[0])), 1_000n + BigInt(fromSid(args[0]))];
        throw new Error(name);
      }),
      profile(),
    );
    await expect(adapter.readSeriesIdsByWorldwideDay(day())).resolves.toEqual([sid(7), sid(9)]);
    await expect(adapter.readTargetSeries(sid(9))).resolves.toMatchObject({
      seriesId: sid(9),
      worldwideDay: 20260804,
      lifecycle: 'called',
      calledAt: 100n,
      intexCallPeriod: 20n,
      issuedTokenId: 9n,
      settledTokenId: 1009n,
    });
    await expect(adapter.readLatestBlockTimestamp()).resolves.toBe(121n);
  });

  it('maps hashed settled token ids through paginated canonical target series enumeration', async () => {
    const wallet = address('a');
    const held = new Map<bigint, bigint>([
      [1007n, 3n],
      [9n, 2n],
    ]);
    const adapter = new CompletionVenueAdapter(
      new FakeClient((name, args) => {
        const offset = Number(args[0]);
        if (name === 'getSeriesPaginated') return offset === 0 ? [[7n], 2n] : [[9n], 2n];
        if (name === 'readData') return seriesData(fromSid(args[0]));
        if (name === 'tokenIds') return [BigInt(fromSid(args[0])), 1_000n + BigInt(fromSid(args[0]))];
        if (name === 'balanceOfBatch') {
          const ids = args[1] as readonly bigint[];
          return ids.map((id) => held.get(id) ?? 0n);
        }
        throw new Error(name);
      }),
      profile(),
    );
    await expect(adapter.readPortfolio(wallet, 1)).resolves.toMatchObject([
      { seriesId: sid(7), tokenId: 1007n, tokenStatus: 'settled', balance: 3n },
      { seriesId: sid(9), tokenId: 9n, tokenStatus: 'issued', balance: 2n },
    ]);
  });

  it('throws when balanceOfBatch returns a mismatched balance count', async () => {
    const adapter = new CompletionVenueAdapter(
      new FakeClient((name) => {
        if (name === 'getSeriesPaginated') return [[7n], 1n];
        if (name === 'readData') return seriesData(7);
        if (name === 'tokenIds') return [7n, 1007n];
        if (name === 'balanceOfBatch') return [1n];
        throw new Error(name);
      }),
      profile(),
    );
    await expect(adapter.readPortfolio(address('a'), 10)).rejects.toThrow('mismatched balance count');
  });

  it('derives won-count and delivery from IntexIssued logs and ownerBalances without getAuctionWonCount', async () => {
    const wallet = address('a');
    let sawWonCount = false;
    const adapter = new CompletionVenueAdapter(
      new FakeClient(
        (name) => {
          if (name === 'getAuctionWonCount') {
            sawWonCount = true;
            throw new Error('getAuctionWonCount must not be called');
          }
          if (name === 'ownerBalances') return [1n, 0n];
          if (name === 'tokenIds') return [7n, 1007n];
          throw new Error(name);
        },
        (event) => {
          if (event === 'IssuanceInstructionsReceived') return [{ args: { seriesId: 7n } }];
          if (event === 'IntexIssued') return [{ args: { operator: wallet, tokenId: 7n, to: wallet, quantity: 1n } }];
          return [];
        },
      ),
      profile(),
    );
    await expect(adapter.readRecipientEvidence(sid(7), wallet)).resolves.toEqual({
      seriesId: sid(7),
      issuanceInstructionsReceived: true,
      deferred: false,
      deliveredEvent: true,
      wonCount: 1n,
      currentIssuedBalance: 1n,
      currentSettledBalance: 0n,
    });
    expect(sawWonCount).toBe(false);
  });

  it('detects a parked issuance from the renamed IssuanceParked event when it is not applied', async () => {
    const wallet = address('a');
    const adapter = new CompletionVenueAdapter(
      new FakeClient(
        (name) => {
          if (name === 'ownerBalances') return [0n, 0n];
          if (name === 'tokenIds') return [7n, 1007n];
          throw new Error(name);
        },
        (event) => {
          if (event === 'IssuanceInstructionsReceived') return [{ args: { seriesId: 7n } }];
          if (event === 'IssuanceParked') return [{ args: { idx: 4n, seriesId: 7n, recipient: wallet } }];
          if (event === 'ParkedIssuanceApplied') return [];
          if (event === 'IntexIssued') return [];
          return [];
        },
      ),
      profile(),
    );
    await expect(adapter.readRecipientEvidence(sid(7), wallet)).resolves.toEqual({
      seriesId: sid(7),
      issuanceInstructionsReceived: true,
      deferred: true,
      deliveredEvent: false,
      wonCount: 0n,
      currentIssuedBalance: 0n,
      currentSettledBalance: 0n,
    });
  });

  it('reconciles a parked issuance as delivered once the same index is applied', async () => {
    const wallet = address('a');
    const adapter = new CompletionVenueAdapter(
      new FakeClient(
        (name) => {
          if (name === 'ownerBalances') return [2n, 0n];
          if (name === 'tokenIds') return [7n, 1007n];
          throw new Error(name);
        },
        (event) => {
          if (event === 'IssuanceInstructionsReceived') return [{ args: { seriesId: 7n } }];
          if (event === 'IssuanceParked') return [{ args: { idx: 4n, seriesId: 7n, recipient: wallet } }];
          if (event === 'ParkedIssuanceApplied') return [{ args: { idx: 4n, seriesId: 7n } }];
          if (event === 'IntexIssued') return [{ args: { operator: wallet, tokenId: 7n, to: wallet, quantity: 2n } }];
          return [];
        },
      ),
      profile(),
    );
    await expect(adapter.readRecipientEvidence(sid(7), wallet)).resolves.toEqual({
      seriesId: sid(7),
      issuanceInstructionsReceived: true,
      deferred: false,
      deliveredEvent: true,
      wonCount: 2n,
      currentIssuedBalance: 2n,
      currentSettledBalance: 0n,
    });
  });

  it('reads the bidder original terms from the chronologically-last BidRevealed log', async () => {
    const wallet = address('a');
    const adapter = new CompletionVenueAdapter(
      new FakeClient(
        () => {
          throw new Error('no read');
        },
        (event) => {
          if (event !== 'BidRevealed') return [];
          return [
            {
              args: { worldwideDay: 20260804, bidder: wallet, quantity: 3, bidRate: 700_000n },
              blockNumber: 4n,
              transactionIndex: 0,
              logIndex: 1,
            },
            {
              args: { worldwideDay: 20260804, bidder: wallet, quantity: 2, bidRate: 550_000n },
              blockNumber: 2n,
              transactionIndex: 1,
              logIndex: 0,
            },
          ];
        },
      ),
      profile(),
    );
    await expect(adapter.readBidderRevealedBid(day(), wallet)).resolves.toEqual({ quantity: 3n, bidRate: 700_000n });
  });

  it('returns null when the bidder emitted no BidRevealed log', async () => {
    const adapter = new CompletionVenueAdapter(
      new FakeClient(
        () => {
          throw new Error('no read');
        },
        () => [],
      ),
      profile(),
    );
    await expect(adapter.readBidderRevealedBid(day(), address('a'))).resolves.toBeNull();
  });

  it('rejects a BidRevealed rate outside the reviewed 1e6 scale rather than surfacing it', async () => {
    const wallet = address('a');
    const adapter = new CompletionVenueAdapter(
      new FakeClient(
        () => {
          throw new Error('no read');
        },
        (event) =>
          event === 'BidRevealed'
            ? [
                {
                  args: { worldwideDay: 20260804, bidder: wallet, quantity: 3, bidRate: 1_000_001n },
                  blockNumber: 2n,
                  transactionIndex: 0,
                  logIndex: 0,
                },
              ]
            : [],
      ),
      profile(),
    );
    await expect(adapter.readBidderRevealedBid(day(), wallet)).rejects.toThrow('1e6 scale');
  });
});
