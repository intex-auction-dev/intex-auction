import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { auctionRoute, worldwideDay } from '../support/scenario';
import { advanceTo as advance, control, seedCommitOpen, seedScenario } from '../support/local-commands';
import { createPublicClient, getAddress, http, type Abi, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const ROOT = resolve(import.meta.dirname, '../../..');
const WORLDWIDE_DAY = worldwideDay;
const RPC_PORT = process.env.ITX_LOCAL_RPC_PORT ?? '8545';
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const MNEMONIC = 'test test test test test test test test test test test junk';
const bidderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

interface Deployment {
  readonly bidder: Address;
  readonly escrowAdapter: Address;
  readonly intexAuction: Address;
  readonly wcoen: Address;
}

interface WalletRequest {
  readonly method: string;
  readonly params?: unknown;
}

const json = <T>(path: string): T => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
const abi = (name: string): Abi => json<Abi>(`.local/config/abi/${name}.json`);
const deployment = (): Deployment => json<Deployment>('.local/deployment.json');
const publicClient = () => createPublicClient({ transport: http(RPC_URL) });

const installInjectedWallet = async (page: Page): Promise<void> => {
  const bidder = bidderAccount.address;
  await page.exposeFunction('__itxE2eSignTypedData', async (account: string, payload: string) => {
    if (getAddress(account) !== bidder) throw new Error('Unexpected E2E signing account.');
    return bidderAccount.signTypedData(JSON.parse(payload) as Parameters<typeof bidderAccount.signTypedData>[0]);
  });
  await page.addInitScript(
    ({ rpcUrl, bidderAddress }) => {
      type Listener = (...args: unknown[]) => void;
      const requests: WalletRequest[] = [];
      const listeners = new Map<string, Set<Listener>>();
      let nextId = 1;
      const global = globalThis as typeof globalThis & {
        __itxE2eSignTypedData(account: string, payload: string): Promise<Hex>;
        __itxE2eWalletRequests: WalletRequest[];
        ethereum: unknown;
      };

      // This EIP-1193 test excludes extension UI; add extension automation if release-critical.
      const provider = {
        async request({ method, params }: WalletRequest): Promise<unknown> {
          requests.push(
            params === undefined ? { method } : (JSON.parse(JSON.stringify({ method, params })) as WalletRequest),
          );
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [bidderAddress];
          if (method === 'eth_chainId') return '0x7a69';
          if (method === 'eth_signTypedData_v4') {
            const [account, payload] = params as readonly [string, string];
            return global.__itxE2eSignTypedData(account, payload);
          }
          if (method === 'wallet_switchEthereumChain') return null;

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
    { rpcUrl: RPC_URL, bidderAddress: bidder },
  );
};

const connectWallet = async (page: Page): Promise<void> => {
  await page.goto(auctionRoute);
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await page.getByRole('button', { name: /Injected wallet/ }).click();
  await expect(page.getByRole('button', { name: new RegExp(bidderAccount.address.slice(0, 6), 'i') })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit Sealed Bid', exact: true })).toBeEnabled();
};

const commitBid = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Commit Sealed Bid', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Quantity', exact: true })).not.toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Bid rate', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Your sealed bid' })).toBeVisible();
};

const walletRequests = (page: Page): Promise<WalletRequest[]> =>
  page.evaluate(
    () => (globalThis as typeof globalThis & { __itxE2eWalletRequests: WalletRequest[] }).__itxE2eWalletRequests,
  );

const sentTransactions = (requests: readonly WalletRequest[]) =>
  requests
    .filter((request) => request.method === 'eth_sendTransaction')
    .map((request) => {
      const [transaction] = request.params as readonly [{ to: Address; data?: Hex; input?: Hex }];
      const data = transaction.data ?? transaction.input;
      if (!data) throw new Error('E2E wallet transaction has no calldata.');
      return { to: getAddress(transaction.to), data };
    });

const liveBidderState = async () => {
  const contracts = deployment();
  const client = publicClient();
  const [commitHash, bond, allowance, revealed, lock] = await Promise.all([
    client.readContract({
      address: contracts.intexAuction,
      abi: abi('IntexAuction'),
      functionName: 'committedBidsByHash',
      args: [WORLDWIDE_DAY, bidderAccount.address],
    }),
    client.readContract({
      address: contracts.escrowAdapter,
      abi: abi('EscrowAdapter'),
      functionName: 'getCommitBond',
      args: [WORLDWIDE_DAY, bidderAccount.address],
    }),
    client.readContract({
      address: contracts.wcoen,
      abi: abi('ERC20'),
      functionName: 'allowance',
      args: [bidderAccount.address, contracts.escrowAdapter],
    }),
    client.readContract({
      address: contracts.intexAuction,
      abi: abi('IntexAuction'),
      functionName: 'revealedBidsByBidder',
      args: [WORLDWIDE_DAY, bidderAccount.address],
    }),
    client.readContract({
      address: contracts.escrowAdapter,
      abi: abi('EscrowAdapter'),
      functionName: 'getBidLock',
      args: [WORLDWIDE_DAY, bidderAccount.address],
    }),
  ]);
  return { contracts, commitHash, bond, allowance, revealed, lock };
};

const tupleField = (value: unknown, name: string, index: number): unknown =>
  Array.isArray(value) ? value[index] : (value as Record<string, unknown>)[name];

