import { expect, test, type Locator } from '@playwright/test';
import { auctionRoute } from '../support/scenario';

type Motion = { duration: string; property: string; timing: string };

const motion = (locator: Locator): Promise<Motion> =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      duration: style.transitionDuration,
      property: style.transitionProperty,
      timing: style.transitionTimingFunction,
    };
  });

// A hover-driven overlay closes again if the pointer drifts off its trigger while the page is still
// settling, which leaves the following style read waiting for an element that is already gone. Re-hover
// until the overlay is present long enough to be measured.
const motionAfterHover = async (trigger: Locator, overlay: Locator): Promise<Motion> => {
  let measured: Motion | undefined;
  await expect(async () => {
    await trigger.hover();
    await expect(overlay).toBeVisible({ timeout: 5_000 });
    measured = await motion(overlay);
  }).toPass({ timeout: 30_000 });
  if (!measured) throw new Error('Overlay motion could not be measured.');
  return measured;
};

const durations = (value: string) => [...new Set(value.split(',').map((part) => part.trim()))];

const longestDurationSeconds = (value: string) =>
  Math.max(
    ...durations(value).map((part) =>
      part.endsWith('ms') ? Number(part.slice(0, -2)) / 1000 : Number(part.replace(/s$/, '')),
    ),
  );

test('calendar and previous demand use the tooltip enter and exit motion', async ({ page }) => {
  await page.goto(auctionRoute);

  const info = page.locator('.info-tip').first();
  const tooltip = page.locator('.tooltip__content').first();
  const tooltipMotion = await motionAfterHover(info, tooltip);

  const calendarTrigger = page.getByRole('button', { name: 'Show calendar' });
  const calendar = page.getByRole('dialog', { name: 'Auction calendar' });
  expect(await motionAfterHover(calendarTrigger, calendar)).toEqual(tooltipMotion);

  await page.mouse.move(1400, 880);
  await expect(calendar).toBeHidden();

  const demandTrigger = page.getByRole('button', { name: 'Demand history' });
  const demand = page.getByRole('dialog', { name: 'Oversubscription rates of past auctions' });
  const demandPanel = page.locator('.demand-popover');
  expect(await motionAfterHover(demandTrigger, demandPanel)).toEqual(tooltipMotion);
  await expect(demand).toBeVisible();

  await page.mouse.move(10, 880);
  await expect(demandPanel).toBeHidden();
});

test('calendar leaves non-auction dates inert', async ({ page }) => {
  await page.goto(auctionRoute);

  const calendarTrigger = page.getByRole('button', { name: 'Show calendar' });
  await calendarTrigger.click();
  const calendar = page.getByRole('dialog', { name: 'Auction calendar' });
  await expect(calendar).toBeVisible();

  const emptyDay = calendar.locator('[aria-label^="2026 08 03."]');
  await expect(emptyDay).toHaveCount(1);
  expect(await emptyDay.evaluate((element) => element.tagName)).toBe('SPAN');
});

test('calendar closes and remains interactive after choosing a different auction date', async ({ page }) => {
  await page.goto(auctionRoute);

  const calendarTrigger = page.getByRole('button', { name: 'Show calendar' });
  await calendarTrigger.click();
  const calendar = page.locator('.auction-calendar-popover');
  await expect(calendar).toBeVisible();

  const differentDate = calendar.locator('button[aria-pressed="false"]').first();
  await expect(differentDate).toBeVisible();
  await differentDate.click();
  await expect(calendar).toBeHidden();

  await calendarTrigger.hover();
  await expect(calendar).toBeVisible();
  await calendar.locator('button[aria-pressed="false"]').first().click();
  await expect(calendar).toBeHidden();
});

test('info tip opens on hover and closes with escape', async ({ page }) => {
  await page.goto(auctionRoute);

  const info = page.locator('.info-tip').first();
  await info.hover();
  await expect(page.locator('.tooltip__content').first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.tooltip__content').first()).toBeHidden();
});

test('header menu supports keyboard opening and escape', async ({ page }) => {
  await page.goto(auctionRoute);

  const menuTrigger = page.getByRole('button', { name: 'More options' });
  await menuTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(menuTrigger).toBeFocused();
});

test('wallet dropdown uses the tooltip enter and exit motion', async ({ page }) => {
  await page.goto(auctionRoute);

  const info = page.locator('.info-tip').first();
  const tooltip = page.locator('.tooltip__content').first();
  const tooltipMotion = await motionAfterHover(info, tooltip);

  const walletTrigger = page.getByRole('button', { name: 'Connect Wallet' });
  await walletTrigger.click();
  const walletPanel = page.locator('.wallet-panel');
  await expect(walletPanel).toBeVisible();
  expect(await motion(walletPanel)).toEqual(tooltipMotion);

  await page.keyboard.press('Escape');
  await expect(walletPanel).toBeHidden();
});

test('overlays use 180ms motion and instant motion when reduced', async ({ page }) => {
  await page.goto(auctionRoute);

  const info = page.locator('.info-tip').first();
  const tooltip = page.locator('.tooltip__content').first();
  const normalMotion = await motionAfterHover(info, tooltip);
  expect(durations(normalMotion.duration)).toEqual(['0.18s']);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await motionAfterHover(info, page.locator('.tooltip__content').first());
  expect(longestDurationSeconds(reducedMotion.duration)).toBeLessThanOrEqual(0.001);
});
