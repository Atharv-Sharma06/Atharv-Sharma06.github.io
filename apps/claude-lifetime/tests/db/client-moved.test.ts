import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's half of PGlite's worker is replaced by a real PostgreSQL in memory (see the helper).
// src/db/client.ts runs unchanged.
vi.mock('@electric-sql/pglite/worker', async (original) => ({
  ...(await original<object>()),
  PGliteWorker: (await import('../helpers/fake-pglite-worker')).FakePGliteWorker,
}));

import { getSettings, updateSettings } from '@/analytics/settings';
import { DatabaseBusyError, openDatabase, releaseDatabase, SETUP_TIMEOUT_MS } from '@/db/client';
import { DatabaseMovedError } from '@/db/driver';
import { installIndexedDb, installWebLocks, installWindow, resetTimeline, trackBroadcastChannels, waitFor, WorkerStub, type FakeLocks } from '../helpers/browser';
import { dataDirectory, fakeDatabases } from '../helpers/fake-pglite-worker';

/**
 * A tab of the app while the database is held by another tab: what it does when that
 * tab is closed or reloaded in the middle of something, and when the database does not
 * answer at all.
 */
const SETUP_LOCK = 'claude-lifetime:setup:claude-lifetime';
/** Stands for an answer that does not come: the tab that held the database is gone, or busy. */
const noAnswer = () => new Promise<void>(() => undefined);

let locks: FakeLocks;
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
  locks = installWebLocks();
});
afterEach(async () => {
  fakeDatabases.beforeStatement = null;
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

describe('a tab that is starting while the database changes hands', () => {
  it('starts its set-up over when the tab that held the database goes away in the middle of it', async () => {
    let asked = 0;
    // The first statement of the set-up is never answered: the tab it was sent to is gone.
    fakeDatabases.beforeStatement = () => (++asked === 1 ? noAnswer() : undefined);
    const opening = openDatabase();
    await waitFor(() => asked === 1);

    fakeDatabases.move();

    // Before the fix the tab stayed on "Preparing the database…" for good and kept the set-up lock,
    // so every tab opened after it waited as well.
    const database = await opening;
    expect(database.userId).toBeGreaterThan(0);
    expect(asked).toBeGreaterThan(1);
    expect(locks.held()).not.toContain(SETUP_LOCK);
    expect((await getSettings(database.db, database.userId)).basis).toBe('processed');
  });

  it('stops trying after a few moves in a row, lets the next tab try, and leaves no worker behind', async () => {
    let asked = 0;
    fakeDatabases.beforeStatement = () => {
      asked++;
      return noAnswer();
    };
    const opening = outcomeOf(openDatabase());
    for (let attempt = 1; attempt <= 4; attempt++) {
      await waitFor(() => asked === attempt);
      fakeDatabases.move();
    }

    expect(await opening).toBeInstanceOf(DatabaseMovedError);
    expect(locks.held()).not.toContain(SETUP_LOCK);
    expect(WorkerStub.created).toHaveLength(1);
    expect(WorkerStub.created[0].terminated).toBe(true);
  });
});

describe('a tab that is starting while the database does not answer', () => {
  it('gives up after two minutes with an error the start-up screen explains, and lets go of the set-up lock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const asked: Array<[connection: number, sql: string]> = [];
    let answer!: () => void;
    const busy = new Promise<void>((resolve) => (answer = resolve));
    fakeDatabases.beforeStatement = (sql, connection) => {
      asked.push([connection, sql]);
      return connection === 0 ? busy : undefined;
    };
    const opening = outcomeOf(openDatabase());
    await waitFor(() => asked.length === 1);
    expect(locks.held()).toContain(SETUP_LOCK);

    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    const failure = await opening;
    expect(failure).toBeInstanceOf(DatabaseBusyError);
    expect(failure?.message).toBe('The database did not answer within 2 minutes.');
    // Before the fix there was no limit: the lock stayed with this tab, and every other tab waited behind it.
    expect(locks.held()).not.toContain(SETUP_LOCK);
    expect(WorkerStub.created[0].terminated).toBe(true);

    // "Try again" works once the database answers, with a connection of its own.
    const database = await openDatabase();
    expect(database.userId).toBeGreaterThan(0);
    expect(WorkerStub.created).toHaveLength(2);

    // The first attempt's statement is answered at last. Nothing of that attempt goes on behind what the page shows now.
    const before = asked.filter(([connection]) => connection === 0).length;
    answer();
    await vi.advanceTimersByTimeAsync(200);
    expect(asked.filter(([connection]) => connection === 0)).toHaveLength(before);
    expect(before).toBe(1);
  });
});

describe('a tab that gets no answer while it connects', () => {
  const timers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });

  it('says that the database is busy when it was waiting for another tab’s worker, which is saving that tab’s import', async () => {
    timers();
    // The worker that holds the database does not get round to answering: it is in the middle of something long.
    fakeDatabases.becomeReady = false;
    const opening = outcomeOf(openDatabase());
    await waitFor(() => WorkerStub.created.length === 1);

    // Before the fix the tab gave up after 90 seconds with "The local database could not be opened" and advice
    // about private windows and disk space, while its own hint still said it would go on when the other tab was done.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(WorkerStub.created[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);

    const failure = await opening;
    expect(failure).toBeInstanceOf(DatabaseBusyError);
    expect(failure?.message).toBe('The database did not answer within 2 minutes.');
    expect(WorkerStub.created[0].terminated).toBe(true);
  });

  it('says that the database did not open when its own worker was the one opening it', async () => {
    timers();
    fakeDatabases.becomeReady = false;
    fakeDatabases.leads = true;
    const opening = outcomeOf(openDatabase());
    await waitFor(() => WorkerStub.created.length === 1);
    await vi.advanceTimersByTimeAsync(90_500);

    const failure = await opening;
    expect(failure).not.toBeInstanceOf(DatabaseBusyError);
    expect(failure?.message).toBe('The database did not open in time.');
  });

  it('starts the wait anew when its own worker is chosen to open the database after all', async () => {
    timers();
    fakeDatabases.becomeReady = false;
    const opening = outcomeOf(openDatabase());
    await waitFor(() => WorkerStub.created.length === 1);
    await vi.advanceTimersByTimeAsync(100_000);
    // The tab that held the database is closed, and this tab's worker begins to open it.
    fakeDatabases.leads = true;
    fakeDatabases.move();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(WorkerStub.created[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(30_500);

    expect((await opening)?.message).toBe('The database did not open in time.');
  });
});

describe('a change that is under way when the tab that held the database goes away', () => {
  it('fails with a message for the person instead of waiting for good, and the next change goes through', async () => {
    const { db, userId } = await openDatabase();
    let asked = 0;
    fakeDatabases.beforeStatement = () => (++asked === 1 ? noAnswer() : undefined);
    const saving = outcomeOf(updateSettings(db, userId, { basis: 'new' }));
    await waitFor(() => asked === 1);

    fakeDatabases.move();

    // Before the fix this promise never settled: a dialog that waited for it stayed busy and could not be closed.
    const failure = await saving;
    expect(failure).toBeInstanceOf(DatabaseMovedError);
    expect(failure?.message).toBe(
      'The tab that held the database was closed or reloaded at that moment, and another tab has taken over. It is not known whether your change was stored: check, and make it again if it is missing.',
    );
    expect((await updateSettings(db, userId, { basis: 'new' })).basis).toBe('new');
  });
});
