'use client';

import { LeaderChangedError, PGliteWorker } from '@electric-sql/pglite/worker';
import { decryptBackup, isEncryptedBackup } from '@/lib/backup-crypto';
import { looksLikeDatabaseDump } from '@/lib/backup-format';
import { KV_DATABASE_NAME } from '@/lib/kv';
import { DatabaseMovedError, type SqlDriver } from './driver';
import { ensureStatistics } from './maintenance';
import { migrate, MigrationError, NewerSchemaError } from './migrate';
import { pgliteDriver } from './pglite-driver';
import { ensureSeeded } from './seed';
import type { BackupAnswer, BackupRequest, BackupStarted, FlushAnswer, FlushRequest, StartFailure, WorkerMeta } from './worker/pglite.worker';

/**
 * Browser entry point to the database: one PostgreSQL instance (PGlite) per browser
 * profile, shared by all tabs, persisted in IndexedDB on this device only.
 *
 * The database lives in an IndexedDB database named after a pointer kept in
 * localStorage. Restoring a backup builds and checks a complete new database under a
 * new name first, waits until the browser has confirmed that it is stored, and only
 * then moves the pointer, so a backup that cannot be read or stored never costs the
 * data that is already here.
 */
const PGLITE_VERSION = '0.5.16';
const DEFAULT_NAME = 'claude-lifetime';
const POINTER_KEY = 'claude-lifetime:database';
/**
 * Tabs talk to each other here. Every message carries the sender's TAB_ID, because a
 * BroadcastChannel also delivers to other channel objects in the sender's own page.
 *
 *  changed   stored data changed: re-read it
 *  release   the database is about to be erased: close your connection and wait
 *  reload    the database was replaced or erased: load the page again
 */
export const DATA_CHANNEL = 'claude-lifetime:data';
export const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
export type TabMessage = { from: string; op: 'changed' | 'release' | 'reload' };
/** Everything the app keeps in localStorage starts with this. */
export const LOCAL_STORAGE_PREFIX = 'claude-lifetime:';
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export interface Database {
  db: SqlDriver;
  userId: number;
  /**
   * A backup: a compressed copy of everything that is stored now, and of nothing that was
   * deleted. Rejects with a message for the person when no backup could be made.
   */
  exportBackup(): Promise<Blob>;
}

export type BootPhase = 'starting' | 'migrating' | 'ready';

function activeName(): string {
  try {
    const value = window.localStorage.getItem(POINTER_KEY);
    if (value && /^claude-lifetime(-[a-z0-9]{1,24})?$/.test(value)) return value;
  } catch {
    // no storage access: the default name is used
  }
  return DEFAULT_NAME;
}

const idbName = (name: string) => `/pglite/${name}`;
const controlChannel = (name: string) => `claude-lifetime:db-control:${name}`;
/** The Web Lock a restore holds on the database it is building. */
const restoreLock = (name: string) => `claude-lifetime:restore:${name}`;

/** The app's name for one of its databases, given the name IndexedDB lists it under, or null for anything else. */
function appDatabaseName(listed: string | undefined): string | null {
  return listed?.match(/^\/pglite\/(claude-lifetime(?:-[a-z0-9]{1,24})?)$/)?.[1] ?? null;
}

// ── Saving to this device's storage ─────────────────────────────────────────────

/** What became of a request to copy the database to this device's storage. */
export type FlushOutcome =
  | { status: 'confirmed' }
  /** The copy was tried and did not work. `reason` is the browser's own error text. */
  | { status: 'failed'; reason: string }
  /** Nobody answered in time, so it is not known whether the copy was made. */
  | { status: 'unanswered' };

/** What was written could not be copied to this device's storage. The message is written for the person using the app. */
export class StorageWriteError extends Error {
  constructor(
    message: string,
    /** The browser's own error text, when it gave one. */
    readonly reason: string | null,
  ) {
    super(message);
    this.name = 'StorageWriteError';
  }
}

