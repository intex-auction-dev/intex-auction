import { expect, test, type Locator, type Page } from '@playwright/test';
import { auctionRoute } from '../support/scenario';
import { seedCommitOpen } from '../support/local-commands';
import { getAddress, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const RPC_PORT = process.env.ITX_LOCAL_RPC_PORT ?? '8545';
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const MNEMONIC = 'test test test test test test test test test test test junk';
const bidderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

interface WalletRequest {
  readonly method: string;
  readonly params?: unknown;
}

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
          const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
          if (body.error) throw new Error(body.error.message ?? 'Injected test wallet RPC failed.');
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

const commitButton = (page: Page): Locator => page.getByRole('button', { name: 'Commit Sealed Bid', exact: true });

const expandCommitForm = async (page: Page): Promise<void> => {
  await expect(commitButton(page)).toBeEnabled();
  await commitButton(page).click();
  await expect(page.getByRole('heading', { name: 'Commit Sealed Bid', exact: true })).toBeVisible();
};

const openCommitForm = async (page: Page): Promise<void> => {
  await page.goto(auctionRoute);
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await page.getByRole('button', { name: /Injected wallet/ }).click();
  await expandCommitForm(page);
};

const reopenCommitForm = async (page: Page): Promise<void> => {
  await page.goto(auctionRoute);
  await expandCommitForm(page);
};

const detailRow = (page: Page, label: string): Locator =>
  page.locator(`xpath=//dl[@aria-label="Your Bid Details"]/div[dt[normalize-space(text())="${label}"]]/dd`);

const selectIssuanceCurrency = async (page: Page, alphaCode: string, numericCode: number): Promise<void> => {
  await page.getByRole('combobox', { name: 'Issuance currency' }).click();
  await page.getByRole('option', { name: new RegExp(`^${alphaCode} · ${numericCode} —`) }).click();
  await expect(page.getByRole('combobox', { name: 'Issuance currency' })).toContainText(alphaCode);
};

test.describe('strike amount currencies', () => {
  test.beforeAll(() => {
    seedCommitOpen();
  });

  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        pageErrors.push(`console: ${message.text()}`);
      }
    });
    await installInjectedWallet(page);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('shows the strike in the issuance currency with its reference equivalent', async ({ page }) => {
    await openCommitForm(page);
    const strike = detailRow(page, 'Strike amount');
    const total = detailRow(page, 'Total strike amount');

    await selectIssuanceCurrency(page, 'USD', 840);
    await expect(strike.locator('strong')).toHaveAttribute('aria-label', '100,000.00 USD');
    await expect(strike.locator('small')).toHaveAttribute('aria-label', '100,000.00 USD · per Intex');
    await expect(total.locator('strong')).toHaveAttribute('aria-label', /^[\d,]+\.\d{2} USD$/);

    await selectIssuanceCurrency(page, 'TRY', 949);
    await expect(strike.locator('strong')).toHaveAttribute('aria-label', /^[\d,]+\.\d{2} TRY$/);
    await expect(strike.locator('small')).toHaveAttribute('aria-label', '100,000.00 USD · per Intex');
    await expect(total.locator('strong')).toHaveAttribute('aria-label', /^[\d,]+\.\d{2} TRY$/);
    await expect(total.locator('small')).toHaveAttribute('aria-label', /^[\d,]+\.\d{2} USD$/);

    await expect(page.getByText('Reference strike unavailable')).toHaveCount(0);
  });

  test('keeps the reference strike when the issuance currency has no Oracle rate', async ({ page }) => {
    await openCommitForm(page);
    const strike = detailRow(page, 'Strike amount');

    await selectIssuanceCurrency(page, 'CHF', 756);
    await expect(strike.locator('strong')).toHaveAttribute('aria-label', '100,000.00 USD');
    await expect(strike.locator('small')).toHaveAttribute('aria-label', 'CHF conversion unavailable · per Intex');
    await expect(page.getByText('Reference strike unavailable')).toHaveCount(0);
  });

  test('presets the issuance currency from the stored preference after a reload', async ({ page }) => {
    await openCommitForm(page);
    const issuance = page.getByRole('combobox', { name: 'Issuance currency' });
    const strike = detailRow(page, 'Strike amount');

    await expect(issuance).toContainText('TRY');
    await selectIssuanceCurrency(page, 'EUR', 978);
    expect(await page.evaluate(() => globalThis.localStorage.getItem('itx-acn:issuance-currency'))).toBe('978');

    await reopenCommitForm(page);
    await expect(issuance).toContainText('EUR');
    await expect(strike.locator('strong')).toHaveAttribute('aria-label', /^[\d,]+\.\d{2} EUR$/);
    await expect(strike.locator('small')).toHaveAttribute('aria-label', '100,000.00 USD · per Intex');
  });
});
