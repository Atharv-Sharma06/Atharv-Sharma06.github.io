import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's half of PGlite's worker is replaced by a real PostgreSQL in memory; what the worker
// would say (start-up messages, flush answers) is scripted per test. src/db/client.ts runs unchanged.
vi.mock('@electric-sql/pglite/worker', async (original) => ({
  ...(await original<object>()),
  PGliteWorker: (await import('../helpers/fake-pglite-worker')).FakePGliteWorker,
}));

import { updateSettings } from '@/analytics/settings';
import { DATA_CHANNEL, destroyDatabase, openDatabase, releaseDatabase, StorageWriteError, type TabMessage } from '@/db/client';
import { NewerSchemaError } from '@/db/migrate';
import {
  after,
  installIndexedDb,
  installNoWebLocks,
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
 * openDatabase() and what follows from it: starting on data a newer version upgraded,
 * a worker that cannot start, clearing away leftover databases, and what a write that
 * does not reach storage looks like to the code that made it.
 */
const POINTER = 'claude-lifetime:database';
const QUOTA = 'QuotaExceededError: The quota has been exceeded.';

let idb: FakeIndexedDb;
let locks: FakeLocks;
let storage: Record<string, string>;
let closeChannels: () => void;
/** What a device that has used this version of the app before has stored. */
let stored: Blob;
/** What it has stored once a later release of the app has been used on it. */
let storedByNewerVersion: Blob;

beforeAll(async () => {
  stored = await dataDirectory();
  storedByNewerVersion = await dataDirectory(NEWER_MIGRATIONS);
});

beforeEach(() => {
  resetTimeline();
  fakeDatabases.reset();
  fakeDatabases.stored.set('claude-lifetime', stored);
  WorkerStub.created = [];
  closeChannels = trackBroadcastChannels();
  vi.stubGlobal('Worker', WorkerStub);
  storage = installWindow().storage;
  idb = installIndexedDb(['/pglite/claude-lifetime']);
  locks = installWebLocks();
});
afterEach(async () => {
  await releaseDatabase();
  closeChannels();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const outcomeOf = <T>(attempt: Promise<T>) =>
  attempt.then(
    () => null,
    (error: Error) => error,
  );
/** Long enough for the clean-up that openDatabase() starts without waiting for it. */
const cleanUpDone = async () => {
  await waitFor(() => idb.listed > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
};

describe('openDatabase(): data that a newer version of the app has upgraded', () => {
  it('refuses to start, with the error the start-up screen recognises', async () => {
    fakeDatabases.stored.set('claude-lifetime', storedByNewerVersion);

    const failure = await outcomeOf(openDatabase());

    expect(failure, 'the old page must not start on the newer data').not.toBeNull();
    expect(failure).toBeInstanceOf(NewerSchemaError);
    expect((failure as NewerSchemaError).unknownMigrations).toEqual(['20991231000000_from_a_later_release']);
    // The old code did not get as far as writing anything.
    expect(timeline).not.toContain('flush requested claude-lifetime');
  });

  it('fails the same way when asked again, and starts normally on data of its own version', async () => {
    fakeDatabases.stored.set('claude-lifetime', storedByNewerVersion);
    await outcomeOf(openDatabase());
    expect(await outcomeOf(openDatabase())).toBeInstanceOf(NewerSchemaError);

    fakeDatabases.stored.set('claude-lifetime', stored);
    const database = await openDatabase();
    expect(database.userId).toBeGreaterThan(0);
  });

  it('starts normally on a device that has never stored anything', async () => {
    fakeDatabases.stored.clear();
    const database = await openDatabase();
    expect(database.userId).toBeGreaterThan(0);
    expect(timeline).toContain('flush claude-lifetime: ok');
  });
});

describe('openDatabase(): a database worker that cannot start', () => {
  const REASON = 'Could not load /claude-lifetime/pglite/0.5.16/pglite.wasm.gz (HTTP 404)';

  it('fails at once with the reason the worker gives, and stops the worker', async () => {
    // PGlite itself tells the page nothing when its worker cannot start: the page would wait for good.
    fakeDatabases.becomeReady = false;
    const opening = outcomeOf(openDatabase());
    const worker = await waitFor(() => WorkerStub.created[0]);
    worker.emit('message', { data: { type: 'here' } });
    worker.emit('message', { data: { type: 'ready', id: 'x' } });
    worker.emit('message', { data: { type: 'claude-lifetime:start-failed', error: REASON } });

    const failure = await Promise.race([opening, after(5000, 'still waiting after 5 seconds')]);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(REASON);
    expect(worker.terminated).toBe(true);
  });

  it('can be tried again afterwards', async () => {
    fakeDatabases.becomeReady = false;
    const opening = outcomeOf(openDatabase());
    (await waitFor(() => WorkerStub.created[0])).emit('message', { data: { type: 'claude-lifetime:start-failed', error: REASON } });
    expect(await opening).toBeInstanceOf(Error);

    fakeDatabases.becomeReady = true;
    const database = await openDatabase();
    expect(database.userId).toBeGreaterThan(0);
    expect(WorkerStub.created).toHaveLength(2);
  });

  it('still reports a worker whose script fails, as before', async () => {
    fakeDatabases.becomeReady = false;
    const opening = outcomeOf(openDatabase());
    const worker = await waitFor(() => WorkerStub.created[0]);
    worker.emit('error', { message: 'Uncaught SyntaxError: Unexpected token' });

    const failure = await Promise.race([opening, after(5000, 'still waiting after 5 seconds')]);
    expect((failure as Error).message).toBe('Uncaught SyntaxError: Unexpected token');
    expect(worker.terminated).toBe(true);
  });

  it('stops a worker that reports a failed start long after the page connected', async () => {
    // The worker of this tab was only waiting its turn. It is asked to host the database when the tab
    // that did so closes; if it cannot, it must not keep that role.
    await openDatabase();
    const worker = WorkerStub.created[0];
    expect(worker.terminated).toBe(false);
    worker.emit('message', { data: { type: 'claude-lifetime:start-failed', error: REASON } });
    await waitFor(() => worker.terminated);
  });
});

describe('openDatabase(): databases left behind by earlier restores', () => {
  it('clears away leftovers, and nothing that is not a database of this app', async () => {
    idb.names.add('/pglite/claude-lifetime-left0ver');
    idb.names.add('claude-lifetime-local');
    idb.names.add('/pglite/some-other-app');

    await openDatabase();
    await cleanUpDone();

    expect(idb.deleted).toEqual(['/pglite/claude-lifetime-left0ver']);
  });

  it('leaves a database alone that a restore in another tab is still building', async () => {
    idb.names.add('/pglite/claude-lifetime-build1ng');
    idb.names.add('/pglite/claude-lifetime-left0ver');
    const finishRestore = await locks.holdElsewhere('claude-lifetime:restore:claude-lifetime-build1ng');

    await openDatabase();
    await cleanUpDone();

    expect(idb.deleted).toEqual(['/pglite/claude-lifetime-left0ver']);
    finishRestore();
  });

  it('leaves a database alone that became the current one while this tab was starting', async () => {
    // Another tab finishes a restore just as this one looks for leftovers: the lock is gone already,
    // and the pointer names the restored database.
    idb.whileListing = () => {
      idb.names.add('/pglite/claude-lifetime-fresh001');
      storage[POINTER] = 'claude-lifetime-fresh001';
    };

    await openDatabase();
    await cleanUpDone();

    expect(idb.deleted).toEqual([]);
  });

  it('removes nothing where the browser cannot say which locks are held', async () => {
    vi.unstubAllGlobals();
    closeChannels = trackBroadcastChannels();
    vi.stubGlobal('Worker', WorkerStub);
    storage = installWindow().storage;
    idb = installIndexedDb(['/pglite/claude-lifetime', '/pglite/claude-lifetime-left0ver']);
    locks = installWebLocks({ query: false });

    await openDatabase();
    await cleanUpDone();

    expect(idb.deleted).toEqual([]);
  });

  it('removes nothing, and still opens, in a browser without Web Locks', async () => {
    vi.unstubAllGlobals();
    closeChannels = trackBroadcastChannels();
    vi.stubGlobal('Worker', WorkerStub);
    storage = installWindow().storage;
    idb = installIndexedDb(['/pglite/claude-lifetime', '/pglite/claude-lifetime-left0ver']);
    installNoWebLocks();

    const database = await openDatabase();
    await cleanUpDone();

    expect(database.userId).toBeGreaterThan(0);
    expect(idb.deleted).toEqual([]);
  });
});

describe('SqlDriver.flush(): a change that has to reach this device’s storage', () => {
  const refuse = () => {
    fakeDatabases.answerFlush = (request) => ({ op: 'flushed', id: request.id, ok: false, error: QUOTA });
  };

  it('resolves when the worker confirms the copy', async () => {
    const { db } = await openDatabase();
    await expect(db.flush()).resolves.toBeUndefined();
  });

  it('fails with a plain message when the browser refuses to store the change', async () => {
    const { db } = await openDatabase();
    refuse();

    const failure = await outcomeOf(db.flush());

    expect(failure?.message).toBe(
      `The change could not be saved to this device's storage and may be lost when the app is closed. The storage is probably full: free up space on this device, then try again. (${QUOTA})`,
    );
    expect(failure).toBeInstanceOf(StorageWriteError);
    expect((failure as StorageWriteError).reason).toBe(QUOTA);
  });

  it('makes a settings change fail instead of reporting it as saved', async () => {
    const { db, userId } = await openDatabase();
    refuse();
    await expect(updateSettings(db, userId, { basis: 'new' })).rejects.toThrow(/could not be saved to this device's storage/);
  });

  it('does not call a change lost just because nobody answered in time', async () => {
    const { db } = await openDatabase();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    fakeDatabases.answerFlush = () => null;

    const flushing = db.flush();
    await waitFor(() => timeline.includes('flush claude-lifetime: no answer'));
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(flushing).resolves.toBeUndefined();
  });

  it('lets the app open when the set-up cannot be stored, so that a full device can still read and back up its data', async () => {
    refuse();
    const database = await openDatabase();
    expect(database.userId).toBeGreaterThan(0);
    expect(timeline).toContain('flush claude-lifetime: failed');
    const backup = await database.exportBackup();
    expect(backup.size).toBeGreaterThan(0);
  });
});

describe('destroyDatabase(): erasing everything stays as it was', () => {
  it('deletes every database of the app and what the app keeps beside them, and tells the other tabs', async () => {
    storage['claude-lifetime:range'] = '{"preset":"90d"}';
    storage[POINTER] = 'claude-lifetime-current1';
    storage['someone-else'] = 'kept';
    idb.names.clear();
    for (const name of ['/pglite/claude-lifetime-current1', '/pglite/claude-lifetime-left0ver', 'claude-lifetime-local', '/pglite/some-other-app']) idb.names.add(name);
    const heard: string[] = [];
    const otherTab = new BroadcastChannel(DATA_CHANNEL);
    otherTab.onmessage = (event: MessageEvent<TabMessage>) => heard.push(event.data.op);
    await openDatabase();

    await destroyDatabase();
    await waitFor(() => heard.length === 2);

    expect(heard).toEqual(['release', 'reload']);
    expect([...idb.deleted].sort()).toEqual(['/pglite/claude-lifetime', '/pglite/claude-lifetime-current1', '/pglite/claude-lifetime-left0ver', 'claude-lifetime-local']);
    expect(storage).toEqual({ 'someone-else': 'kept' });
    expect(WorkerStub.created[0].terminated).toBe(true);
  });
});
