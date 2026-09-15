import { getAddress, zeroAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { parseWorldwideDayKey, type WorldwideDayKey } from '../domain/protocol-time';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import type { AuctionReadClient } from '../protocol/read-client';
import { namespaceKey } from '../persistence/namespace-key';
import { browserStorage } from '../persistence/available-storage';
import { LogPageScanError, LogPageScanInterruptedError, scanLogPages } from '../chain/scan-log-pages';

const CACHE_VERSION = 1;
const CACHE_PREFIX = 'itx-acn:wallet-recovery-history';

export type WalletRecoveryEventFamily =
  | 'BidCommitted'
  | 'CommitCancelled'
  | 'BidRevealed'
  | 'AuctionStageUpdated'
  | 'AuctionClearingExecuted'
  | 'EscrowWired'
  | 'CommitBondLocked'
  | 'CommitBondReleased'
  | 'FundsLocked'
  | 'FundsRefunded'
  | 'ProceedsBurned'
  | 'AuctionEscrowFinalized'
  | 'BidderRefundFailed'
  | 'BidderRetried'
  | 'FinalizationNoOp'
  | 'Wired';

export interface WalletRecoveryHistoryEvent {
  readonly family: WalletRecoveryEventFamily;
  readonly contract: Address;
  readonly worldwideDay: WorldwideDayKey | null;
  readonly bidder: Address | null;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly transactionIndex: number | null;
  readonly logIndex: number;
}

export interface RecoveryWiringEpoch {
  readonly escrowContract: Address;
  readonly auctionContract: Address;
  readonly paymentToken: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface RecoveryEscrowHistoryContract {
  readonly escrowContract: Address;
  readonly paymentToken: Address | null;
  readonly associatedAuction: Address | null;
  readonly custody: 'current' | 'historical';
  readonly compatible: boolean;
  readonly compatibilityError: string | null;
}

export type WalletRecoveryHistoryCacheStatus =
  | 'cache-hit'
  | 'cache-extended'
  | 'cold-scan'
  | 'rebuilt-invalid-cache'
  | 'rebuilt-after-reorg'
  | 'storage-unavailable'
  | 'storage-write-failed';

export interface WalletRecoveryHistory {
  readonly confirmedThroughBlock: bigint;
  readonly candidates: readonly WorldwideDayKey[];
  readonly events: readonly WalletRecoveryHistoryEvent[];
  readonly wiringEpochs: readonly RecoveryWiringEpoch[];
  readonly escrows: readonly RecoveryEscrowHistoryContract[];
  readonly cacheStatus: WalletRecoveryHistoryCacheStatus;
  readonly storageWarning: string | null;
}

export interface WalletRecoveryHistoryStorage {
  readonly length?: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class WalletRecoveryHistoryError extends Error {}
export class WalletRecoveryHistoryAbortedError extends Error {}

interface StoredHistoryEnvelope {
  readonly schemaVersion: 1;
  readonly chainId: number;
  readonly deploymentId: string;
  readonly auctionContract: Address;
  readonly wallet: Address;
  readonly lastCompletelyScannedBlock: string;
  readonly checkpointBlockHash: Hex;
  readonly events: readonly Record<string, unknown>[];
  readonly wiringEpochs: readonly Record<string, unknown>[];
}

interface CachedHistory {
  readonly lastCompletelyScannedBlock: bigint;
  readonly checkpointBlockHash: Hex;
  readonly events: readonly WalletRecoveryHistoryEvent[];
  readonly wiringEpochs: readonly RecoveryWiringEpoch[];
}

interface EventSpec {
  readonly family: WalletRecoveryEventFamily;
  readonly source: 'auction' | 'escrow';
  readonly walletFiltered: boolean;
}

const AUCTION_EVENTS: readonly EventSpec[] = [
  { family: 'BidCommitted', source: 'auction', walletFiltered: true },
  { family: 'CommitCancelled', source: 'auction', walletFiltered: true },
  { family: 'BidRevealed', source: 'auction', walletFiltered: true },
  { family: 'AuctionStageUpdated', source: 'auction', walletFiltered: false },
  { family: 'AuctionClearingExecuted', source: 'auction', walletFiltered: false },
  { family: 'EscrowWired', source: 'auction', walletFiltered: false },
];

const ESCROW_EVENTS: readonly EventSpec[] = [
  { family: 'CommitBondLocked', source: 'escrow', walletFiltered: true },
  { family: 'CommitBondReleased', source: 'escrow', walletFiltered: true },
  { family: 'FundsLocked', source: 'escrow', walletFiltered: true },
  { family: 'FundsRefunded', source: 'escrow', walletFiltered: true },
  { family: 'ProceedsBurned', source: 'escrow', walletFiltered: true },
  { family: 'AuctionEscrowFinalized', source: 'escrow', walletFiltered: false },
  { family: 'BidderRefundFailed', source: 'escrow', walletFiltered: true },
  { family: 'BidderRetried', source: 'escrow', walletFiltered: true },
  { family: 'FinalizationNoOp', source: 'escrow', walletFiltered: false },
  { family: 'Wired', source: 'escrow', walletFiltered: false },
];

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const asUint = (value: unknown, bits: number, label: string): bigint => {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) parsed = BigInt(value);
  else throw new TypeError(`${label} must be an unsigned integer.`);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (parsed < 0n || parsed > maximum) throw new RangeError(`${label} exceeds uint${bits}.`);
  return parsed;
};

const asSafeNumber = (value: unknown, label: string): number => {
  const parsed = asUint(value, 53, label);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} is not a safe integer.`);
  return Number(parsed);
};

const asOptionalSafeNumber = (value: unknown, label: string): number | null =>
  value === undefined || value === null ? null : asSafeNumber(value, label);

const asHex32 = (value: unknown, label: string): Hex => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${label} must be bytes32.`);
  }
  return value.toLowerCase() as Hex;
};

