import { describe, expect, it } from 'vitest';
import type { Address, Hash, Hex, PublicClient, TransactionReceipt } from 'viem';
import { parseWorldwideDayKey } from '@/domain/protocol-time';
import { RECEIPT_STORAGE_PREFIX } from '@/receipts/receipt-store';
import { MemoryStorage, TEST_ACCOUNT, TEST_AUCTION, TEST_TIME } from '../receipts/test-fixtures';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import { executeCommitTransaction, readFreshCommitState, type CommitWalletClient } from '@/bidding/commit-transaction';

const ESCROW = '0x000000000000000000000000000000000000eC01' as Address;
const TOKEN = '0x0000000000000000000000000000000000007001' as Address;
const ROUTER = '0x0000000000000000000000000000000000007002' as Address;
const NFT = '0x0000000000000000000000000000000000007003' as Address;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const TX_HASH = `0x${'b'.repeat(64)}` as Hash;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hash;
const parsed = parseWorldwideDayKey('20260804');
if (!parsed.ok) throw new Error('Invalid test WorldwideDay.');

const profile: ResolvedVenueReadProfile = {
  id: 'venue',
  name: 'Venue',
  deploymentId: 'venue-upstream',
  deploymentBlock: 1n,
  chainId: 31337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['http://127.0.0.1:8545'],
  explorerUrl: null,
  confirmationDepth: 1,
  logBatchSize: 100,
  requestTimeoutMs: 1_000,
  readRetryCount: 0,
  adapterProfile: 'multi-issuance-usd-reference',
  addresses: {
    intexAuction: TEST_AUCTION,
    escrowAdapter: ESCROW,
    targetRouter: ROUTER,
    intexNFT1155: NFT,
    paymentToken: TOKEN,
  },
  abis: {
    intexAuction: [],
    escrowAdapter: [],
    targetRouter: [],
    intexNFT1155: [],
    paymentToken: [],
  },
};

interface PriceRow {
  readonly isoCode: number;
  readonly entryPriceMinor: bigint;
  readonly floorPriceMinor: bigint;
  readonly callPriceMinor: bigint;
}

class FakeChain {
  liveCommit = ZERO_HASH;
  allowance: bigint;
  readonly bond: bigint;
  readonly prices: readonly PriceRow[];
  readonly simulations: string[] = [];
  readonly writes: string[] = [];
  signatures = 0;

  constructor(input: { readonly prices: readonly PriceRow[]; readonly bond?: bigint; readonly allowance?: bigint }) {
    this.prices = input.prices;
    this.bond = input.bond ?? 0n;
    this.allowance = input.allowance ?? 100n;
  }

  client(): PublicClient {
    return {
      readContract: async (request: { functionName: string }) => {
        switch (request.functionName) {
          // commitBid is whitelist-gated via requireWhitelisted(_s().whitelist, msg.sender)
          // (IntexAuction.sol:298). The pre-commit preflight reads whitelist() first; a ZERO
          // registry leaves the gate open (Whitelist.sol:16-20 requireWhitelisted), so the
          // preflight short-circuits and never reads isWhitelisted. Returning the zero address
          // keeps these tests exercising issuance-currency authority, not whitelist behaviour.
          case 'whitelist':
            return ZERO_ADDRESS;
          case 'getAuctionStage':
            return 0;
          case 'getAuctionInfo':
            return {
              schedule: { commitEnd: 2_000_000_000n, revealEnd: 2_000_003_600n, issuanceEnd: 2_000_007_200n },
              params: {
                promisLoadMinor: 1_000n,
                minIntexBidRate: 500_000,
                minIntexBidQuantity: 1,
                commitBondMinor: this.bond,
                prices: this.prices,
              },
            };
          case 'committedBidsByHash':
            return this.liveCommit;
          case 'revealedBidsByBidder':
            return false;
          case 'escrowContract':
            return ESCROW;
          case 'intexAuctionContract':
            return TEST_AUCTION;
          case 'paymentToken':
            return TOKEN;
          case 'getCommitBond':
            return { amount: this.liveCommit === ZERO_HASH ? 0n : this.bond, lockedAt: 0n };
          case 'getBidLock':
            return { lockedAmount: 0n, lockedAt: 0n, status: 0, failedRefund: 0n, splitRecorded: false };
          case 'balanceOf':
            return 100n;
          case 'allowance':
            return this.allowance;
          case 'decimals':
            return 18;
          case 'symbol':
            return 'wCOEN';
          default:
            throw new Error(`Unexpected read ${request.functionName}`);
        }
      },
      simulateContract: async (request: { functionName: string }) => {
        this.simulations.push(request.functionName);
        return { request };
      },
      estimateContractGas: async () => 100_000n,
      waitForTransactionReceipt: async () =>
        ({
          status: 'success',
          transactionHash: TX_HASH,
          logs: [],
        }) as unknown as TransactionReceipt,
    } as unknown as PublicClient;
  }

