import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImportParser } from '@/core/types';
import { commitImport, previewImport } from '@/import/commit';
import { genericCsvParser, genericJsonParser } from '@/import/generic';
import { resetStaging, StagingWriter } from '@/import/staging';
import { createTestDb, type TestDb } from '../helpers/db';
import { fileOf } from '../helpers/sink';

/** The generic CSV and JSON importers against a real PostgreSQL: staging, preview and commit as the app runs them. */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const fixture = (name: string) => readFileSync(new URL(`../fixtures/generic/${name}`, import.meta.url));
const NOW = Date.UTC(2026, 10, 10);

async function importWith(parser: ImportParser, name: string, content: string | Uint8Array, options: Record<string, unknown> = {}) {
  await resetStaging(t.db);
  const writer = new StagingWriter(t.db);
  const parsed = await parser.parse([fileOf(name, content)], writer, { options: { now: NOW, ...options } });
  await writer.finish();
  const preview = await previewImport(t.db, t.userId, parsed);
  const result = await commitImport(t.db, t.userId, parsed);
  return { parsed, preview, result };
}

const rows = async <T = Record<string, unknown>>(sql: string) => (await t.db.query<T>(sql)).rows;
const count = async (table: string) => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
const tokens = async () =>
  (await rows<{ n: number }>(`SELECT COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens), 0)::int AS n FROM usage_records`))[0].n;

