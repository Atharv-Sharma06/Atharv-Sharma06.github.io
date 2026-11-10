import { expect, test, type Page } from '@playwright/test';
import { loadDemo, open, watch } from './helpers';

const PAGES: Array<{ link: string; heading: string | RegExp }> = [
  { link: 'Lifetime Usage', heading: 'Lifetime Usage' },
  { link: 'Subscription History', heading: 'Subscription History' },
  { link: 'Conversations', heading: 'Conversations' },
  { link: 'Model Breakdown', heading: 'Model Breakdown' },
  { link: 'Activity Heatmap', heading: 'Activity Heatmap' },
  { link: 'Import Data', heading: 'Recover Your Claude History' },
  { link: 'Settings', heading: 'Settings' },
  { link: 'How it is counted', heading: 'How it is counted' },
  { link: 'Overview', heading: 'CLAUDE LIFETIME' },
];

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('the synthetic demo data is labelled on every page, and every page renders it', async ({ page }) => {
  const problems = watch(page);
  await loadDemo(page);

  for (const { link, heading } of PAGES) {
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
    // The banner that says the figures are invented is on every page while the demo is loaded.
    await expect(page.getByText('Synthetic demo data.')).toBeVisible();
    await expect(page.locator('main [role="alert"]')).toHaveCount(0);
    expect(await overflow(page), `${link} scrolls sideways`).toBeLessThanOrEqual(0);
  }

  // The overview shows both kinds of figures, and keeps them apart.
  await expect(page.getByText('Exact', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Estimated', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What We Know About Your Claude History' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('removing the demo data returns the app to its empty state', async ({ page }) => {
  const problems = watch(page);
  await loadDemo(page);
  await page.getByRole('button', { name: 'Remove demo data' }).click();
  await expect(page.getByRole('heading', { name: 'Your history starts with an import' })).toBeVisible();
  await expect(page.getByText('Synthetic demo data.')).toHaveCount(0);
  // The demo's subscription periods are gone as well.
  await open(page, '/subscriptions/');
  await expect(page.getByText('Synthetic', { exact: true })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('every page works on a phone-sized screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = watch(page);
  await loadDemo(page);
  for (const { link, heading } of PAGES) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
    expect(await overflow(page), `${link} scrolls sideways on a phone`).toBeLessThanOrEqual(0);
  }
  expect(problems).toEqual([]);
});
