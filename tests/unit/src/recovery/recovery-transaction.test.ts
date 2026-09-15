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
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider } from '@/wallet/eip1193';
import {
  listRecoveryAttempts,
  RecoveryAttemptPersistenceError,
  type RecoveryAttemptStorage,
} from '@/recovery/recovery-attempt';
import { recoveryItemKey, type RecoveryItem } from '@/recovery/recovery-domain';
import {
  executeRecoveryTransaction,
  type RecoveryOperationProgress,
  type RecoveryWalletClient,
} from '@/recovery/recovery-transaction';

const AUCTION_ABI = parseAbi([
  'function escrowContract() view returns (address)',
  'function getAuctionStage(uint32 worldwideDay) view returns (uint8)',
  'function getAuctionInfo(uint32 worldwideDay) view returns ((uint8 worldwideDayState,(uint32 commitEnd,uint32 revealEnd,uint32 issuanceEnd) schedule,(uint16 issuanceCurrency,uint16 referenceCurrency,uint128 promisLoadMinor,uint32 minIntexBidRate,uint16 minIntexBidQuantity,uint128 entryPriceMinor,uint128 floorPriceMinor,uint128 callPriceMinor,uint128 commitBondMinor,(uint8 thresholdDays,uint8 windowDays,uint32 intexCallPeriod) callTrigger) params,(uint32 auctionClearingRate,uint32 wonBidsCount,uint32 issuedIntexCount) result))',
  'function UNREVEALED_BOND_LOCK_PERIOD() view returns (uint32)',
  'function claimCommitBond(uint32 worldwideDay,address bidder)',
]);
const ESCROW_ABI = parseAbi([
  'function intexAuctionContract() view returns (address)',
  'function paymentToken() view returns (address)',
  'function COMMIT_BOND_ABANDON_DELAY() view returns (uint32)',
  'function UNFINALIZED_REFUND_DELAY() view returns (uint32)',
  'function POST_FINALIZE_REFUND_DELAY() view returns (uint32)',
  'function NO_SPLIT_REFUND_DELAY() view returns (uint32)',
  'function getCommitBond(uint32 worldwideDay,address bidder) view returns ((uint128 amount,uint32 lockedAt))',
  'function getBidLock(uint32 worldwideDay,address bidder) view returns ((uint128 lockedAmount,uint32 lockedAt,uint8 status,uint128 failedRefund,bool splitRecorded))',
  'function auctionEscrowState(uint32 worldwideDay) view returns (uint128 totalLocked,uint32 lockCount,uint32 finalizedAt,bool finalized)',
  'function claimAbandonedCommitBond(uint32 worldwideDay,address bidder)',
  'function claimRefund(uint32 worldwideDay,address bidder)',
  'event CommitBondReleased(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event FundsRefunded(bytes32 indexed receiveId,uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
  'event ProceedsBurned(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
]);

const AUCTION = getAddress('0x1111111111111111111111111111111111111111');
const ESCROW = getAddress('0x2222222222222222222222222222222222222222');
const OLD_ESCROW = getAddress('0x6666666666666666666666666666666666666666');
const ROUTER = getAddress('0x3333333333333333333333333333333333333333');
const NFT = getAddress('0x4444444444444444444444444444444444444444');
const PAYMENT = getAddress('0x5555555555555555555555555555555555555555');
const BIDDER = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CALLER = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const parsedDay = parseWorldwideDayKey('20260804');
if (!parsedDay.ok) throw new Error('Invalid test WorldwideDay.');
const DAY = parsedDay.value;
const TX = `0x${'a'.repeat(64)}` as Hash;
const BLOCK = `0x${'c'.repeat(64)}` as Hash;

const profile = (): ResolvedVenueReadProfile => ({
  id: 'venue',
  name: 'Venue',
  deploymentId: 'local',
  deploymentBlock: 1n,
  chainId: 31_337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['/rpc'],
  explorerUrl: null,
  confirmationDepth: 2,
  logBatchSize: 100,
  requestTimeoutMs: 10_000,
  readRetryCount: 0,
  addresses: {
    intexAuction: AUCTION,
    escrowAdapter: ESCROW,
    targetRouter: ROUTER,
    intexNFT1155: NFT,
    paymentToken: PAYMENT,
  },
  abis: { intexAuction: AUCTION_ABI, escrowAdapter: ESCROW_ABI, targetRouter: [], intexNFT1155: [], paymentToken: [] },
});