/** How long a page waits for the answer to a flush after an ordinary write. */
const FLUSH_TIMEOUT_MS = 15_000;
/** How long a restore waits for the whole restored database to reach storage. No answer by then counts as a failure. */
const RESTORE_FLUSH_TIMEOUT_MS = 300_000;

/**
 * Reads what the database worker answered to the flush request `id`. Null for any
 * other message: the channel is shared by every tab, so it also carries their requests
 * and the answers to them.
 */
export function readFlushAnswer(message: unknown, id: string): FlushOutcome | null {
  if (typeof message !== 'object' || message === null) return null;
  const answer = message as Partial<FlushAnswer> & { error?: unknown };
  if (answer.op !== 'flushed' || answer.id !== id) return null;
  // Only an explicit yes means the copy was made. Anything else is the worker saying that it was not.
  if (answer.ok === true) return { status: 'confirmed' };
  return { status: 'failed', reason: typeof answer.error === 'string' && answer.error !== '' ? answer.error : 'no reason was given' };
}

/**
 * Asks the worker that hosts database `name` to copy everything committed so far to
 * this device's storage, and reports what came of it.
 */
export function requestFlush(name: string, timeoutMs: number): Promise<FlushOutcome> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(controlChannel(name));
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const finish = (outcome: FlushOutcome) => {
      clearTimeout(timer);
      channel.close();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: 'unanswered' }), timeoutMs);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const outcome = readFlushAnswer(event.data, id);
      if (outcome) finish(outcome);
    };
    channel.postMessage({ op: 'flush', id } satisfies FlushRequest);
  });
}

/**
 * `SqlDriver.flush()` for database `name`, called after every change the app makes.
 * Throws a StorageWriteError when the browser refused to store the change.
 */
async function saveWrites(name: string): Promise<void> {
  const outcome = await requestFlush(name, FLUSH_TIMEOUT_MS);
  if (outcome.status === 'failed') {
    throw new StorageWriteError(
      `The change could not be saved to this device's storage and may be lost when the app is closed. The storage is probably full: free up space on this device, then try again. (${outcome.reason})`,
      outcome.reason,
    );
  }
  // No answer in time is deliberately not an error. The change is already committed in the database,
  // which copies itself to storage in the background after every statement whether or not anyone asks.
  // A large database can simply take longer to copy than this wait. And when the tab that hosted the
  // database has just been closed, the tab taking over is still starting and cannot answer yet. In none
  // of these cases is it known that anything was lost, so telling the person that their change could
  // not be saved would be wrong more often than right.
}

// ── Backups ─────────────────────────────────────────────────────────────────────

/** How long a page waits for the database worker to take up a backup request. */
const BACKUP_START_TIMEOUT_MS = 20_000;
/**
 * How long the worker may stay silent while it makes a backup. It says that it is at work every
 * few seconds; silence for this long means the tab that was making the backup has been closed.
 * Generous, because one large table can keep the worker busy for a while without a word.
 */
const BACKUP_QUIET_TIMEOUT_MS = 90_000;
/** How long the backup itself may take. The whole database is copied row by row and then packed. */
const BACKUP_TIMEOUT_MS = 900_000;

/** What the database worker said about the backup request `id`. Null for any other message on the channel. */
export type BackupMessage =
  | { status: 'started' }
  | { status: 'done'; backup: Blob }
  /** `explained` is true when `reason` is already a sentence for the person. */
  | { status: 'failed'; reason: string; explained: boolean };

export function readBackupMessage(message: unknown, id: string): BackupMessage | null {
  if (typeof message !== 'object' || message === null) return null;
  const answer = message as Partial<BackupAnswer | BackupStarted> & { backup?: unknown; error?: unknown; explained?: unknown };
  if (answer.id !== id) return null;
  if (answer.op === ('backup-started' satisfies BackupStarted['op'])) return { status: 'started' };
  if (answer.op !== ('backed-up' satisfies BackupAnswer['op'])) return null;
  // Only an archive with something in it is a backup. Anything else is the worker saying that there is none.
  if (answer.ok === true && answer.backup instanceof Blob && answer.backup.size > 0) return { status: 'done', backup: answer.backup };
  const reason = typeof answer.error === 'string' && answer.error !== '' ? answer.error : 'no reason was given';
  return { status: 'failed', reason, explained: answer.explained === true && reason !== 'no reason was given' };
}

