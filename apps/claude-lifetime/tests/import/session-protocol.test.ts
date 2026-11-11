import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedImport } from '@/core/types';
import type { SqlDriver } from '@/db/driver';
import { ExportManifestFound } from '@/import/claude-export/manifest';
import type { Detected } from '@/import/detect';
import { ImportSession } from '@/import/session';
import { resetStaging, type StagedBatch } from '@/import/staging';
import type { ToWorker } from '@/import/worker/protocol';
import { assistant, at, jsonl, LATER, usage as tokens, user } from '../fixtures/claude-code/builders';
import { createTestDb, type TestDb } from '../helpers/db';
import { installWebLocks, observed, RealWorker, ScriptedWorker, sleep, useWorker, workersCreated, type LockLog, type Statement } from '../helpers/import-session';
import { fileOf } from '../helpers/sink';
import { conv, parsed as parsedOf, usage } from '../helpers/staged';

/**
 * ImportSession between the page, the import worker and the database: what happens
 * when an import is cancelled, fails or is abandoned at an awkward moment. The staging
 * tables are shared by every tab, so the rule under test is always the same: when a
 * session says it is done, none of its records are staged, none are still on their way,
 * and the lock is free.
 *
 * The worker is scripted to pin down exact message timings; the database is the real
 * one, slowed down where a test needs a statement to be in flight.
 */
const LOCK = 'claude-lifetime:import';

let t: TestDb;
let locks: LockLog;
let sessions: ImportSession[];

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  await resetStaging(t.db);
  locks = installWebLocks();
  useWorker(ScriptedWorker);
  ScriptedWorker.respond = () => undefined;
  sessions = [];
});
afterEach(async () => {
  // A session that a failed test left behind must not hold the lock for the tests after it.
  await Promise.all(sessions.map((session) => session.dispose()));
});

const open = (db: SqlDriver = t.db) => {
  const session = new ImportSession(db, t.userId);
  sessions.push(session);
  return session;
};

type Outcome<T> = { resolved: T } | { rejected: string | undefined };
const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ resolved: value }),
    (error: { code?: string }) => ({ rejected: error.code }),
  );
/** The outcome, or 'still pending' when there is none in time: a promise that never settles must fail a test, not stall it. */
const within = <T>(outcome: Promise<T>, ms = 3000): Promise<T | 'still pending'> => Promise.race([outcome, sleep(ms).then(() => 'still pending' as const)]);

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The awaited moment did not come.');
    await sleep(1);
  }
}

const staged = async () =>
  (await t.db.query<{ n: number }>(`SELECT (SELECT count(*) FROM stg_usage)::int + (SELECT count(*) FROM stg_conversations)::int AS n`)).rows[0].n;
/** A statement that writes parsed records to a staging table. */
const isBatchWrite = (s: Statement) => /^\s*INSERT INTO stg_/.test(s.sql);

const detected: Detected = { parser: 'generic-json', fileIndexes: [0], totalBytes: 2, recognisedAs: 'test', ignoredFiles: 0 };
const files = [fileOf('a.json', '[]')];
const batchOf = (tag: string, rows: number): StagedBatch => ({
  models: [],
  messages: [],
  costs: [],
  conversations: [conv(tag, { dedupKey: `generic::${tag}`, kind: 'usage_bucket' })],
  usage: Array.from({ length: rows }, (_, i) => usage(`${tag}:${i}`, { conversationKey: `generic::${tag}` })),
});
const meta = (over: Partial<ParsedImport> = {}) => parsedOf({ source: { kind: 'generic_json', label: 'Usage file', externalRef: '' }, contentHash: null, ...over });

/** A worker that answers a detection, and parses a file of five rows. */
const smallImport = (worker: ScriptedWorker, m: ToWorker) => {
  if (m.type === 'detect') worker.emit({ type: 'detected', id: m.id, detected });
  if (m.type !== 'parse') return;
  worker.emit({ type: 'batch', id: m.id, batch: batchOf('rows', 5) });
  worker.emit({ type: 'done', id: m.id, parsed: meta({ fileName: 'rows.json', recordsSeen: 5 }) });
};
const parseRequests = () => workersCreated().flatMap((worker) => worker.received.filter((m) => m.type === 'parse'));

