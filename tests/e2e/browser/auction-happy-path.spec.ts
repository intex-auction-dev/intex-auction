import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { auctionRoute, worldwideDay } from '../support/scenario';
import { advanceTo as advance, seedCommitOpen, seedScenario } from '../support/local-commands';
import { createPublicClient, decodeFunctionData, getAddress, http, type Abi, type Address, type Hex } from 'viem';
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

test('refreshes the enriched final ladder with the lifecycle result', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(String(error)));
  page.on('console', (message) => {
    const source = message.location().url;
    const expectedOptional404 = source.endsWith('/__diagnostics/v1') || source.endsWith('/config/timing.json');
    if (message.type() === 'error' && !expectedOptional404) browserErrors.push(`${message.text()} (${source})`);
  });
  seedScenario('reveal-open');

  await page.goto(auctionRoute);
  await expect(
    page.getByLabel('Active-venue auction lifecycle').getByText('Reveal Bid', { exact: true }),
  ).toBeVisible();

  seedScenario('completed-green-sold-out');

  await expect(page.getByText('Series cleared at 8%. You had no revealed bid in this series.')).toBeVisible({
    timeout: 35_000,
  });
  await expect(page.getByRole('heading', { name: 'Final Bid Ladder' })).toBeVisible();
  await expect(page.getByRole('img', { name: /1 bids and 8% clearing rate/ })).toBeVisible();
  await expect(page.getByText(/5 Intexes demand · 5 Intexes supply/)).toBeVisible();
  await page.screenshot({ path: '.local/lifecycle-ladder-refresh.png', fullPage: true });
  expect(browserErrors).toEqual([]);
});

test('keeps all commit selectors centered, editable, and synchronized', async ({ page }) => {
  await connectWallet(page);
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();

  const quantity = page.getByRole('textbox', { name: 'Quantity', exact: true });
  const bidPerIntex = page.getByRole('textbox', { name: 'Bid per Intex', exact: true });
  const bidRate = page.getByRole('textbox', { name: 'Bid rate', exact: true });
  await expect(quantity).toHaveValue('1');
  await expect(bidPerIntex).toHaveValue('5000');
  await expect(bidRate).toHaveValue('5');

  const quantityWidth = await quantity.evaluate((input) => input.getBoundingClientRect().width);
  expect(quantityWidth).toBeLessThan(40);
  expect(await quantity.evaluate((input) => getComputedStyle(input).textAlign)).toBe('center');

  await quantity.fill('12');
  await quantity.blur();
  await expect(quantity).toHaveValue('12');
  await quantity.locator('xpath=../..').getByRole('button', { name: 'Increase' }).click();
  await expect(quantity).toHaveValue('13');

  await bidPerIntex.fill('6000');
  await bidPerIntex.blur();
  await expect(bidPerIntex).toHaveValue('6000');
  await expect(bidRate).toHaveValue('6');
  await bidPerIntex.locator('xpath=../..').getByRole('button', { name: 'Increase' }).click();
  await expect(bidPerIntex).toHaveValue('6500');
  await expect(bidRate).toHaveValue('6.5');

  await bidRate.fill('7.5');
  await bidRate.blur();
  await expect(bidRate).toHaveValue('7.5');
  await expect(bidPerIntex).toHaveValue('7500');
  await bidRate.locator('xpath=../..').getByRole('button', { name: 'Decrease' }).click();
  await expect(bidRate).toHaveValue('7');
  await expect(bidPerIntex).toHaveValue('7000');

  await page.screenshot({ path: '.local/commit-stepper-parity.png', fullPage: true });
});