/**
 * Asks the worker that hosts database `name` for a backup: an archive of a copy that
 * holds the rows stored now and nothing that was deleted. Rejects, with a message
 * written for the person, when no backup was made. There is no other way to get a
 * backup: the database's own files still hold deleted rows and are never handed out.
 */
export function requestBackup(
  name: string,
  timeouts: { startMs?: number; quietMs?: number; totalMs?: number } = {},
): Promise<Blob> {
  const { startMs = BACKUP_START_TIMEOUT_MS, quietMs = BACKUP_QUIET_TIMEOUT_MS, totalMs = BACKUP_TIMEOUT_MS } = timeouts;
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(controlChannel(name));
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      clearTimeout(startTimer);
      clearTimeout(quietTimer);
      clearTimeout(totalTimer);
      channel.close();
    };
    const fail = (message: string) => {
      end();
      reject(new Error(message));
    };
    const startTimer = setTimeout(
      () =>
        fail(
          'The database did not answer, so no backup was made. This can happen for a moment after the tab that held the database was closed. Try again.',
        ),
      startMs,
    );
    const totalTimer = setTimeout(() => fail(`The backup was not finished after ${Math.round(totalMs / 60_000)} minutes, so nothing was downloaded. Try again.`), totalMs);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const said = readBackupMessage(event.data, id);
      if (said === null) return;
      if (said.status === 'started') {
        clearTimeout(startTimer);
        // The worker says this again every few seconds while it works. When it stops, the tab that held the database is gone.
        clearTimeout(quietTimer);
        quietTimer = setTimeout(
          () => fail('The tab that was making the backup was closed before it was finished, so nothing was downloaded. Try again.'),
          quietMs,
        );
      } else if (said.status === 'done') {
        end();
        resolve(said.backup);
      } else {
        fail(said.explained ? `No backup was made. ${said.reason}` : `No backup was made: the data could not be copied. (${said.reason})`);
      }
    };
    channel.postMessage({ op: 'backup', id } satisfies BackupRequest);
  });
}

/** `Database.exportBackup()` for database `name`. */
async function makeBackup(name: string): Promise<Blob> {
  const backup = await requestBackup(name);
  // Checked the way a restore checks it, so that a file that could not be restored is never saved as a backup.
  if (!(await looksLikeDatabaseDump(backup))) throw new Error('No backup was made: the copy of the data did not come out as a readable archive. Try again.');
  return backup;
}

/** Why a restored database that did not reach storage was dropped again, in words for the person restoring. */
function restoreNotSaved(outcome: Exclude<FlushOutcome, { status: 'confirmed' }>): StorageWriteError {
  if (outcome.status === 'failed') {
    return new StorageWriteError(
      `The backup could not be saved to this device's storage, so nothing was changed. The storage is probably full: a restore needs room for the backup's data next to the data stored now. Free up space on this device, then restore the backup again. (${outcome.reason})`,
      outcome.reason,
    );
  }
  return new StorageWriteError(
    `The browser did not confirm within ${RESTORE_FLUSH_TIMEOUT_MS / 60_000} minutes that the backup was saved to this device's storage, so nothing was changed. Restore the backup again. If that keeps failing, free up space on this device first.`,
    null,
  );
}

