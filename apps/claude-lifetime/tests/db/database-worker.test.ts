import { MemoryFS } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the page's half of PGlite's worker library is replaced; `worker()`, which the database worker
// is built on, stays the real one.
vi.mock('@electric-sql/pglite/worker', async (original) => ({
  ...(await original<object>()),
  PGliteWorker: (await import('../helpers/fake-pglite-worker')).FakePGliteWorker,
}));

import { openDatabase, readFlushAnswer, readStartFailure, releaseDatabase, requestFlush, type FlushOutcome } from '@/db/client';
import { after, installIndexedDb, installWebLocks, installWindow, resetTimeline, trackBroadcastChannels, waitFor } from '../helpers/browser';
import { InProcessDatabaseWorker, serveEngineFiles } from '../helpers/database-worker';
import { fakeDatabases } from '../helpers/fake-pglite-worker';

/**
 * The real database worker (src/db/worker/pglite.worker.ts), run inside the test
 * process: what it tells its page when the database cannot be started, and what it
 * answers when a page asks for the database to be copied to storage. Both are read by
 * src/db/client.ts, so each test also passes the worker's message through the client's
 * reader.
 */
const START_FAILED = 'claude-lifetime:start-failed';
const notFound = () => vi.stubGlobal('fetch', async () => new Response('Not found', { status: 404 }));

/** Does what PGlite's page class does first: answers the worker's "here" with the options to start with. */
function startLikeAPage(worker: InProcessDatabaseWorker, name: string) {
  worker.addEventListener('message', (event) => {
    if ((event.data as { type?: string }).type !== 'here') return;
    worker.postMessage({
      type: 'init',
      options: { dataDir: `memory://${name}`, meta: { assetBase: 'https://app.test/pglite/0.5.16/', controlChannel: `claude-lifetime:db-control:${name}` } },
    });
  });
}

let closeChannels: () => void;
beforeEach(() => {
  resetTimeline();
  fakeDatabases.reset();
  InProcessDatabaseWorker.created = [];
  closeChannels = trackBroadcastChannels();
  installWebLocks();
});
afterEach(async () => {
  await releaseDatabase();
  for (const worker of InProcessDatabaseWorker.created) worker.terminate();
  closeChannels();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the database worker, when the database cannot be started', () => {
  it('tells its page why, once', async () => {
    notFound();
    const worker = new InProcessDatabaseWorker();
    startLikeAPage(worker, 'start-failure');

    const failure = await waitFor(() => worker.posted.find((message) => message.type === START_FAILED), 15_000);

    expect(failure.error).toMatch(/^Could not load https:\/\/app\.test\/pglite\/0\.5\.16\/[a-z.]+\.gz \(HTTP 404\)$/);
    // The page reads the same reason out of the message.
    expect(readStartFailure(failure)).toBe(failure.error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(worker.posted.filter((message) => message.type === START_FAILED)).toHaveLength(1);
  });

  it('names the file it could not get when there is no connection', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const worker = new InProcessDatabaseWorker();
    startLikeAPage(worker, 'offline');

    const failure = await waitFor(() => worker.posted.find((message) => message.type === START_FAILED), 15_000);

    // the browser's own text alone ("Failed to fetch") would not say what was being fetched
    expect(failure.error).toMatch(/^Could not load https:\/\/app\.test\/pglite\/0\.5\.16\/[a-z.]+\.gz \(TypeError: Failed to fetch\)$/);
  });

  it('lets the page fail at once with that reason instead of waiting for a start that never comes', async () => {
    notFound();
    vi.stubGlobal('Worker', InProcessDatabaseWorker);
    installWindow();
    installIndexedDb(['/pglite/claude-lifetime']);
    // PGlite's page class does not become ready when the worker's start fails, and is told nothing.
    fakeDatabases.becomeReady = false;

    const failure = await Promise.race([
      openDatabase().then(
        () => null,
        (error: Error) => error,
      ),
      after(10_000, 'still waiting after 10 seconds'),
    ]);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^Could not load \/pglite\/0\.5\.16\/[a-z.]+\.gz \(HTTP 404\)$/);
    expect(InProcessDatabaseWorker.created).toHaveLength(1);
    expect(InProcessDatabaseWorker.created[0].terminated).toBe(true);
  });
});

describe('the database worker, asked to copy the database to storage', () => {
  it('answers yes when the copy was made, and no with the browser’s error when it was not', async () => {
    serveEngineFiles();
    const worker = new InProcessDatabaseWorker();
    startLikeAPage(worker, 'flush');
    const control = new BroadcastChannel('claude-lifetime:db-control:flush');
    const answers: unknown[] = [];
    control.onmessage = (event: MessageEvent<{ op?: string }>) => {
      if (event.data?.op === 'flushed') answers.push(event.data);
    };

    // The worker answers from the moment the database is up.
    let outcome: FlushOutcome = { status: 'unanswered' };
    for (let attempt = 0; attempt < 200 && outcome.status === 'unanswered'; attempt++) outcome = await requestFlush('flush', 250);
    expect(outcome).toEqual({ status: 'confirmed' });
    await waitFor(() => answers.length > 0);
    expect(answers.at(-1)).toMatchObject({ op: 'flushed', ok: true });

    // From here on the copy to storage fails the way a full disk makes it fail. Only the copy a page asks
    // for passes `false`; the ones the engine makes by itself after each statement are left alone.
    vi.spyOn(MemoryFS.prototype, 'syncToFs').mockImplementation(async (relaxed?: boolean) => {
      if (relaxed === false) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    answers.length = 0;
    control.postMessage({ op: 'flush', id: 'full-disk' });
    await waitFor(() => answers.length > 0);

    expect(answers).toEqual([{ op: 'flushed', id: 'full-disk', ok: false, error: 'QuotaExceededError: The quota has been exceeded.' }]);
    expect(readFlushAnswer(answers[0], 'full-disk')).toEqual({ status: 'failed', reason: 'QuotaExceededError: The quota has been exceeded.' });
    expect(await requestFlush('flush', 5000)).toEqual({ status: 'failed', reason: 'QuotaExceededError: The quota has been exceeded.' });
    // A copy that fails later on is not a failed start.
    expect(worker.posted.some((message) => message.type === START_FAILED)).toBe(false);
  });
});