const asWorldwideDay = (value: unknown, label: string): WorldwideDayKey => {
  const parsed = parseWorldwideDayKey(asSafeNumber(value, label).toString().padStart(8, '0'));
  if (!parsed.ok) throw new TypeError(`${label} is not a valid WorldwideDay key.`);
  return parsed.value;
};

const eventFromAbi = (abi: Abi, family: WalletRecoveryEventFamily): AbiEvent => {
  const event = abi.find((entry) => entry.type === 'event' && entry.name === family);
  if (event?.type !== 'event') throw new TypeError(`Reviewed ABI is missing ${family}.`);
  return event;
};

const historyKey = (profile: ResolvedVenueReadProfile, wallet: Address): string =>
  namespaceKey({
    prefix: CACHE_PREFIX,
    version: CACHE_VERSION,
    chainId: profile.chainId,
    deploymentId: profile.deploymentId,
    contract: getAddress(profile.addresses.intexAuction),
    wallet: getAddress(wallet),
  });

const eventKey = (event: Pick<WalletRecoveryHistoryEvent, 'contract' | 'transactionHash' | 'logIndex'>): string =>
  `${event.contract.toLowerCase()}:${event.transactionHash.toLowerCase()}:${event.logIndex}`;

const epochKey = (epoch: Pick<RecoveryWiringEpoch, 'escrowContract' | 'transactionHash' | 'logIndex'>): string =>
  `${epoch.escrowContract.toLowerCase()}:${epoch.transactionHash.toLowerCase()}:${epoch.logIndex}`;

const compareProvenance = (
  left: Pick<WalletRecoveryHistoryEvent, 'blockNumber' | 'transactionIndex' | 'logIndex' | 'contract'>,
  right: Pick<WalletRecoveryHistoryEvent, 'blockNumber' | 'transactionIndex' | 'logIndex' | 'contract'>,
): number => {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
  const leftTx = left.transactionIndex ?? Number.MAX_SAFE_INTEGER;
  const rightTx = right.transactionIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftTx !== rightTx) return leftTx - rightTx;
  if (left.logIndex !== right.logIndex) return left.logIndex - right.logIndex;
  return left.contract.localeCompare(right.contract);
};

