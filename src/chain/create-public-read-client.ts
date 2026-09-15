import { createPublicClient, http, type PublicClient } from 'viem';
import { diagnosticEndpoint, diagnosticError, emitDiagnostic } from '../diagnostics/local-diagnostics';
import { recordRpcRequest } from './rpc-diagnostics';

export interface PublicRpcReadProfile {
  id: string;
  chainId: number;
  rpcUrls: readonly string[];
  requestTimeoutMs: number;
  readRetryCount: number;
}

export interface SelectedPublicReadClient {
  client: PublicClient;
  rpcUrl: string;
}

export class RpcEndpointSelectionError extends Error {
  constructor(
    readonly profileId: string,
    readonly failures: readonly string[],
  ) {
    super(`No configured RPC endpoint is healthy for ${profileId}.`);
  }
}

export type PublicClientFactory = (rpcUrl: string, profile: PublicRpcReadProfile) => PublicClient;

const defaultFactory: PublicClientFactory = (rpcUrl, profile) =>
  createPublicClient({
    transport: http(rpcUrl, {
      timeout: profile.requestTimeoutMs,
      retryCount: profile.readRetryCount,
    }),
  });

export const createPublicReadClient = async (
  profile: PublicRpcReadProfile,
  factory: PublicClientFactory = defaultFactory,
): Promise<SelectedPublicReadClient> => {
  const failures: string[] = [];
  for (const rpcUrl of profile.rpcUrls) {
    const client = factory(rpcUrl, profile);
    const finishProbe = recordRpcRequest(`rpc-endpoint-probe:${profile.id}`, 'eth_chainId');
    const endpoint = diagnosticEndpoint(rpcUrl);
    try {
      const chainId = await client.getChainId();
      finishProbe(false);
      if (chainId !== profile.chainId) {
        const message = `Expected chain ${profile.chainId}; received ${chainId}.`;
        emitDiagnostic({
          category: 'rpc',
          event: 'error',
          component: 'endpoint-probe',
          profileId: profile.id,
          chainId: profile.chainId,
          endpoint,
          operation: 'eth_chainId',
          name: 'WrongChainError',
          message,
        });
        failures.push(`${rpcUrl}: expected chain ${profile.chainId}, received ${chainId}`);
        continue;
      }
      emitDiagnostic({
        category: 'rpc',
        event: 'selected',
        component: 'endpoint-probe',
        profileId: profile.id,
        chainId: profile.chainId,
        endpoint,
      });
      return { client, rpcUrl };
    } catch (error) {
      finishProbe(true);
      emitDiagnostic({
        category: 'rpc',
        event: 'error',
        component: 'endpoint-probe',
        profileId: profile.id,
        chainId: profile.chainId,
        endpoint,
        operation: 'eth_chainId',
        ...diagnosticError(error),
      });
      failures.push(`${rpcUrl}: ${error instanceof Error ? error.message : 'RPC probe failed'}`);
    }
  }
  throw new RpcEndpointSelectionError(profile.id, failures);
};