describe('generic CSV in the database', () => {
  it('stores the rows with the declared confidence, linked to their conversations', async () => {
    const { preview, result } = await importWith(genericCsvParser, 'usage.csv', fixture('usage.csv'));
    expect(preview.usageRows).toEqual({ total: 4, new: 4, duplicate: 0, withoutModel: 0 });
    expect(preview.conversations).toEqual({ total: 2, new: 2, existing: 0 });
    // nothing vouches for a file somebody made: its counts are estimates unless declared exact
    expect(preview.tokens).toEqual({ exact: 0, estimated: 85010 });
    expect(preview.coverage.hasExactUsage).toBe(false);
    expect(result.inserted).toMatchObject({ conversations: 2, usageRows: 4 });

    expect(
      await rows(
        `SELECT u.dedup_key, to_char(u.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS at, u.bucket_seconds, m.model_key, u.price_tier, u.confidence::text AS confidence,
                u.input_tokens::int AS input, u.output_tokens::int AS output, u.cache_read_tokens::int AS cache_read, u.cache_write_5m_tokens::int AS cw5m, u.cache_write_1h_tokens::int AS cw1h,
                u.request_count AS requests, c.external_id AS conversation
           FROM usage_records u LEFT JOIN model_catalog m ON m.id = u.model_id LEFT JOIN conversations c ON c.id = u.conversation_id ORDER BY u.occurred_at`,
      ),
    ).toEqual([
      { dedup_key: 'generic:req-0001', at: '2026-03-01T09:15:00', bucket_seconds: 0, model_key: 'claude-sonnet-4-6', price_tier: 'standard', confidence: 'estimated', input: 1200, output: 350, cache_read: 8000, cw5m: 0, cw1h: 0, requests: 1, conversation: 'conv-1' },
      { dedup_key: 'generic:req-0002', at: '2026-03-01T09:20:30', bucket_seconds: 0, model_key: 'claude-sonnet-4-6', price_tier: 'standard', confidence: 'estimated', input: 2200, output: 410, cache_read: 9100, cw5m: 500, cw1h: 0, requests: 1, conversation: 'conv-1' },
      { dedup_key: 'generic:day-2026-03-02', at: '2026-03-02T00:00:00', bucket_seconds: 86400, model_key: 'claude-opus-4-6', price_tier: 'batch', confidence: 'estimated', input: 50000, output: 12000, cache_read: 0, cw5m: 0, cw1h: 0, requests: 40, conversation: null },
      { dedup_key: 'generic:req-0003', at: '2026-03-03T10:00:00', bucket_seconds: 60, model_key: 'claude-haiku-4-5', price_tier: 'standard', confidence: 'estimated', input: 900, output: 100, cache_read: 0, cw5m: 0, cw1h: 250, requests: 1, conversation: 'conv-2' },
    ]);

    expect(
      await rows(
        `SELECT c.external_id, c.kind::text AS kind, c.title, m.model_key, c.dedup_key,
                to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS created, to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS updated
           FROM conversations c LEFT JOIN model_catalog m ON m.id = c.model_id ORDER BY c.external_id`,
      ),
    ).toEqual([
      { external_id: 'conv-1', kind: 'usage_bucket', title: 'Refactoring notes', model_key: 'claude-sonnet-4-6', dedup_key: 'generic::conv-1', created: '2026-03-01T09:15:00', updated: '2026-03-01T09:20:30' },
      { external_id: 'conv-2', kind: 'usage_bucket', title: 'Quoted, title', model_key: 'claude-haiku-4-5', dedup_key: 'generic::conv-2', created: '2026-03-03T10:00:00', updated: '2026-03-03T10:00:00' },
    ]);
    expect(await rows(`SELECT kind::text AS kind, label, external_ref FROM data_sources`)).toEqual([{ kind: 'generic_csv', label: 'Custom usage data', external_ref: '' }]);
    expect(await rows(`SELECT format, parser_version, records_seen, records_inserted FROM import_batches`)).toEqual([{ format: 'generic/csv', parser_version: 'generic-1', records_seen: 4, records_inserted: 4 }]);
    expect(await rows(`SELECT confidence::text AS confidence, count(*)::int AS n FROM usage_facts GROUP BY 1`)).toEqual([{ confidence: 'estimated', n: 4 }]);
  });

  it('adds nothing when the same file is imported a second time', async () => {
    const first = await importWith(genericCsvParser, 'usage.csv', fixture('usage.csv'));
    const before = { rows: await count('usage_records'), tokens: await tokens(), conversations: await count('conversations'), batches: await count('import_batches') };
    expect(before).toEqual({ rows: 4, tokens: 85010, conversations: 2, batches: 1 });

    const second = await importWith(genericCsvParser, 'usage.csv', fixture('usage.csv'));
    expect(second.preview.previousImport?.batchId).toBe(first.result.batchId);
    expect(second.preview.usageRows).toMatchObject({ total: 4, new: 0, duplicate: 4 });
    expect(second.preview.conversations).toEqual({ total: 2, new: 0, existing: 2 });
    expect(second.preview.nothingNew).toBe(true);
    expect(second.result).toMatchObject({ nothingNew: true, batchId: null, inserted: { usageRows: 0, conversations: 0 }, duplicates: { usageRows: 4 } });
    expect({ rows: await count('usage_records'), tokens: await tokens(), conversations: await count('conversations'), batches: await count('import_batches') }).toEqual(before);

    // the same holds for rows without an id column, which are identified by a hash of their content
    const noIds = 'timestamp,model,input_tokens,output_tokens\n2026-04-01T10:00:00Z,claude-opus-4-6,100,10\n2026-04-01T11:00:00Z,claude-opus-4-6,200,20\n';
    expect((await importWith(genericCsvParser, 'plain.csv', noIds)).result.inserted.usageRows).toBe(2);
    const again = await importWith(genericCsvParser, 'plain.csv', noIds);
    expect(again.result).toMatchObject({ nothingNew: true, inserted: { usageRows: 0 }, duplicates: { usageRows: 2 } });
    expect(await count('usage_records')).toBe(6);
  });

  it('adds only the new rows when a longer version of the file is imported later', async () => {
    const head = 'timestamp,model,input_tokens,output_tokens\n2026-04-01T10:00:00Z,claude-opus-4-6,100,10\n';
    await importWith(genericCsvParser, 'log.csv', head);
    const longer = await importWith(genericCsvParser, 'log.csv', `${head}2026-04-02T10:00:00Z,claude-opus-4-6,200,20\n2026-04-03T10:00:00Z,claude-opus-4-6,300,30\n`);
    expect(longer.preview.usageRows).toMatchObject({ total: 3, new: 2, duplicate: 1 });
    expect(longer.result.inserted.usageRows).toBe(2);
    expect(await tokens()).toBe(660);
  });

  it('stores exact and estimated files side by side, each with what was declared', async () => {
    const file = (model: string) => `timestamp,model,input_tokens,output_tokens\n2026-04-01T10:00:00Z,${model},1000,100\n`;
    await importWith(genericCsvParser, 'estimates.csv', file('claude-opus-4-6'));
    await importWith(genericCsvParser, 'gateway.csv', file('claude-sonnet-4-6'), { confidence: 'exact', sourceLabel: 'Gateway', sourceRef: 'gateway' });
    expect(
      await rows(`SELECT s.label, s.external_ref, u.confidence::text AS confidence, u.dedup_key ~ '^generic:[0-9a-f]{64}$' AS hashed FROM usage_records u JOIN data_sources s ON s.id = u.source_id ORDER BY s.label`),
    ).toEqual([
      { label: 'Custom usage data', external_ref: '', confidence: 'estimated', hashed: true },
      { label: 'Gateway', external_ref: 'gateway', confidence: 'exact', hashed: true },
    ]);
    expect(await rows(`SELECT confidence::text AS confidence, sum(input_tokens)::int AS input FROM usage_facts GROUP BY 1 ORDER BY 1`)).toEqual([
      { confidence: 'estimated', input: 1000 },
      { confidence: 'exact', input: 1000 },
    ]);
  });

  it('keeps two sources apart even when their ids are the same', async () => {
    const file = 'id,timestamp,model,input_tokens\n1,2026-04-01,claude-opus-4-6,100\n2,2026-04-02,claude-opus-4-6,200\n';
    await importWith(genericCsvParser, 'a.csv', file, { sourceRef: 'laptop', sourceLabel: 'Laptop' });
    const other = await importWith(genericCsvParser, 'b.csv', file, { sourceRef: 'server', sourceLabel: 'Server' });
    expect(other.result.inserted.usageRows).toBe(2);
    expect(await rows(`SELECT dedup_key FROM usage_records ORDER BY 1`)).toEqual([{ dedup_key: 'generic:laptop:1' }, { dedup_key: 'generic:laptop:2' }, { dedup_key: 'generic:server:1' }, { dedup_key: 'generic:server:2' }]);
    expect(await count('data_sources')).toBe(2);
    // within one source the ids deduplicate as usual
    expect((await importWith(genericCsvParser, 'a.csv', file, { sourceRef: 'laptop', sourceLabel: 'Laptop' })).result.nothingNew).toBe(true);
  });

  it('stores total-only rows under a tier that has no price, and unknown models verbatim', async () => {
    const { preview } = await importWith(genericCsvParser, 'totals.csv', 'date,model,tokens\n2026-04-01,claude-opus-4-6,5000\n2026-04-02,some-other-model,700\n2026-04-03,,10\n');
    expect(preview.usageRows).toMatchObject({ total: 3, new: 3, withoutModel: 1 });
    expect(preview.warnings.map((w) => w.code)).toEqual(['total_only']);
    expect(await rows(`SELECT m.model_key, m.is_builtin, u.price_tier, u.input_tokens::int AS input, u.output_tokens::int AS output, u.bucket_seconds FROM usage_records u LEFT JOIN model_catalog m ON m.id = u.model_id ORDER BY u.occurred_at`)).toEqual([
      { model_key: 'claude-opus-4-6', is_builtin: true, price_tier: 'uncategorised', input: 5000, output: 0, bucket_seconds: 86400 },
      { model_key: 'some-other-model', is_builtin: false, price_tier: 'uncategorised', input: 700, output: 0, bucket_seconds: 86400 },
      { model_key: null, is_builtin: null, price_tier: 'uncategorised', input: 10, output: 0, bucket_seconds: 86400 },
    ]);
    // no price exists for that tier, for any model: these tokens can never be priced
    expect(await count(`pricing_history WHERE price_tier = 'uncategorised'`)).toBe(0);
  });
});

