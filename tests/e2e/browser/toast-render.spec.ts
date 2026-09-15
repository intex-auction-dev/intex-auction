import { expect, test } from '@playwright/test';
import { auctionRoute } from '../support/scenario';

test('Sonner toasts stack and animate inside the bottom-right viewport', async ({ page }) => {
  await page.goto(auctionRoute);
  await page.evaluate(async () => {
    const { showErrorToast, showSuccessToast } = await import('/src/ui/toast.tsx');
    showErrorToast('The transaction could not be submitted.', 'Transaction failed');
    showSuccessToast('Your commitment was cancelled and its commit bond was returned.', 'Commit cancelled');
  });

  const toasts = page.locator('[data-sonner-toast]');
  await expect(toasts).toHaveCount(2);

  const front = page.locator('[data-sonner-toast][data-front="true"]');
  await expect(front).toBeVisible();
  await expect(front).toContainText('Commit cancelled');
  await expect(page.locator('[data-sonner-toast][data-front="false"]')).toHaveCount(1);
  await expect(front).toHaveAttribute('data-expanded', 'false');

  const transitionDuration = await front.evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transitionDuration).not.toMatch(/^(0s)(, 0s)*$/);

  const box = await front.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(440);
  expect(box!.x).toBeGreaterThan(900);
  expect(box!.y).toBeGreaterThan(700);
});
