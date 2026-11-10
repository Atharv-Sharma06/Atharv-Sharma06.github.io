import { expect, type Page } from '@playwright/test';
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

/** Opens a page of the app and waits until the local database is open and the page has settled. */
export async function open(page: Page, path = '/') {
  await page.goto(`${APP}${path}`);
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
}

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
