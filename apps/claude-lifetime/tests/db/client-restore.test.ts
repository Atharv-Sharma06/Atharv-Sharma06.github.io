import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's half of PGlite's worker is replaced by a real PostgreSQL in memory; the worker's half of
// the conversation (flush answers) is scripted per test. Everything in src/db/client.ts runs unchanged.
vi.mock('@electric-sql/pglite/worker', async (original) => ({
  ...(await original<object>()),
  PGliteWorker: (await import('../helpers/fake-pglite-worker')).FakePGliteWorker,
}));

import { openDatabase, releaseDatabase, restoreDatabase } from '@/db/client';
import { MIGRATIONS } from '@/db/migrations.generated';
import {
  installIndexedDb,
  installWebLocks,
  installWindow,
  resetTimeline,
  timeline,
  trackBroadcastChannels,
  waitFor,
  WorkerStub,
  type FakeIndexedDb,
  type FakeLocks,
} from '../helpers/browser';
import { dataDirectory, fakeDatabases, NEWER_MIGRATIONS } from '../helpers/fake-pglite-worker';

/**
 * restoreDatabase(): a backup replaces the stored data only when it could be read,
 * brought up to date and written to this device's storage. Until then nothing that is
 * stored may change, and no other tab may clear the half-made database away.
 */
const POINTER = 'claude-lifetime:database';
const QUOTA = 'QuotaExceededError: The quota has been exceeded.';

let backup: Blob;
let idb: FakeIndexedDb;
let locks: FakeLocks;
let storage: Record<string, string>;
let closeChannels: () => void;

beforeAll(async () => {
  backup = await dataDirectory();
});

function browser(pointer?: string) {
  storage = installWindow(pointer ? { [POINTER]: pointer } : {}).storage;
  idb = installIndexedDb([`/pglite/${pointer ?? 'claude-lifetime'}`]);
  locks = installWebLocks();
}

