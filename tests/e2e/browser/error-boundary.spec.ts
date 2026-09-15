import { expect, test, type Page } from '@playwright/test';
import { auctionRoute } from '../support/scenario';
import { seedScenario as seed } from '../support/local-commands';

const crashFor = (boundary: string) => (page: Page) =>
  page.addInitScript((boundary: string) => {
    (globalThis as { __ITX_ERROR_BOUNDARY_TEST_CRASH__?: string }).__ITX_ERROR_BOUNDARY_TEST_CRASH__ = boundary;
  }, boundary);

const trackUncaught = (page: Page) => {
  const uncaught: string[] = [];
  page.on('pageerror', (error) => uncaught.push(error.message));
  return uncaught;
};

test('root boundary shows a full-page fallback instead of a blank app', async ({ page }) => {
  const uncaught = trackUncaught(page);
  await crashFor('Application')(page);

  await page.goto(auctionRoute);

  await expect(page.getByText('Application could not be loaded')).toBeVisible();
  await expect(page.locator('.error-fallback--full')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload application' })).toBeVisible();
  expect(uncaught).toEqual([]);
});

test('content boundary keeps the shell header while the content region falls back', async ({ page }) => {
  const uncaught = trackUncaught(page);
  await crashFor('Auction content')(page);

  await page.goto(auctionRoute);

  await expect(page.getByText('Auction content could not be rendered')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload application' })).toBeVisible();
  await expect(page.locator('.app-shell__header')).toBeVisible();
  expect(uncaught).toEqual([]);
});

test('wallet-controls boundary keeps the shell usable when the wallet control crashes', async ({ page }) => {
  const uncaught = trackUncaught(page);
  await crashFor('Wallet controls')(page);

  await page.goto(auctionRoute);

  await expect(page.getByText('Wallet controls could not be rendered')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload application' })).toBeVisible();
  await expect(page.locator('.app-shell__header')).toBeVisible();
  expect(uncaught).toEqual([]);
});

test('bid-ladder boundary keeps sibling auction widgets rendered', async ({ page }) => {
  seed('completed-green-sold-out');
  const uncaught = trackUncaught(page);
  await crashFor('Bid ladder')(page);

  await page.goto(auctionRoute);

  await expect(page.getByText('Bid ladder could not be rendered')).toBeVisible();
  await expect(page.getByLabel('Active-venue auction lifecycle')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Intex Details' })).toBeVisible();
  expect(uncaught).toEqual([]);
});
