import { chromium, expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fixture, lifetimeTokens, loadDemo, open, ORIGIN, watch } from './helpers';

async function downloadBackup(page: Page, saveTo: (name: string) => string, passphrase?: string): Promise<string> {
  await open(page, '/settings/');
  if (passphrase) {
    await page.getByLabel('Passphrase (optional)').fill(passphrase);
    await page.getByLabel('Repeat passphrase').fill(passphrase);
  }
  const started = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const download = await started;
  const path = saveTo(download.suggestedFilename());
  await download.saveAs(path);
  return path;
}

async function deleteAllImported(page: Page) {
  await open(page, '/settings/');
  await page.getByRole('button', { name: 'Delete all imported data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete all imported data?' });
  await dialog.getByRole('textbox').fill('DELETE');
  await dialog.getByRole('button', { name: 'Delete imported data' }).click();
  await expect(dialog).toBeHidden();
  await open(page, '/');
  await expect(page.getByRole('heading', { name: 'Your history starts with an import' })).toBeVisible();
}

const chooseBackup = (page: Page, file: string) => page.locator('input[aria-label="Backup file"]').setInputFiles(file);

test('a backup brings everything back after the data was deleted', async ({ page }, testInfo) => {
  const problems = watch(page);
  await loadDemo(page);
  const total = await lifetimeTokens(page);
  expect(total).toMatch(/^[\d,]+ tokens$/);

  const backup = await downloadBackup(page, (name) => testInfo.outputPath(name));
  expect(backup).toMatch(/\.tar\.gz$/);
  await expect(page.getByText('not encrypted')).toBeVisible();

  await deleteAllImported(page);

  await open(page, '/settings/');
  await chooseBackup(page, backup);
  const dialog = page.getByRole('dialog', { name: 'Replace everything with this backup?' });
  await expect(dialog.getByText('Nothing is imported here at the moment.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Replace with backup' }).click();

  // The page reloads into the restored database: the demo, its label and the same total are back.
  await expect(page.getByText('Synthetic demo data.')).toBeVisible({ timeout: 90_000 });
  await open(page, '/');
  expect(await lifetimeTokens(page)).toBe(total);
  // Restoring is not a one-off view: the restored database is the stored one.
  await page.reload();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
  expect(await lifetimeTokens(page)).toBe(total);
  expect(problems).toEqual([]);
});

test('a passphrase-protected backup opens only with its passphrase, and a wrong one changes nothing', async ({ page }, testInfo) => {
  const problems = watch(page);
  await loadDemo(page);
  const total = await lifetimeTokens(page);

  const backup = await downloadBackup(page, (name) => testInfo.outputPath(name), 'correct horse battery');
  expect(backup).toMatch(/\.clbackup$/);
  await expect(page.getByText('encrypted with your passphrase')).toBeVisible();
  // What was written to disk is not a readable archive.
  expect(readFileSync(backup).subarray(0, 5).toString('latin1')).toBe('CLBK1');

  await deleteAllImported(page);
  await open(page, '/settings/');
  await chooseBackup(page, backup);
  const dialog = page.getByRole('dialog', { name: 'Replace everything with this backup?' });
  await expect(dialog.getByText('It is protected with a passphrase.')).toBeVisible();

  await dialog.getByLabel('Passphrase for this backup').fill('not the passphrase');
  await dialog.getByRole('button', { name: 'Replace with backup' }).click();
  await expect(dialog.getByText('The passphrase does not match this backup, or the file was changed after it was saved.')).toBeVisible();
  // Still open, and nothing was replaced.
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Passphrase for this backup').fill('correct horse battery');
  await dialog.getByRole('button', { name: 'Replace with backup' }).click();
  await expect(page.getByText('Synthetic demo data.')).toBeVisible({ timeout: 90_000 });
  await open(page, '/');
  expect(await lifetimeTokens(page)).toBe(total);
  expect(problems).toEqual([]);
});

