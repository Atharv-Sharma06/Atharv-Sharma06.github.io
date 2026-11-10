import { PGliteWorker } from '@electric-sql/pglite/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { readStartFailure, requestBackup, requestFlush } from '@/db/client';
import { migrate } from '@/db/migrate';
import { pgliteDriver } from '@/db/pglite-driver';
import { ensureSeeded } from '@/db/seed';
import type { WorkerMeta } from '@/db/worker/pglite.worker';
import { deleteBatch } from '@/import/delete';
import { conv, importRecords, msg } from '../helpers/staged';
import { after, installWebLocks, trackBroadcastChannels, waitFor } from '../helpers/browser';
import {
  InProcessDatabaseWorker,
  pause,
  routeUnhandledRejections,
  sandboxTimers,
  serveEngineFiles,
  type RoutedRejections,
} from '../helpers/database-worker';

/**
 * The real database worker together with both halves of PGlite's worker library, none
 * of them changed: PGliteWorker on the page's side, worker() inside the worker. Only
 * the transport between them, Web Locks and `fetch` are stand-ins.
 *
 * This is where it shows that the worker's own messages do not disturb the library,
 * and that the library on its own never tells the page about a failed start.
 */
const START_FAILED = 'claude-lifetime:start-failed';
const meta = (name: string): WorkerMeta => ({ assetBase: 'https://app.test/pglite/0.5.16/', controlChannel: `claude-lifetime:db-control:${name}` });

let closeChannels: () => void;
let stopTimers: () => void;
let rejections: RoutedRejections | null;

beforeEach(() => {
  InProcessDatabaseWorker.created = [];
  rejections = null;
  closeChannels = trackBroadcastChannels();
  stopTimers = sandboxTimers();
  installWebLocks();
});
afterEach(async () => {
  // In this order: no new messages, the ones under way delivered, then the channels closed.
  stopTimers();
  for (const worker of InProcessDatabaseWorker.created) worker.terminate();
  await pause(50);
  closeChannels();
  await pause(50);
  rejections?.restore();
  vi.unstubAllGlobals();
});

describe('the database worker behind PGlite’s own client', () => {
  it('reports a failed start to the page, which PGlite leaves waiting, and leaves nothing unhandled behind', async () => {
    vi.stubGlobal('fetch', async () => new Response('Not found', { status: 404 }));
    const worker = new InProcessDatabaseWorker();
    rejections = routeUnhandledRejections(worker);
    const pg = new PGliteWorker(worker as unknown as Worker, { dataDir: 'memory://cannot-start', meta: meta('cannot-start') });

    const failure = await waitFor(() => worker.posted.find((message) => message.type === START_FAILED), 15_000);
    expect(readStartFailure(failure)).toMatch(/^Could not load https:\/\/app\.test\/pglite\/0\.5\.16\/[a-z.]+\.gz \(HTTP 404\)$/);

    // PGlite's client keeps asking for the database (every 16 ms) and is never answered or told.
    expect(await Promise.race([pg.waitReady.then(() => 'ready'), after(500, 'still waiting')])).toBe('still waiting');
    // Each of those requests ends in a rejection inside the worker. The page has the reason already,
    // so the worker keeps them out of the console; anything else would show up here.
    const routed = rejections;
    await waitFor(() => routed.offered > 0);
    expect(routed.unhandled).toEqual([]);
    expect(worker.posted.filter((message) => message.type === START_FAILED)).toHaveLength(1);
  });

  it('serves the page and confirms a copy to storage when the start works', async () => {
    serveEngineFiles();
    const worker = new InProcessDatabaseWorker();
    rejections = routeUnhandledRejections(worker);
    const pg = new PGliteWorker(worker as unknown as Worker, { dataDir: 'memory://starts', meta: meta('starts') });

    await pg.waitReady;
    expect((await pg.query<{ one: number }>('select 1 as one')).rows).toEqual([{ one: 1 }]);
    expect(await requestFlush('starts', 10_000)).toEqual({ status: 'confirmed' });

    expect(worker.posted.some((message) => message.type === START_FAILED)).toBe(false);
    expect(rejections.unhandled).toEqual([]);
    await pg.close();
    expect(worker.terminated).toBe(true);
  });

  it('makes a backup on request that holds what is stored and nothing that was deleted', async () => {
    const TITLE = 'Severance negotiation with ACME-CORP-7731';
    const KEPT = 'Planning the allotment for spring';
    serveEngineFiles();
    const worker = new InProcessDatabaseWorker();
    rejections = routeUnhandledRejections(worker);
    const pg = new PGliteWorker(worker as unknown as Worker, { dataDir: 'memory://backup', meta: meta('backup') });
    await pg.waitReady;
    // The app's own schema and an import that is deleted again, all through PGlite's client as the pages do it.
    const db = pgliteDriver(pg as never);
    await migrate(db);
    const userId = await ensureSeeded(db, { timezone: 'UTC' });
    const secret = await importRecords(db, userId, { conversations: [conv('a', { title: TITLE })], messages: [msg('a', 0), msg('a', 1)] }, { contentHash: 'one' });
    await importRecords(db, userId, { conversations: [conv('k', { title: KEPT })], messages: [msg('k', 0)] }, { contentHash: 'two' });
    await deleteBatch(db, userId, secret.result.batchId!);

    // What the engine's own dump of this database gives away, and the backup must not.
    const raw = gunzipSync(Buffer.from(await ((await pg.dumpDataDir('gzip')) as Blob).arrayBuffer()));
    expect(raw.includes(TITLE)).toBe(true);

    const backup = await requestBackup('backup', { startMs: 10_000, totalMs: 120_000 });

    const files = gunzipSync(Buffer.from(await backup.arrayBuffer()));
    expect(files.includes(TITLE)).toBe(false);
    expect(files.includes(KEPT)).toBe(true);
    const restored = new PGlite({ loadDataDir: backup });
    expect((await migrate(pgliteDriver(restored))).applied).toEqual([]);
    expect((await restored.query<{ title: string }>('SELECT title FROM conversations')).rows).toEqual([{ title: KEPT }]);
    await restored.close();

    // The database the backup was made of goes on working, and a second backup can be made.
    expect((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM conversations')).rows).toEqual([{ n: 1 }]);
    expect((await requestBackup('backup', { startMs: 10_000, totalMs: 120_000 })).size).toBeGreaterThan(0);
    expect(rejections.unhandled).toEqual([]);
    await pg.close();
  }, 180_000);

  it('says why when the stored data cannot be copied, in a sentence for the person', async () => {
    serveEngineFiles();
    const worker = new InProcessDatabaseWorker();
    rejections = routeUnhandledRejections(worker);
    const pg = new PGliteWorker(worker as unknown as Worker, { dataDir: 'memory://odd', meta: meta('odd') });
    await pg.waitReady;
    await migrate(pgliteDriver(pg as never));
    await pg.exec('CREATE TABLE "left_by_something_else" (id integer)');

    await expect(requestBackup('odd', { startMs: 10_000, totalMs: 120_000 })).rejects.toThrow(
      'No backup was made. The stored data has other tables than this version of the app sets up, so it cannot be copied.',
    );
    // A database without the app's tables at all: the engine's own error is passed on as such.
    await pg.exec('DROP TABLE "_prisma_migrations" CASCADE');
    await expect(requestBackup('odd', { startMs: 10_000, totalMs: 120_000 })).rejects.toThrow(/^No backup was made: the data could not be copied\. \(.*_prisma_migrations/);
    await pg.close();
  }, 180_000);
});