describe('an import that is cancelled or fails while its batches are being written', () => {
  // The worker may have three batches on their way that the page has not acknowledged yet.
  const threeBatches = (worker: ScriptedWorker, m: ToWorker) => {
    if (m.type !== 'parse') return;
    for (const n of [1, 2, 3]) worker.emit({ type: 'batch', id: m.id, batch: batchOf(`first-${n}`, 50) });
  };

  it('sends nothing more to the database after the cancel, and is finished with it when prepare() rejects', async () => {
    ScriptedWorker.respond = threeBatches;
    const { db, statements } = observed(t.db, { delayMs: 8 });
    const session = open(db);
    const outcome = settle(session.prepare(files, detected));
    await until(() => statements.some(isBatchWrite));
    const cancelledAt = performance.now();
    session.cancel();
    expect(await within(outcome)).toEqual({ rejected: 'cancelled' });
    const rejectedAt = performance.now();

    // The lock is free and nothing is staged, now and a moment later.
    expect(locks.held.has(LOCK)).toBe(false);
    expect(await staged()).toBe(0);
    await sleep(300);
    expect(await staged()).toBe(0);

    const writes = statements.filter(isBatchWrite);
    expect(writes.length).toBeGreaterThan(0);
    // Only what was on its way when the cancel came was written ...
    expect(writes.filter((s) => s.startedAt > cancelledAt)).toEqual([]);
    // ... it had arrived before the tables were emptied ...
    const emptied = statements.filter((s) => s.sql.startsWith('TRUNCATE')).at(-1)!;
    expect(Math.max(...writes.map((s) => s.endedAt ?? Infinity))).toBeLessThanOrEqual(emptied.startedAt);
    // ... and the lock was given back after the last statement, before prepare() rejected.
    const last = Math.max(...statements.map((s) => s.endedAt ?? Infinity));
    expect(locks.released.at(-1)).toBeGreaterThanOrEqual(last);
    expect(last).toBeLessThanOrEqual(rejectedAt);
  });

  it('lets the next import start at once and hold only its own records', async () => {
    let parses = 0;
    ScriptedWorker.respond = (worker, m) => {
      if (m.type !== 'parse') return;
      if (++parses === 1) return threeBatches(worker, m);
      worker.emit({ type: 'batch', id: m.id, batch: batchOf('second', 5) });
      worker.emit({ type: 'done', id: m.id, parsed: meta({ fileName: 'second.json', recordsSeen: 5 }) });
    };
    const { db, statements } = observed(t.db, { delayMs: 8 });
    const session = open(db);
    const first = settle(session.prepare(files, detected));
    await until(() => statements.some(isBatchWrite));
    session.cancel();
    expect(await within(first)).toEqual({ rejected: 'cancelled' });

    // The wizard is idle again and the next file is dropped at once.
    const second = await session.prepare(files, detected);
    expect(second.preview.usageRows).toMatchObject({ total: 5, new: 5 });
    expect(second.preview.conversations).toMatchObject({ total: 1, new: 1 });
    const result = await session.commit(second);
    expect(result.inserted).toMatchObject({ conversations: 1, usageRows: 5 });
    const stored = await t.db.query<{ prefix: string; n: number }>(`SELECT split_part(dedup_key, ':', 1) AS prefix, count(*)::int AS n FROM usage_records GROUP BY 1 ORDER BY 1`);
    expect(stored.rows).toEqual([{ prefix: 'second', n: 5 }]);
  });

  it('does the same when the worker reports an error while batches are on their way', async () => {
    ScriptedWorker.respond = (worker, m) => {
      if (m.type !== 'parse') return;
      threeBatches(worker, m);
      worker.emit({ type: 'error', id: m.id, error: { message: 'Line 7 of the file is not valid JSON.', code: 'invalid_json' } });
    };
    const { db, statements } = observed(t.db, { delayMs: 8 });
    const session = open(db);
    await expect(session.prepare(files, detected)).rejects.toMatchObject({ name: 'ImportError', code: 'invalid_json', message: 'Line 7 of the file is not valid JSON.' });
    expect(locks.held.has(LOCK)).toBe(false);
    expect(statements.every((s) => s.endedAt !== null)).toBe(true);
    expect(await staged()).toBe(0);
    await sleep(300);
    expect(await staged()).toBe(0);
  });

  it('does the same when the worker itself fails', async () => {
    ScriptedWorker.respond = (worker, m) => {
      if (m.type !== 'parse') return;
      threeBatches(worker, m);
      worker.emitError('out of memory');
    };
    const { db } = observed(t.db, { delayMs: 8 });
    const session = open(db);
    await expect(session.prepare(files, detected)).rejects.toMatchObject({
      code: 'worker_failed',
      message: 'The part of the app that reads files stopped unexpectedly.',
      details: 'out of memory',
    });
    expect(workersCreated()[0].terminated).toBe(true);
    expect(locks.held.has(LOCK)).toBe(false);
    await sleep(300);
    expect(await staged()).toBe(0);
  });
});

