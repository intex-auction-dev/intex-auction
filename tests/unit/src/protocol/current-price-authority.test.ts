import { describe, expect, it } from 'vitest';
import type { Abi, Address, Hex } from 'viem';
import { VenueAuctionAdapter } from '@/protocol/venue-adapter';
import type { AuctionReadClient } from '@/protocol/read-client';
import type { VenueDeploymentProfile } from '@/chain/deployment-profile';
import { parseWorldwideDayKey } from '@/domain/protocol-time';

const ABI = [] as Abi;
const address = (digit: string): Address => `0x${digit.repeat(40)}` as Address;
const AUCTION = address('1');
const ESCROW = address('2');
const TARGET_ROUTER = address('3');
const NFT = address('4');
const PAYMENT = address('5');
const BIDDER = address('6');
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const key = (contract: Address, functionName: string): string => `${contract.toLowerCase()}:${functionName}`;

class FakeClient implements AuctionReadClient {
  constructor(private readonly reads: ReadonlyMap<string, unknown>) {}

  async readContract(request: { address: Address; functionName: string }): Promise<unknown> {
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
  async getBlock(): Promise<unknown> {
    return { number: 1n, timestamp: 1n };
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
    targetRouter: TARGET_ROUTER,
    intexNFT1155: NFT,
    paymentToken: PAYMENT,
  },
  abis: {
    intexAuction: ABI,
    escrowAdapter: ABI,
    targetRouter: ABI,
    intexNFT1155: ABI,
    paymentToken: ABI,
  },
});

const worldwideDay = () => {
  const parsed = parseWorldwideDayKey('20260825');
  if (!parsed.ok) throw new Error('Test WorldwideDay is invalid.');
  return parsed.value;
};

const auctionInfo = {
  worldwideDayState: 1,
  schedule: { commitEnd: 1_000n, revealEnd: 2_000n, issuanceEnd: 3_000n },
  params: {
    prices: [
      { isoCode: 949, entryPriceMinor: 949n, floorPriceMinor: 900n, callPriceMinor: 1_000n },
      { isoCode: 840, entryPriceMinor: 840n, floorPriceMinor: 800n, callPriceMinor: 900n },
    ],
    issuanceCurrencies: [949],
    issuanceEntryPrices: [9_490n],
    strikeAmountsMinor: [8_490n],
    oraclePairIds: [949],
    referenceCurrency: 949,
    entryPriceMinor: 9_490n,
    floorPriceMinor: 9_000n,
    callPriceMinor: 10_000n,
    promisLoadMinor: 1_000n,
    minIntexBidRate: 500_000,
    minIntexBidQuantity: 2,
    commitBondMinor: 10n,
    callTrigger: { callWindow: 2_592_000n, callThreshold: 1_814_400n, callNoticePeriod: 604_800n },
  },
  result: {
    auctionClearingRate: 0n,
    wonBidsCount: 0,
    issuedIntexCount: 0,
    issuedIntexLoadedPromis: 0n,
  },
};

describe('current AuctionParams price authority', () => {
  it('keeps reference-price rows out of public issuance authority', async () => {
    const client = new FakeClient(
      new Map<string, unknown>([
        [key(AUCTION, 'getAuctionStage'), 0],
        [key(AUCTION, 'getAuctionInfo'), auctionInfo],
        [key(AUCTION, 'auctionRunningCounts'), [0, 0]],
      ]),
    );

    const snapshot = await new VenueAuctionAdapter(client, profile()).readAuction(worldwideDay());

    expect(snapshot.params).toMatchObject({
      referenceCurrency: 840,
      entryPriceMinor: 840n,
      floorPriceMinor: 800n,
      callPriceMinor: 900n,
      issuanceCurrency: 0,
      issuanceCurrencies: [],
    });
    expect(snapshot.params.issuanceEntryPrices).toBeUndefined();
    expect(snapshot.params.strikeAmountsMinor).toBeUndefined();
    expect(snapshot.params.oraclePairIds).toBeUndefined();
  });

  it('keeps reference-price rows and v2 leftovers out of bidder issuance authority', async () => {
    const client = new FakeClient(
      new Map<string, unknown>([
        [key(AUCTION, 'getAuctionStage'), 0],
        [key(AUCTION, 'getAuctionInfo'), auctionInfo],
        [key(AUCTION, 'committedBidsByHash'), ZERO_HASH],
        [key(AUCTION, 'revealedBidsByBidder'), false],
        [key(AUCTION, 'escrowContract'), ESCROW],
        [key(ESCROW, 'intexAuctionContract'), AUCTION],
        [key(ESCROW, 'paymentToken'), PAYMENT],
        [key(ESCROW, 'getCommitBond'), [0n, 0n]],
        [key(ESCROW, 'getBidLock'), [0n, 0n, 0, 0n, false]],
        [key(PAYMENT, 'decimals'), 18],
        [key(PAYMENT, 'symbol'), 'wCOEN'],
        [key(PAYMENT, 'balanceOf'), 1_000n],
        [key(PAYMENT, 'allowance'), 1_000n],
      ]),
    );

    const state = await new VenueAuctionAdapter(client, profile()).readBidderState(worldwideDay(), BIDDER);

    expect(state.params).toMatchObject({
      referenceCurrency: 840,
      entryPriceMinor: 840n,
      floorPriceMinor: 800n,
      callPriceMinor: 900n,
      issuanceCurrencies: [],
      issuanceEntryPrices: [],
      strikeAmountsMinor: [],
      oraclePairIds: [],
    });
  });
});