class MemoryStorage implements RecoveryAttemptStorage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class AttemptWriteFailureStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('attempt write failed');
  }
}

const baseItem = (overrides: Partial<RecoveryItem> = {}): RecoveryItem => {
  const item = {
    path: 'escrow-unfinalized-refund',
    worldwideDay: DAY,
    bidder: BIDDER,
    auctionContract: AUCTION,
    escrowContract: ESCROW,
    paymentToken: PAYMENT,
    paymentTokenDecimals: 18,
    paymentTokenSymbol: 'wCOEN',
    custody: 'current',
    returnedAmount: 1_000n,
    burnedAmount: 0n,
    claimableAt: 269_200n,
    latestBlockTimestamp: 400_000n,
    availability: 'claimable',
    explanation: 'test',
    ...overrides,
  } as Omit<RecoveryItem, 'key'> & { key?: string };
  return {
    ...item,
    key:
      overrides.key ??
      recoveryItemKey({
        chainId: 31_337,
        deploymentId: 'local',
        path: item.path,
        worldwideDay: item.worldwideDay,
        bidder: item.bidder,
        contract: item.path === 'auction-commit-bond' ? item.auctionContract : item.escrowContract,
      }),
  };
};

const eventLog = (
  eventName: 'CommitBondReleased' | 'FundsRefunded' | 'ProceedsBurned',
  item: RecoveryItem,
  amount: bigint,
) => {
  const args =
    eventName === 'FundsRefunded'
      ? {
          receiveId: `0x${'0'.repeat(64)}` as Hex,
          worldwideDay: Number(item.worldwideDay),
          bidder: item.bidder,
          amount,
        }
      : { worldwideDay: Number(item.worldwideDay), bidder: item.bidder, amount };
  return {
    address: item.escrowContract,
    topics: encodeEventTopics({ abi: ESCROW_ABI, eventName, args } as never),
    data: encodeAbiParameters([{ type: 'uint128' }], [amount]),
    blockHash: BLOCK,
    blockNumber: 1n,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
};

interface FakeState {
  bondAmount: bigint;
  lockStatus: number;
  lockedAmount: bigint;
  failedRefund: bigint;
  splitRecorded: boolean;
  finalized: boolean;
  finalizedAt: bigint;
}

class FakePublicClient {
  readonly simulations: unknown[] = [];
  readonly estimates: unknown[] = [];
  receipt: TransactionReceipt;
  simulationError: Error | null = null;
  clearOnReceipt = true;
  constructor(
    readonly item: RecoveryItem,
    readonly state: FakeState,
    logs: readonly unknown[],
  ) {
    this.receipt = { status: 'success', logs } as unknown as TransactionReceipt;
  }
  getBlock = async () => ({ timestamp: 400_000n });
  getBytecode = async () => '0x6000' as Hex;
  readContract = async (request: { address: Address; functionName: string }) => {
    switch (request.functionName) {
      case 'intexAuctionContract':
        return AUCTION;
      case 'paymentToken':
        return PAYMENT;
      case 'decimals':
        return 18;
      case 'symbol':
        return 'wCOEN';
      case 'COMMIT_BOND_ABANDON_DELAY':
        return 2_592_000n;
      case 'UNFINALIZED_REFUND_DELAY':
        return 259_200n;
      case 'POST_FINALIZE_REFUND_DELAY':
        return 259_200n;
      case 'NO_SPLIT_REFUND_DELAY':
        return 2_592_000n;
      case 'getCommitBond':
        return { amount: this.state.bondAmount, lockedAt: 10_000n };
      case 'getBidLock':
        return {
          lockedAmount: this.state.lockedAmount,
          lockedAt: this.state.lockStatus === 0 ? 0n : 10_000n,
          status: this.state.lockStatus,
          failedRefund: this.state.failedRefund,
          splitRecorded: this.state.splitRecorded,
        };
      case 'auctionEscrowState':
        return {
          totalLocked: this.state.lockStatus === 1 ? this.state.lockedAmount : 0n,
          lockCount: 1n,
          finalizedAt: this.state.finalizedAt,
          finalized: this.state.finalized,
        };
      case 'escrowContract':
        return this.item.escrowContract;
      case 'getAuctionStage':
        return 3;
      case 'getAuctionInfo':
        return { schedule: { commitEnd: 1n, revealEnd: 100_000n, issuanceEnd: 200_000n } };
      case 'UNREVEALED_BOND_LOCK_PERIOD':
        return 86_400n;
      default:
        throw new Error(`Unexpected read ${request.functionName}`);
    }
  };
  simulateContract = async (request: unknown) => {
    this.simulations.push(request);
    if (this.simulationError) throw this.simulationError;
    return { request };
  };
  estimateContractGas = async (request: unknown) => {
    this.estimates.push(request);
    return 100_000n;
  };
  waitForTransactionReceipt = async () => {
    if (this.clearOnReceipt) {
      this.state.bondAmount = 0n;
      this.state.lockStatus = 2;
    }
    return this.receipt;
  };
}

const provider = (chainId = '0x7a69', account: Address = CALLER): Eip1193Provider => ({
  request: async ({ method }) => {
    if (method === 'eth_chainId') return chainId;
    if (method === 'eth_accounts') return [account];
    throw new Error(`Unexpected wallet request ${method}`);
  },
});

const wallet = () => {
  const requests: unknown[] = [];
  const client: RecoveryWalletClient = {
    writeContract: async (request) => {
      requests.push(request);
      return TX;
    },
  };
  return { client, requests };
};

const stateFor = (item: RecoveryItem): FakeState => ({
  bondAmount: item.path.includes('commit-bond') ? item.returnedAmount : 0n,
  lockStatus: item.path.includes('refund') ? 1 : 0,
  lockedAmount: item.path.includes('refund') ? item.returnedAmount + item.burnedAmount : 0n,
  failedRefund: item.path === 'escrow-failed-split-refund' ? item.returnedAmount : 0n,
  splitRecorded: item.path === 'escrow-failed-split-refund',
  finalized: item.path === 'escrow-failed-split-refund' || item.path === 'escrow-no-split-refund',
  finalizedAt: item.path === 'escrow-failed-split-refund' || item.path === 'escrow-no-split-refund' ? 100_000n : 0n,
});

const run = async (
  item: RecoveryItem,
  logs: readonly unknown[],
  overrides: {
    publicClient?: FakePublicClient;
    provider?: Eip1193Provider;
    walletClient?: ReturnType<typeof wallet>;
    storage?: RecoveryAttemptStorage;
    onProgress?: (progress: RecoveryOperationProgress) => void;
  } = {},
) => {
  const storage = overrides.storage ?? new MemoryStorage();
  const publicClient = overrides.publicClient ?? new FakePublicClient(item, stateFor(item), logs);
  const walletClient = overrides.walletClient ?? wallet();
  const result = await executeRecoveryTransaction({
    publicClient: publicClient as unknown as PublicClient,
    walletProvider: overrides.provider ?? provider(),
    walletClient: walletClient.client,
    profile: profile(),
    caller: CALLER,
    item,
    storage,
    contextToken: 'current',
    isContextCurrent: (token) => token === 'current',
    now: () => '2026-08-04T20:00:00.000Z',
    ...(overrides.onProgress === undefined ? {} : { onProgress: overrides.onProgress }),
  });
  return { result, storage, publicClient, walletClient };
};

describe('real recovery transaction flow', () => {
  it('preflights and submits never-finalized recovery to the exact escrow with a permissionless caller', async () => {
    const item = baseItem();
    const completed = await run(item, [eventLog('FundsRefunded', item, 1_000n)]);
    expect(completed.result.reconciliation).toBe('confirmed');
    expect(completed.walletClient.requests).toHaveLength(1);
    expect(completed.walletClient.requests[0]).toMatchObject({
      account: CALLER,
      address: ESCROW,
      functionName: 'claimRefund',
      args: [20260804, BIDDER],
    });
    expect(completed.publicClient.simulations).toHaveLength(1);
    expect(completed.publicClient.estimates).toHaveLength(1);
    expect(completed.publicClient.estimates[0]).toBe(completed.publicClient.simulations[0]);
    expect(completed.walletClient.requests[0]).toBe(completed.publicClient.simulations[0]);
    expect(listRecoveryAttempts(completed.storage)[0]).toMatchObject({
      state: 'confirmed',
      bidder: BIDDER.toLowerCase(),
    });
  });

  it('targets the historical escrow for abandoned commit-bond recovery', async () => {
    const item = baseItem({
      path: 'escrow-abandoned-commit-bond',
      escrowContract: OLD_ESCROW,
      custody: 'historical',
      returnedAmount: 50n,
      burnedAmount: 0n,
      claimableAt: 2_602_000n,
      latestBlockTimestamp: 2_602_000n,
    });
    const state = stateFor(item);
    const client = new FakePublicClient(item, state, [eventLog('CommitBondReleased', item, 50n)]);
    client.getBlock = async () => ({ timestamp: 2_602_000n });
    const completed = await run(item, client.receipt.logs, { publicClient: client });
    expect(completed.walletClient.requests[0]).toMatchObject({
      address: OLD_ESCROW,
      functionName: 'claimAbandonedCommitBond',
      args: [20260804, BIDDER],
    });
    expect(completed.result.commitBondReleasedEventObserved).toBe(true);
  });

  it('matches exact failed-split refund and burn events, including zero-return full burn', async () => {
    const item = baseItem({
      path: 'escrow-failed-split-refund',
      returnedAmount: 0n,
      burnedAmount: 1_000n,
      claimableAt: 359_200n,
      latestBlockTimestamp: 400_000n,
    });
    const completed = await run(item, [eventLog('ProceedsBurned', item, 1_000n)]);
    expect(completed.result).toMatchObject({
      reconciliation: 'confirmed',
      fundsRefundedEventObserved: false,
      proceedsBurnedEventObserved: true,
    });
  });

  it('causes zero wallet submissions when chain context or simulation is invalid', async () => {
    const item = baseItem();
    const wrongWallet = wallet();
    await expect(run(item, [], { provider: provider('0x1'), walletClient: wrongWallet })).rejects.toThrow(
      'selected venue chain',
    );
    expect(wrongWallet.requests).toHaveLength(0);

    const failedWallet = wallet();
    const client = new FakePublicClient(item, stateFor(item), []);
    client.simulationError = new Error('simulation reverted');
    await expect(run(item, [], { publicClient: client, walletClient: failedWallet })).rejects.toThrow(
      'simulation reverted',
    );
    expect(failedWallet.requests).toHaveLength(0);
  });

  it('retains the returned recovery hash when post-broadcast attempt persistence fails', async () => {
    const item = baseItem();
    const submittedWallet = wallet();
    try {
      await run(item, [eventLog('FundsRefunded', item, 1_000n)], {
        walletClient: submittedWallet,
        storage: new AttemptWriteFailureStorage(),
      });
      throw new Error('Expected recovery attempt persistence to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryAttemptPersistenceError);
      const failure = error as RecoveryAttemptPersistenceError;
      expect(failure.attempt.transactionHash).toBe(TX);
      expect(failure.message).toContain(TX);
      expect(failure.message).toContain('may already be submitted');
    }
    expect(submittedWallet.requests).toHaveLength(1);
  });

  it('keeps a confirmed attempt with a visible reconciliation error when state or events mismatch', async () => {
    const item = baseItem();
    const client = new FakePublicClient(item, stateFor(item), []);
    const progress: RecoveryOperationProgress['kind'][] = [];
    client.clearOnReceipt = false;
    const completed = await run(item, [], {
      publicClient: client,
      onProgress: (value) => progress.push(value.kind),
    });
    expect(completed.result.reconciliation).toBe('mismatch');
    const attempt = listRecoveryAttempts(completed.storage)[0]!;
    expect(attempt.state).toBe('confirmed');
    expect(attempt.lastReconciliationError).toContain('FundsRefunded');
    expect(progress).not.toContain('confirmed');
  });

  it('blocks successful reconciliation when required exact event evidence is missing', async () => {
    const item = baseItem();
    const completed = await run(item, []);
    expect(completed.result.reconciliation).toBe('mismatch');
    expect(completed.result.reconciliationMessage).toContain('FundsRefunded');
  });
});
