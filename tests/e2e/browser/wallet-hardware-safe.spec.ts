import { expect, test, type Page } from '@playwright/test';
import { auctionRoute } from '../support/scenario';
import { seedCommitOpen } from '../support/local-commands';
import {
  bidderAccount,
  installConfigurableWallet,
  storedReceiptCount,
  walletRequests,
  type WalletQuirks,
} from '../support/wallet-harness';

interface Harness {
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
}

const trackErrors = (page: Page): Harness => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    const source = message.location().url;
    const expectedOptional404 = source.endsWith('/__diagnostics/v1') || source.endsWith('/config/timing.json');
    if (message.type() === 'error' && !expectedOptional404) consoleErrors.push(`${message.text()} (${source})`);
  });
  return { pageErrors, consoleErrors };
};

const connect = async (page: Page): Promise<void> => {
  await page.goto(auctionRoute);
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await page.getByRole('button', { name: /Injected wallet/ }).click();
  await expect(page.getByRole('button', { name: new RegExp(bidderAccount.address.slice(0, 6), 'i') })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit Sealed Bid', exact: true })).toBeEnabled();
};

const openCommitAndSubmit = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Commit Sealed Bid', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Quantity', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Commit Sealed Bid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve allowance' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve allowance' }).click();
};

const install = async (page: Page, quirks: WalletQuirks): Promise<void> => {
  await installConfigurableWallet(page, quirks);
};

test.beforeEach(() => {
  seedCommitOpen();
});

test('slow-signing hardware wallet still persists reveal material before broadcasting', async ({ page }) => {
  const errors = trackErrors(page);
  await install(page, { signTypedDataDelayMs: 4_000 });
  await connect(page);
  const beforeSubmit = Date.now();
  await openCommitAndSubmit(page);

  await expect(page.getByRole('heading', { name: 'Your sealed bid' })).toBeVisible({ timeout: 45_000 });
  expect(Date.now() - beforeSubmit).toBeGreaterThan(3_500);

  expect(await storedReceiptCount(page)).toBe(1);
  const signs = (await walletRequests(page)).filter((r) => r.method === 'eth_signTypedData_v4');
  expect(signs).toHaveLength(1);
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});

test('a wallet that rejects typed-data signing fails early with no half-commit', async ({ page }) => {
  const errors = trackErrors(page);
  await install(page, {
    rejectTypedData: { code: 4001, message: 'Ledger: typed data signing is not supported on this device path.' },
  });
  await connect(page);
  await openCommitAndSubmit(page);

  await expect(page.getByText(/typed data signing is not supported/i)).toBeVisible({ timeout: 15_000 });

  expect(await storedReceiptCount(page)).toBe(0);
  const requests = await walletRequests(page);
  expect(requests.filter((r) => r.method === 'eth_sendTransaction')).toHaveLength(0);
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});

test('a Safe contract account persists the receipt and explains the unobserved confirmation', async ({ page }) => {
  const errors = trackErrors(page);
  await install(page, { safeContractAccount: true });
  await connect(page);
  await openCommitAndSubmit(page);

  await expect.poll(() => storedReceiptCount(page), { timeout: 30_000 }).toBe(1);

  await expect(page.getByText(/was not observed on the active venue/i)).toBeVisible({ timeout: 70_000 });
  await expect(page.getByText(/Safe or other multisig/i)).toBeVisible();
  await expect(page.getByText(/reveal material is already saved locally, so no bid was lost/i)).toBeVisible();
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});

test('the bid receipt omits the commit-hash Explorer link when the venue has no explorer', async ({ page }) => {
  const errors = trackErrors(page);
  await install(page, {});
  await connect(page);
  await openCommitAndSubmit(page);
  await expect(page.getByRole('heading', { name: 'Your sealed bid' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'View Receipt' }).click();
  const receipt = page.getByRole('dialog', { name: 'Bid Receipt' });
  await expect(receipt).toBeVisible();
  await expect(receipt.getByText('Commit hash')).toBeVisible();

  await expect(receipt.getByRole('link', { name: /Explorer/ })).toHaveCount(0);
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
});
