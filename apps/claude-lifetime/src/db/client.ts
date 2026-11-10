'use client';

import { PGliteWorker } from '@electric-sql/pglite/worker';
import { decryptBackup, isEncryptedBackup } from '@/lib/backup-crypto';
import { looksLikeDatabaseDump } from '@/lib/backup-format';
import { KV_DATABASE_NAME } from '@/lib/kv';
import type { SqlDriver } from './driver';
import { ensureStatistics } from './maintenance';
import { migrate, MigrationError } from './migrate';
import { pgliteDriver } from './pglite-driver';
import { ensureSeeded } from './seed';

/**
 * Browser entry point to the database: one PostgreSQL instance (PGlite) per browser
 * profile, shared by all tabs, persisted in IndexedDB on this device only.
 *
 * The database lives in an IndexedDB database named after a pointer kept in
 * localStorage. Restoring a backup builds and checks a complete new database under a
 * new name first and only then moves the pointer, so a backup that cannot be read
 * never costs the data that is already here.
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
  /** Compressed copy of the whole database, for a manual backup. */
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

function flushOverChannel(name: string): Promise<void> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(controlChannel(name));
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Flushing is best effort from the page's point of view: the write is already committed
    // in the database, and it is synced in the background even if nobody answers in time.
    const timer = setTimeout(() => {
      channel.close();
      resolve();
    }, 15_000);
    channel.onmessage = (event: MessageEvent<{ op: string; id: string }>) => {
      if (event.data?.op === 'flushed' && event.data.id === id) {
        clearTimeout(timer);
        channel.close();
        resolve();
      }
    };
    channel.postMessage({ op: 'flush', id });
  });
}

interface Handle {
  pg: PGliteWorker;
  db: SqlDriver;
  /**
   * Stops the database worker at once, for a database this page is finished with (it is
   * about to be erased or replaced, and the page reloads). Used instead of closing the
   * client: closing tears down the channels the client reaches other tabs on, while a
   * timer of its own still posts to them whenever the tab that hosts the database has
   * just changed, and that ends in an uncaught error.
   */
  stop(): void;
}

/** How long opening the database may take before it counts as failed. Restoring unpacks the whole backup first. */
const OPEN_TIMEOUT_MS = 90_000;
const RESTORE_TIMEOUT_MS = 240_000;

async function connect(name: string, loadDataDir?: Blob): Promise<Handle> {
  const worker = new Worker(new URL('./worker/pglite.worker.ts', import.meta.url), { type: 'module' });
  const pg = new PGliteWorker(worker, {
    dataDir: `idb://${name}`,
    ...(loadDataDir ? { loadDataDir } : {}),
    meta: { assetBase: `${BASE_PATH}/pglite/${PGLITE_VERSION}/`, controlChannel: controlChannel(name) },
  });
  // The engine does not always reject `waitReady` when it cannot start (a data directory it cannot
  // read keeps failing inside the worker instead). An error in the worker, or no answer in time,
  // therefore ends the attempt here, and the worker is stopped so it cannot keep running.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = new Promise<never>((_, reject) => {
    worker.addEventListener('error', (event) => reject(new Error(event.message || 'The database worker failed to start.')), { once: true });
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
  return { pg, db: pgliteDriver(pg as never, { flush: () => flushOverChannel(name) }), stop: () => worker.terminate() };
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

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(idbName(name));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not delete the local database.'));
    // Another tab still has it open. The deletion stays queued and completes when that tab reloads or closes.
    request.onblocked = () => resolve();
  });
}

