import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { parseWorldwideDayKey } from '@/domain/protocol-time';
import { persistRevealMaterial } from '@/receipts/receipt-store';
import { listTransactionAttempts } from '@/receipts/receipt-store';
import { createTestMaterial, MemoryStorage, TEST_ACCOUNT, TEST_AUCTION } from '../receipts/test-fixtures';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import { executeRecommitTransaction, type CommitWalletClient } from '@/bidding/commit-transaction';
import {
  executeCancelCommitTransaction,
  executeRevealBidTransaction,
  selectLiveRevealMaterial,
  type BidderActionWalletClient,
} from '@/bidding/cancel-reveal-transaction';

const NATIVE_UNITS_PER_PROTOCOL_UNIT = 1_000_000_000_000n; // 1e12

const ESCROW = '0x000000000000000000000000000000000000eC01' as Address;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN = '0x0000000000000000000000000000000000007001' as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hash;
const APPROVAL_HASH = `0x${'a'.repeat(64)}` as Hash;
const ACTION_HASH = `0x${'b'.repeat(64)}` as Hash;
const REPLACEMENT_HASH = `0x${'c'.repeat(64)}` as Hash;
const parsedWwd = parseWorldwideDayKey('20260804');
if (!parsedWwd.ok) throw new Error(`Invalid WorldwideDay: ${parsedWwd.reason}`);
const WWD = parsedWwd.value;

const intexAbi = parseAbi([
  'event CommitCancelled(uint32 indexed worldwideDay,address indexed bidder)',
  'event BidRevealed(uint32 indexed worldwideDay,address indexed bidder,uint16 indexed issuanceCurrency,uint16 quantity,uint32 bidRate)',
]);
const escrowAbi = parseAbi([
  'event CommitBondReleased(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event FundsLocked(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
]);

const profile = (): ResolvedVenueReadProfile => ({
  id: 'local-anvil',
  name: 'Local Anvil',
  deploymentId: 'venue-v1',
  chainId: 31_337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['http://127.0.0.1:8545'],
  explorerUrl: null,
  confirmationDepth: 1,
  addresses: {
    intexAuction: TEST_AUCTION,
    escrowAdapter: ESCROW,
    targetRouter: '0x0000000000000000000000000000000000001001',
    intexNFT1155: '0x0000000000000000000000000000000000001002',
    paymentToken: TOKEN,
  },
  deploymentBlock: 1n,
  logBatchSize: 1_000,
  requestTimeoutMs: 10_000,
  readRetryCount: 0,
  abis: { intexAuction: intexAbi, escrowAdapter: escrowAbi, targetRouter: [], intexNFT1155: [], paymentToken: [] },
});

const eventLog = (input: {
  address: Address;
  abi: typeof intexAbi | typeof escrowAbi;
  eventName: string;
  args: Record<string, unknown>;
  dataTypes?: readonly { readonly type: string }[];
  dataValues?: readonly unknown[];
}) => ({
  address: input.address,
  topics: encodeEventTopics({ abi: input.abi, eventName: input.eventName as never, args: input.args as never }),
  data: input.dataTypes ? encodeAbiParameters(input.dataTypes as never, input.dataValues as never) : '0x',
});

interface FakeOptions {
  stage?: number;
  bond?: bigint;
  allowance?: bigint;
  balance?: bigint;
  keepLiveAfterCancel?: boolean;
  wrongRevealLock?: boolean;
  replacement?: boolean;
  rejectAction?: boolean;
  rejectApproval?: boolean;
  revertAction?: boolean;
  afterApprovalStage?: number;
  afterApprovalEscrow?: Address;
  afterApprovalLiveHash?: Hash;
  afterApprovalRevealed?: boolean;
  afterApprovalLock?: {
    lockedAmount: bigint;
    lockedAt: bigint;
    status: number;
    failedRefund: bigint;
    splitRecorded: boolean;
  };
}