beforeEach(() => {
  resetTimeline();
  fakeDatabases.reset();
  WorkerStub.created = [];
  closeChannels = trackBroadcastChannels();
  vi.stubGlobal('Worker', WorkerStub);
  browser();
});
afterEach(async () => {
  await releaseDatabase();
  closeChannels();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const failureOf = (attempt: Promise<void>) =>
  attempt.then(
    () => null,
    (error: Error) => error,
  );
/** The database the restore built, which is the only one opened from a backup. */
const built = () => fakeDatabases.opened.find((database) => database.fromBackup)!;

describe('restoreDatabase(): the restored data must be in storage before it replaces anything', () => {
  it('changes nothing and says why when the browser refuses to store the restored data', async () => {
    fakeDatabases.answerFlush = (request) => ({ op: 'flushed', id: request.id, ok: false, error: QUOTA });

    const failure = await failureOf(restoreDatabase(backup));

    expect(failure?.message).toBe(
      `The backup could not be saved to this device's storage, so nothing was changed. The storage is probably full: a restore needs room for the backup's data next to the data stored now. Free up space on this device, then restore the backup again. (${QUOTA})`,
    );
    // The stored data is still the current data, and it was not deleted.
    expect(storage[POINTER]).toBeUndefined();
    expect(idb.deleted).toEqual([`/pglite/${built().name}`]);
    expect(idb.names.has('/pglite/claude-lifetime')).toBe(true);
    expect(locks.held()).toEqual([]);
  });

  it('changes nothing when the copy to storage is never confirmed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    fakeDatabases.answerFlush = () => null;

    const outcome = failureOf(restoreDatabase(backup));
    await waitFor(() => timeline.includes(`flush ${built()?.name}: no answer`));
    // A quarter of a minute is how long an ordinary write waits. A restore must not go on after that.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage[POINTER]).toBeUndefined();
    expect(built().closed).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const failure = await outcome;
    expect(failure?.message).toBe(
      "The browser did not confirm within 5 minutes that the backup was saved to this device's storage, so nothing was changed. Restore the backup again. If that keeps failing, free up space on this device first.",
    );
    expect(storage[POINTER]).toBeUndefined();
    expect(idb.deleted).toEqual([`/pglite/${built().name}`]);
    expect(idb.names.has('/pglite/claude-lifetime')).toBe(true);
  });

  it('waits for the confirmation before it closes the restored database and makes it the current one', async () => {
    let release!: () => void;
    const copying = new Promise<void>((resolve) => (release = resolve));
    fakeDatabases.answerFlush = async (request) => {
      await copying;
      return { op: 'flushed', id: request.id, ok: true };
    };

    const restoring = restoreDatabase(backup);
    await waitFor(() => timeline.includes(`flush requested ${built()?.name}`));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The copy is still running: closing now would stop the worker in the middle of it.
    expect(built().closed).toBe(false);
    expect(storage[POINTER]).toBeUndefined();

    release();
    await restoring;
    expect(built().closed).toBe(true);
    expect(storage[POINTER]).toBe(built().name);
  });
});

describe('restoreDatabase(): the database it replaces', () => {
  it('deletes the previous database itself, after the new one has become the current one', async () => {
    await openDatabase();
    resetTimeline();

    await restoreDatabase(backup);

    const name = built().name;
    expect(name).toMatch(/^claude-lifetime-[a-z0-9]+$/);
    expect(storage[POINTER]).toBe(name);
    expect(idb.deleted).toEqual(['/pglite/claude-lifetime']);
    expect(timeline).toEqual([
      `lock claude-lifetime:restore:${name}`,
      `open ${name}`,
      `flush requested ${name}`,
      `flush ${name}: ok`,
      `close ${name}`,
      `localStorage ${POINTER}=${name}`,
      // this tab lets go of the database it had open, then deletes it
      'worker stopped',
      'delete /pglite/claude-lifetime',
      `unlock claude-lifetime:restore:${name}`,
    ]);
  });

  it('deletes the database the pointer named, also when that was itself a restored one', async () => {
    vi.unstubAllGlobals();
    closeChannels = trackBroadcastChannels();
    vi.stubGlobal('Worker', WorkerStub);
    browser('claude-lifetime-earlier1');

    await restoreDatabase(backup);

    expect(storage[POINTER]).toBe(built().name);
    expect(idb.deleted).toEqual(['/pglite/claude-lifetime-earlier1']);
  });

  it('keeps the previous database when the new one cannot be made the current one', async () => {
    vi.unstubAllGlobals();
    closeChannels = trackBroadcastChannels();
    vi.stubGlobal('Worker', WorkerStub);
    storage = installWindow({}, { refuseWrites: true }).storage;
    idb = installIndexedDb(['/pglite/claude-lifetime']);
    locks = installWebLocks();

    const failure = await failureOf(restoreDatabase(backup));

    expect(failure?.message).toBe('This browser does not allow the site to save settings, so the backup cannot be activated. Nothing was changed.');
    expect(idb.deleted).toEqual([`/pglite/${built().name}`]);
    expect(locks.held()).toEqual([]);
  });
});

describe('restoreDatabase(): a tab that starts while a restore is under way', () => {
  it('does not clear away the database the restore is still building', async () => {
    // The restore in this tab is held at the point where the restored data is being copied to storage.
    let release!: () => void;
    const copying = new Promise<void>((resolve) => (release = resolve));
    fakeDatabases.answerFlush = async (request, database) => {
      if (database !== 'claude-lifetime') await copying;
      return { op: 'flushed', id: request.id, ok: true };
    };
    const restoring = restoreDatabase(backup);
    await waitFor(() => timeline.includes(`flush requested ${built()?.name}`));
    const name = built().name;
    // By now the browser lists the new database next to the current one.
    idb.names.add(`/pglite/${name}`);

    // A second tab: its own copy of the client, the same browser underneath.
    vi.resetModules();
    const otherTab = await import('@/db/client');
    expect(otherTab.openDatabase).not.toBe(openDatabase);
    await otherTab.openDatabase();
    await waitFor(() => idb.listed > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(idb.deleted).toEqual([]);

    release();
    await restoring;
    await otherTab.releaseDatabase();
    // The restore finished on a database that still exists, and only the replaced one is gone.
    expect(storage[POINTER]).toBe(name);
    expect(idb.names.has(`/pglite/${name}`)).toBe(true);
    expect(idb.deleted).toEqual(['/pglite/claude-lifetime']);
  });
});

describe('restoreDatabase(): backups from other versions of the app', () => {
  const NEWER_VERSION =
    'This backup was made by a newer version of Claude Lifetime than the one running here. Reload the page to update, then restore it again.';

  it('refuses a backup made by a newer version and says to reload', async () => {
    const newer = await dataDirectory(NEWER_MIGRATIONS);

    const failure = await failureOf(restoreDatabase(newer));

    expect(failure?.message).toBe(NEWER_VERSION);
    expect(storage[POINTER]).toBeUndefined();
    expect(idb.deleted).toEqual([`/pglite/${built().name}`]);
  });

  it('does not blame a newer version when a backup of this version cannot be brought up to date', async () => {
    // A backup whose record of an applied migration does not match what this build ships.
    const mismatched = await dataDirectory(MIGRATIONS, async (db) => {
      await db.query(`UPDATE "_prisma_migrations" SET "checksum" = $1 WHERE "migration_name" = $2`, ['0'.repeat(64), MIGRATIONS[0].name]);
    });

    const failure = await failureOf(restoreDatabase(mismatched));

    expect(failure?.message).not.toBe(NEWER_VERSION);
    expect(failure?.message).toBe(
      `This backup could not be updated to work with this version of Claude Lifetime, so nothing was changed. (Migration "${MIGRATIONS[0].name}" was changed after it was applied to this database. Add a new migration instead of editing an applied one.)`,
    );
    expect(storage[POINTER]).toBeUndefined();
  });

  it('still turns away a file that is not a backup before anything is opened', async () => {
    await expect(restoreDatabase(new Blob(['hello world, this is not a backup']))).rejects.toThrow(/not a Claude Lifetime backup/);
    expect(fakeDatabases.opened).toEqual([]);
    expect(storage[POINTER]).toBeUndefined();
    expect(idb.deleted).toEqual([]);
  });
});