/** Removes databases left behind by a restore that was interrupted. Best effort. */
async function removeOrphans(active: string): Promise<void> {
  try {
    const all = (await indexedDB.databases?.()) ?? [];
    for (const entry of all) {
      const match = entry.name?.match(/^\/pglite\/(claude-lifetime(?:-[a-z0-9]{1,24})?)$/);
      if (match && match[1] !== active) void deleteIndexedDb(match[1]).catch(() => undefined);
    }
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

let pending: Promise<Database & { name: string; stop(): void }> | null = null;

export function openDatabase(onPhase?: (phase: BootPhase) => void): Promise<Database> {
  if (pending) return pending;
  pending = (async () => {
    onPhase?.('starting');
    const name = activeName();
    const { pg, db, stop } = await connect(name);

    onPhase?.('migrating');
    const userId = await exclusively(name, async () => {
      await migrate(db);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const id = await ensureSeeded(db, { timezone });
      await ensureStatistics(db);
      return id;
    });
    await db.flush();

    // Ask the browser not to evict this origin's storage under pressure. Best effort.
    void navigator.storage?.persist?.().catch(() => false);
    void removeOrphans(name);

    onPhase?.('ready');
    return {
      db,
      userId,
      name,
      stop,
      exportBackup: async () => (await pg.dumpDataDir('gzip')) as Blob,
    };
  })();
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/**
 * Lets go of this tab's connection to the active database for good and returns the
 * database's name. Only for a database that is about to be erased or replaced: nothing
 * can be read through this page's connection afterwards, so the page has to reload.
 */
async function dropCurrent(): Promise<string> {
  const name = activeName();
  try {
    const current = pending ? await pending : null;
    current?.stop();
  } catch {
    // it never opened, so there is nothing to let go of
  }
  pending = null;
  return name;
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
  const name = await dropCurrent();
  // Every database of the app goes, including one an interrupted restore may have left behind.
  const names = new Set([name, DEFAULT_NAME]);
  try {
    for (const entry of (await indexedDB.databases?.()) ?? []) {
      const match = entry.name?.match(/^\/pglite\/(claude-lifetime(?:-[a-z0-9]{1,24})?)$/);
      if (match) names.add(match[1]);
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
 * into a separate database and checked first; the current data is only removed once
 * that has succeeded. The page must be reloaded afterwards.
 */
export async function restoreDatabase(file: Blob, passphrase?: string): Promise<void> {
  if (file.size === 0) throw new Error('The file is empty.');
  // A passphrase-protected backup is decrypted first; a wrong passphrase stops here, before anything changes.
  const backup = (await isEncryptedBackup(file)) ? await decryptBackup(file, passphrase) : file;
  // The engine does not fail cleanly on an archive that is not a database, so that is ruled out before it sees the file.
  if (!(await looksLikeDatabaseDump(backup))) {
    throw new Error('This is not a Claude Lifetime backup. Choose the file that "Download backup" saved.');
  }

  const name = `${DEFAULT_NAME}-${Date.now().toString(36)}`;
  let restored: Handle | null = null;
  try {
    restored = await connect(name, backup);
    await migrate(restored.db);
    const users = await restored.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    if (users.rows[0].n === 0) throw new Error('The backup contains no Claude Lifetime data.');
    await ensureStatistics(restored.db);
    await restored.db.flush();
    await restored.db.close();
  } catch (error) {
    try {
      await restored?.db.close();
    } catch {
      // already closed or never opened
    }
    await deleteIndexedDb(name).catch(() => undefined);
    if (error instanceof MigrationError) {
      throw new Error('This backup was made by a newer version of Claude Lifetime than the one running here. Reload the page to update, then restore it again.');
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The backup could not be read, so nothing was changed. (${detail})`);
  }

  try {
    window.localStorage.setItem(POINTER_KEY, name);
  } catch {
    await deleteIndexedDb(name).catch(() => undefined);
    throw new Error('This browser does not allow the site to save settings, so the backup cannot be activated. Nothing was changed.');
  }
  // From here on the restored database is the current one. Other tabs load it when they reload;
  // the previous database is deleted once nothing has it open any more.
  announce('reload');
  const previous = await dropCurrent();
  if (previous !== name) await deleteIndexedDb(previous).catch(() => undefined);
}
