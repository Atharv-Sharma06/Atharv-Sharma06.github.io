import { expect } from '@playwright/test';
import { APP, fixture, importFiles, open, test, watch } from './helpers';

/**
 * Two tabs of the app on one database. The worker of one tab holds the database and the
 * other tab reaches it through that worker, so what happens to one tab at a bad moment
 * must not cost the other one anything.
 */
test('a tab that is reloaded while it is still loading does not lock the other tabs out', async ({ page, context }) => {
  // Some data, so that the pages have real questions for the database. This tab's worker holds it.
  await importFiles(page, fixture('claude-export/claude-export-sample.zip'));
  await open(page, '/');
  const second = await context.newPage();
  const problems = watch(second);

  // Sent to another address again and again before the page has its answers: that is the moment its
  // questions stand in line at the database. Before the fix the database gave the turn to a tab that
  // was gone, nothing ever ended that turn, and every tab stayed on "Preparing the database…".
  for (const pauseMs of [200, 350, 500, 650, 800]) {
    await second.goto(`${APP}/usage/`, { waitUntil: 'commit' });
    await second.waitForTimeout(pauseMs);
  }
  await open(second, '/usage/');
  await expect(second.getByRole('heading', { name: 'Lifetime Usage' })).toBeVisible();
  await expect(second.getByRole('group', { name: 'Lifetime tokens' })).toBeVisible();

  // The tab whose worker holds the database still gets answers, and so does a tab that is opened now.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Model Breakdown', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Model Breakdown' })).toBeVisible();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
  const third = await context.newPage();
  problems.push(...watch(third));
  await open(third, '/import/');
  await expect(third.getByRole('row', { name: /claude-export-sample\.zip/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test('the other tab goes on working when the tab that holds the database is closed', async ({ page, context }) => {
  await importFiles(page, fixture('claude-export/claude-export-sample.zip'));
  const second = await context.newPage();
  const problems = watch(second);
  await open(second, '/');
  const before = await second.getByRole('group', { name: 'Lifetime tokens' }).locator('p[title$=" tokens"]').first().getAttribute('title');

  // The first tab was opened first, so its worker holds the database. Closing it moves the database
  // to the worker of the second tab, which has to open it from this device's storage.
  await page.close();

  // Reading: a page the second tab has not shown yet.
  await second.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Lifetime Usage', exact: true }).click();
  await expect(second.getByRole('heading', { name: 'Lifetime Usage' })).toBeVisible();
  await expect(second.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
  await expect(second.getByRole('group', { name: 'Lifetime tokens' })).toBeVisible();

  // Changing: an entry by hand, which is there after the page is loaded anew.
  await open(second, '/import/');
  await expect(second.getByRole('row', { name: /claude-export-sample\.zip/ })).toBeVisible();
  await second.getByRole('button', { name: 'Add an entry' }).click();
  const dialog = second.getByRole('dialog');
  await dialog.getByLabel('Day').fill('2026-03-02');
  await dialog.getByLabel('Input tokens').fill('222');
  await dialog.getByRole('button', { name: 'Save entry' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(second.getByRole('row', { name: /Manual entry for 2026-03-02/ })).toBeVisible();
  await open(second, '/import/');
  await expect(second.getByRole('row', { name: /Manual entry for 2026-03-02/ })).toBeVisible();

  await open(second, '/');
  const after = await second.getByRole('group', { name: 'Lifetime tokens' }).locator('p[title$=" tokens"]').first().getAttribute('title');
  expect(before).not.toBeNull();
  expect(after).not.toBe(before);
  expect(problems).toEqual([]);
});