test('approves the exact bond and commits through the auction UI', async ({ page }) => {
  await connectWallet(page);
  await commitBid(page);

  const state = await liveBidderState();
  const bondAmount = tupleField(state.bond, 'amount', 0) as bigint;
  expect(state.commitHash).not.toBe(`0x${'0'.repeat(64)}`);
  expect(bondAmount).toBeGreaterThan(0n);
  expect(state.allowance).toBe(0n);

  const transactions = sentTransactions(await walletRequests(page));
  expect(transactions).toHaveLength(2);
  expect(transactions[0]!.to).toBe(getAddress(state.contracts.wcoen));
  expect(decodeFunctionData({ abi: abi('ERC20'), data: transactions[0]!.data })).toEqual({
    functionName: 'approve',
    args: [getAddress(state.contracts.escrowAdapter), bondAmount],
  });
  expect(transactions[1]!.to).toBe(getAddress(state.contracts.intexAuction));
  expect(decodeFunctionData({ abi: abi('IntexAuction'), data: transactions[1]!.data }).functionName).toBe('commitBid');
});

test('lists the contract-enabled issuance currencies and signs the bidder-selected one', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(String(error)));
  page.on('console', (message) => {
    const source = message.location().url;
    const expectedOptional404 = source.endsWith('/__diagnostics/v1') || source.endsWith('/config/timing.json');
    if (message.type() === 'error' && !expectedOptional404) browserErrors.push(message.text());
  });

  await connectWallet(page);
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();

  const issuance = page.getByRole('combobox', { name: 'Issuance currency' });
  await expect(issuance).toBeVisible();
  await expect(issuance).toContainText('TRY');
  await issuance.click();
  for (const [alpha, numeric] of [
    ['USD', 840],
    ['EUR', 978],
    ['GBP', 826],
    ['CNY', 156],
    ['JPY', 392],
    ['HKD', 344],
  ] as const) {
    await expect(page.getByRole('option', { name: new RegExp(`^${alpha} · ${numeric} —`) })).toBeVisible();
  }
  await page.getByRole('option', { name: /^EUR · 978 —/ }).click();
  await expect(issuance).toContainText('EUR');

  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Your sealed bid' })).toBeVisible();

  const signing = (await walletRequests(page)).filter((request) => request.method === 'eth_signTypedData_v4');
  expect(signing).toHaveLength(1);
  const [, payload] = signing[0]!.params as readonly [string, string];
  const typed = JSON.parse(payload) as { message: { issuanceCurrency: number; referenceCurrency: number } };
  expect(typed.message.issuanceCurrency).toBe(978);
  expect(typed.message.referenceCurrency).toBe(840);
  expect(browserErrors).toEqual([]);
});

test('opens the bid receipt and keeps saved receipts in the header menu', async ({ page }) => {
  await connectWallet(page);
  await commitBid(page);

  await page.getByRole('button', { name: 'View Receipt' }).click();
  const receipt = page.getByRole('dialog', { name: 'Bid Receipt' });
  await expect(receipt).toBeVisible();
  await expect(receipt.getByText('Intex Series')).toBeVisible();
  await expect(receipt.getByText('Quantity', { exact: true })).toBeVisible();
  await expect(receipt.getByText('Bid rate', { exact: true })).toBeVisible();
  await expect(receipt.getByText('Total escrow at reveal')).toBeVisible();
  await expect(receipt.getByText('Total Promis')).toBeVisible();
  await expect(receipt.getByText('Commit hash')).toBeVisible();
  await expect(receipt.getByText('Chain ID')).toBeVisible();
  await expect(receipt.getByText('Bidder', { exact: true })).toBeVisible();
  await expect(receipt.getByText('Auction Contract')).toBeVisible();
  await expect(receipt.getByText('Your bid is stored in local storage by default.')).toBeVisible();
  await expect(receipt.getByRole('button', { name: 'Download bid receipt' })).toBeVisible();
  await expect(receipt.getByText('Local safety records')).toHaveCount(0);
  await page.screenshot({ path: '.local/bid-receipt-parity.png', fullPage: true });

  await receipt.getByRole('button', { name: 'Close bid receipt' }).click();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Bid receipts' }).click();
  const manager = page.getByRole('dialog', { name: 'Bid receipts' });
  await expect(manager).toBeVisible();
  await expect(manager.getByText('Local safety records')).toBeVisible();
  await expect(manager.getByText(`WorldwideDay ${worldwideDay}`)).toBeVisible();
});

