'use client';

import { PGliteWorker } from '@electric-sql/pglite/worker';
import type { SqlDriver } from './driver';
import { migrate } from './migrate';
import { pgliteDriver } from './pglite-driver';
import { ensureSeeded } from './seed';

/**
 * Browser entry point to the database: one PostgreSQL instance (PGlite) per browser
 * profile, shared by all tabs, persisted in IndexedDB on this device only.
 */
const PGLITE_VERSION = '0.5.16';
const DATABASE_NAME = 'claude-lifetime';
const CONTROL_CHANNEL = 'claude-lifetime:db-control';
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export interface Database {
  db: SqlDriver;
  userId: number;
  /** Compressed copy of the whole database, for a manual backup. */
  exportBackup(): Promise<Blob>;
}

export type BootPhase = 'starting' | 'migrating' | 'ready';

let pending: Promise<Database> | null = null;

function flushOverChannel(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(CONTROL_CHANNEL);
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

export function openDatabase(onPhase?: (phase: BootPhase) => void): Promise<Database> {
  if (pending) return pending;
  pending = (async () => {
    onPhase?.('starting');
    const worker = new Worker(new URL('./worker/pglite.worker.ts', import.meta.url), { type: 'module' });
    const pg = new PGliteWorker(worker, {
      dataDir: `idb://${DATABASE_NAME}`,
      meta: { assetBase: `${BASE_PATH}/pglite/${PGLITE_VERSION}/`, controlChannel: CONTROL_CHANNEL },
    });
    await pg.waitReady;
    const db = pgliteDriver(pg as never, { flush: flushOverChannel });

    onPhase?.('migrating');
    await migrate(db);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const userId = await ensureSeeded(db, { timezone });
    await db.flush();

    // Ask the browser not to evict this origin's storage under pressure. Best effort.
    void navigator.storage?.persist?.().catch(() => false);

    onPhase?.('ready');
    return {
      db,
      userId,
      exportBackup: async () => (await pg.dumpDataDir('gzip')) as Blob,
    };
  })();
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/** Deletes the local database completely. The page must be reloaded afterwards. */
export async function destroyDatabase(): Promise<void> {
  try {
    const current = pending ? await pending : null;
    await current?.db.close();
  } catch {
    // closing is best effort; the database is deleted below either way
  }
  pending = null;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(`/pglite/${DATABASE_NAME}`);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not delete the local database.'));
    request.onblocked = () => resolve();
  });
}
