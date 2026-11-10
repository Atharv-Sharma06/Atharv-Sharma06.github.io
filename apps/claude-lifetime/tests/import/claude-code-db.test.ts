import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImportFile, ImportParser } from '@/core/types';
import { toNumber } from '@/db/driver';
import { claudeCodeLedgerParser, claudeCodeParser, extractTranscripts, mergeIntoLedger, serialiseLedger } from '@/import/claude-code';
import { emptyLedger } from '@/import/claude-code/ledger';
import { commitImport, importGeneration, loadKnownRequestKeys, previewImport } from '@/import/commit';
import { deleteBatch } from '@/import/delete';
import { resetStaging, StagingWriter } from '@/import/staging';
import { assistant, at, file, fixtureText, jsonl, LATER, loadFixtureDir, SESSION_B, usage, user } from '../fixtures/claude-code/builders';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * The Claude Code importer against the real database: parse -> staging tables ->
 * preview -> commit, exactly as the app runs it.
 */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const S = '11111111-1111-4111-8111-111111111111';
const MODIFIED = Date.UTC(2026, 0, 15, 12);

const count = async (table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

/** Sums per model, straight from usage_records. */
async function sums() {
  const { rows } = await t.db.query<Record<string, unknown>>(
    `SELECT m.model_key, count(*)::int AS rows,
            sum(u.input_tokens)::int AS input, sum(u.output_tokens)::int AS output, sum(u.cache_read_tokens)::int AS cache_read,
            sum(u.cache_write_5m_tokens)::int AS write_5m, sum(u.cache_write_1h_tokens)::int AS write_1h,
            sum(u.request_count)::int AS requests, sum(u.user_message_count)::int AS user_messages,
            sum(u.assistant_message_count)::int AS assistant_messages
       FROM usage_records u LEFT JOIN model_catalog m ON m.id = u.model_id
      GROUP BY m.model_key ORDER BY m.model_key`,
  );
  return Object.fromEntries(rows.map(({ model_key, ...rest }) => [String(model_key), rest]));
}

async function knownFilesFromDb() {
  const { rows } = await t.db.query<{ path: string; size: unknown; last_modified: Date }>(`SELECT path, size, last_modified FROM synced_files`);
  return new Map(rows.map((r) => [r.path, { size: toNumber(r.size), lastModified: r.last_modified.getTime() }]));
}

/** One import the way the app does it: load what is known, parse into staging, preview, commit. */
async function runImport(files: ImportFile[], opts: { parser?: ImportParser; skipKnownFiles?: boolean } = {}) {
  await resetStaging(t.db);
  const writer = new StagingWriter(t.db);
  const generation = await importGeneration(t.db, t.userId);
  const knownRequestKeys = await loadKnownRequestKeys(t.db, t.userId);
  const knownFiles = opts.skipKnownFiles ? await knownFilesFromDb() : undefined;
  const parsed = await (opts.parser ?? claudeCodeParser).parse(files, writer, { knownRequestKeys, knownFiles, options: { now: LATER } });
  await writer.finish();
  const preview = await previewImport(t.db, t.userId, parsed);
  const result = await commitImport(t.db, t.userId, parsed, { generation });
  return { parsed, preview, result };
}

const example = () => loadFixtureDir('research-example', MODIFIED);

/** The example plus a later turn in the same session (same 15-minute window) and a second session. */
function supersetFiles(): ImportFile[] {
  const mainPath = `projects/-home-alex-demo/${S}.jsonl`;
  const grown = file(
    mainPath,
    fixtureText(`research-example/${mainPath}`) +
      jsonl([
        user('FOLLOW-UP-PROMPT', { ts: at('09:10:00'), session: S, uuid: 'follow-up-prompt' }),
        assistant({ id: 'msg_NEW1', req: 'req_NEW1', ts: at('09:10:05'), session: S, usage: usage(1, 50, 17400, 30, 0) }),
      ]),
    MODIFIED + 3_600_000,
  );
  const other = file(
    `projects/-home-alex-demo/${SESSION_B}.jsonl`,
    jsonl([assistant({ id: 'msg_NEW2', req: 'req_NEW2', ts: at('10:00:00', '2026-01-16'), session: SESSION_B, model: 'claude-opus-5-5', usage: usage(5, 500, 1000, 0, 100) })]),
    MODIFIED + 3_600_000,
  );
  return [grown, ...example().filter((f) => f.path !== mainPath), other];
}

const EXAMPLE_SUMS = {
  'claude-haiku-4-5': { rows: 1, input: 10, output: 300, cache_read: 0, write_5m: 5000, write_1h: 0, requests: 1, user_messages: 0, assistant_messages: 0 },
  'claude-sonnet-4-5': { rows: 1, input: 9, output: 380, cache_read: 49150, write_5m: 240, write_1h: 2000, requests: 3, user_messages: 1, assistant_messages: 1 },
};

describe('Claude Code import into the database', () => {
  it('previews and commits the example with the exact expected sums', async () => {
    const { parsed, preview, result } = await runImport(example());

    expect(preview).toMatchObject({
      format: 'claude-code/jsonl',
      conversations: { total: 1, new: 1, existing: 0 },
      usageRows: { total: 2, new: 2, duplicate: 0, withoutModel: 0 },
      messages: { total: 0, new: 0 },
      requests: { new: 5, duplicate: 0 },
      tokens: { exact: 19 + 680 + 7240 + 49150, estimated: 0 },
      dateRange: { start: '2026-01-15T09:00:00.000Z', end: '2026-01-15T09:00:00.000Z' },
      coverage: { hasExactUsage: true, hasModel: true, modelShare: 1 },
      models: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
      nothingNew: false,
      previousImport: null,
    });
    expect(result).toMatchObject({ inserted: { conversations: 1, messages: 0, usageRows: 2, costRows: 0 }, nothingNew: false });
    expect(await sums()).toEqual(EXAMPLE_SUMS);

    const conversation = (await t.db.query<Record<string, unknown>>(
      `SELECT c.kind::text, c.external_id, c.dedup_key, c.title, c.project_label, m.model_key, c.message_count, c.user_message_count,
              c.assistant_message_count, c.created_at, c.updated_at, c.metadata
         FROM conversations c LEFT JOIN model_catalog m ON m.id = c.model_id`,
    )).rows;
    expect(conversation).toHaveLength(1);
    expect(conversation[0]).toMatchObject({
      kind: 'code_session', external_id: S, dedup_key: `claude_code:${S}`, title: null, project_label: '/home/alex/demo',
      model_key: 'claude-sonnet-4-5', message_count: 2, user_message_count: 1, assistant_message_count: 1,
      metadata: { gitBranch: 'main', version: '2.1.321', hasSubagents: true },
    });
    expect((conversation[0].created_at as Date).toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect((conversation[0].updated_at as Date).toISOString()).toBe('2026-01-15T09:00:24.000Z');

    const batch = (await t.db.query<Record<string, unknown>>(
      `SELECT b.format, b.parser_version, b.file_name, b.records_seen, b.records_skipped, b.records_inserted, cardinality(b.request_keys) AS keys,
              s.kind::text AS source_kind, s.label, s.external_ref, b.coverage_start, b.stats->>'responses' AS responses
         FROM import_batches b JOIN data_sources s ON s.id = b.source_id`,
    )).rows[0];
    expect(batch).toMatchObject({
      format: 'claude-code/jsonl', parser_version: 'claude-code-1', file_name: '2 transcript files', records_seen: 6, records_skipped: 1,
      records_inserted: 2, keys: 5, source_kind: 'claude_code', label: 'Claude Code (this computer)', external_ref: 'local', responses: '4',
    });
    expect([...(await loadKnownRequestKeys(t.db, t.userId))].sort()).toEqual([...parsed.requestKeys!].sort());
    expect([...(await knownFilesFromDb()).entries()].sort()).toEqual(
      parsed.syncedFiles!.map((f) => [f.path, { size: f.size, lastModified: f.lastModified }]).sort(),
    );
    // every usage row is exact and reaches the analytics view
    const facts = (await t.db.query<{ confidence: string; tokens: unknown }>(
      `SELECT confidence::text, sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)::bigint AS tokens
         FROM usage_facts GROUP BY confidence`,
    )).rows;
    expect(facts.map((f) => [f.confidence, toNumber(f.tokens)])).toEqual([['exact', 57089]]);
  });

  it('importing the same transcripts twice adds nothing and reports the duplicates', async () => {
    const first = await runImport(example());
    const before = await sums();

    const second = await runImport(example());
    expect(second.parsed.requestKeys).toEqual([]);
    expect(second.parsed.duplicateRequests).toBe(5);
    expect(second.parsed.stats).toMatchObject({ responses: 4, newResponses: 0, duplicateResponses: 4, duplicateHumanPrompts: 1 });
    expect(second.preview).toMatchObject({
      requests: { new: 0, duplicate: 5 },
      usageRows: { total: 0, new: 0 },
      conversations: { total: 0, new: 0 },
      tokens: { exact: 0, estimated: 0 },
      nothingNew: true,
    });
    expect(second.result).toMatchObject({ nothingNew: true, batchId: null, inserted: { conversations: 0, usageRows: 0 } });
    expect(await sums()).toEqual(before);
    expect(await count('import_batches')).toBe(1);
    expect(await count('usage_records')).toBe(2);
    expect(await count('conversations')).toBe(1);
    expect(second.result.sourceId).toBe(first.result.sourceId);

    // with the list of synced files, the unchanged transcripts are not even read
    const third = await runImport(example(), { skipKnownFiles: true });
    expect(third.parsed.stats).toMatchObject({ filesRead: 0, filesSkippedUnchanged: 2 });
    expect(third.result.nothingNew).toBe(true);
    expect(await sums()).toEqual(before);
  });

  it('importing a superset later adds only the new responses', async () => {
    await runImport(example());
    const later = await runImport(supersetFiles(), { skipKnownFiles: true });

    // the main transcript grew and a session was added; the unchanged subagent file is skipped
    expect(later.parsed.stats).toMatchObject({ filesRead: 2, filesSkippedUnchanged: 1, newResponses: 2, duplicateResponses: 3, newHumanPrompts: 1, duplicateHumanPrompts: 1 });
    expect(later.preview).toMatchObject({
      requests: { new: 3, duplicate: 4 },
      conversations: { total: 2, new: 1, existing: 1 },
      usageRows: { total: 2, new: 2, duplicate: 0 },
      tokens: { exact: 1 + 50 + 17400 + 30 + 5 + 500 + 1000 + 100, estimated: 0 },
      nothingNew: false,
    });
    expect(later.result.inserted).toMatchObject({ conversations: 1, usageRows: 2 });

    expect(await sums()).toEqual({
      'claude-haiku-4-5': EXAMPLE_SUMS['claude-haiku-4-5'],
      'claude-opus-5-5': { rows: 1, input: 5, output: 500, cache_read: 1000, write_5m: 0, write_1h: 100, requests: 1, user_messages: 0, assistant_messages: 1 },
      // a second row for the same 15-minute window: later imports add to earlier ones
      'claude-sonnet-4-5': { rows: 2, input: 10, output: 430, cache_read: 66550, write_5m: 270, write_1h: 2000, requests: 4, user_messages: 2, assistant_messages: 2 },
    });
    const window = (await t.db.query<{ rows: number; requests: number }>(
      `SELECT count(*)::int AS rows, sum(u.request_count)::int AS requests
         FROM usage_records u JOIN model_catalog m ON m.id = u.model_id
        WHERE m.model_key = 'claude-sonnet-4-5' AND u.occurred_at = '2026-01-15T09:00:00Z' AND u.bucket_seconds = 900`,
    )).rows[0];
    expect(window).toEqual({ rows: 2, requests: 4 });

    const session = (await t.db.query<Record<string, unknown>>(
      `SELECT message_count, user_message_count, assistant_message_count, updated_at FROM conversations WHERE external_id = $1`, [S],
    )).rows[0];
    expect(session).toMatchObject({ message_count: 4, user_message_count: 2, assistant_message_count: 2 });
    expect((session.updated_at as Date).toISOString()).toBe('2026-01-15T09:10:05.000Z');
    expect(await count('import_batches')).toBe(2);

    // and once more: everything is known now
    const again = await runImport(supersetFiles());
    expect(again.preview).toMatchObject({ requests: { new: 0, duplicate: 8 }, nothingNew: true });
  });

  it('the ledger of already imported transcripts adds nothing, and a ledger alone gives the same totals', async () => {
    const files = supersetFiles();
    await runImport(files);
    const fromTranscripts = await sums();
    const conversations = await count('conversations');

    const ledger = emptyLedger();
    mergeIntoLedger(ledger, await extractTranscripts(files));
    const text = [...serialiseLedger(ledger, { generatedAt: new Date(LATER).toISOString(), machine: 'test-machine', collector: 'test' })].join('');
    const ledgerFile = () => file('claude-code-ledger.json', text, LATER);

    const after = await runImport([ledgerFile()], { parser: claudeCodeLedgerParser });
    expect(after.parsed).toMatchObject({ format: 'claude-code/ledger', requestKeys: [], duplicateRequests: 8 });
    expect(after.preview).toMatchObject({ requests: { new: 0, duplicate: 8 }, nothingNew: true });
    expect(await sums()).toEqual(fromTranscripts);

    await t.reset();
    const alone = await runImport([ledgerFile()], { parser: claudeCodeLedgerParser });
    expect(alone.preview).toMatchObject({ requests: { new: 8, duplicate: 0 }, conversations: { total: 2, new: 2 }, nothingNew: false });
    expect(alone.parsed.stats).toMatchObject({ machine: 'test-machine', responses: 6, humanPrompts: 2 });
    expect(await sums()).toEqual({
      ...fromTranscripts,
      // one import, so one row per window
      'claude-sonnet-4-5': { ...fromTranscripts['claude-sonnet-4-5'], rows: 1 },
    });
    expect(await count('conversations')).toBe(conversations);

    // the same ledger file again is recognised by its content hash and adds nothing
    const repeat = await runImport([ledgerFile()], { parser: claudeCodeLedgerParser });
    expect(repeat.preview.previousImport?.batchId).toBe(alone.result.batchId);
    expect(repeat.result.nothingNew).toBe(true);

    // transcripts after the ledger: nothing new either
    const transcripts = await runImport(files);
    expect(transcripts.preview).toMatchObject({ requests: { new: 0, duplicate: 8 }, nothingNew: true });
  });

  it('stores model identifiers the catalog does not know and keeps a missing model empty', async () => {
    await runImport([
      file(`projects/p/${SESSION_B}.jsonl`, jsonl([
        assistant({ id: 'msg_Q1', req: 'req_Q1', ts: at('09:00:00'), session: SESSION_B, model: 'claude-opus-9-20300101', usage: usage(1, 2) }),
        assistant({ id: 'msg_Q2', req: 'req_Q2', ts: at('09:00:01'), session: SESSION_B, model: null, usage: usage(3, 4) }),
      ])),
    ]);
    const rows = (await t.db.query<Record<string, unknown>>(
      `SELECT m.model_key, m.display_name, m.family, m.is_builtin, u.input_tokens::int AS input
         FROM usage_records u LEFT JOIN model_catalog m ON m.id = u.model_id ORDER BY u.input_tokens`,
    )).rows;
    expect(rows).toEqual([
      { model_key: 'claude-opus-9', display_name: 'claude-opus-9-20300101', family: 'opus', is_builtin: false, input: 1 },
      { model_key: null, display_name: null, family: null, is_builtin: null, input: 3 },
    ]);
  });

  it('deleting the import removes what it added, and the transcripts can be imported again', async () => {
    const first = await runImport(example());
    await deleteBatch(t.db, t.userId, first.result.batchId!);
    expect(await count('usage_records')).toBe(0);
    expect((await loadKnownRequestKeys(t.db, t.userId)).size).toBe(0);

    const again = await runImport(example());
    expect(again.preview.requests).toEqual({ new: 5, duplicate: 0 });
    expect(await sums()).toEqual(EXAMPLE_SUMS);
  });
});
