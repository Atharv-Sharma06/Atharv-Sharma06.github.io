import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { chooseFiles, fixture, importFiles, lifetimeTokens, open, watch } from './helpers';

const EXPORT_ZIP = fixture('claude-export/claude-export-sample.zip');

test('a first visit shows the empty state and talks to no other server', async ({ page }) => {
  const problems = watch(page);
  await open(page, '/');
  await expect(page.getByRole('heading', { name: 'CLAUDE LIFETIME' })).toBeVisible();
  await expect(page.getByText('Your entire history with Claude, quantified.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your history starts with an import' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Data coverage: No data yet/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a claude.ai export is previewed, saved as estimated usage, and never counted twice', async ({ page }) => {
  const problems = watch(page);
  await chooseFiles(page, EXPORT_ZIP);

  // The preview states what the file holds before anything is stored.
  await expect(page.getByRole('heading', { name: 'Review before saving' })).toBeVisible();
  await expect(page.getByText('Recognised as claude.ai data export')).toBeVisible();
  const added = page.getByRole('region', { name: 'What this import adds' });
  await expect(added.locator('div', { hasText: /^Conversations28/ }).first()).toBeVisible();
  await expect(added.locator('div', { hasText: /^Messages168/ }).first()).toBeVisible();
  await expect(page.getByText('No token counts for the messages in the file.')).toBeVisible();
  await expect(page.getByText('The model is not recorded.')).toBeVisible();
  await expect(page.getByText('Nothing has been saved yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Save to my history' }).click();
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible();
  await expect(page.getByText('Added 28 conversations and 168 messages')).toBeVisible();

  // The dashboard now shows the import, labelled as an estimate with no exact part.
  await page.getByRole('link', { name: 'Open the overview' }).click();
  const hero = page.getByRole('group', { name: 'Lifetime tokens' });
  await expect(hero.getByText('Estimated', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('No source in this range meters tokens.')).toBeVisible();
  const total = await lifetimeTokens(page);
  expect(total).toMatch(/^[\d,]+ tokens$/);
  // No subscription dates were entered, so the split is unavailable rather than zero.
  await expect(page.getByRole('link', { name: 'Add subscription history' }).first()).toBeVisible();

  // Importing the same file again adds nothing.
  await chooseFiles(page, EXPORT_ZIP);
  await expect(page.getByText('Everything in this file is already imported.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to my history' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close' }).click();
  await open(page, '/');
  expect(await lifetimeTokens(page)).toBe(total);

  // The data is stored on the device: it is still there after a reload.
  await page.reload();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
  expect(await lifetimeTokens(page)).toBe(total);
  expect(problems).toEqual([]);
});

test('Claude Code transcripts are imported as exact usage', async ({ page }) => {
  const problems = watch(page);
  await importFiles(page, [
    fixture('claude-code/research-example/projects/-home-alex-demo/11111111-1111-4111-8111-111111111111.jsonl'),
    fixture('claude-code/research-example/projects/-home-alex-demo/11111111-1111-4111-8111-111111111111/subagents/agent-a0000000000000001.jsonl'),
  ]);
  await page.getByRole('link', { name: 'Open the overview' }).click();
  const hero = page.getByRole('group', { name: 'Lifetime tokens' });
  await expect(hero.getByText('Exact', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Nothing in this range is estimated.')).toBeVisible();
  // Exact usage names its model, so it can be priced.
  const value = page.getByRole('group', { name: 'Equivalent API value' });
  await expect(value.getByText('Exact', { exact: true })).toBeVisible();
  await expect(value.getByText(/^(\$\d|<\$0\.01)/).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test('an API usage report spread over two pages is imported in one go', async ({ page }) => {
  const problems = watch(page);
  await chooseFiles(page, [fixture('api-reports/usage-report.daily.page-1.json'), fixture('api-reports/usage-report.daily.page-2.json')]);
  await expect(page.getByRole('heading', { name: 'Review before saving' })).toBeVisible();
  await expect(page.getByText('Recognised as Anthropic API usage report')).toBeVisible();
  await expect(page.getByText('Token counts are metered by the source')).toBeVisible();
  await page.getByRole('button', { name: 'Save to my history' }).click();
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a CSV of your own asks which column is which before it is read', async ({ page }) => {
  const problems = watch(page);
  await chooseFiles(page, fixture('generic/usage.csv'));
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Column for Timestamp' })).toContainText('timestamp');
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByRole('heading', { name: 'Review before saving' })).toBeVisible();
  // The user did not say the counts are exact, so they are stored as estimates.
  await expect(page.getByRole('region', { name: 'What this import adds' }).getByText('Estimated', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect(page.getByText('Drop a file or folder here')).toBeVisible();
  // Cancelling stores nothing.
  await expect(page.getByText('No imports yet')).toBeVisible();
  expect(problems).toEqual([]);
});

test('a file the app cannot read is explained, and nothing is stored', async ({ page }, testInfo) => {
  const problems = watch(page);
  const odd = testInfo.outputPath('notes.json');
  writeFileSync(odd, JSON.stringify({ hello: 'world' }));
  await chooseFiles(page, odd);
  await expect(page.getByRole('heading', { name: 'This import did not work' })).toBeVisible();
  await expect(page.getByText('is a JSON document, but not one of the formats this app reads')).toBeVisible();
  await expect(page.getByText('Nothing was saved')).toBeVisible();

  const errorBody = testInfo.outputPath('usage.json');
  writeFileSync(errorBody, JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  await page.getByRole('button', { name: 'Choose another file' }).click();
  await chooseFiles(page, errorBody);
  await expect(page.getByText('is an error response from the Anthropic API')).toBeVisible();
  expect(problems).toEqual([]);
});

test('an import can be deleted again, which removes exactly what it added', async ({ page }) => {
  const problems = watch(page);
  await importFiles(page, EXPORT_ZIP);
  await open(page, '/import/');
  const row = page.getByRole('row', { name: /claude-export-sample\.zip/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete import' }).click();
  await expect(page.getByText('No imports yet')).toBeVisible();
  await open(page, '/');
  await expect(page.getByRole('heading', { name: 'Your history starts with an import' })).toBeVisible();
  expect(problems).toEqual([]);
});
