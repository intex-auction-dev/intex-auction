import type { Abi, AbiEvent, Address, Hex } from 'viem';

export interface RpcDiagnosticCounter {
  readonly count: number;
  readonly failures: number;
}

export interface RpcDiagnosticComponentCounter extends RpcDiagnosticCounter {
  readonly component: string;
}

export interface RpcDiagnosticMethodCounter extends RpcDiagnosticCounter {
  readonly method: string;
}

export interface RpcDiagnosticComponentMethodCounter extends RpcDiagnosticCounter {
  readonly component: string;
  readonly method: string;
}

export interface RpcDiagnosticsSnapshot {
  readonly total: number;
  readonly failures: number;
  readonly inFlight: number;
  readonly byComponent: readonly RpcDiagnosticComponentCounter[];
  readonly byMethod: readonly RpcDiagnosticMethodCounter[];
  readonly byComponentMethod: readonly RpcDiagnosticComponentMethodCounter[];
}

interface MutableCounter {
  count: number;
  failures: number;
}

interface RpcDiagnosticsState {
  total: number;
  failures: number;
  inFlight: number;
  byComponent: Map<string, MutableCounter>;
  byMethod: Map<string, MutableCounter>;
  byComponentMethod: Map<string, MutableCounter>;
}

type RpcDiagnosticsApi = {
  snapshot(): RpcDiagnosticsSnapshot;
  reset(): void;
};

declare global {
  var __ITX_RPC_DIAGNOSTICS__: RpcDiagnosticsApi | undefined;
}

const state: RpcDiagnosticsState = {
  total: 0,
  failures: 0,
  inFlight: 0,
  byComponent: new Map(),
  byMethod: new Map(),
  byComponentMethod: new Map(),
};

const enabled = (): boolean => import.meta.env.DEV;

const bump = (map: Map<string, MutableCounter>, key: string, failed: boolean): void => {
  const current = map.get(key) ?? { count: 0, failures: 0 };
  current.count += 1;
  if (failed) current.failures += 1;
  map.set(key, current);
};

const sorted = <T extends { count: number; failures: number }>(
  map: ReadonlyMap<string, MutableCounter>,
  mapEntry: (key: string, value: MutableCounter) => T,
): readonly T[] =>
  [...map.entries()]
    .map(([key, value]) => mapEntry(key, value))
    .sort((left, right) => right.count - left.count || JSON.stringify(left).localeCompare(JSON.stringify(right)));

export const rpcDiagnosticsSnapshot = (): RpcDiagnosticsSnapshot => ({
  total: state.total,
  failures: state.failures,
  inFlight: state.inFlight,
  byComponent: sorted(state.byComponent, (component, value) => ({ component, ...value })),
  byMethod: sorted(state.byMethod, (method, value) => ({ method, ...value })),
  byComponentMethod: sorted(state.byComponentMethod, (key, value) => {
    const separator = key.indexOf('\n');
    return {
      component: key.slice(0, separator),
      method: key.slice(separator + 1),
      ...value,
    };
  }),
});

export const resetRpcDiagnostics = (): void => {
  state.total = 0;
  state.failures = 0;
  state.inFlight = 0;
  state.byComponent.clear();
  state.byMethod.clear();
  state.byComponentMethod.clear();
};

const ensureGlobal = (): void => {
  if (!enabled() || globalThis.__ITX_RPC_DIAGNOSTICS__) return;
  globalThis.__ITX_RPC_DIAGNOSTICS__ = {
    snapshot: rpcDiagnosticsSnapshot,
    reset: resetRpcDiagnostics,
  };
};

export const recordRpcRequest = (component: string, method: string): ((failed?: boolean) => void) => {
  if (!enabled()) return () => {};
  ensureGlobal();
  state.total += 1;
  state.inFlight += 1;
  let finished = false;
  return (failed = false) => {
    if (finished) return;
    finished = true;
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (failed) state.failures += 1;
    bump(state.byComponent, component, failed);
    bump(state.byMethod, method, failed);
    bump(state.byComponentMethod, `${component}\n${method}`, failed);
  };
};

const contractMethod = (request: unknown): string => {
  const functionName =
    typeof request === 'object' && request !== null
      ? String((request as { functionName?: string }).functionName ?? 'unknown')
      : 'unknown';
  return `eth_call:${functionName}`;
};

const logsMethod = (request: unknown): string => {
  const event =
    typeof request === 'object' && request !== null
      ? (request as { event?: AbiEvent | { name?: string } }).event
      : undefined;
  return `eth_getLogs:${event?.name ?? 'unknown'}`;
};

const rpcMethod = (property: PropertyKey, request: unknown): string | null => {
  switch (property) {
    case 'readContract':
      return contractMethod(request);
    case 'getLogs':
      return logsMethod(request);
    case 'getBlock':
      return 'eth_getBlockByNumber';
    case 'getBlockNumber':
      return 'eth_blockNumber';
    case 'getBytecode':
      return 'eth_getCode';
    case 'getChainId':
      return 'eth_chainId';
    default:
      return null;
  }
};

export type RpcDiagnosticReadClient = {
  readContract?(request: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getChainId?(): Promise<number>;
  getBlockNumber?(): Promise<bigint>;
  getBlock?(request: { blockNumber: bigint }): Promise<unknown>;
  getBytecode?(request: { address: Address }): Promise<Hex | undefined>;
  getLogs?(request: {
    address?: Address;
    event?: AbiEvent;
    args?: Record<string, unknown>;
    fromBlock?: bigint;
    toBlock?: bigint | 'latest';
  }): Promise<readonly unknown[]>;
};

export const withRpcDiagnostics = <T extends RpcDiagnosticReadClient>(client: T, component: string): T =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const method = rpcMethod(property, undefined);
      if (method === null && property !== 'readContract' && property !== 'getLogs') {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        const resolvedMethod =
          property === 'readContract' || property === 'getLogs'
            ? (rpcMethod(property, args[0]) ?? String(property))
            : (method ?? String(property));
        const finish = recordRpcRequest(component, resolvedMethod);
        try {
          const result = value.apply(target, args);
          return Promise.resolve(result).then(
            (resolved) => {
              finish(false);
              return resolved;
            },
            (error) => {
              finish(true);
              throw error;
            },
          );
        } catch (error) {
          finish(true);
          throw error;
        }
      };
    },
  });

ensureGlobal();