test.beforeEach(async ({ page }) => {
  seedCommitOpen();
  await installInjectedWallet(page);
});

test('cancels and recommits the stored sealed bid without signing it again', async ({ page }) => {
  await connectWallet(page);
  await commitBid(page);

  await page.getByRole('button', { name: 'Cancel Commit' }).click();
  await expect(page.getByRole('heading', { name: 'Place your bid' })).toBeVisible();
  await commitBid(page);

  const requests = await walletRequests(page);
  expect(requests.filter((request) => request.method === 'eth_signTypedData_v4')).toHaveLength(1);
  expect(sentTransactions(requests)).toHaveLength(5);
  const state = await liveBidderState();
  expect(state.commitHash).not.toBe(`0x${'0'.repeat(64)}`);
  expect(tupleField(state.bond, 'amount', 0)).toBeGreaterThan(0n);
});

test('advances to reveal and locks the bid through the auction UI', async ({ page }) => {
  await connectWallet(page);
  await commitBid(page);

  advance('commit-end');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reveal your bid' })).toBeVisible();
  await page.getByRole('button', { name: 'Reveal Bid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reveal & Lock Funds' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve allowance' }).locator('svg.lucide-wallet')).toBeVisible();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Bid revealed' })).toBeVisible();

  const state = await liveBidderState();
  expect(state.revealed).toBe(true);
  expect(tupleField(state.lock, 'lockedAmount', 0)).toBeGreaterThan(0n);
  expect(Number(tupleField(state.lock, 'status', 2))).toBe(1);
  const requests = await walletRequests(page);
  expect(requests.filter((request) => request.method === 'eth_signTypedData_v4')).toHaveLength(0);
  expect(sentTransactions(requests)).toHaveLength(2);
});

const RIGHT_RAIL_AFTER = resolve(ROOT, 'docs/test-evidence/right-rail-parity/2026-08-07/after');
const rightRailShot = async (page: Page, name: string): Promise<void> => {
  const rail = page.locator('.auction-product-rail');
  await expect(rail).toBeVisible();
  await rail.screenshot({ path: resolve(RIGHT_RAIL_AFTER, `${name}.png`) });
};

test('AUDIT captures commit and cancellation right-rail parity states', async ({ page }) => {
  await page.goto(auctionRoute);
  await rightRailShot(page, 'product-after-01-place-bid');
  await connectWallet(page);
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await rightRailShot(page, 'product-after-02-commit-form');
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await rightRailShot(page, 'product-after-03-commit-confirm');
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Your sealed bid' })).toBeVisible();
  await rightRailShot(page, 'product-after-04-committed');
  await page.getByRole('button', { name: 'Cancel Commit' }).click();
  await expect(page.getByRole('heading', { name: 'Place your bid' })).toBeVisible();
  await rightRailShot(page, 'product-after-05-cancelled');
});

test('AUDIT captures missing receipt, reveal prompt, reveal flow, and revealed receipt', async ({ page }) => {
  await connectWallet(page);
  await commitBid(page);
  await page.evaluate(() => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('itx-acn:reveal-material:v1:')) localStorage.removeItem(key);
    }
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reveal receipt missing' })).toBeVisible();
  await rightRailShot(page, 'product-after-06-missing-receipt');

  seedCommitOpen();
  await page.reload();
  await commitBid(page);
  advance('commit-end');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reveal your bid' })).toBeVisible();
  await rightRailShot(page, 'product-after-07-reveal-prompt');
  await page.getByRole('button', { name: 'Reveal Bid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reveal & Lock Funds' })).toBeVisible();
  await rightRailShot(page, 'product-after-08-reveal-flow');
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Bid revealed' })).toBeVisible();
  await rightRailShot(page, 'product-after-09-revealed');
});

test('AUDIT captures sale winner and no-sale terminal right-rail states', async ({ page }) => {
  await connectWallet(page);
  await commitBid(page);
  advance('commit-end');
  await page.reload();
  await page.getByRole('button', { name: 'Reveal Bid', exact: true }).click();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Bid revealed' })).toBeVisible();
  control('clearing');
  control('complete-sale');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your result' })).toBeVisible();
  await rightRailShot(page, 'product-after-10-result-sale');

  seedCommitOpen();
  await page.reload();
  await commitBid(page);
  advance('commit-end');
  await page.reload();
  await page.getByRole('button', { name: 'Reveal Bid', exact: true }).click();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  control('clearing');
  control('no-sale');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your result' })).toBeVisible();
  await rightRailShot(page, 'product-after-11-result-no-sale');
});

test('AUDIT captures no-bid cancellation, observer result, and red-day cancellation rail', async ({ page }) => {
  seedScenario('completed-green-no-sale');
  await page.goto(auctionRoute);
  await expect(page.getByRole('heading', { name: 'Your result' })).toBeVisible();
  await rightRailShot(page, 'product-after-12-no-bid-cancellation');

  seedScenario('completed-green-sold-out');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your result' })).toBeVisible();
  await rightRailShot(page, 'product-after-13-result-observer');

  seedScenario('completed-red');
  await page.reload();
  await page.screenshot({
    path: resolve(RIGHT_RAIL_AFTER, 'product-after-14-series-cancelled-full.png'),
    fullPage: true,
  });
});
