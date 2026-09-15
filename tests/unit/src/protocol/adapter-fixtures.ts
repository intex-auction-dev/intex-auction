import { parseAbi, type Abi, type Address, type Hex } from 'viem';
import type { OutbeDeploymentProfile, VenueDeploymentProfile } from '@/chain/deployment-profile';
import { parseWorldwideDayKey } from '@/domain/protocol-time';
import type { AuctionReadClient } from '@/protocol/read-client';

export const ABI = [] as Abi;
export const address = (digit: string): Address => `0x${digit.repeat(40)}` as Address;
export const METADOSIS = address('1');
export const DESIS = address('2');
export const ORIGIN_ROUTER = address('3');
export const ORACLE = address('4');
export const INTEX = address('5');
export const AUCTION = address('6');
export const ESCROW = address('7');
export const TARGET_ROUTER = address('8');
export const NFT = address('9');
export const PAYMENT = address('a');
export const IMPLEMENTATION = address('b');
export const COEN = address('0');
export const USD_QUOTE = address('b');

export const key = (contract: Address, functionName: string): string => `${contract.toLowerCase()}:${functionName}`;

export class FakeClient implements AuctionReadClient {
  readonly readNames: string[] = [];
  chainReads = 0;
  bytecodeReads = 0;

  constructor(
    private readonly chainId: number,
    private readonly reads: ReadonlyMap<string, unknown>,
    private readonly bytecodes: ReadonlyMap<string, Hex> = new Map(),
    private readonly logs: readonly unknown[] = [],
    private readonly storage: ReadonlyMap<string, Hex> = new Map(),
  ) {}

  async readContract(request: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown> {
    this.readNames.push(request.functionName);
    const lookup = key(request.address, request.functionName);
    if (!this.reads.has(lookup)) throw new Error(`Missing fake read: ${lookup}`);
    const value = this.reads.get(lookup);
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(request);
    return value;
  }

  async getChainId(): Promise<number> {
    this.chainReads += 1;
    return this.chainId;
  }

  async getBalance(): Promise<bigint> {
    return 0n;
  }

  async getBlockNumber(): Promise<bigint> {
    return 100n;
  }

  async getBlock(request: { blockNumber: bigint }): Promise<unknown> {
    return { number: request.blockNumber, hash: `0x${'1'.repeat(64)}`, timestamp: 1n };
  }

  async getBytecode(request: { address: Address }): Promise<Hex | undefined> {
    this.bytecodeReads += 1;
    return this.bytecodes.get(request.address.toLowerCase());
  }

  async getStorageAt(request: { address: Address; slot: Hex }): Promise<Hex | undefined> {
    return this.storage.get(`${request.address.toLowerCase()}:${request.slot.toLowerCase()}`);
  }

  async getLogs(): Promise<readonly unknown[]> {
    return this.logs;
  }
}

export const outbeProfile = (): OutbeDeploymentProfile => ({
  chainId: 31337,
  deploymentBlock: 1n,
  addresses: {
    metadosis: METADOSIS,
    desis: DESIS,
    originRouter: ORIGIN_ROUTER,
    oracle: ORACLE,
    intex: INTEX,
  },
  abis: {
    metadosis: ABI,
    desis: ABI,
    originRouter: ABI,
    oracle: ABI,
    intex: ABI,
  },
});

export const venueProfile = (): VenueDeploymentProfile => ({
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

export const reviewedVenueProfile = (): VenueDeploymentProfile => {
  const profile = venueProfile();
  profile.addresses.intexAuctionImplementation = IMPLEMENTATION;
  return profile;
};

export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
export const implementationStorage = (implementation: Address): Map<string, Hex> =>
  new Map([
    [`${AUCTION.toLowerCase()}:${ERC1967_IMPLEMENTATION_SLOT}`, `0x${'0'.repeat(24)}${implementation.slice(2)}` as Hex],
  ]);

export const reviewedVenueReads = (overrides: ReadonlyMap<string, unknown> = new Map()): Map<string, unknown> =>
  new Map([
    [key(TARGET_ROUTER, 'auction'), AUCTION],
    [key(TARGET_ROUTER, 'escrowAdapter'), ESCROW],
    [key(TARGET_ROUTER, 'intex'), NFT],
    [key(AUCTION, 'escrowContract'), ESCROW],
    [key(ESCROW, 'intexAuctionContract'), AUCTION],
    [key(ESCROW, 'paymentToken'), PAYMENT],
    [key(AUCTION, 'eip712Domain'), ['0x0f', 'IntexAuction', '1', 31337n, AUCTION, `0x${'0'.repeat(64)}`, []]],
    ...overrides,
  ]);

export const worldwideDay = () => {
  const parsed = parseWorldwideDayKey('20260803');
  if (!parsed.ok) throw new Error('Test WorldwideDay is invalid.');
  return parsed.value;
};

export const codeMap = (...addresses: Address[]): Map<string, Hex> =>
  new Map(addresses.map((value) => [value.toLowerCase(), '0x6000' as Hex]));

export const decodedRevert = (errorName: string, args: readonly unknown[] = []): Error =>
  Object.assign(new Error(errorName), { data: { errorName, args } });

export const metadosisEventAbi = parseAbi([
  'event WorldwideDayCleanedUp(uint32 indexed worldwideDay,uint8 finalStatus)',
]);
