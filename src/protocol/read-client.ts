import type { Abi, AbiEvent, Address, Hex, PublicClient } from 'viem';
import { IncompatibleDeploymentError } from '../chain/revert-classify';

export interface AuctionReadClient {
  readContract(request: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getBalance(request: { address: Address }): Promise<bigint>;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(request: { blockNumber: bigint }): Promise<unknown>;
  getBytecode(request: { address: Address }): Promise<Hex | undefined>;
  getStorageAt?(request: { address: Address; slot: Hex }): Promise<Hex | undefined>;
  getLogs(request: {
    address: Address;
    event: AbiEvent;
    args?: Readonly<Record<string, unknown>>;
    fromBlock: bigint;
    toBlock: bigint | 'latest';
  }): Promise<readonly unknown[]>;
}

export const fromViemPublicClient = (client: PublicClient): AuctionReadClient => ({
  readContract: (request) => client.readContract(request as never) as Promise<unknown>,
  getBalance: (request) => client.getBalance(request),
  getChainId: () => client.getChainId(),
  getBlockNumber: () => client.getBlockNumber(),
  getBlock: (request) => client.getBlock(request) as Promise<unknown>,
  getBytecode: (request) => client.getBytecode(request),
  getStorageAt: (request) => client.getStorageAt(request),
  getLogs: (request) => client.getLogs(request as never) as Promise<readonly unknown[]>,
});

export const requireCode = async (client: AuctionReadClient, label: string, address: Address): Promise<void> => {
  const bytecode = await client.getBytecode({ address });
  if (!bytecode || bytecode === '0x') {
    throw new IncompatibleDeploymentError(`${label} has no bytecode.`);
  }
};
