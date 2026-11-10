import { expect, test } from '@playwright/test';
import { APP, watch } from './helpers';

test('the portfolio links to the app, and the app links back', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  const link = page.locator('#nav').getByRole('link', { name: 'Claude Lifetime' });
  await expect(link).toHaveAttribute('href', 'claude-lifetime/');
  // The portfolio's own entry in the project list points at the same place.
  await expect(page.locator('#projects .entry').first().getByRole('link', { name: 'Open app' })).toHaveAttribute('href', 'claude-lifetime/');

  await page.goto(`${APP}/`);
  await expect(page.getByRole('heading', { name: 'CLAUDE LIFETIME' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('link', { name: /portfolio/ })).toHaveAttribute('href', '/');
  // Requests made by the portfolio page itself (it shows recent GitHub activity) are not the app's.
  expect(problems.filter((p) => !p.includes('api.github.com'))).toEqual([]);
});

test('a deep link to any page of the app works without a server rewrite', async ({ page }) => {
  for (const path of ['/usage/', '/subscriptions/', '/conversations/', '/models/', '/activity/', '/import/', '/settings/', '/methodology/']) {
    const response = await page.goto(`${APP}${path}`);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 });
  }
});