const parseLog = async (input: {
  readonly value: unknown;
  readonly family: WalletRecoveryEventFamily;
  readonly contract: Address;
  readonly client: AuctionReadClient;
  readonly blockHashes: Map<bigint, Promise<Hex>>;
}): Promise<{ event: WalletRecoveryHistoryEvent; args: Record<string, unknown> }> => {
  const raw = asRecord(input.value, `${input.family} log`);
  if (raw.removed === true) throw new TypeError(`${input.family} log is removed.`);
  const args = asRecord(raw.args, `${input.family} args`);
  const blockNumber = asUint(raw.blockNumber, 256, `${input.family} blockNumber`);
  const blockHash = asHex32(raw.blockHash, `${input.family} blockHash`);
  let expected = input.blockHashes.get(blockNumber);
  if (!expected) {
    expected = input.client
      .getBlock({ blockNumber })
      .then((value) => asHex32(asRecord(value, `block ${blockNumber}`).hash, `block ${blockNumber} hash`));
    input.blockHashes.set(blockNumber, expected);
  }
  if ((await expected).toLowerCase() !== blockHash.toLowerCase()) {
    throw new WalletRecoveryHistoryError(`${input.family} block hash no longer matches canonical chain state.`);
  }
  const worldwideDay =
    args.worldwideDay === undefined ? null : asWorldwideDay(args.worldwideDay, `${input.family} worldwideDay`);
  const bidder = args.bidder === undefined ? null : getAddress(String(args.bidder));
  return {
    args,
    event: {
      family: input.family,
      contract: getAddress(input.contract),
      worldwideDay,
      bidder,
      blockNumber,
      blockHash,
      transactionHash: asHex32(raw.transactionHash, `${input.family} transactionHash`),
      transactionIndex: asOptionalSafeNumber(raw.transactionIndex, `${input.family} transactionIndex`),
      logIndex: asSafeNumber(raw.logIndex, `${input.family} logIndex`),
    },
  };
};

const checkedSignal = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new WalletRecoveryHistoryAbortedError('Wallet recovery history scan was superseded.');
};

