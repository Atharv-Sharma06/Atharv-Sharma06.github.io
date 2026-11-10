import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's half of PGlite's worker is replaced by a real PostgreSQL in memory; what the worker
// would say on the control channel is scripted per test. src/db/client.ts runs unchanged.
vi.mock('@electric-sql/pglite/worker', async (original) => ({
  ...(await original<object>()),
  PGliteWorker: (await import('../helpers/fake-pglite-worker')).FakePGliteWorker,
}));

import { openDatabase, readBackupMessage, releaseDatabase, requestBackup, restoreDatabase } from '@/db/client';
import { migrate } from '@/db/migrate';
import { pgliteDriver } from '@/db/pglite-driver';
import { deleteBatch } from '@/import/delete';
import { installIndexedDb, installWebLocks, installWindow, resetTimeline, timeline, trackBroadcastChannels, waitFor, WorkerStub } from '../helpers/browser';
import { dataDirectory, FakePGliteWorker, fakeDatabases } from '../helpers/fake-pglite-worker';
import { conv, importRecords, msg } from '../helpers/staged';

/**
 * "Download backup" as the page sees it: the database worker is asked for a backup
 * and answers with an archive of a copy that holds only what is stored now. The
 * database's own files, which still hold deleted rows, are never what is saved, also
 * not when the worker fails or does not answer.
 */
const TITLE = 'Severance negotiation with ACME-CORP-7731';
const KEPT = 'Planning the allotment for spring';

let closeChannels: () => void;
let stored: Blob;

beforeAll(async () => {
  stored = await dataDirectory();
});

beforeEach(() => {
  resetTimeline();
  fakeDatabases.reset();
  fakeDatabases.stored.set('claude-lifetime', stored);
  WorkerStub.created = [];
  closeChannels = trackBroadcastChannels();
  vi.stubGlobal('Worker', WorkerStub);
  installWindow();
  installIndexedDb(['/pglite/claude-lifetime']);
  installWebLocks();
});
afterEach(async () => {
  await releaseDatabase();
  closeChannels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const holds = async (archive: Blob, text: string) => gunzipSync(Buffer.from(await archive.arrayBuffer())).includes(Buffer.from(text, 'utf8'));
const messageOf = (attempt: Promise<unknown>) =>
  attempt.then(
    () => 'no error',
    (error: Error) => error.message,
  );

describe('Download backup', () => {
  it('saves what is stored now, and nothing of an import that was deleted', async () => {
    const database = await openDatabase();
    const secret = await importRecords(database.db, database.userId, { conversations: [conv('a', { title: TITLE })], messages: [msg('a', 0), msg('a', 1)] }, { contentHash: 'one' });
    await importRecords(database.db, database.userId, { conversations: [conv('k', { title: KEPT })], messages: [msg('k', 0)] }, { contentHash: 'two' });
    await deleteBatch(database.db, database.userId, secret.result.batchId!);
    // The engine's own dump of the same database is what used to be saved; it still holds the deleted title.
    const dump = vi.spyOn(FakePGliteWorker.prototype, 'dumpDataDir');

    const backup = await database.exportBackup();

    expect(await holds(backup, TITLE)).toBe(false);
    expect(await holds(backup, KEPT)).toBe(true);
    expect(dump).not.toHaveBeenCalled();
    expect(timeline).toContain('backup claude-lifetime: ok');

    // It restores to exactly the conversations that were stored.
    const restored = new PGlite({ loadDataDir: backup });
    await migrate(pgliteDriver(restored));
    expect((await restored.query<{ title: string }>(`SELECT title FROM conversations ORDER BY 1`)).rows).toEqual([{ title: KEPT }]);
    await restored.close();
  }, 120_000);

  it('makes a backup that "Restore backup" accepts', async () => {
    const database = await openDatabase();
    await importRecords(database.db, database.userId, { conversations: [conv('k', { title: KEPT })], messages: [msg('k', 0)] }, { contentHash: 'two' });
    const backup = await database.exportBackup();

    await restoreDatabase(backup);

    const restoredInto = fakeDatabases.opened.find((o) => o.fromBackup);
    expect(restoredInto?.name).toMatch(/^claude-lifetime-[a-z0-9]+$/);
  }, 120_000);

  it('tells the person why when the data could not be copied, and saves nothing', async () => {
    const database = await openDatabase();
    const dump = vi.spyOn(FakePGliteWorker.prototype, 'dumpDataDir');

    fakeDatabases.answerBackup = (request) => ({ op: 'backed-up', id: request.id, ok: false, error: 'out of memory', explained: false });
    expect(await messageOf(database.exportBackup())).toBe('No backup was made: the data could not be copied. (out of memory)');

    // A reason that is already a sentence for the person is passed on as it is.
    const sentence = 'The stored data has other tables than this version of the app sets up, so it cannot be copied.';
    fakeDatabases.answerBackup = (request) => ({ op: 'backed-up', id: request.id, ok: false, error: sentence, explained: true });
    expect(await messageOf(database.exportBackup())).toBe(`No backup was made. ${sentence}`);

    // An answer without an archive is not a backup either.
    fakeDatabases.answerBackup = (request) => ({ op: 'backed-up', id: request.id, ok: true, backup: new Blob([]) });
    expect(await messageOf(database.exportBackup())).toBe('No backup was made: the data could not be copied. (no reason was given)');
    // Nor is an archive that is not a database.
    fakeDatabases.answerBackup = (request) => ({ op: 'backed-up', id: request.id, ok: true, backup: new Blob(['not an archive at all']) });
    expect(await messageOf(database.exportBackup())).toBe('No backup was made: the copy of the data did not come out as a readable archive. Try again.');

    // In none of these cases were the database's own files fetched instead.
    expect(dump).not.toHaveBeenCalled();
  }, 120_000);

  it('gives up soon when no tab holds the database, instead of waiting as long as a backup may take', async () => {
    await openDatabase();
    fakeDatabases.answerBackup = () => 'silence';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });

    const asked = messageOf(requestBackup('claude-lifetime'));
    await waitFor(() => timeline.includes('backup requested claude-lifetime'));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await asked).toBe(
      'The database did not answer, so no backup was made. This can happen for a moment after the tab that held the database was closed. Try again.',
    );
  });

  it('waits for a backup for as long as the worker says it is at work, then says that it was not finished', async () => {
    await openDatabase();
    // Taken up and never answered, by a worker that keeps saying it is at work.
    fakeDatabases.answerBackup = () => null;
    fakeDatabases.backupBeatMs = 5_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });

    const asked = messageOf(requestBackup('claude-lifetime', { startMs: 20_000, quietMs: 30_000, totalMs: 120_000 }));
    await waitFor(() => timeline.includes('backup claude-lifetime: no answer'));
    let settled = false;
    void asked.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await asked).toBe('The backup was not finished after 2 minutes, so nothing was downloaded. Try again.');
  });

  it('gives up when the tab that was making the backup is closed, instead of waiting the whole time out', async () => {
    await openDatabase();
    // Taken up, and then nothing more: no word that the work goes on, and no answer.
    fakeDatabases.answerBackup = () => null;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });

    const asked = messageOf(requestBackup('claude-lifetime', { startMs: 20_000, quietMs: 30_000, totalMs: 900_000 }));
    await waitFor(() => timeline.includes('backup claude-lifetime: no answer'));
    let settled = false;
    void asked.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await asked).toBe('The tab that was making the backup was closed before it was finished, so nothing was downloaded. Try again.');
  });
});