test('a file that is not a backup is refused and the stored data stays', async ({ page }, testInfo) => {
  const problems = watch(page);
  await loadDemo(page);
  const total = await lifetimeTokens(page);
  await open(page, '/settings/');

  // An export is not a backup.
  await chooseBackup(page, fixture('claude-export/claude-export-sample.zip'));
  await expect(page.getByRole('alert').filter({ hasText: 'is not a Claude Lifetime backup' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Neither is some other gzip file, even though a backup is one.
  const other = testInfo.outputPath('notes.tar.gz');
  writeFileSync(other, gzipSync(Buffer.from('just some notes, not a database')));
  await chooseBackup(page, other);
  await expect(page.getByRole('alert').filter({ hasText: 'notes.tar.gz' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await open(page, '/');
  expect(await lifetimeTokens(page)).toBe(total);
  expect(problems).toEqual([]);
});

test('erasing the local database resets this tab and every other open tab', async ({ page, context }) => {
  const problems = watch(page);
  await loadDemo(page);
  // Something the browser remembers outside the database.
  await page.getByRole('button', { name: /^Date range/ }).click();
  await page.getByRole('button', { name: 'Last 90 days' }).click();
  expect(await page.evaluate(() => window.localStorage.getItem('claude-lifetime:range'))).toContain('90d');

  const other = await context.newPage();
  const otherProblems = watch(other);
  await open(other, '/usage/');
  await expect(other.getByText('Synthetic demo data.')).toBeVisible();

  await open(page, '/settings/');
  await page.getByRole('button', { name: 'Erase the local database' }).click();
  const dialog = page.getByRole('dialog', { name: 'Erase the local database?' });
  await dialog.getByRole('textbox').fill('ERASE');
  await dialog.getByRole('button', { name: 'Erase everything' }).click();

  // This tab starts again as on a first visit.
  await expect(page.getByRole('heading', { name: 'Your history starts with an import' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Synthetic demo data.')).toHaveCount(0);
  expect(await page.evaluate(() => window.localStorage.getItem('claude-lifetime:range'))).toBeNull();

  // The other tab reloaded by itself and shows the empty database too, not figures that no longer exist.
  await expect(other.getByText('Synthetic demo data.')).toHaveCount(0, { timeout: 90_000 });
  await expect(other.getByRole('heading', { level: 1, name: 'Lifetime Usage' })).toBeVisible({ timeout: 90_000 });
  await expect(other.locator('main [aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
  await expect(other.locator('main [role="alert"]')).toHaveCount(0);

  // Both tabs work on the new database: data loaded in one shows up in the other.
  await page.getByRole('button', { name: 'Explore with demo data' }).click();
  await expect(page.getByText('Synthetic demo data.')).toBeVisible({ timeout: 90_000 });
  await expect(other.getByText('Synthetic demo data.')).toBeVisible({ timeout: 90_000 });
  expect(problems).toEqual([]);
  expect(otherProblems).toEqual([]);
});

// ── The remembered Claude Code folder ─────────────────────────────────────────────

/** A folder with a single transcript is listed under that file's name. */
const IMPORT_ROW = /11111111-1111-4111-8111-111111111111\.jsonl/;
const TRANSCRIPT = fixture('claude-code/research-example/projects/-home-alex-demo/11111111-1111-4111-8111-111111111111.jsonl');

/**
 * Gives the app a remembered Claude Code folder the way the folder picker would,
 * without a picker: a directory in the browser's own private file system, which the
 * page may always read. Everything after that is the app's real code path.
 */
async function rememberFolder(page: Page, autoSync: boolean) {
  await page.evaluate(
    async ({ text, autoSync }) => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('claude-home', { create: true });
      const project = await (await folder.getDirectoryHandle('projects', { create: true })).getDirectoryHandle('-home-alex-demo', { create: true });
      const file = await project.getFileHandle('11111111-1111-4111-8111-111111111111.jsonl', { create: true });
      const writable = await file.createWritable();
      await writable.write(text);
      await writable.close();
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('claude-lifetime-local', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(folder, 'claude-code-folder');
        if (autoSync) tx.objectStore('kv').put(true, 'claude-code-auto-sync');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { text: readFileSync(TRANSCRIPT, 'utf8'), autoSync },
  );
}

const remembered = (page: Page, key: string) =>
  page.evaluate(
    (key) =>
      new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('claude-lifetime-local', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const get = request.result.transaction('kv', 'readonly').objectStore('kv').get(key);
          get.onsuccess = () => {
            request.result.close();
            resolve(get.result ?? null);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    key,
  );

test('a remembered folder is read automatically when asked to, and a deletion is not undone by it', async ({}, testInfo) => {
  // A profile on disk instead of the usual throwaway one: Chromium's throwaway profiles crash when a
  // folder handle is read back from IndexedDB, which is how the app remembers the folder.
  const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), { baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  const problems = watch(page);
  await open(page, '/import/');
  await expect(page.getByText('No imports yet')).toBeVisible();
  await rememberFolder(page, true);

  // Opening the app reads the folder by itself: no preview, but a normal entry in the import history.
  await page.reload();
  const row = page.getByRole('row', { name: IMPORT_ROW });
  await expect(row).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('The folder “claude-home” is remembered on this device.')).toBeVisible();
  const auto = page.getByRole('switch', { name: 'Read the folder automatically when the app opens' });
  await expect(auto).toBeChecked();
  const firstSync = (await remembered(page, 'claude-code-last-sync')) as { at: number; added: number };
  expect(firstSync.added).toBeGreaterThan(0);

  // Opening it again adds nothing: every request is already stored.
  await page.reload();
  await expect.poll(async () => ((await remembered(page, 'claude-code-last-sync')) as { at: number }).at, { timeout: 60_000 }).toBeGreaterThan(firstSync.at);
  expect(((await remembered(page, 'claude-code-last-sync')) as { added: number }).added).toBe(0);
  await expect(page.getByRole('row', { name: IMPORT_ROW })).toHaveCount(1);

  // Deleting the import says what happens to automatic reading, and then does it.
  await page.getByRole('row', { name: IMPORT_ROW }).getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this import?' });
  await expect(dialog.getByText('Reading the Claude Code folder automatically is switched off with this')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete import' }).click();
  await expect(page.getByText('No imports yet')).toBeVisible();
  await expect(auto).not.toBeChecked();
  await expect(page.getByText(/Automatic reading was switched off .* when Claude Code usage was deleted/)).toBeVisible();

  // The next visit leaves the deleted usage deleted.
  const before = (await remembered(page, 'claude-code-last-sync')) as { at: number };
  await page.reload();
  await expect(page.getByText('The folder “claude-home” is remembered on this device.')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await expect(page.getByText('No imports yet')).toBeVisible();
  expect(((await remembered(page, 'claude-code-last-sync')) as { at: number }).at).toBe(before.at);

  // Reading it on request still works, and switching the automatic reading back on clears the note.
  await page.getByRole('button', { name: 'Read the folder again' }).click();
  await expect(page.getByRole('row', { name: IMPORT_ROW })).toBeVisible({ timeout: 90_000 });
  await auto.click();
  await expect(auto).toBeChecked();
  await expect(page.getByText(/Automatic reading was switched off/)).toHaveCount(0);
  await context.close();
  expect(problems).toEqual([]);
});
