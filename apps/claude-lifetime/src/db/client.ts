'use client';

import { PGliteWorker } from '@electric-sql/pglite/worker';
import { decryptBackup, isEncryptedBackup } from '@/lib/backup-crypto';
import type { SqlDriver } from './driver';
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
/** Tabs listen here for data changes; `{ op: 'reload' }` tells them the database itself was replaced. */
export const DATA_CHANNEL = 'claude-lifetime:data';
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
}

async function connect(name: string, loadDataDir?: Blob): Promise<Handle> {
  const worker = new Worker(new URL('./worker/pglite.worker.ts', import.meta.url), { type: 'module' });
  const pg = new PGliteWorker(worker, {
    dataDir: `idb://${name}`,
    ...(loadDataDir ? { loadDataDir } : {}),
    meta: { assetBase: `${BASE_PATH}/pglite/${PGLITE_VERSION}/`, controlChannel: controlChannel(name) },
  });
  await pg.waitReady;
  return { pg, db: pgliteDriver(pg as never, { flush: () => flushOverChannel(name) }) };
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

function tellOtherTabsToReload(): void {
  try {
    const channel = new BroadcastChannel(DATA_CHANNEL);
    channel.postMessage({ op: 'reload' });
    channel.close();
  } catch {
    // no BroadcastChannel: other tabs pick the change up on their next load
  }
}

let pending: Promise<Database & { name: string; pg: PGliteWorker }> | null = null;

export function openDatabase(onPhase?: (phase: BootPhase) => void): Promise<Database> {
  if (pending) return pending;
  pending = (async () => {
    onPhase?.('starting');
    const name = activeName();
    const { pg, db } = await connect(name);

    onPhase?.('migrating');
    await migrate(db);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const userId = await ensureSeeded(db, { timezone });
    await db.flush();

    // Ask the browser not to evict this origin's storage under pressure. Best effort.
    void navigator.storage?.persist?.().catch(() => false);
    void removeOrphans(name);

    onPhase?.('ready');
    return {
      db,
      userId,
      name,
      pg,
      exportBackup: async () => (await pg.dumpDataDir('gzip')) as Blob,
    };
  })();
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

async function closeCurrent(): Promise<string> {
  const name = activeName();
  try {
    const current = pending ? await pending : null;
    await current?.db.close();
  } catch {
    // closing is best effort; the database is replaced or deleted below either way
  }
  pending = null;
  return name;
}

/** Deletes the local database completely. The page must be reloaded afterwards. */
export async function destroyDatabase(): Promise<void> {
  tellOtherTabsToReload();
  const name = await closeCurrent();
  await deleteIndexedDb(name);
  try {
    window.localStorage.removeItem(POINTER_KEY);
  } catch {
    // nothing to clean up
  }
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
  const head = new Uint8Array(await backup.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    throw new Error('This is not a Claude Lifetime backup. Choose the file that "Download backup" saved.');
  }

  const name = `${DEFAULT_NAME}-${Date.now().toString(36)}`;
  let restored: Handle | null = null;
  try {
    restored = await connect(name, backup);
    await migrate(restored.db);
    const users = await restored.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    if (users.rows[0].n === 0) throw new Error('The backup contains no Claude Lifetime data.');
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
  tellOtherTabsToReload();
  const previous = await closeCurrent();
  if (previous !== name) await deleteIndexedDb(previous).catch(() => undefined);
}