/** What to tell the person when a restore stopped before the backup became the stored data. */
export function restoreFailureMessage(error: unknown): string {
  // Already written for the person: the backup was fine, storing it was the problem.
  if (error instanceof StorageWriteError) return error.message;
  if (error instanceof NewerSchemaError) {
    return 'This backup was made by a newer version of Claude Lifetime than the one running here. Reload the page to update, then restore it again.';
  }
  if (error instanceof MigrationError) {
    return `This backup could not be updated to work with this version of Claude Lifetime, so nothing was changed. (${error.message})`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `The backup could not be read, so nothing was changed. (${detail})`;
}

// ── Connecting ──────────────────────────────────────────────────────────────────

// PGlite's page class asks the database a few things of its own when it connects, and waits for none of
// them. One that is under way when the database moves fails with nobody to tell. The app deals with a move
// itself (see pglite-driver.ts), so that failure is kept out of the console, where it would read as a fault.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof LeaderChangedError) event.preventDefault();
  });
}

interface Handle {
  pg: PGliteWorker;
  db: SqlDriver;
  /**
   * Stops the database worker at once, for a database this page is finished with (it is
   * about to be erased or replaced, and the page reloads). Nothing more is sent through
   * `db` afterwards. Used instead of closing the client: closing tears down the channels
   * the client reaches other tabs on, while a timer of its own still posts to them
   * whenever the tab that hosts the database has just changed, and that ends in an
   * uncaught error.
   */
  stop(): void;
  /**
   * Gives this connection up after a start that did not get through, so that nothing of
   * it goes on behind the error the page shows: whatever was still waiting for the
   * database is refused when its turn comes. The worker is stopped as well, unless it is
   * the one that holds the database for the other tabs.
   */
  giveUp(): void;
}

/** How long opening the database may take before it counts as failed. Restoring unpacks the whole backup first. */
const OPEN_TIMEOUT_MS = 90_000;
const RESTORE_TIMEOUT_MS = 240_000;

/** The reason a database worker gave for not starting, or null when the message is about something else. */
export function readStartFailure(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const failure = message as Partial<StartFailure> & { error?: unknown };
  if (failure.type !== ('claude-lifetime:start-failed' satisfies StartFailure['type'])) return null;
  return typeof failure.error === 'string' && failure.error !== '' ? failure.error : 'The database could not be started.';
}

async function connect(name: string, loadDataDir?: Blob): Promise<Handle> {
  const worker = new Worker(new URL('./worker/pglite.worker.ts', import.meta.url), { type: 'module' });
  const pg = new PGliteWorker(worker, {
    dataDir: `idb://${name}`,
    ...(loadDataDir ? { loadDataDir } : {}),
    meta: { assetBase: `${BASE_PATH}/pglite/${PGLITE_VERSION}/`, controlChannel: controlChannel(name) } satisfies WorkerMeta,
  });
  // The engine never rejects `waitReady` when it cannot start: the failure stays inside the worker.
  // The worker therefore says so itself (see pglite.worker.ts), and that message, an error in the
  // worker or no answer in time ends the attempt here. The worker is stopped so it cannot keep running.
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Why this tab's own worker could not open the database, once it has tried and failed. */
  let startFailure: string | null = null;
  const failure = new Promise<never>((_, reject) => {
    worker.addEventListener('error', (event) => reject(new Error(event.message || 'The database could not be started.')), { once: true });
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const reason = readStartFailure(event.data);
      if (reason === null) return;
      startFailure = reason;
      reject(new Error(reason));
      // Also for a worker that fails long after this page connected: it was chosen to host the database
      // when the tab that did so closed, and could not open it. Stopping it hands that role to the next tab.
      worker.terminate();
    });
    timer = setTimeout(() => reject(new Error('The database did not open in time.')), loadDataDir ? RESTORE_TIMEOUT_MS : OPEN_TIMEOUT_MS);
  });
  try {
    await Promise.race([pg.waitReady, failure]);
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let over = false;
  return {
    pg,
    db: pgliteDriver(pg as never, {
      flush: () => saveWrites(name),
      // The database moves when the tab whose worker holds it goes away; PGlite's page class says so with this event.
      onMove: (listener) => pg.onLeaderChange(listener),
      isOver: () => over,
      whyUnavailable: () => startFailure,
      prepare: () => pg.refreshArrayTypes(),
    }),
    stop() {
      over = true;
      worker.terminate();
    },
    giveUp() {
      over = true;
      if (!pg.isLeader) worker.terminate();
    },
  };
}

