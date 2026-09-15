import { getAddress, type Address } from 'viem';

export interface Eip1193RequestArguments {
  method: string;
  params?: readonly unknown[] | Record<string, unknown>;
}

export interface Eip1193Provider {
  request(args: Eip1193RequestArguments): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  disconnect?(): Promise<void>;
}

export interface ProviderRequestFailure {
  code: number | string | null;
  message: string;
}

export const isEip1193Provider = (value: unknown): value is Eip1193Provider =>
  typeof value === 'object' && value !== null && typeof (value as { request?: unknown }).request === 'function';

export const parseWalletChainId = (value: unknown): number => {
  let parsed: bigint;
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    parsed = BigInt(value);
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === 'bigint') {
    parsed = value;
  } else {
    throw new TypeError('Wallet chain ID must be a hexadecimal quantity.');
  }
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Wallet chain ID is outside the supported integer range.');
  }
  return Number(parsed);
};

export const walletChainIdHex = (chainId: number): `0x${string}` => {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new RangeError('Configured chain ID must be a positive safe integer.');
  }
  return `0x${chainId.toString(16)}`;
};

export const parseWalletAccounts = (value: unknown): readonly Address[] => {
  if (!Array.isArray(value)) throw new TypeError('Wallet accounts response must be an array.');
  return value.map((account) => {
    if (typeof account !== 'string') throw new TypeError('Wallet account must be an address string.');
    return getAddress(account);
  });
};

export const normalizeProviderError = (error: unknown): ProviderRequestFailure => {
  if (error instanceof Error) {
    const code =
      'code' in error && (typeof error.code === 'number' || typeof error.code === 'string') ? error.code : null;
    return { code, message: error.message || 'Wallet request failed.' };
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === 'number' || typeof candidate.code === 'string' ? candidate.code : null,
      message:
        typeof candidate.message === 'string' && candidate.message.trim()
          ? candidate.message.trim()
          : 'Wallet request failed.',
    };
  }
  return { code: null, message: 'Wallet request failed.' };
};
