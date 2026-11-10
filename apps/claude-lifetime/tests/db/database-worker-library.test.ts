import { PGliteWorker } from '@electric-sql/pglite/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStartFailure, requestFlush } from '@/db/client';
import type { WorkerMeta } from '@/db/worker/pglite.worker';
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
});