describe('cancel() and dispose() at any moment of prepare()', () => {
  it('dispose() in the same moment as prepare(): no worker is started and the lock is not kept', async () => {
    ScriptedWorker.respond = smallImport;
    const session = open();
    const outcome = settle(session.prepare(files, detected)); // the wizard starts reading ...
    await session.dispose(); // ... and is taken off the page in the same moment
    expect(await within(outcome)).toEqual({ rejected: 'cancelled' });
    expect(workersCreated()).toHaveLength(0);
    expect(locks.held.has(LOCK)).toBe(false);
    expect(await staged()).toBe(0);

    // The import page is opened again: its new session imports as if nothing had happened.
    const prepared = await open().prepare(files, detected);
    expect(prepared.preview.usageRows).toMatchObject({ total: 5, new: 5 });
  });

  it('dispose() while the request for the lock is unanswered: the lock is given back as soon as it comes', async () => {
    locks = installWebLocks({ grantAfterMs: 30 });
    ScriptedWorker.respond = smallImport;
    const session = open();
    const outcome = settle(session.prepare(files, detected));
    await sleep(5); // the session has asked for the lock and waits for the answer
    expect(locks.held.has(LOCK)).toBe(true);
    await session.dispose();
    expect(await within(outcome)).toEqual({ rejected: 'cancelled' });
    expect(locks.held.has(LOCK)).toBe(false);
    expect(locks.released).toHaveLength(1);
    expect(workersCreated()).toHaveLength(0);

    const prepared = await open().prepare(files, detected);
    expect(prepared.preview.usageRows).toMatchObject({ total: 5, new: 5 });
  });

  it('dispose() while the staging tables are being made ready: the worker stays stopped and nothing is parsed', async () => {
    ScriptedWorker.respond = smallImport;
    const { db, statements } = observed(t.db, { delayMs: 5 });
    const session = open(db);
    await session.detect(files); // as the wizard does; this starts the worker
    const outcome = settle(session.prepare(files, detected));
    await until(() => statements.length > 0); // the lock is held and the first statement is on its way
    expect(locks.held.has(LOCK)).toBe(true);
    await session.dispose();

    // dispose() comes back when the session has let go of everything.
    expect(locks.held.has(LOCK)).toBe(false);
    expect(statements.every((s) => s.endedAt !== null)).toBe(true);
    expect(await within(outcome)).toEqual({ rejected: 'cancelled' });
    await sleep(80);
    expect(workersCreated()).toHaveLength(1);
    expect(workersCreated()[0].terminated).toBe(true);
    expect(parseRequests()).toEqual([]);
    expect(statements.filter(isBatchWrite)).toEqual([]);
    expect(await staged()).toBe(0);
  });

  it('cancel() in the same moment as prepare()', async () => {
    ScriptedWorker.respond = smallImport;
    const session = open();
    const outcome = settle(session.prepare(files, detected));
    session.cancel();
    expect(await within(outcome)).toEqual({ rejected: 'cancelled' });
    expect(workersCreated()).toHaveLength(0);
    expect(locks.held.has(LOCK)).toBe(false);
  });

  it('cancel() before the worker was asked to parse, after which the session imports the next file', async () => {
    ScriptedWorker.respond = smallImport;
    const { db, statements } = observed(t.db, { delayMs: 5 });
    const session = open(db);
    const outcome = settle(session.prepare(files, detected));
    await until(() => statements.length > 0);
    session.cancel();
    expect(await within(outcome)).toEqual({ rejected: 'cancelled' });
    expect(locks.held.has(LOCK)).toBe(false);
    expect(parseRequests()).toEqual([]);
    expect(await staged()).toBe(0);

    const prepared = await session.prepare(files, detected);
    expect(prepared.preview.usageRows).toMatchObject({ total: 5, new: 5 });
    expect(locks.held.has(LOCK)).toBe(true);
  });

  it('cancel() after the worker has finished, while the preview is being computed', async () => {
    ScriptedWorker.respond = smallImport;
    let rowsWritten = false;
    let cancelledDuringPreview = false;
    const { db } = observed(t.db, {
      onStatement: (sql) => {
        if (sql.includes('INSERT INTO stg_usage')) rowsWritten = true;
        // The first statement after the rows were written belongs to the preview: the worker's "done" has been handled.
        else if (rowsWritten && !cancelledDuringPreview) {
          cancelledDuringPreview = true;
          session.cancel();
        }
      },
    });
    const session = open(db);
    expect(await within(settle(session.prepare(files, detected)))).toEqual({ rejected: 'cancelled' });
    expect(cancelledDuringPreview).toBe(true);
    expect(locks.held.has(LOCK)).toBe(false);
    expect(await staged()).toBe(0);
  });

  it('a session that was disposed of does no further work, starts no worker and takes no lock', async () => {
    ScriptedWorker.respond = smallImport;
    const session = open();
    await session.dispose();
    expect(await within(settle(session.prepare(files, detected)))).toEqual({ rejected: 'cancelled' });
    expect(await within(settle(session.detect(files)))).toEqual({ rejected: 'cancelled' });
    expect(workersCreated()).toHaveLength(0);
    expect(locks.held.has(LOCK)).toBe(false);
  });

  it('discard() and dispose() after a finished prepare() throw the staged records away and free the lock', async () => {
    ScriptedWorker.respond = smallImport;
    const session = open();
    await session.prepare(files, detected);
    expect(await staged()).toBe(6);
    expect(locks.held.has(LOCK)).toBe(true);
    await session.discard();
    expect(await staged()).toBe(0);
    expect(locks.held.has(LOCK)).toBe(false);

    const again = await session.prepare(files, detected);
    await session.dispose();
    expect(await staged()).toBe(0);
    expect(locks.held.has(LOCK)).toBe(false);
    // What was prepared is gone, and saving it is refused rather than saving nothing.
    expect(await within(settle(session.commit(again)))).toEqual({ rejected: 'stale_preview' });
  });
});