  wallet(): CommitWalletClient {
    return {
      signTypedData: async (request) => {
        this.signatures += 1;
        return TEST_ACCOUNT.signTypedData(request as Parameters<typeof TEST_ACCOUNT.signTypedData>[0]) as Promise<Hex>;
      },
      writeContract: async (request) => {
        const call = request as { functionName: string; args: readonly unknown[] };
        this.writes.push(call.functionName);
        if (call.functionName === 'approve') this.allowance = call.args[1] as bigint;
        if (call.functionName === 'commitBid') this.liveCommit = call.args[1] as Hash;
        return TX_HASH;
      },
    };
  }
}

const USD = {
  isoCode: 840,
  entryPriceMinor: 1_000_000_000_000_000_000n,
  floorPriceMinor: 900_000_000_000_000_000n,
  callPriceMinor: 2_000_000_000_000_000_000n,
} as const;
const INVALID_1000 = {
  isoCode: 1_000,
  entryPriceMinor: 2_000_000_000_000_000_000n,
  floorPriceMinor: 2_000_000_000_000_000_000n,
  callPriceMinor: 2_000_000_000_000_000_000n,
} as const;

const execute = (
  chain: FakeChain,
  input: {
    readonly issuanceCurrency: number;
    readonly transactionKind?: 'commit' | 'recommit';
    readonly storage?: MemoryStorage;
  },
) => {
  const storage = input.storage ?? new MemoryStorage();
  return {
    storage,
    result: executeCommitTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile,
      context: {
        token: 'context',
        chainId: profile.chainId,
        deploymentId: profile.deploymentId,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: parsed.value,
      },
      storage,
      quantity: '2',
      bidRatePercent: '50',
      issuanceCurrency: input.issuanceCurrency,
      isContextCurrent: () => true,
      now: () => TEST_TIME,
      ...(input.transactionKind === undefined ? {} : { transactionKind: input.transactionKind }),
    }),
  };
};

const receiptKeys = (storage: MemoryStorage): string[] =>
  [...storage.data.keys()].filter((key) => key.startsWith(RECEIPT_STORAGE_PREFIX));

describe('upstream auction authority boundary', () => {
  it('keeps reference-price rows out of issuance economics while exposing the contract-valid issuance range for commit preparation', async () => {
    const chain = new FakeChain({ prices: [USD] });
    const fresh = await readFreshCommitState({
      publicClient: chain.client(),
      profile,
      bidder: TEST_ACCOUNT.address,
      worldwideDay: parsed.value,
    });

    expect(fresh.params.referenceCurrency).toBe(840);
    expect(fresh.params.entryPriceMinor).toBe(USD.entryPriceMinor);
    expect(fresh.params.issuanceCurrencies).toHaveLength(999);
    expect(fresh.params.issuanceCurrencies[0]).toBe(1);
    expect(fresh.params.issuanceCurrencies[998]).toBe(999);
    expect(fresh.params.issuanceEntryPrices).toEqual([]);
    expect(fresh.params.strikeAmountsMinor).toEqual([]);
    expect(fresh.params.oraclePairIds).toEqual([]);
  });

  it.each(['commit', 'recommit'] as const)(
    'rejects issuanceCurrency 1000 before any %s signature, canonical receipt, approval or write',
    async (transactionKind) => {
      const chain = new FakeChain({ prices: [USD, INVALID_1000], bond: 10n, allowance: 0n });
      const { result, storage } = execute(chain, { issuanceCurrency: 1_000, transactionKind });

      await expect(result).rejects.toThrow('Issuance currency');
      expect(chain.signatures).toBe(0);
      expect(receiptKeys(storage)).toEqual([]);
      expect(chain.simulations).toEqual([]);
      expect(chain.writes).toEqual([]);
    },
  );

  it('commits a valid bidder-declared issuance currency absent from reference-price rows and keeps referenceCurrency priced', async () => {
    const chain = new FakeChain({ prices: [USD] });
    const { result } = execute(chain, { issuanceCurrency: 392 });
    const completed = await result;

    expect(completed.material.issuanceCurrency).toBe(392);
    expect(completed.material.referenceCurrency).toBe(840);
    expect(completed.reconciliation).toBe('confirmed');
    expect(chain.signatures).toBe(1);
    expect(chain.writes).toEqual(['commitBid']);
  });
});