class Phase8Chain {
  stage: number;
  liveCommit = ZERO_HASH;
  revealed = false;
  escrow = ESCROW;
  bond: bigint;
  allowance: bigint;
  balance: bigint;
  lock = { lockedAmount: 0n, lockedAt: 0n, status: 0, failedRefund: 0n, splitRecorded: false };
  readonly writes: Array<{ functionName: string; args: readonly unknown[] }> = [];
  readonly options: FakeOptions;
  private pendingAction = '';
  private pendingApproval = 0n;
  private pendingCommit = ZERO_HASH;
  private pendingReveal: { quantity: number; bidRate: number; lockAmount: bigint } | null = null;

  constructor(options: FakeOptions = {}) {
    this.options = options;
    this.stage = options.stage ?? 0;
    this.bond = options.bond ?? 10n * NATIVE_UNITS_PER_PROTOCOL_UNIT;
    this.allowance = options.allowance ?? 1_000n * NATIVE_UNITS_PER_PROTOCOL_UNIT;
    this.balance = options.balance ?? 1_000n * NATIVE_UNITS_PER_PROTOCOL_UNIT;
  }

  client(): PublicClient {
    return {
      readContract: async (request: { functionName: string }) => {
        switch (request.functionName) {
          case 'getAuctionStage':
            return this.stage;
          case 'getAuctionInfo':
            return {
              schedule: { commitEnd: 2_000_000_000n, revealEnd: 2_000_003_600n, issuanceEnd: 2_000_007_200n },
              params: {
                promisLoadMinor: 100n,
                minIntexBidRate: 500_000,
                minIntexBidQuantity: 1,
                commitBondMinor: 10n,
                prices: [{ isoCode: 840, entryPriceMinor: 100n, floorPriceMinor: 100n, callPriceMinor: 200n }],
              },
            };
          case 'committedBidsByHash':
            return this.liveCommit;
          case 'revealedBidsByBidder':
            return this.revealed;
          case 'escrowContract':
            return this.escrow;
          case 'intexAuctionContract':
            return TEST_AUCTION;
          case 'paymentToken':
            return TOKEN;
          case 'getCommitBond':
            return { amount: this.bond, lockedAt: this.bond > 0n ? 1n : 0n };
          case 'getBidLock':
            return this.lock;
          case 'balanceOf':
            return this.balance;
          case 'allowance':
            return this.allowance;
          case 'decimals':
            return 18;
          case 'symbol':
            return 'WCOEN';
          case 'whitelist':
            return ZERO_ADDRESS;
          default:
            throw new Error(`Unexpected read ${request.functionName}`);
        }
      },
      simulateContract: async (request: { functionName: string }) => {
        if (request.functionName === 'cancelCommit' && (this.stage !== 0 || this.liveCommit === ZERO_HASH)) {
          throw new Error('cancellation simulation rejected');
        }
        if (request.functionName === 'revealBid' && this.stage !== 1) throw new Error('reveal simulation rejected');
        return { request };
      },
      estimateContractGas: async () => 100_000n,
      waitForTransactionReceipt: async (request: {
        hash: Hash;
        onReplaced?: (replacement: { reason: 'repriced'; transaction: { hash: Hash } }) => void;
      }) => {
        const approval = request.hash === APPROVAL_HASH;
        if (!approval && this.options.replacement)
          request.onReplaced?.({ reason: 'repriced', transaction: { hash: REPLACEMENT_HASH } });
        if (approval) {
          this.allowance = this.pendingApproval;
          if (this.options.afterApprovalStage !== undefined) this.stage = this.options.afterApprovalStage;
          if (this.options.afterApprovalEscrow !== undefined) this.escrow = this.options.afterApprovalEscrow;
          if (this.options.afterApprovalLiveHash !== undefined) this.liveCommit = this.options.afterApprovalLiveHash;
          if (this.options.afterApprovalRevealed !== undefined) this.revealed = this.options.afterApprovalRevealed;
          if (this.options.afterApprovalLock !== undefined) this.lock = this.options.afterApprovalLock;
        }
        const logs: Array<ReturnType<typeof eventLog>> = [];
        if (this.pendingAction === 'cancelCommit' && !approval) {
          if (!this.options.keepLiveAfterCancel) this.liveCommit = ZERO_HASH;
          const released = this.bond;
          this.bond = 0n;
          logs.push(
            eventLog({
              address: TEST_AUCTION,
              abi: intexAbi,
              eventName: 'CommitCancelled',
              args: { worldwideDay: Number(WWD), bidder: TEST_ACCOUNT.address },
            }),
          );
          if (released > 0n)
            logs.push(
              eventLog({
                address: ESCROW,
                abi: escrowAbi,
                eventName: 'CommitBondReleased',
                args: { worldwideDay: Number(WWD), bidder: TEST_ACCOUNT.address },
                dataTypes: [{ type: 'uint128' }],
                dataValues: [released],
              }),
            );
        }
        if (this.pendingAction === 'commitBid' && !approval) {
          this.liveCommit = this.pendingCommit;
          this.bond = 10n;
        }
        if (this.pendingAction === 'revealBid' && !approval && this.pendingReveal) {
          const released = this.bond;
          this.liveCommit = ZERO_HASH;
          this.bond = 0n;
          this.revealed = true;
          this.lock = {
            lockedAmount: this.options.wrongRevealLock
              ? this.pendingReveal.lockAmount + 1n
              : this.pendingReveal.lockAmount,
            lockedAt: 2_000_000_001n,
            status: 1,
            failedRefund: 0n,
            splitRecorded: false,
          };
          logs.push(
            eventLog({
              address: TEST_AUCTION,
              abi: intexAbi,
              eventName: 'BidRevealed',
              args: {
                worldwideDay: Number(WWD),
                bidder: TEST_ACCOUNT.address,
                issuanceCurrency: 949,
                quantity: this.pendingReveal.quantity,
                bidRate: this.pendingReveal.bidRate,
              },
              dataTypes: [{ type: 'uint16' }, { type: 'uint32' }],
              dataValues: [this.pendingReveal.quantity, this.pendingReveal.bidRate],
            }),
          );
          logs.push(
            eventLog({
              address: ESCROW,
              abi: escrowAbi,
              eventName: 'FundsLocked',
              args: { worldwideDay: Number(WWD), bidder: TEST_ACCOUNT.address },
              dataTypes: [{ type: 'uint128' }],
              dataValues: [this.pendingReveal.lockAmount],
            }),
          );
          if (released > 0n)
            logs.push(
              eventLog({
                address: ESCROW,
                abi: escrowAbi,
                eventName: 'CommitBondReleased',
                args: { worldwideDay: Number(WWD), bidder: TEST_ACCOUNT.address },
                dataTypes: [{ type: 'uint128' }],
                dataValues: [released],
              }),
            );
        }
        return {
          status: !approval && this.options.revertAction ? 'reverted' : 'success',
          transactionHash: !approval && this.options.replacement ? REPLACEMENT_HASH : request.hash,
          logs,
        } as unknown as TransactionReceipt;
      },
    } as unknown as PublicClient;
  }