describe('detection', () => {
  it('starts a fresh worker after a worker error, so that the next detection is answered', async () => {
    ScriptedWorker.respond = (worker, m) => {
      if (m.type !== 'detect') return;
      // The first worker is one whose script could not be loaded: an error event for the first request, then silence.
      if (worker !== workersCreated()[0]) worker.emit({ type: 'detected', id: m.id, detected });
      else if (worker.received.length === 1) worker.emitError('Failed to fetch dynamically imported module');
    };
    const session = open();
    await expect(session.detect(files)).rejects.toMatchObject({
      code: 'worker_failed',
      message: 'The part of the app that reads files stopped unexpectedly.',
      details: 'Failed to fetch dynamically imported module',
    });
    expect(workersCreated()[0].terminated).toBe(true);
    await session.discard(); // the wizard: "Choose another file"

    expect(await within(settle(session.detect(files)), 1000)).toEqual({ resolved: detected });
    expect(workersCreated()).toHaveLength(2);
  });

  it('a detection that dispose() abandons ends as cancelled and leaves no listener on the worker', async () => {
    const session = open();
    const outcome = settle(session.detect(files)); // this worker never answers
    await session.dispose();
    expect(await within(outcome, 1000)).toEqual({ rejected: 'cancelled' });
    const [worker] = workersCreated();
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount('message') + worker.listenerCount('error')).toBe(0);
  });

  it('passes on what the worker says about the files and keeps the worker', async () => {
    let asked = 0;
    ScriptedWorker.respond = (worker, m) => {
      if (m.type !== 'detect') return;
      if (++asked === 1) worker.emit({ type: 'error', id: m.id, error: { message: '"notes.txt" is not a format this app can read.', code: 'unknown_format' } });
      else worker.emit({ type: 'detected', id: m.id, detected });
    };
    const session = open();
    await expect(session.detect(files)).rejects.toMatchObject({ name: 'ImportError', code: 'unknown_format', message: '"notes.txt" is not a format this app can read.' });
    expect(await session.detect(files)).toEqual(detected);
    expect(workersCreated()).toHaveLength(1);
    expect(workersCreated()[0].terminated).toBe(false);
  });
});