test('reconstructs a cancelled v2 bid after reload and recommits it with a fresh exact approval', async ({ page }) => {
  await connectWallet(page);
  await commitBid(page);

  const committed = await liveBidderState();
  const originalCommitHash = committed.commitHash;
  const bondAmount = tupleField(committed.bond, 'amount', 0) as bigint;
  expect(bondAmount).toBeGreaterThan(0n);
  expect(committed.allowance).toBe(0n);

  await page.getByRole('button', { name: 'Cancel Commit' }).click();
  await expect(page.getByRole('heading', { name: 'Place your bid' })).toBeVisible();
  const cancelToast = page.locator('[data-sonner-toast]').filter({ hasText: 'Commit cancelled' });
  await expect(cancelToast).toContainText('Your commitment was cancelled and its commit bond was returned.');
  await expect(page.getByRole('button', { name: 'Claim Bond' })).toHaveCount(0);

  const cancelled = await liveBidderState();
  expect(cancelled.commitHash).toBe(`0x${'0'.repeat(64)}`);
  expect(tupleField(cancelled.bond, 'amount', 0)).toBe(0n);
  expect(cancelled.allowance).toBe(0n);
  const firstCycleRequests = await walletRequests(page);
  expect(firstCycleRequests.filter((request) => request.method === 'eth_signTypedData_v4')).toHaveLength(1);
  expect(sentTransactions(firstCycleRequests)).toHaveLength(3);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Place your bid' })).toBeVisible();
  await commitBid(page);

  const recommitRequests = await walletRequests(page);
  expect(recommitRequests.filter((request) => request.method === 'eth_signTypedData_v4')).toHaveLength(0);
  const recommitTransactions = sentTransactions(recommitRequests);
  expect(recommitTransactions).toHaveLength(2);
  expect(decodeFunctionData({ abi: abi('ERC20'), data: recommitTransactions[0]!.data })).toEqual({
    functionName: 'approve',
    args: [getAddress(committed.contracts.escrowAdapter), bondAmount],
  });
  const recommitCall = decodeFunctionData({ abi: abi('IntexAuction'), data: recommitTransactions[1]!.data });
  expect(recommitCall.functionName).toBe('commitBid');
  expect(recommitCall.args?.[1]).toBe(originalCommitHash);

  const recommitted = await liveBidderState();
  expect(recommitted.commitHash).toBe(originalCommitHash);
  expect(tupleField(recommitted.bond, 'amount', 0)).toBe(bondAmount);
  expect(recommitted.allowance).toBe(0n);
});

test('imports a receipt JSON and reveals the bid', async ({ page }) => {
  await connectWallet(page);
  await commitBid(page);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'View Receipt' }).click();
  const receipt = page.getByRole('dialog', { name: 'Bid Receipt' });
  await expect(receipt).toBeVisible();
  await receipt.getByRole('button', { name: 'Download bid receipt' }).click();
  const download = await downloadPromise;
  const receiptJson = await download.createReadStream().then(
    (s) =>
      new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        s.on('data', (c) => chunks.push(c));
        s.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }),
  );
  await receipt.getByRole('button', { name: 'Close bid receipt' }).click();

  await page.evaluate(() => {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k?.startsWith('itx-acn:reveal-material:v1:')) localStorage.removeItem(k);
    }
  });

  advance('commit-end');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reveal receipt missing' })).toBeVisible();

  await page.setInputFiles('input[aria-label="Import bid receipt"]', {
    name: 'receipt.json',
    mimeType: 'application/json',
    buffer: Buffer.from(receiptJson),
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reveal your bid' })).toBeVisible();

  await page.getByRole('button', { name: 'Reveal Bid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reveal & Lock Funds' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Bid revealed' })).toBeVisible();

  const state = await liveBidderState();
  expect(state.revealed).toBe(true);
  expect(tupleField(state.lock, 'lockedAmount', 0)).toBeGreaterThan(0n);
});