describe('generic JSON in the database', () => {
  it('stores the example file and adds nothing the second time', async () => {
    const first = await importWith(genericJsonParser, 'usage.json', fixture('usage.json'), { confidence: 'exact' });
    expect(first.preview.tokens).toEqual({ exact: 85010, estimated: 0 });
    expect(first.result.inserted).toMatchObject({ conversations: 2, usageRows: 4 });
    expect(await rows(`SELECT kind::text AS kind, label, external_ref FROM data_sources`)).toEqual([{ kind: 'generic_json', label: 'My proxy logs', external_ref: '' }]);
    expect(await rows(`SELECT DISTINCT confidence::text AS confidence FROM usage_records`)).toEqual([{ confidence: 'exact' }]);
    expect(await rows(`SELECT format, parser_version FROM import_batches`)).toEqual([{ format: 'claude-lifetime/usage', parser_version: 'generic-1' }]);

    const second = await importWith(genericJsonParser, 'usage.json', fixture('usage.json'), { confidence: 'exact' });
    expect(second.preview.nothingNew).toBe(true);
    expect(second.result).toMatchObject({ nothingNew: true, inserted: { usageRows: 0 }, duplicates: { usageRows: 4 } });
    expect(await count('usage_records')).toBe(4);
    expect(await tokens()).toBe(85010);

    // the same records as JSON Lines, and as CSV: the ids are known, nothing is added
    expect((await importWith(genericJsonParser, 'usage.jsonl', fixture('usage.jsonl'))).result.nothingNew).toBe(true);
    expect((await importWith(genericCsvParser, 'usage.csv', fixture('usage.csv'))).result.nothingNew).toBe(true);
    expect(await count('usage_records')).toBe(4);
    expect(await count('conversations')).toBe(2);
  });
});