/**
 * Runs `work` while no other tab of the app is setting the same database up. Tabs that
 * start together (a restored browser session, or every tab reloading after an erase)
 * would otherwise create the schema and the built-in catalog at the same time.
 */
async function exclusively<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.request) return work();
  return (await locks.request(`claude-lifetime:setup:${name}`, work)) as T;
}

/**
 * Runs `work` while this tab is marked as restoring into database `name`, so that no
 * other tab clears that database away as a leftover before it has become the active
 * one. The mark is a Web Lock: the browser drops it when this tab goes away, and a
 * database whose restore never finished then counts as a leftover again.
 */
async function whileRestoring<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  // Without Web Locks no tab removes leftovers (see orphanedDatabases), so there is nothing to guard against.
  if (!locks?.request) return work();
  return (await locks.request(restoreLock(name), work)) as T;
}

/** Names of the Web Locks that are held or waited for in any tab of the app, or null where the browser cannot tell. */
async function locksInUse(): Promise<Set<string> | null> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.query) return null;
  try {
    const snapshot = await locks.query();
    const names = new Set<string>();
    for (const lock of [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]) {
      if (lock.name) names.add(lock.name);
    }
    return names;
  } catch {
    return null;
  }
}

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(idbName(name));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not delete the local database.'));
    // Another tab still has it open. The deletion stays queued and completes when that tab reloads or closes.
    request.onblocked = () => resolve();
  });
}

/**
 * Which of the app's databases are leftovers that can be deleted: everything except
 * the databases in `keep` and those a restore is still building.
 *
 * `listed` are the names IndexedDB reports, `locks` the names of the Web Locks in use
 * in this browser profile, or null when the browser cannot tell. A database that
 * another tab is restoring into is not the active one yet and looks exactly like a
 * leftover; the lock that restore holds is the only thing that tells the two apart.
 * So when the locks cannot be read, nothing is called a leftover: an unused database
 * left behind costs some disk space, a restore deleted halfway costs the data.
 */
export function orphanedDatabases(listed: readonly (string | undefined)[], keep: readonly string[], locks: ReadonlySet<string> | null): string[] {
  if (locks === null) return [];
  const orphans: string[] = [];
  for (const entry of listed) {
    const name = appDatabaseName(entry);
    if (name !== null && !keep.includes(name) && !locks.has(restoreLock(name)) && !orphans.includes(name)) orphans.push(name);
  }
  return orphans;
}

/** Removes databases left behind by a restore that was interrupted, or replaced by one that finished. Best effort. */
async function removeOrphans(own: string): Promise<void> {
  try {
    const listed = ((await indexedDB.databases?.()) ?? []).map((entry) => entry.name);
    // In this order on purpose. A restore takes its lock before it creates its database, so every listed
    // database that is still being built has its lock in this snapshot. And it makes its database the
    // active one before it lets the lock go, so a restore that finished in between is caught by reading
    // the pointer last.
    const locks = await locksInUse();
    const keep = [own, activeName()];
    for (const name of orphanedDatabases(listed, keep, locks)) void deleteIndexedDb(name).catch(() => undefined);
  } catch {
    // listing databases is not supported everywhere; orphans are then left alone
  }
}

