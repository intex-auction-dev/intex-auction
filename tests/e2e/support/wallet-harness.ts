import { getAddress, type Hex, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import type { Page } from '@playwright/test';

const MNEMONIC = 'test test test test test test test test test test test junk';
export const bidderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

const RPC_PORT = process.env.ITX_LOCAL_RPC_PORT ?? '8545';
export const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

export interface WalletRequest {
  readonly method: string;
  readonly params?: unknown;
}

export interface WalletQuirks {
  readonly signTypedDataDelayMs?: number;
  readonly rejectTypedData?: { readonly code: number; readonly message: string };
  readonly safeContractAccount?: boolean;
}

export const installConfigurableWallet = async (page: Page, quirks: WalletQuirks = {}): Promise<void> => {
  const bidder = bidderAccount.address;
  await page.exposeFunction('__itxE2eSignTypedData', async (account: string, payload: string) => {
    if (getAddress(account) !== bidder) throw new Error('Unexpected E2E signing account.');
    return bidderAccount.signTypedData(JSON.parse(payload) as Parameters<typeof bidderAccount.signTypedData>[0]);
  });
  await page.addInitScript(
    ({ rpcUrl, bidderAddress, quirks: q }) => {
      type Listener = (...args: unknown[]) => void;
      const requests: WalletRequest[] = [];
      const listeners = new Map<string, Set<Listener>>();
      let nextId = 1;
      const safeProposalHash = `0x${'5a'.repeat(32)}`;
      const global = globalThis as typeof globalThis & {
        __itxE2eSignTypedData(account: string, payload: string): Promise<Hex>;
        __itxE2eWalletRequests: WalletRequest[];
        ethereum: unknown;
      };

      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      const provider = {
        async request({ method, params }: WalletRequest): Promise<unknown> {
          requests.push(
            params === undefined ? { method } : (JSON.parse(JSON.stringify({ method, params })) as WalletRequest),
          );
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [bidderAddress];
          if (method === 'eth_chainId') return '0x7a69';
          if (method === 'eth_signTypedData_v4') {
            if (q.rejectTypedData) {
              throw Object.assign(new Error(q.rejectTypedData.message), { code: q.rejectTypedData.code });
            }
            if (q.signTypedDataDelayMs) await sleep(q.signTypedDataDelayMs);
            const [account, payload] = params as readonly [string, string];
            return global.__itxE2eSignTypedData(account, payload);
          }
          if (method === 'wallet_switchEthereumChain') return null;
          if (method === 'eth_sendTransaction' && q.safeContractAccount) {
            return safeProposalHash;
          }

          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: params ?? [] }),
          });
          const body = (await response.json()) as {
            result?: unknown;
            error?: { code?: number; message?: string; data?: unknown };
          };
          if (body.error) {
            throw Object.assign(new Error(body.error.message ?? 'Injected test wallet RPC failed.'), body.error);
          }
          return body.result;
        },
        on(event: string, listener: Listener) {
          const bucket = listeners.get(event) ?? new Set<Listener>();
          bucket.add(listener);
          listeners.set(event, bucket);
        },
        removeListener(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener);
        },
      };
      Object.defineProperty(global, 'ethereum', { configurable: true, value: provider });
      Object.defineProperty(global, '__itxE2eWalletRequests', { configurable: true, value: requests });
    },
    { rpcUrl: RPC_URL, bidderAddress: bidder, quirks },
  );
};

export const walletRequests = (page: Page): Promise<WalletRequest[]> =>
  page.evaluate(
    () => (globalThis as typeof globalThis & { __itxE2eWalletRequests: WalletRequest[] }).__itxE2eWalletRequests,
  );

export const sentTransactions = (requests: readonly WalletRequest[]) =>
  requests
    .filter((request) => request.method === 'eth_sendTransaction')
    .map((request) => {
      const [transaction] = request.params as readonly [{ to: Address; data?: Hex; input?: Hex }];
      return { to: getAddress(transaction.to), data: transaction.data ?? transaction.input };
    });

export const storedReceiptCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    let count = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      if (localStorage.key(i)?.startsWith('itx-acn:reveal-material:v1:')) count += 1;
    }
    return count;
  });