  wallet(): BidderActionWalletClient & CommitWalletClient {
    return {
      signTypedData: async () => {
        throw new Error('unexpected signature request');
      },
      writeContract: async (request) => {
        const typed = request as { functionName: string; args: readonly unknown[] };
        this.writes.push(typed);
        if (this.options.rejectApproval && typed.functionName === 'approve') throw new Error('user rejected approval');
        if (this.options.rejectAction && typed.functionName !== 'approve') throw new Error('user rejected action');
        this.pendingAction = typed.functionName;
        if (typed.functionName === 'approve') {
          this.pendingApproval = typed.args[1] as bigint;
          return APPROVAL_HASH;
        }
        if (typed.functionName === 'commitBid') this.pendingCommit = typed.args[1] as Hash;
        if (typed.functionName === 'revealBid') {
          const quantity = typed.args[1] as number;
          const bidRate = typed.args[2] as number;
          this.pendingReveal = {
            quantity,
            bidRate,
            lockAmount: ((BigInt(quantity) * 100n * BigInt(bidRate)) / 1_000_000n) * NATIVE_UNITS_PER_PROTOCOL_UNIT,
          };
        }
        return ACTION_HASH;
      },
    };
  }
}

const setup = async (input: Partial<{ quantity: number; bidRate: number }> = {}) => {
  const storage = new MemoryStorage();
  const material = await createTestMaterial({
    deploymentId: 'venue-v1',
    chainId: 31_337,
    auctionProxy: TEST_AUCTION,
    bidder: TEST_ACCOUNT.address,
    worldwideDay: Number(WWD),
    quantity: input.quantity ?? 1,
    bidRate: input.bidRate ?? 1_000_000,
  });
  const persisted = await persistRevealMaterial({
    storage,
    material,
    authoritativeParameters: { promisLoadMinor: 100n },
  });
  if (!persisted.ok) throw new Error(persisted.message);
  return { storage, material, persisted };
};

