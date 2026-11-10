import { expect, test } from '@playwright/test';
import { APP, watch } from './helpers';

test('the portfolio links to the app, and the app links back', async ({ page, context }) => {
  // The portfolio page loads web fonts and GitHub activity of its own; only the app is held to "no other origin".
  const portfolio = await context.newPage();
  await portfolio.goto('/');
  await expect(portfolio.locator('#nav').getByRole('link', { name: 'Claude Lifetime' })).toHaveAttribute('href', 'claude-lifetime/');
  // The portfolio keeps its sections folded until they are opened, so the entry is checked by markup, not by visibility.
  await expect(portfolio.locator('#projects .entry').first().locator('a.e-act', { hasText: 'Open app' })).toHaveAttribute('href', 'claude-lifetime/');
  await portfolio.locator('#nav').getByRole('link', { name: 'Claude Lifetime' }).click();
  await expect(portfolio).toHaveURL(/\/claude-lifetime\/$/);
  await portfolio.close();

  const problems = watch(page);
  await page.goto(`${APP}/`);
  await expect(page.getByRole('heading', { name: 'CLAUDE LIFETIME' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('link', { name: /portfolio/ })).toHaveAttribute('href', '/');
  expect(problems).toEqual([]);
});

test('a deep link to any page of the app works without a server rewrite', async ({ page }) => {
  for (const path of ['/usage/', '/subscriptions/', '/conversations/', '/models/', '/activity/', '/import/', '/settings/', '/methodology/']) {
    const response = await page.goto(`${APP}${path}`);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 60_000 });
  }
});
