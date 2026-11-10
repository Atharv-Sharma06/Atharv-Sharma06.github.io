import { expect, test as base, type Page } from '@playwright/test';
import { resolve } from 'node:path';

export const ORIGIN = 'http://localhost:4173';
export const APP = '/claude-lifetime';
export const fixture = (path: string) => resolve(__dirname, '..', 'tests', 'fixtures', path);

/**
 * Collects everything that should never happen on any page: script errors, failed
 * requests, and requests to another origin. The app promises that nothing leaves the
 * device; this is where that promise is checked.
 */
export function watch(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`script error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (new URL(url).origin !== ORIGIN) problems.push(`request to another origin: ${url}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  return problems;
}

/**
 * `test` for every spec file. The page a test is given is watched from its first request
 * to its last, and the test fails at its end when anything was collected. A spec file
 * that imports `test` from Playwright itself would run without that check, which is why
 * tests/e2e-conventions.test.ts does not allow it. A page a test opens on its own (a
 * second tab, a browser profile of its own) is not covered: the test calls watch() for it.
 */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems = watch(page);
      await use(problems);
      expect(problems, 'script errors, failed requests and requests to another origin').toEqual([]);
    },
    { auto: true },
  ],
});

/** Opens a page of the app and waits until the local database is open and the page has settled. */
export async function open(page: Page, path = '/') {
  await page.goto(`${APP}${path}`);
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
}

/**
 * The exact lifetime total, as the overview's headline states it in its tooltip.
 * Scoped to the headline: other cards carry token tooltips too and can render first.
 */
export const lifetimeTokens = (page: Page) =>
  page.getByRole('group', { name: 'Lifetime tokens' }).locator('p[title$=" tokens"]').first().getAttribute('title');

export async function loadDemo(page: Page) {
  await open(page, '/');
  await page.getByRole('button', { name: 'Explore with demo data' }).click();
  await expect(page.getByText('Synthetic demo data.')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
}

/** Runs one import through the wizard on the import page, up to the preview. */
export async function chooseFiles(page: Page, files: string | string[]) {
  await open(page, '/import/');
  await page.locator('input[type=file]').first().setInputFiles(files);
}

export async function importFiles(page: Page, files: string | string[]) {
  await chooseFiles(page, files);
  await expect(page.getByRole('heading', { name: 'Review before saving' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Save to my history' }).click();
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible({ timeout: 60_000 });
}

/**
 * Deletes one import in the history of the import page and waits until it is gone.
 *
 * The dialog stays open while the records are removed, and while it is open the rest of
 * the page is hidden from assistive technology. A check for the row at that moment
 * passes although nothing has been deleted yet, and a test that then leaves the page
 * cuts the deletion short. So this waits for the dialog to close first.
 */
export async function deleteImport(page: Page, fileName: RegExp) {
  await open(page, '/import/');
  const row = page.getByRole('row', { name: fileName });
  await row.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this import?' });
  await dialog.getByRole('button', { name: 'Delete import' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
}
