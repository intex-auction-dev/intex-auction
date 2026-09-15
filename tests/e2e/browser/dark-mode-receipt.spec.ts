import { expect, test, type Page } from '@playwright/test';
import { getAddress, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { auctionRoute } from '../support/scenario';
import { seedCommitOpen } from '../support/local-commands';

const RPC_PORT = process.env.ITX_LOCAL_RPC_PORT ?? '8545';
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const MNEMONIC = 'test test test test test test test test test test test junk';
const bidderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

interface WalletRequest {
  readonly method: string;
  readonly params?: unknown;
}

const collectBrowserErrors = (page: Page): readonly string[] => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.location().url.includes('/__diagnostics/')) return;
    errors.push(message.text());
  });
  return errors;
};

const parseColor = (value: string) => {
  const match = value.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (!match) throw new Error(`Unexpected color value: ${value}`);
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
};

const installInjectedWallet = async (page: Page): Promise<void> => {
  const bidder = bidderAccount.address;
  await page.exposeFunction('__itxE2eSignTypedData', async (account: string, payload: string) => {
    if (getAddress(account) !== bidder) throw new Error('Unexpected E2E signing account.');
    return bidderAccount.signTypedData(JSON.parse(payload) as Parameters<typeof bidderAccount.signTypedData>[0]);
  });
  await page.addInitScript(
    ({ rpcUrl, bidderAddress }) => {
      type Listener = (...args: unknown[]) => void;
      const listeners = new Map<string, Set<Listener>>();
      let nextId = 1;
      const global = globalThis as typeof globalThis & {
        __itxE2eSignTypedData(account: string, payload: string): Promise<Hex>;
        ethereum: unknown;
      };

      const provider = {
        async request({ method, params }: WalletRequest): Promise<unknown> {
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
    },
    { rpcUrl: RPC_URL, bidderAddress: bidder },
  );
};

test.beforeEach(async ({ page }) => {
  seedCommitOpen();
  await page.emulateMedia({ colorScheme: 'dark' });
  await installInjectedWallet(page);
});

test('renders the committed sealed-bid receipt with a dark background in dark mode', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto(auctionRoute);
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await page.getByRole('button', { name: /Injected wallet/ }).click();
  await expect(page.getByRole('button', { name: new RegExp(bidderAccount.address.slice(0, 6), 'i') })).toBeVisible();

  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Quantity', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Your sealed bid' })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);

  const receipt = page.locator('.bidder-receipt');
  const rgb = await receipt.evaluate((el) => {
    const match = getComputedStyle(el).backgroundColor.match(
      /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/,
    );
    if (!match) throw new Error(`Unexpected background color: ${getComputedStyle(el).backgroundColor}`);
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    };
  });
  expect(rgb.r + rgb.g + rgb.b).toBeLessThan(500);

  await page.screenshot({ path: '.local/dark-mode-committed-receipt.png', fullPage: true });
  expect(browserErrors).toEqual([]);
});

test('renders receipt labels as translucent black ink in light mode', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(auctionRoute);
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await page.getByRole('button', { name: /Injected wallet/ }).click();
  await expect(page.getByRole('button', { name: new RegExp(bidderAccount.address.slice(0, 6), 'i') })).toBeVisible();

  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Quantity', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Your sealed bid' })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);

  const label = page.locator('.bidder-receipt__details dt').first();
  await expect(label).toBeVisible();
  const labelColor = parseColor(await label.evaluate((el) => getComputedStyle(el).color));
  expect(labelColor.r + labelColor.g + labelColor.b).toBeLessThan(120);
  expect(labelColor.a).toBeLessThan(1);

  const cardBackground = parseColor(
    await page.locator('.bidder-receipt').evaluate((el) => getComputedStyle(el).backgroundColor),
  );
  expect(cardBackground.r + cardBackground.g + cardBackground.b).toBeGreaterThan(500);

  await page.waitForTimeout(800);
  await page.locator('.bidder-receipt').screenshot({ path: '.local/light-mode-committed-receipt.png' });
  expect(browserErrors).toEqual([]);
});

test('renders InfoTip tooltips with dark background in dark mode', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto(auctionRoute);
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await page.getByRole('button', { name: /Injected wallet/ }).click();
  await expect(page.getByRole('button', { name: new RegExp(bidderAccount.address.slice(0, 6), 'i') })).toBeVisible();

  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Quantity', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
  await expect(page.getByRole('heading', { name: 'Your sealed bid' })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);

  const infoTipTrigger = page.locator('.info-tip').first();
  await infoTipTrigger.hover();
  await page.waitForTimeout(200);

  const tooltip = page.locator('.tooltip__content');
  await expect(tooltip).toBeVisible();

  const tooltipRgb = await tooltip.evaluate((el) => {
    const match = getComputedStyle(el).backgroundColor.match(
      /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/,
    );
    if (!match) throw new Error(`Unexpected background color: ${getComputedStyle(el).backgroundColor}`);
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    };
  });
  expect(tooltipRgb.r + tooltipRgb.g + tooltipRgb.b).toBeLessThan(500);

  const tooltipTextColor = await tooltip.evaluate((el) => getComputedStyle(el).color);
  expect(tooltipTextColor).not.toBe('rgb(255, 255, 255)');

  await page.screenshot({ path: '.local/dark-mode-infotip-tooltip.png', fullPage: true });
  expect(browserErrors).toEqual([]);
});