const context = () => ({
  token: 'context',
  chainId: 31_337,
  deploymentId: 'venue-v1',
  auctionProxy: TEST_AUCTION,
  bidder: TEST_ACCOUNT.address,
  worldwideDay: WWD,
});

describe('Phase 8 bidder transaction boundaries', () => {
  it('selects reveal material only by exact live hash and active context', async () => {
    const { storage, material, persisted } = await setup();
    await expect(
      selectLiveRevealMaterial({
        storage,
        context: context(),
        liveCommitHash: material.commitHash,
        promisLoadMinor: 100n,
      }),
    ).resolves.toMatchObject({ key: persisted.key });
    await expect(
      selectLiveRevealMaterial({
        storage,
        context: context(),
        liveCommitHash: `0x${'9'.repeat(64)}` as Hash,
        promisLoadMinor: 100n,
      }),
    ).rejects.toThrow('no exact matching reveal receipt');
  });

  it('cancels a live commitment and reconciles the exact atomic bond return', async () => {
    const chain = new Phase8Chain({ bond: 10n });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    const result = await executeCancelCommitTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
    });
    expect(result).toMatchObject({ reconciliation: 'confirmed', returnedBondAmount: 10n });
    expect(chain.liveCommit).toBe(ZERO_HASH);
    expect(chain.bond).toBe(0n);
    expect(
      listTransactionAttempts(storage, result.revealMaterialKey).map((attempt) => [attempt.kind, attempt.state]),
    ).toEqual([['cancellation', 'confirmed']]);
  });

  it('reuses the exact cancellation request for simulation, estimation and submission', async () => {
    const chain = new Phase8Chain({ bond: 10n });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    const client = chain.client();
    const wallet = chain.wallet();
    let simulated: unknown;
    let estimated: unknown;
    let written: unknown;
    const simulate = client.simulateContract.bind(client);
    const estimate = client.estimateContractGas.bind(client);
    const write = wallet.writeContract.bind(wallet);
    client.simulateContract = async (request) => {
      simulated = request;
      return simulate(request as never);
    };
    client.estimateContractGas = async (request) => {
      estimated = request;
      return estimate(request as never);
    };
    wallet.writeContract = async (request) => {
      written = request;
      return write(request);
    };

    await executeCancelCommitTransaction({
      publicClient: client,
      walletClient: wallet,
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
    });

    expect(estimated).toBe(simulated);
    expect(written).toBe(simulated);
  });

  it('supports zero-bond cancellation without requiring a release event', async () => {
    const chain = new Phase8Chain({ bond: 0n });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    const result = await executeCancelCommitTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
    });
    expect(result.reconciliation).toBe('confirmed');
    expect(result.commitBondReleasedEventObserved).toBe(false);
  });

  it('persists a confirmed cancellation mismatch without claiming the bond return', async () => {
    const chain = new Phase8Chain({ keepLiveAfterCancel: true });
    const { storage, material } = await setup();
    const progress: string[] = [];
    chain.liveCommit = material.commitHash;
    const result = await executeCancelCommitTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
      onProgress: (value) => progress.push(value.kind),
    });
    expect(result.reconciliation).toBe('mismatch');
    expect(chain.writes.filter((write) => write.functionName === 'cancelCommit')).toHaveLength(1);
    expect(listTransactionAttempts(storage, result.revealMaterialKey).at(-1)?.lastReconciliationError).toContain(
      'does not yet reconcile',
    );
    expect(progress).not.toContain('confirmed');
  });

  it('rejects cancellation at the reveal boundary before any wallet call', async () => {
    const chain = new Phase8Chain({ stage: 1 });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    await expect(
      executeCancelCommitTransaction({
        publicClient: chain.client(),
        walletClient: chain.wallet(),
        profile: profile(),
        context: context(),
        storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('commit stage');
    expect(chain.writes).toHaveLength(0);
  });

  it('rejects cancellation when the bidder owns no commitment', async () => {
    const chain = new Phase8Chain();
    const { storage } = await setup();
    await expect(
      executeCancelCommitTransaction({
        publicClient: chain.client(),
        walletClient: chain.wallet(),
        profile: profile(),
        context: context(),
        storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('no live commitment');
    expect(chain.writes).toHaveLength(0);
  });

  it('does not persist a cancellation attempt when the wallet rejects broadcast', async () => {
    const chain = new Phase8Chain({ rejectAction: true });
    const { storage, material, persisted } = await setup();
    chain.liveCommit = material.commitHash;
    await expect(
      executeCancelCommitTransaction({
        publicClient: chain.client(),
        walletClient: chain.wallet(),
        profile: profile(),
        context: context(),
        storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('user rejected action');
    expect(listTransactionAttempts(storage, persisted.key)).toHaveLength(0);
  });

  it('preserves cancellation replacement and confirmed attempts separately', async () => {
    const chain = new Phase8Chain({ replacement: true });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    const result = await executeCancelCommitTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
    });
    const attempts = listTransactionAttempts(storage, result.revealMaterialKey);
    expect(attempts.map((attempt) => attempt.state)).toEqual(['replaced', 'confirmed']);
    expect(result.cancellationTransactionHash).toBe(REPLACEMENT_HASH);
  });

  it('recommits the exact stored material without another signature and records recommit separately', async () => {
    const chain = new Phase8Chain({ bond: 0n, allowance: 1_000n });
    const { storage, material } = await setup();
    chain.bond = 0n;
    const wallet = chain.wallet();
    let signatures = 0;
    wallet.signTypedData = async () => {
      signatures += 1;
      return '0x' as Hex;
    };
    const result = await executeRecommitTransaction({
      publicClient: chain.client(),
      walletClient: wallet,
      profile: profile(),
      context: context(),
      storage,
      quantity: '1',
      bidRatePercent: '100',
      issuanceCurrency: 949,
      isContextCurrent: () => true,
    });
    expect(signatures).toBe(0);
    expect(result.kind).toBe('recommit');
    expect(result.material.commitHash).toBe(material.commitHash);
    expect(listTransactionAttempts(storage, result.revealMaterialKey).at(-1)?.kind).toBe('recommit');
  });

  it('uses the bond in effective balance but approves the exact full reveal lock', async () => {
    const chain = new Phase8Chain({
      stage: 1,
      bond: 50n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
      balance: 50n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
      allowance: 0n,
    });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    const result = await executeRevealBidTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
    });
    expect(result).toMatchObject({
      reconciliation: 'confirmed',
      fullLockAmount: 100n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
      effectiveBalance: 100n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
      liveBondContribution: 50n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
    });
    expect(chain.writes[0]).toMatchObject({
      functionName: 'approve',
      args: [getAddress(ESCROW), 100n * NATIVE_UNITS_PER_PROTOCOL_UNIT],
    });
    expect(chain.writes[0]?.args?.[1]).toBe(100_000_000_000_000n);
    expect(chain.writes[1]?.functionName).toBe('revealBid');
    expect(chain.revealed).toBe(true);
    expect(chain.liveCommit).toBe(ZERO_HASH);
    expect(chain.lock).toMatchObject({ lockedAmount: 100n * NATIVE_UNITS_PER_PROTOCOL_UNIT, status: 1 });
  });

  it('reuses exact approval and reveal requests for simulation, estimation and submission', async () => {
    const chain = new Phase8Chain({
      stage: 1,
      bond: 50n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
      balance: 50n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
      allowance: 0n,
    });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    const client = chain.client();
    const wallet = chain.wallet();
    const simulated: unknown[] = [];
    const estimated: unknown[] = [];
    const written: unknown[] = [];
    const simulate = client.simulateContract.bind(client);
    const estimate = client.estimateContractGas.bind(client);
    const write = wallet.writeContract.bind(wallet);
    client.simulateContract = async (request) => {
      simulated.push(request);
      return simulate(request as never);
    };
    client.estimateContractGas = async (request) => {
      estimated.push(request);
      return estimate(request as never);
    };
    wallet.writeContract = async (request) => {
      written.push(request);
      return write(request);
    };

    await executeRevealBidTransaction({
      publicClient: client,
      walletClient: wallet,
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
    });

    expect(simulated).toHaveLength(2);
    expect(estimated).toHaveLength(2);
    expect(written).toHaveLength(2);
    for (let index = 0; index < written.length; index += 1) {
      expect(estimated[index]).toBe(simulated[index]);
      expect(written[index]).toBe(simulated[index]);
    }
  });

  it('requires full-lock allowance even when the bond funds the entire reveal balance', async () => {
    const chain = new Phase8Chain({
      stage: 1,
      bond: 100n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
      balance: 0n,
      allowance: 0n,
    });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    await executeRevealBidTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
    });
    expect(chain.writes[0]?.args).toEqual([getAddress(ESCROW), 100n * NATIVE_UNITS_PER_PROTOCOL_UNIT]);
  });

  it('rejects insufficient effective balance before any wallet call', async () => {
    const chain = new Phase8Chain({ stage: 1, bond: 10n, balance: 10n, allowance: 1_000n });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    await expect(
      executeRevealBidTransaction({
        publicClient: chain.client(),
        walletClient: chain.wallet(),
        profile: profile(),
        context: context(),
        storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('insufficient');
    expect(chain.writes).toHaveLength(0);
  });

  it('makes zero wallet calls when the live hash has no matching receipt', async () => {
    const chain = new Phase8Chain({ stage: 1 });
    const { storage } = await setup();
    chain.liveCommit = `0x${'9'.repeat(64)}` as Hash;
    await expect(
      executeRevealBidTransaction({
        publicClient: chain.client(),
        walletClient: chain.wallet(),
        profile: profile(),
        context: context(),
        storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('no exact matching reveal receipt');
    expect(chain.writes).toHaveLength(0);
  });

  it('rejects reveal outside the reveal stage before any wallet call', async () => {
    const chain = new Phase8Chain({ stage: 0 });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    await expect(
      executeRevealBidTransaction({
        publicClient: chain.client(),
        walletClient: chain.wallet(),
        profile: profile(),
        context: context(),
        storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('not currently accepting');
    expect(chain.writes).toHaveLength(0);
  });

  it('rejects an already revealed bidder and a pre-existing bid lock', async () => {
    const alreadyRevealed = new Phase8Chain({ stage: 1 });
    const first = await setup();
    alreadyRevealed.liveCommit = first.material.commitHash;
    alreadyRevealed.revealed = true;
    await expect(
      executeRevealBidTransaction({
        publicClient: alreadyRevealed.client(),
        walletClient: alreadyRevealed.wallet(),
        profile: profile(),
        context: context(),
        storage: first.storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('already revealed');
    expect(alreadyRevealed.writes).toHaveLength(0);

    const locked = new Phase8Chain({ stage: 1 });
    const second = await setup();
    locked.liveCommit = second.material.commitHash;
    locked.lock = { lockedAmount: 100n, lockedAt: 1n, status: 1, failedRefund: 0n, splitRecorded: false };
    await expect(
      executeRevealBidTransaction({
        publicClient: locked.client(),
        walletClient: locked.wallet(),
        profile: profile(),
        context: context(),
        storage: second.storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('already has an escrow bid lock');
    expect(locked.writes).toHaveLength(0);
  });

  it('stops after approval when stage, wiring, commitment, reveal flag or lock changes', async () => {
    const cases: Array<[string, FakeOptions]> = [
      ['stage', { afterApprovalStage: 2 }],
      ['wiring', { afterApprovalEscrow: '0x000000000000000000000000000000000000eC02' as Address }],
      ['commitment', { afterApprovalLiveHash: `0x${'8'.repeat(64)}` as Hash }],
      ['revealed', { afterApprovalRevealed: true }],
      [
        'lock',
        { afterApprovalLock: { lockedAmount: 1n, lockedAt: 1n, status: 1, failedRefund: 0n, splitRecorded: false } },
      ],
    ];
    for (const [label, options] of cases) {
      const chain = new Phase8Chain({ stage: 1, allowance: 0n, ...options });
      const { storage, material } = await setup();
      chain.liveCommit = material.commitHash;
      await expect(
        executeRevealBidTransaction({
          publicClient: chain.client(),
          walletClient: chain.wallet(),
          profile: profile(),
          context: context(),
          storage,
          isContextCurrent: () => true,
        }),
        label,
      ).rejects.toThrow();
      expect(
        chain.writes.map((write) => write.functionName),
        label,
      ).toEqual(['approve']);
    }
  });

  it('does not submit reveal when exact approval is rejected', async () => {
    const chain = new Phase8Chain({ stage: 1, allowance: 0n, rejectApproval: true });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    await expect(
      executeRevealBidTransaction({
        publicClient: chain.client(),
        walletClient: chain.wallet(),
        profile: profile(),
        context: context(),
        storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('user rejected approval');
    expect(chain.writes.map((write) => write.functionName)).toEqual(['approve']);
  });

  it('persists a reverted reveal attempt and never retries it', async () => {
    const chain = new Phase8Chain({ stage: 1, revertAction: true });
    const { storage, material, persisted } = await setup();
    chain.liveCommit = material.commitHash;
    await expect(
      executeRevealBidTransaction({
        publicClient: chain.client(),
        walletClient: chain.wallet(),
        profile: profile(),
        context: context(),
        storage,
        isContextCurrent: () => true,
      }),
    ).rejects.toThrow('Reveal transaction reverted');
    const attempts = listTransactionAttempts(storage, persisted.key).filter((attempt) => attempt.kind === 'reveal');
    expect(attempts.map((attempt) => attempt.state)).toEqual(['reverted']);
    expect(chain.writes.filter((write) => write.functionName === 'revealBid')).toHaveLength(1);
  });

  it('persists reveal reconciliation mismatch without claiming funds are locked', async () => {
    const chain = new Phase8Chain({ stage: 1, bond: 10n, wrongRevealLock: true });
    const { storage, material } = await setup();
    const progress: string[] = [];
    chain.liveCommit = material.commitHash;
    const result = await executeRevealBidTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
      onProgress: (value) => progress.push(value.kind),
    });
    expect(result.reconciliation).toBe('mismatch');
    expect(listTransactionAttempts(storage, result.revealMaterialKey).at(-1)?.lastReconciliationError).toContain(
      'does not yet reconcile',
    );
    expect(progress).not.toContain('confirmed');
  });

  it('preserves replacement and confirmed reveal attempts separately', async () => {
    const chain = new Phase8Chain({ stage: 1, bond: 10n, replacement: true });
    const { storage, material } = await setup();
    chain.liveCommit = material.commitHash;
    const result = await executeRevealBidTransaction({
      publicClient: chain.client(),
      walletClient: chain.wallet(),
      profile: profile(),
      context: context(),
      storage,
      isContextCurrent: () => true,
    });
    const attempts = listTransactionAttempts(storage, result.revealMaterialKey).filter(
      (attempt) => attempt.kind === 'reveal',
    );
    expect(attempts.map((attempt) => attempt.state)).toEqual(['replaced', 'confirmed']);
    expect(result.revealTransactionHash).toBe(REPLACEMENT_HASH);
  });
});
