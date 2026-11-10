import { expect, type Page } from '@playwright/test';
import { fixture, importFiles, open, test } from './helpers';

/** The sample export holds conversations from March 2025 to April 2026. */
const EXPORT_ZIP = fixture('claude-export/claude-export-sample.zip');

async function addPeriod(page: Page, plan: string, start: string, end?: string) {
  await page.getByRole('button', { name: 'Add period' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Plan' }).click();
  await page.getByRole('option', { name: plan, exact: true }).click();
  await dialog.getByLabel('Start date').fill(start);
  if (end) await dialog.getByLabel('End date (optional)').fill(end);
  await dialog.getByRole('button', { name: 'Save period' }).click();
  return dialog;
}

test('subscription periods are entered by hand and split the usage by date', async ({ page }) => {
  await importFiles(page, EXPORT_ZIP);

  // Without any period the split is unavailable, not zero.
  await open(page, '/');
  await expect(page.getByRole('link', { name: 'Add subscription history' }).first()).toBeVisible();

  await open(page, '/subscriptions/');
  await expect(page.getByRole('heading', { level: 1, name: 'Subscription History' })).toBeVisible();

  await expect(await addPeriod(page, 'Free', '2025-01-01', '2025-08-31')).toBeHidden();
  await expect(await addPeriod(page, 'Pro', '2025-09-01', '2025-12-31')).toBeHidden();
  // Cancelled, then subscribed again to another plan: any number of changes is allowed.
  await expect(await addPeriod(page, 'Max 5x', '2026-02-01')).toBeHidden();

  // Two plans cannot be active on the same day; the message names the period in the way.
  const dialog = await addPeriod(page, 'Max 20x', '2025-12-15', '2026-01-10');
  await expect(dialog.getByText(/overlap your Pro period/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  const table = page.getByRole('table').filter({ hasText: 'Pro' }).first();
  await expect(table.getByText('Free', { exact: true }).first()).toBeVisible();
  await expect(table.getByText('Max 5x', { exact: true }).first()).toBeVisible();
  // January 2026 is covered by no period: it is shown as such, not as Free.
  await expect(page.getByText('No subscription recorded').first()).toBeVisible();

  // The overview now splits at the first PAID period.
  await open(page, '/');
  const before = page.getByRole('group', { name: 'Before subscription' });
  const after = page.getByRole('group', { name: 'After subscription' });
  await expect(before.getByText('Before Pro started on Sep 1, 2025.')).toBeVisible();
  await expect(after.getByText('Since Pro started on Sep 1, 2025.')).toBeVisible();
  await expect(before.getByText('Estimated', { exact: true })).toBeVisible();

  // The periods survive a reload: they are stored like everything else.
  await page.reload();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText('Before Pro started on Sep 1, 2025.')).toBeVisible();
});