describe('with the real import worker', () => {
  beforeEach(() => useWorker(RealWorker));

  const usageLines = (tag: string, records: number) =>
    Array.from({ length: records }, (_, i) =>
      JSON.stringify({ timestamp: new Date(Date.UTC(2026, 2, 1) + i * 60_000).toISOString(), model: 'claude-sonnet-4-5', input_tokens: 100 + i, output_tokens: 10, id: `${tag}-${i}` }),
    ).join('\n') + '\n';
  const storedRows = async () => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM usage_records`)).rows[0].n;

  it('imports a file that needs several batches, each acknowledged before the worker sends more', async () => {
    // Five batches of 2,000 records; the worker pauses when three are unacknowledged.
    const records = 9000;
    const input = [fileOf('usage.jsonl', usageLines('big', records))];
    const session = open();
    const found = await session.detect(input);
    expect(found).toMatchObject({ parser: 'generic-json', fileIndexes: [0] });
    const progress: number[] = [];
    const prepared = await session.prepare(input, found, {}, (p) => progress.push(p.records));
    expect(prepared.preview.usageRows).toMatchObject({ total: records, new: records, duplicate: 0 });
    expect(progress.at(-1)).toBe(records);
    expect(workersCreated()[0].received.filter((m) => m.type === 'ack').length).toBeGreaterThanOrEqual(5);

    const result = await session.commit(prepared);
    expect(result.inserted.usageRows).toBe(records);
    expect(await storedRows()).toBe(records);
    expect(locks.held.has(LOCK)).toBe(false);
    expect(await staged()).toBe(0);
  });

  it('reads a Claude Code folder, and on the second reading skips the files it knows', async () => {
    const day = Date.UTC(2026, 0, 15);
    const transcript = (session: string, responses: number) =>
      jsonl([
        user('please do the thing', { ts: at('09:00:00'), session }),
        ...Array.from({ length: responses }, (_, i) =>
          assistant({ ts: at(`09:00:0${i + 1}`), session, id: `msg_${session}_${i}`, req: `req_${session}_${i}`, usage: tokens(100, 50) }),
        ),
      ]);
    const folder = [
      fileOf('settings.json', '{"theme":"dark"}', { path: '.claude/settings.json', lastModified: day }),
      fileOf('s1.jsonl', transcript('s1', 3), { path: '.claude/projects/-home-alex-demo/s1.jsonl', lastModified: day }),
      fileOf('s2.jsonl', transcript('s2', 2), { path: '.claude/projects/-home-alex-demo/s2.jsonl', lastModified: day }),
    ];
    const session = open();
    const found = await session.detect(folder);
    expect(found).toMatchObject({ parser: 'claude-code', fileIndexes: [1, 2], ignoredFiles: 1, recognisedAs: 'folder with 2 Claude Code transcript files' });
    const first = await session.prepare(folder, found, { now: LATER });
    expect(first.parsed.stats).toMatchObject({ filesRead: 2, filesSkippedUnchanged: 0 });
    await session.commit(first);
    const stored = async () =>
      (
        await t.db.query<{ requests: number; prompts: number; synced: number }>(
          `SELECT (SELECT COALESCE(sum(request_count), 0) FROM usage_records)::int AS requests,
                  (SELECT COALESCE(sum(user_message_count), 0) FROM usage_records)::int AS prompts,
                  (SELECT count(*) FROM synced_files)::int AS synced`,
        )
      ).rows[0];
    expect(await stored()).toEqual({ requests: 5, prompts: 2, synced: 2 });

    // The second reading gets the request keys and the file list of the first from the database.
    const second = await session.prepare(folder, await session.detect(folder), { now: LATER });
    expect(second.parsed.stats).toMatchObject({ filesRead: 0, filesSkippedUnchanged: 2 });
    expect(second.preview.nothingNew).toBe(true);
    await session.commit(second);
    expect(await stored()).toEqual({ requests: 5, prompts: 2, synced: 2 });
    expect(locks.held.has(LOCK)).toBe(false);
  });

  it('reads a ZIP of a Claude Code folder, and adds nothing when the same archive is read again', async () => {
    const day = new Date(2026, 0, 15, 12, 0, 0);
    const transcript = (session: string, responses: number) =>
      jsonl([
        user('please do the thing', { ts: at('09:00:00'), session }),
        ...Array.from({ length: responses }, (_, i) =>
          assistant({ ts: at(`09:00:0${i + 1}`), session, id: `msg_${session}_${i}`, req: `req_${session}_${i}`, usage: tokens(100, 50) }),
        ),
      ]);
    const archive = zipSync(
      {
        '.claude/settings.json': strToU8('{"theme":"dark"}'),
        '.claude/projects/-home-alex-demo/s1.jsonl': strToU8(transcript('s1', 3)),
        '.claude/projects/-home-alex-demo/s2.jsonl': strToU8(transcript('s2', 2)),
      },
      { mtime: day },
    );
    // The archive is chosen next to a file of no interest: the positions detection returns count the files inside the archive.
    const selection = [fileOf('notes.txt', 'hello'), fileOf('claude.zip', archive)];
    const session = open();
    const found = await session.detect(selection);
    expect(found).toMatchObject({
      parser: 'claude-code',
      fileIndexes: [2, 3],
      ignoredFiles: 2,
      leadName: 's1.jsonl',
      recognisedAs: '2 Claude Code transcript files, from the ZIP archive "claude.zip"',
    });
    const first = await session.prepare(selection, found, { now: LATER });
    expect(first.parsed).toMatchObject({ fileName: 'claude.zip (2 transcript files)', stats: { filesRead: 2, filesSkippedUnchanged: 0 } });
    await session.commit(first);
    // Files from an archive are not remembered as synced: the next archive usually has another name.
    expect((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM synced_files`)).rows[0].n).toBe(0);
    expect((await t.db.query<{ n: number }>(`SELECT COALESCE(sum(request_count), 0)::int AS n FROM usage_records`)).rows[0].n).toBe(5);

    const second = await session.prepare(selection, await session.detect(selection), { now: LATER });
    expect(second.parsed.stats).toMatchObject({ filesRead: 2, filesSkippedUnchanged: 0 });
    expect(second.preview.nothingNew).toBe(true);
    await session.discard();
    expect(locks.held.has(LOCK)).toBe(false);
  });

  it('brings a claude.ai export manifest from the worker with its parts, for the page to show', async () => {
    const manifest = fileOf(
      'manifest-x.json',
      JSON.stringify({
        created_at: '2026-11-11T18:02:14Z',
        total_files: 2,
        data_files: [
          { batch_index: 0, category: 'conversations', part: 1, filename: 'conversations-000.zip', export_url: 'https://claude.ai/export/x/download/a' },
          { batch_index: 1, category: 'projects', part: 1, filename: 'projects-000.zip', export_url: 'https://claude.ai/export/x/download/b' },
        ],
      }),
    );
    const error = await open()
      .detect([manifest])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportManifestFound);
    expect((error as ExportManifestFound).manifest).toEqual({
      fileName: 'manifest-x.json',
      createdAt: '2026-11-11T18:02:14Z',
      parts: [
        { category: 'conversations', filename: 'conversations-000.zip', url: 'https://claude.ai/export/x/download/a' },
        { category: 'projects', filename: 'projects-000.zip', url: 'https://claude.ai/export/x/download/b' },
      ],
    });
  });

  it('leaves nothing of a cancelled import for the one that follows it at once', async () => {
    const big = [fileOf('big.jsonl', usageLines('big', 30_000))];
    const small = [fileOf('small.jsonl', usageLines('small', 7))];
    const { db, statements } = observed(t.db, { delayMs: 3 });
    const session = open(db);
    // Both files are detected first, so that nothing separates the cancel from the next import.
    const smallFound = await session.detect(small);
    const outcome = settle(session.prepare(big, await session.detect(big)));
    await until(() => statements.filter(isBatchWrite).length >= 2, 20_000);
    session.cancel();
    expect(await within(outcome, 10_000)).toEqual({ rejected: 'cancelled' });
    expect(locks.held.has(LOCK)).toBe(false);

    const prepared = await session.prepare(small, smallFound);
    expect(prepared.preview.usageRows).toMatchObject({ total: 7, new: 7 });
    const result = await session.commit(prepared);
    expect(result.inserted.usageRows).toBe(7);
    expect(await storedRows()).toBe(7);
  });
});