function announce(op: TabMessage['op']): void {
  try {
    const channel = new BroadcastChannel(DATA_CHANNEL);
    channel.postMessage({ from: TAB_ID, op } satisfies TabMessage);
    channel.close();
  } catch {
    // no BroadcastChannel: other tabs pick the change up on their next load
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Removes what the app keeps outside the database: the selected date range, the remembered folder and its switches. */
async function clearDeviceState(): Promise<void> {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(LOCAL_STORAGE_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // no storage access: nothing was stored there either
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(KV_DATABASE_NAME);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

/**
 * The database did not answer while this tab was starting. It is shared by the tabs of
 * the app and does one thing at a time, so a tab that starts while another one is in
 * the middle of a long import or a backup waits for that; this is what the tab says
 * when the wait went on for longer than any of those should take.
 */
export class DatabaseBusyError extends Error {
  constructor(waitedMs: number) {
    super(`The database did not answer within ${Math.round(waitedMs / 60_000)} minutes.`);
    this.name = 'DatabaseBusyError';
  }
}

/** How long a starting tab waits for its turn at the database and for the set-up below. */
export const SETUP_TIMEOUT_MS = 120_000;
/** How often the set-up is started over when the tab that held the database went away in the middle of it. */
const SETUP_ATTEMPTS = 4;

/** Rejects with `late()` when `work` has not settled after `ms`. `work` itself is not stopped: the caller has to see to that. */
function within<T>(ms: number, work: Promise<T>, late: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(late()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Brings the open database up to date: schema, the built-in catalog and the user, planner statistics. Returns the user's id. */
async function setUp(db: SqlDriver): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(db);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const id = await ensureSeeded(db, { timezone });
      await ensureStatistics(db);
      return id;
    } catch (error) {
      // The tab that held the database went away in the middle of this. Every step can be done again from
      // the start, and the next attempt waits for the tab that takes over.
      if (!(error instanceof DatabaseMovedError) || attempt >= SETUP_ATTEMPTS) throw error;
    }
  }
}

let pending: Promise<Database & { name: string; stop(): void }> | null = null;

/**
 * Opens the active database and brings it up to date. Rejects with a NewerSchemaError
 * when a newer version of the app has already upgraded the stored data: this page then
 * runs code that is too old for it and has to be reloaded. Rejects with a
 * DatabaseBusyError when the database, held by another tab, did not answer in time.
 */
export function openDatabase(onPhase?: (phase: BootPhase) => void): Promise<Database> {
  if (pending) return pending;
  pending = (async () => {
    onPhase?.('starting');
    const name = activeName();
    const { db, stop, giveUp } = await connect(name);

    onPhase?.('migrating');
    let userId: number;
    try {
      // The time limit is inside the lock: a tab that gives up must let the next one try.
      userId = await exclusively(name, () => within(SETUP_TIMEOUT_MS, setUp(db), () => new DatabaseBusyError(SETUP_TIMEOUT_MS)));
    } catch (error) {
      giveUp();
      throw error;
    }
    // Waits for the set-up to reach storage, but does not insist on it. Nothing the person did is at
    // stake yet: the schema and the built-in catalog are set up again at the next start if they were not
    // stored. And a device whose storage is full must still be able to open the app, to read what is
    // there and to download a backup. The first real change reports the problem (see saveWrites).
    await requestFlush(name, FLUSH_TIMEOUT_MS);

    // Ask the browser not to evict this origin's storage under pressure. Best effort.
    void navigator.storage?.persist?.().catch(() => false);
    void removeOrphans(name);

    onPhase?.('ready');
    return {
      db,
      userId,
      name,
      stop,
      exportBackup: () => makeBackup(name),
    };
  })();
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/**
 * Lets go of this tab's connection to the database it has open, for good. Only for a
 * database that is about to be erased or replaced: nothing can be read through this
 * page's connection afterwards, so the page has to reload.
 */
async function dropCurrent(): Promise<void> {
  try {
    const current = pending ? await pending : null;
    current?.stop();
  } catch {
    // it never opened, so there is nothing to let go of
  }
  pending = null;
}

/**
 * Closes this tab's connection because another tab is erasing the database. The tab
 * then waits to be told to reload.
 */
export async function releaseDatabase(): Promise<void> {
  await dropCurrent();
}

/**
 * Erases everything the app stores on this device: the database, the selected date
 * range, the remembered Claude Code folder and its switches. The page must be loaded
 * again afterwards.
 */
export async function destroyDatabase(): Promise<void> {
  // Other tabs hold the database open (one of them may host it). Ask them to let go first.
  announce('release');
  await pause(400);
  await dropCurrent();
  // Every database of the app goes, including one an interrupted restore may have left behind.
  const names = new Set([activeName(), DEFAULT_NAME]);
  try {
    for (const entry of (await indexedDB.databases?.()) ?? []) {
      const name = appDatabaseName(entry.name);
      if (name !== null) names.add(name);
    }
  } catch {
    // listing is not supported everywhere; the active and the default database are deleted either way
  }
  for (const each of names) await deleteIndexedDb(each);
  await clearDeviceState();
  announce('reload');
}

/**
 * Replaces everything stored on this device with the contents of a backup made by
 * "Download backup" (plain, or protected with a passphrase). The backup is unpacked
 * into a separate database, checked and copied to this device's storage first; the
 * current data is only removed once the browser has confirmed that copy. The page
 * must be reloaded afterwards.
 *
 * `beforeItCounts` runs once the restore can no longer fail, right before the other tabs
 * are told to load the restored data: the place to adjust what the app keeps beside the
 * database. Afterwards would be too late for those tabs, and earlier would change it for
 * a restore that did not happen.
 */
export async function restoreDatabase(file: Blob, passphrase?: string, beforeItCounts?: () => Promise<unknown>): Promise<void> {
  if (file.size === 0) throw new Error('The file is empty.');
  // A passphrase-protected backup is decrypted first; a wrong passphrase stops here, before anything changes.
  const backup = (await isEncryptedBackup(file)) ? await decryptBackup(file, passphrase) : file;
  // The engine does not fail cleanly on an archive that is not a database, so that is ruled out before it sees the file.
  if (!(await looksLikeDatabaseDump(backup))) {
    throw new Error('This is not a Claude Lifetime backup. Choose the file that "Download backup" saved.');
  }

  const name = `${DEFAULT_NAME}-${Date.now().toString(36)}`;
  // Marked from before the new database exists until it is the active one, or gone again.
  await whileRestoring(name, async () => {
    let restored: Handle | null = null;
    try {
      restored = await connect(name, backup);
      await migrate(restored.db);
      const users = await restored.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
      if (users.rows[0].n === 0) throw new Error('The backup contains no Claude Lifetime data.');
      await ensureStatistics(restored.db);
      // Closing the connection stops the worker at once, and whatever it has not copied to storage by
      // then is gone. So the restore goes on only when the worker has confirmed the copy; a refusal
      // (typically a full disk) or no answer leaves everything as it was.
      const saved = await requestFlush(name, RESTORE_FLUSH_TIMEOUT_MS);
      if (saved.status !== 'confirmed') throw restoreNotSaved(saved);
      await restored.db.close();
    } catch (error) {
      try {
        await restored?.db.close();
      } catch {
        // already closed or never opened
      }
      await deleteIndexedDb(name).catch(() => undefined);
      throw new Error(restoreFailureMessage(error));
    }

    // The database this restore replaces. Read now, because the pointer names the new one from the next step on.
    const previous = activeName();
    try {
      window.localStorage.setItem(POINTER_KEY, name);
    } catch {
      await deleteIndexedDb(name).catch(() => undefined);
      throw new Error('This browser does not allow the site to save settings, so the backup cannot be activated. Nothing was changed.');
    }
    // From here on the restored database is the current one, and nothing can stop the restore any more.
    // A failure in what the caller wants done now costs a convenience, not the restore.
    await beforeItCounts?.().catch(() => undefined);
    // Other tabs load the restored database when they reload; the previous one is deleted once nothing has it open any more.
    announce('reload');
    await dropCurrent();
    if (previous !== name) await deleteIndexedDb(previous).catch(() => undefined);
  });
}