describe('what the page reads from the control channel about a backup', () => {
  const archive = new Blob(['x']);

  it('takes only the messages about its own request', () => {
    expect(readBackupMessage({ op: 'backup-started', id: 'mine' }, 'mine')).toEqual({ status: 'started' });
    expect(readBackupMessage({ op: 'backed-up', id: 'mine', ok: true, backup: archive }, 'mine')).toEqual({ status: 'done', backup: archive });
    for (const other of [
      { op: 'backed-up', id: 'someone-else', ok: true, backup: archive },
      { op: 'backup-started', id: 'someone-else' },
      { op: 'flushed', id: 'mine', ok: true },
      { op: 'backup', id: 'mine' },
      null,
      'backed-up',
    ]) {
      expect(readBackupMessage(other, 'mine'), JSON.stringify(other)).toBeNull();
    }
  });

  it('counts only an archive as a backup', () => {
    expect(readBackupMessage({ op: 'backed-up', id: 'mine', ok: false, error: 'out of memory', explained: false }, 'mine')).toEqual({
      status: 'failed',
      reason: 'out of memory',
      explained: false,
    });
    expect(readBackupMessage({ op: 'backed-up', id: 'mine', ok: false, error: 'A sentence.', explained: true }, 'mine')).toEqual({
      status: 'failed',
      reason: 'A sentence.',
      explained: true,
    });
    for (const broken of [
      { op: 'backed-up', id: 'mine', ok: true },
      { op: 'backed-up', id: 'mine', ok: true, backup: 'a string' },
      { op: 'backed-up', id: 'mine', ok: true, backup: new Blob([]) },
      { op: 'backed-up', id: 'mine' },
      { op: 'backed-up', id: 'mine', ok: false, explained: true },
    ]) {
      expect(readBackupMessage(broken, 'mine'), JSON.stringify(broken)).toEqual({ status: 'failed', reason: 'no reason was given', explained: false });
    }
  });
});