const scanSpec = async (input: {
  readonly client: AuctionReadClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly spec: EventSpec;
  readonly contract: Address;
  readonly wallet: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly blockHashes: Map<bigint, Promise<Hex>>;
  readonly signal?: AbortSignal;
}): Promise<{
  events: WalletRecoveryHistoryEvent[];
  epochs: RecoveryWiringEpoch[];
  rawAuctionWiring: { event: WalletRecoveryHistoryEvent; args: Record<string, unknown> }[];
}> => {
  if (input.fromBlock > input.toBlock) return { events: [], epochs: [], rawAuctionWiring: [] };
  const abi = input.spec.source === 'auction' ? input.profile.abis.intexAuction : input.profile.abis.escrowAdapter;
  const events: WalletRecoveryHistoryEvent[] = [];
  const epochs: RecoveryWiringEpoch[] = [];
  const rawAuctionWiring: { event: WalletRecoveryHistoryEvent; args: Record<string, unknown> }[] = [];
  try {
    const parsedLogs = await scanLogPages<{ event: WalletRecoveryHistoryEvent; args: Record<string, unknown> }>({
      client: input.client,
      address: input.contract,
      event: eventFromAbi(abi, input.spec.family),
      ...(input.spec.walletFiltered ? { args: { bidder: input.wallet } } : {}),
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
      pageSize: input.profile.logBatchSize,
      retryCount: input.profile.readRetryCount,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      errorMessage: ({ fromBlock, toBlock }) => `${input.spec.family} scan failed for blocks ${fromBlock}-${toBlock}`,
      decodeLog: (log) =>
        parseLog({
          value: log,
          family: input.spec.family,
          contract: input.contract,
          client: input.client,
          blockHashes: input.blockHashes,
        }),
      resultKey: (parsed) => eventKey(parsed.event),
      compare: (left, right) => compareProvenance(left.event, right.event),
    });
    for (const parsed of parsedLogs) {
      if (input.spec.walletFiltered && parsed.event.bidder !== getAddress(input.wallet)) {
        throw new WalletRecoveryHistoryError(`${input.spec.family} RPC filtering returned another bidder.`);
      }
      events.push(parsed.event);
      if (input.spec.family === 'EscrowWired') rawAuctionWiring.push(parsed);
      if (input.spec.family === 'Wired') {
        const auctionContract = getAddress(String(parsed.args.intexAuctionNew));
        const paymentToken = getAddress(String(parsed.args.paymentTokenNew));
        if (auctionContract !== zeroAddress && paymentToken !== zeroAddress) {
          epochs.push({
            escrowContract: getAddress(input.contract),
            auctionContract,
            paymentToken,
            blockNumber: parsed.event.blockNumber,
            blockHash: parsed.event.blockHash,
            transactionHash: parsed.event.transactionHash,
            logIndex: parsed.event.logIndex,
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof LogPageScanInterruptedError) throw new WalletRecoveryHistoryAbortedError(error.message);
    if (error instanceof LogPageScanError) {
      const cause = error.cause;
      throw new WalletRecoveryHistoryError(
        `${error.message}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    throw error;
  }
  return { events, epochs, rawAuctionWiring };
};

const serializeEvent = (event: WalletRecoveryHistoryEvent): Record<string, unknown> => ({
  ...event,
  blockNumber: event.blockNumber.toString(),
});

const parseStoredEvent = (value: unknown): WalletRecoveryHistoryEvent => {
  const raw = asRecord(value, 'stored recovery history event');
  if (
    typeof raw.family !== 'string' ||
    ![...AUCTION_EVENTS, ...ESCROW_EVENTS].some((spec) => spec.family === raw.family)
  ) {
    throw new TypeError('Stored recovery event family is unsupported.');
  }
  return {
    family: raw.family as WalletRecoveryEventFamily,
    contract: getAddress(String(raw.contract)),
    worldwideDay: raw.worldwideDay === null ? null : asWorldwideDay(raw.worldwideDay, 'stored event worldwideDay'),
    bidder: raw.bidder === null ? null : getAddress(String(raw.bidder)),
    blockNumber: asUint(raw.blockNumber, 256, 'stored event blockNumber'),
    blockHash: asHex32(raw.blockHash, 'stored event blockHash'),
    transactionHash: asHex32(raw.transactionHash, 'stored event transactionHash'),
    transactionIndex: asOptionalSafeNumber(raw.transactionIndex, 'stored event transactionIndex'),
    logIndex: asSafeNumber(raw.logIndex, 'stored event logIndex'),
  };
};

const serializeEpoch = (epoch: RecoveryWiringEpoch): Record<string, unknown> => ({
  ...epoch,
  blockNumber: epoch.blockNumber.toString(),
});

const parseStoredEpoch = (value: unknown): RecoveryWiringEpoch => {
  const raw = asRecord(value, 'stored recovery wiring epoch');
  return {
    escrowContract: getAddress(String(raw.escrowContract)),
    auctionContract: getAddress(String(raw.auctionContract)),
    paymentToken: getAddress(String(raw.paymentToken)),
    blockNumber: asUint(raw.blockNumber, 256, 'stored epoch blockNumber'),
    blockHash: asHex32(raw.blockHash, 'stored epoch blockHash'),
    transactionHash: asHex32(raw.transactionHash, 'stored epoch transactionHash'),
    logIndex: asSafeNumber(raw.logIndex, 'stored epoch logIndex'),
  };
};

const parseEnvelope = (rawJson: string, profile: ResolvedVenueReadProfile, wallet: Address): CachedHistory => {
  const raw = asRecord(JSON.parse(rawJson), 'wallet recovery history cache');
  if (
    raw.schemaVersion !== CACHE_VERSION ||
    raw.chainId !== profile.chainId ||
    raw.deploymentId !== profile.deploymentId ||
    getAddress(String(raw.auctionContract)) !== getAddress(profile.addresses.intexAuction) ||
    getAddress(String(raw.wallet)) !== getAddress(wallet)
  ) {
    throw new TypeError('Wallet recovery history cache namespace is incompatible.');
  }
  if (!Array.isArray(raw.events) || !Array.isArray(raw.wiringEpochs)) {
    throw new TypeError('Wallet recovery history cache arrays are malformed.');
  }
  const lastCompletelyScannedBlock = asUint(raw.lastCompletelyScannedBlock, 256, 'wallet history cursor');
  const events = raw.events.map(parseStoredEvent);
  const epochs = raw.wiringEpochs.map(parseStoredEpoch);
  if (
    events.some(
      (event) => event.blockNumber < profile.deploymentBlock || event.blockNumber > lastCompletelyScannedBlock,
    )
  ) {
    throw new TypeError('Wallet recovery history event lies outside the completed scan range.');
  }
  if (
    epochs.some(
      (epoch) => epoch.blockNumber < profile.deploymentBlock || epoch.blockNumber > lastCompletelyScannedBlock,
    )
  ) {
    throw new TypeError('Wallet recovery wiring epoch lies outside the completed scan range.');
  }
  if (new Set(events.map(eventKey)).size !== events.length || new Set(epochs.map(epochKey)).size !== epochs.length) {
    throw new TypeError('Wallet recovery history cache contains duplicate records.');
  }
  return {
    lastCompletelyScannedBlock,
    checkpointBlockHash: asHex32(raw.checkpointBlockHash, 'wallet history checkpoint hash'),
    events,
    wiringEpochs: epochs,
  };
};

const envelopeJson = (input: {
  readonly profile: ResolvedVenueReadProfile;
  readonly wallet: Address;
  readonly head: bigint;
  readonly checkpointHash: Hex;
  readonly events: readonly WalletRecoveryHistoryEvent[];
  readonly epochs: readonly RecoveryWiringEpoch[];
}): string =>
  JSON.stringify({
    schemaVersion: CACHE_VERSION,
    chainId: input.profile.chainId,
    deploymentId: input.profile.deploymentId,
    auctionContract: getAddress(input.profile.addresses.intexAuction),
    wallet: getAddress(input.wallet),
    lastCompletelyScannedBlock: input.head.toString(),
    checkpointBlockHash: input.checkpointHash,
    events: input.events.map(serializeEvent),
    wiringEpochs: input.epochs.map(serializeEpoch),
  } satisfies StoredHistoryEnvelope);

const mergeEvents = (
  retained: readonly WalletRecoveryHistoryEvent[],
  scanned: readonly WalletRecoveryHistoryEvent[],
): readonly WalletRecoveryHistoryEvent[] => {
  const result = new Map<string, WalletRecoveryHistoryEvent>();
  for (const event of [...retained, ...scanned]) result.set(eventKey(event), event);
  return [...result.values()].sort(compareProvenance);
};

const mergeEpochs = (
  retained: readonly RecoveryWiringEpoch[],
  scanned: readonly RecoveryWiringEpoch[],
): readonly RecoveryWiringEpoch[] => {
  const result = new Map<string, RecoveryWiringEpoch>();
  for (const epoch of [...retained, ...scanned]) result.set(epochKey(epoch), epoch);
  return [...result.values()].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
    return left.logIndex - right.logIndex;
  });
};

const escrowAddressesFromAuctionEvents = (
  events: readonly WalletRecoveryHistoryEvent[],
  profile: ResolvedVenueReadProfile,
  rawLogs: readonly { event: WalletRecoveryHistoryEvent; args: Record<string, unknown> }[] = [],
): Address[] => {
  const addresses = new Set<string>([getAddress(profile.addresses.escrowAdapter).toLowerCase()]);
  for (const item of rawLogs) {
    if (item.event.family !== 'EscrowWired') continue;
    for (const field of ['previous', 'current'] as const) {
      const address = getAddress(String(item.args[field]));
      if (address !== zeroAddress) addresses.add(address.toLowerCase());
    }
  }
  for (const event of events) {
    if (event.family === 'Wired') addresses.add(event.contract.toLowerCase());
  }
  return [...addresses].map((address) => getAddress(address));
};

const readAddress = async (
  client: AuctionReadClient,
  profile: ResolvedVenueReadProfile,
  escrow: Address,
  functionName: 'intexAuctionContract' | 'paymentToken',
): Promise<Address> =>
  getAddress(
    String(
      await client.readContract({
        address: escrow,
        abi: profile.abis.escrowAdapter,
        functionName,
      }),
    ),
  );

const validateEscrows = async (input: {
  readonly client: AuctionReadClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly escrowAddresses: readonly Address[];
  readonly epochs: readonly RecoveryWiringEpoch[];
}): Promise<readonly RecoveryEscrowHistoryContract[]> =>
  Promise.all(
    input.escrowAddresses.map(async (escrow) => {
      let custody: 'current' | 'historical' =
        getAddress(escrow) === getAddress(input.profile.addresses.escrowAdapter) ? 'current' : 'historical';
      try {
        const code = await input.client.getBytecode({ address: escrow });
        if (!code || code === '0x') throw new Error('No deployed bytecode is present.');
        const [auction, paymentToken] = await Promise.all([
          readAddress(input.client, input.profile, escrow, 'intexAuctionContract'),
          readAddress(input.client, input.profile, escrow, 'paymentToken'),
          input.client.readContract({
            address: escrow,
            abi: input.profile.abis.escrowAdapter,
            functionName: 'COMMIT_BOND_ABANDON_DELAY',
          }),
          input.client.readContract({
            address: escrow,
            abi: input.profile.abis.escrowAdapter,
            functionName: 'UNFINALIZED_REFUND_DELAY',
          }),
          input.client.readContract({
            address: escrow,
            abi: input.profile.abis.escrowAdapter,
            functionName: 'POST_FINALIZE_REFUND_DELAY',
          }),
          input.client.readContract({
            address: escrow,
            abi: input.profile.abis.escrowAdapter,
            functionName: 'NO_SPLIT_REFUND_DELAY',
          }),
        ]);
        const matchingEpochs = input.epochs.filter((epoch) => getAddress(epoch.escrowContract) === getAddress(escrow));
        const associated = [...matchingEpochs]
          .reverse()
          .find((epoch) => getAddress(epoch.auctionContract) === getAddress(input.profile.addresses.intexAuction));
        const currentMetadataMatch =
          getAddress(escrow) === getAddress(input.profile.addresses.escrowAdapter) &&
          auction === getAddress(input.profile.addresses.intexAuction) &&
          paymentToken === getAddress(input.profile.addresses.paymentToken);
        if (!associated && !currentMetadataMatch) {
          throw new Error(
            'No reviewed wiring epoch or current deployment metadata associates this escrow with the configured auction.',
          );
        }
        if (associated && getAddress(associated.paymentToken) !== paymentToken) {
          throw new Error('Historical payment-token wiring does not match the escrow getter.');
        }
        custody = currentMetadataMatch ? 'current' : 'historical';
        return {
          escrowContract: getAddress(escrow),
          paymentToken,
          associatedAuction: associated
            ? getAddress(associated.auctionContract)
            : getAddress(input.profile.addresses.intexAuction),
          custody,
          compatible: true,
          compatibilityError: null,
        };
      } catch (error) {
        return {
          escrowContract: getAddress(escrow),
          paymentToken: null,
          associatedAuction: null,
          custody,
          compatible: false,
          compatibilityError: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

export const browserWalletRecoveryHistoryStorage = (): WalletRecoveryHistoryStorage | null => browserStorage();

export const loadWalletRecoveryHistory = async (input: {
  readonly client: AuctionReadClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly wallet: Address;
  readonly storage?: WalletRecoveryHistoryStorage | null;
  readonly signal?: AbortSignal;
}): Promise<WalletRecoveryHistory> => {
  const storageInput = input.storage === undefined ? browserWalletRecoveryHistoryStorage() : input.storage;
  let storage = storageInput;
  let storageReadable = storage !== null;
  let storageWarning: string | null = null;
  const key = historyKey(input.profile, input.wallet);
  const latest = await input.client.getBlockNumber();
  const depth = BigInt(input.profile.confirmationDepth);
  const confirmedHead = latest > depth ? latest - depth : 0n;
  const blockHashes = new Map<bigint, Promise<Hex>>();
  let cached: CachedHistory | null = null;
  let invalidCache = false;
  let reorg = false;

  if (storage) {
    try {
      const raw = storage.getItem(key);
      if (raw !== null) cached = parseEnvelope(raw, input.profile, input.wallet);
    } catch (error) {
      invalidCache = true;
      try {
        storage.removeItem(key);
      } catch {
        /* advisory cleanup */
      }
      storageWarning = `Stored recovery history was rebuilt: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (cached) {
    if (cached.lastCompletelyScannedBlock > confirmedHead) {
      reorg = true;
      cached = null;
    } else {
      const checkpoint = asRecord(
        await input.client.getBlock({ blockNumber: cached.lastCompletelyScannedBlock }),
        'wallet history checkpoint block',
      );
      if (
        asHex32(checkpoint.hash, 'wallet history checkpoint hash').toLowerCase() !==
        cached.checkpointBlockHash.toLowerCase()
      ) {
        reorg = true;
        cached = null;
      }
    }
    if (reorg) {
      try {
        storage?.removeItem(key);
      } catch {
        /* advisory cleanup */
      }
      storageWarning = 'Stored recovery history checkpoint changed and was rebuilt from deployment.';
    }
  }

  if (cached && cached.lastCompletelyScannedBlock === confirmedHead) {
    const knownEscrows = new Set<string>([getAddress(input.profile.addresses.escrowAdapter).toLowerCase()]);
    cached.wiringEpochs.forEach((epoch) => {
      knownEscrows.add(epoch.escrowContract.toLowerCase());
    });
    const escrows = await validateEscrows({
      client: input.client,
      profile: input.profile,
      escrowAddresses: [...knownEscrows].map((address) => getAddress(address)),
      epochs: cached.wiringEpochs,
    });
    const walletAddress = getAddress(input.wallet);
    const candidates = [
      ...new Set(
        cached.events
          .filter((event) => event.bidder === walletAddress && event.worldwideDay !== null)
          .map((event) => event.worldwideDay!),
      ),
    ].sort();
    return {
      confirmedThroughBlock: confirmedHead,
      candidates,
      events: cached.events,
      wiringEpochs: cached.wiringEpochs,
      escrows,
      cacheStatus: 'cache-hit',
      storageWarning,
    };
  }

  const deploymentBlock = input.profile.deploymentBlock;
  let scanFrom = deploymentBlock;
  let retainedEvents: readonly WalletRecoveryHistoryEvent[] = [];
  let retainedEpochs: readonly RecoveryWiringEpoch[] = [];
  if (cached) {
    const overlap = BigInt(input.profile.confirmationDepth);
    scanFrom =
      cached.lastCompletelyScannedBlock >= overlap ? cached.lastCompletelyScannedBlock - overlap + 1n : deploymentBlock;
    if (scanFrom < deploymentBlock) scanFrom = deploymentBlock;
    retainedEvents = cached.events.filter((event) => event.blockNumber < scanFrom);
    retainedEpochs = cached.wiringEpochs.filter((epoch) => epoch.blockNumber < scanFrom);
  }

  const auctionEvents: WalletRecoveryHistoryEvent[] = [];
  const rawAuctionWiring: { event: WalletRecoveryHistoryEvent; args: Record<string, unknown> }[] = [];
  for (const spec of AUCTION_EVENTS) {
    const scanned = await scanSpec({
      client: input.client,
      profile: input.profile,
      spec,
      contract: input.profile.addresses.intexAuction,
      wallet: input.wallet,
      fromBlock: scanFrom,
      toBlock: confirmedHead,
      blockHashes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    auctionEvents.push(...scanned.events);
    rawAuctionWiring.push(...scanned.rawAuctionWiring);
  }

  const knownFromCache = new Set<string>([getAddress(input.profile.addresses.escrowAdapter).toLowerCase()]);
  retainedEpochs.forEach((epoch) => {
    knownFromCache.add(epoch.escrowContract.toLowerCase());
  });
  const discovered = escrowAddressesFromAuctionEvents(
    [...retainedEvents, ...auctionEvents],
    input.profile,
    rawAuctionWiring,
  );
  discovered.forEach((address) => {
    knownFromCache.add(address.toLowerCase());
  });
  const escrowEvents: WalletRecoveryHistoryEvent[] = [];
  const scannedEpochs: RecoveryWiringEpoch[] = [];
  for (const escrowRaw of knownFromCache) {
    const escrow = getAddress(escrowRaw);
    const existedBefore =
      retainedEpochs.some((epoch) => epoch.escrowContract === escrow) ||
      retainedEvents.some((event) => event.contract === escrow);
    const escrowScanFrom = existedBefore ? scanFrom : deploymentBlock;
    for (const spec of ESCROW_EVENTS) {
      const scanned = await scanSpec({
        client: input.client,
        profile: input.profile,
        spec,
        contract: escrow,
        wallet: input.wallet,
        fromBlock: escrowScanFrom,
        toBlock: confirmedHead,
        blockHashes,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      escrowEvents.push(...scanned.events);
      scannedEpochs.push(...scanned.epochs);
    }
  }

  checkedSignal(input.signal);
  const events = mergeEvents(retainedEvents, [...auctionEvents, ...escrowEvents]);
  const epochs = mergeEpochs(retainedEpochs, scannedEpochs);
  const checkpoint = asRecord(await input.client.getBlock({ blockNumber: confirmedHead }), 'wallet history head block');
  const checkpointHash = asHex32(checkpoint.hash, 'wallet history head hash');

  let cacheStatus: WalletRecoveryHistoryCacheStatus = cached
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
      const serialized = envelopeJson({
        profile: input.profile,
        wallet: input.wallet,
        head: confirmedHead,
        checkpointHash,
        events,
        epochs,
      });
      storage.setItem(key, serialized);
      const readBack = storage.getItem(key);
      if (readBack === null) throw new Error('Stored recovery history was not readable after write.');
      parseEnvelope(readBack, input.profile, input.wallet);
    } catch (error) {
      cacheStatus = 'storage-write-failed';
      storageWarning = `Recovery history could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
      storageReadable = false;
      storage = null;
    }
  }
  void storageReadable;

  const escrowAddresses = new Set<string>([getAddress(input.profile.addresses.escrowAdapter).toLowerCase()]);
  epochs.forEach((epoch) => {
    escrowAddresses.add(epoch.escrowContract.toLowerCase());
  });
  const escrows = await validateEscrows({
    client: input.client,
    profile: input.profile,
    escrowAddresses: [...escrowAddresses].map((address) => getAddress(address)),
    epochs,
  });
  const walletAddress = getAddress(input.wallet);
  const candidates = [
    ...new Set(
      events
        .filter((event) => event.bidder === walletAddress && event.worldwideDay !== null)
        .map((event) => event.worldwideDay!),
    ),
  ].sort();

  return {
    confirmedThroughBlock: confirmedHead,
    candidates,
    events,
    wiringEpochs: epochs,
    escrows,
    cacheStatus,
    storageWarning,
  };
};
