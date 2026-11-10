import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImportParser, ParseContext } from '@/core/types';
import { apiCostReportParser, apiUsageReportParser, consoleCsvParser } from '@/import/api-reports';
import { commitImport, previewImport } from '@/import/commit';
import { resetStaging, StagingWriter } from '@/import/staging';
import { createTestDb, type TestDb } from '../helpers/db';
import { fileOf } from '../helpers/sink';

/**
 * The report importers against a real PostgreSQL: staging, preview and commit as the
 * app runs them. What matters here is that a report which restates a period replaces
 * the earlier figures instead of adding to them.
 */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const fixture = (name: string) => readFileSync(new URL(`../fixtures/api-reports/${name}`, import.meta.url));

/** One import of several files selected together. */
async function importFiles(parser: ImportParser, files: Array<[name: string, content: string | Uint8Array]>, ctx: ParseContext = {}) {
  await resetStaging(t.db);
  const writer = new StagingWriter(t.db);
  const parsed = await parser.parse(files.map(([name, content]) => fileOf(name, content)), writer, ctx);
  await writer.finish();
  const preview = await previewImport(t.db, t.userId, parsed);
  const result = await commitImport(t.db, t.userId, parsed);
  return { parsed, preview, result };
}

const importWith = (parser: ImportParser, name: string, content: string | Uint8Array, ctx: ParseContext = {}) =>
  importFiles(parser, [[name, content]], ctx);

const rows = async <T = Record<string, unknown>>(sql: string) => (await t.db.query<T>(sql)).rows;
const count = async (table: string) => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

/** Input tokens per day, as stored. */
const inputPerDay = async () =>
  Object.fromEntries(
    (
      await rows<{ day: string; tokens: number }>(
        `SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'MM-DD') AS day, sum(input_tokens)::int AS tokens FROM usage_records GROUP BY 1 ORDER BY 1`,
      )
    ).map((r) => [r.day, r.tokens]),
  );

const day = (d: number) => `2026-04-${String(d).padStart(2, '0')}T00:00:00Z`;
const usageResult = (model: string | null, input: number, over: Record<string, unknown> = {}) => ({
  uncached_input_tokens: input,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_read_input_tokens: 0,
  output_tokens: input / 10,
  server_tool_use: { web_search_requests: 0 },
  account_id: null,
  api_key_id: null,
  context_window: null,
  inference_geo: null,
  model,
  service_account_id: null,
  service_tier: null,
  speed: null,
  workspace_id: null,
  ...over,
});
const bucket = (d: number, results: unknown[]) => ({ starting_at: day(d), ending_at: day(d + 1), results });
const report = (...buckets: unknown[]) => JSON.stringify({ data: buckets, has_more: false, next_page: null });

describe('API usage reports in the database', () => {
  it('stores report rows as exact usage of one source', async () => {
    const pages = `[${fixture('usage-report.daily.page-1.json').toString('utf8')},${fixture('usage-report.daily.page-2.json').toString('utf8')}]`;
    const { preview, result } = await importWith(apiUsageReportParser, 'usage.json', pages);

    expect(preview.usageRows).toEqual({ total: 6, new: 6, duplicate: 0, withoutModel: 0 });
    expect(preview.tokens).toEqual({ exact: 2129200, estimated: 0 });
    expect(preview.coverage).toMatchObject({ hasExactUsage: true, hasModel: true });
    expect(preview.replaced).toBeNull();
    expect(result.inserted.usageRows).toBe(6);

    const stored = await rows(
      `SELECT to_char(u.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, m.model_key, m.is_builtin, u.price_tier, u.confidence::text AS confidence,
              u.bucket_seconds, u.input_tokens::int AS input, u.output_tokens::int AS output, u.cache_read_tokens::int AS cache_read,
              u.cache_write_5m_tokens::int AS cw5m, u.cache_write_1h_tokens::int AS cw1h, u.web_search_requests AS searches, u.conversation_id
         FROM usage_records u LEFT JOIN model_catalog m ON m.id = u.model_id ORDER BY u.occurred_at, m.model_key`,
    );
    expect(stored).toEqual([
      { day: '2026-03-01', model_key: 'claude-haiku-4-5', is_builtin: true, price_tier: 'batch', confidence: 'exact', bucket_seconds: 86400, input: 500000, output: 80000, cache_read: 0, cw5m: 0, cw1h: 0, searches: 0, conversation_id: null },
      { day: '2026-03-01', model_key: 'claude-sonnet-4-6', is_builtin: true, price_tier: 'standard', confidence: 'exact', bucket_seconds: 86400, input: 120000, output: 45000, cache_read: 900000, cw5m: 30000, cw1h: 4000, searches: 3, conversation_id: null },
      { day: '2026-03-03', model_key: 'claude-sonnet-4-6', is_builtin: true, price_tier: 'standard', confidence: 'exact', bucket_seconds: 86400, input: 60000, output: 20000, cache_read: 100000, cw5m: 0, cw1h: 0, searches: 0, conversation_id: null },
      { day: '2026-03-04', model_key: 'claude-opus-4-8', is_builtin: true, price_tier: 'fast', confidence: 'exact', bucket_seconds: 86400, input: 7000, output: 3000, cache_read: 0, cw5m: 0, cw1h: 0, searches: 0, conversation_id: null },
      // an identifier the catalog does not know is added to it verbatim, never mapped to a known model
      { day: '2026-03-06', model_key: 'claude-nova-9', is_builtin: false, price_tier: 'priority', confidence: 'exact', bucket_seconds: 86400, input: 1000, output: 200, cache_read: 0, cw5m: 0, cw1h: 0, searches: 0, conversation_id: null },
      { day: '2026-03-06', model_key: 'claude-sonnet-4-5', is_builtin: true, price_tier: 'long_context', confidence: 'exact', bucket_seconds: 86400, input: 250000, output: 9000, cache_read: 0, cw5m: 0, cw1h: 0, searches: 0, conversation_id: null },
    ]);

    expect(await rows(`SELECT kind::text AS kind, label, external_ref FROM data_sources`)).toEqual([{ kind: 'api_usage_report', label: 'Anthropic API usage report', external_ref: '' }]);
    const batches = await rows<{ format: string; parser_version: string; records_seen: number; records_inserted: number; content_hash: string }>(
      `SELECT format, parser_version, records_seen, records_inserted, content_hash FROM import_batches`,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ format: 'anthropic/usage-report', parser_version: 'api-reports-1', records_seen: 6, records_inserted: 6 });
    expect(batches[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    // exact usage shows up in the analytics view as exact
    expect(await rows(`SELECT confidence::text AS confidence, count(*)::int AS n FROM usage_facts GROUP BY 1`)).toEqual([{ confidence: 'exact', n: 6 }]);
  });

  it('replaces a period that a later report restates, without double counting', async () => {
    // first report: 1-5 April
    await importWith(
      apiUsageReportParser,
      'april-1-5.json',
      report(
        bucket(1, [usageResult('claude-sonnet-4-6', 1000)]),
        bucket(2, [usageResult('claude-sonnet-4-6', 2000), usageResult('claude-opus-4-6', 500)]),
        bucket(3, [usageResult('claude-sonnet-4-6', 3000)]),
        bucket(4, [usageResult('claude-sonnet-4-6', 4000)]),
        bucket(5, [usageResult('claude-sonnet-4-6', 5000), usageResult('claude-opus-4-6', 700)]),
      ),
    );
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2500, '04-03': 3000, '04-04': 4000, '04-05': 5700 });

    // revised report: 4-7 April. Day 4 went up, the Opus usage of day 5 is gone, day 6 is new, day 7 is empty.
    const revised = report(
      bucket(4, [usageResult('claude-sonnet-4-6', 4400)]),
      bucket(5, [usageResult('claude-sonnet-4-6', 5000)]),
      bucket(6, [usageResult('claude-sonnet-4-6', 6000)]),
      bucket(7, []),
    );
    const second = await importWith(apiUsageReportParser, 'april-4-7.json', revised);
    expect(second.parsed.replaceRanges).toEqual([{ start: '2026-04-04T00:00:00.000Z', end: '2026-04-08T00:00:00.000Z' }]);
    // Of the three stored rows in the restated range, two are replaced: 4 April is stated differently and the Opus row
    // of 5 April is not stated any more. The Sonnet row of 5 April is stated exactly as stored and stays where it is.
    expect(second.preview.replaced).toEqual({ usageRows: 2, costRows: 0, tokens: Math.round((4000 + 700) * 1.1) });
    expect(second.preview.usageRows).toMatchObject({ total: 3, new: 2, duplicate: 1 });
    expect(second.preview.nothingNew).toBe(false);
    expect(second.result.replaced).toEqual({ usageRows: 2, costRows: 0 });
    expect(second.result.inserted.usageRows).toBe(2);

    // days 1-3 as first reported, days 4-6 as restated: the totals are the revised values
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2500, '04-03': 3000, '04-04': 4400, '04-05': 5000, '04-06': 6000 });
    expect(await count('usage_records')).toBe(7);
    expect(await count('data_sources')).toBe(1);
    expect(await count('import_batches')).toBe(2);

    // The import history stays truthful: the first import lost two of its seven records to the second and says so,
    // and the second says that deleting it would not bring them back.
    const history = await rows<{ file_name: string; records_inserted: number; rows: number; notes: string }>(
      `SELECT b.file_name, b.records_inserted, (SELECT count(*) FROM usage_records u WHERE u.batch_id = b.id)::int AS rows,
              (SELECT string_agg((w->>'code') || ':' || (w->>'count'), ',') FROM jsonb_array_elements(b.warnings) w
                WHERE w->>'code' IN ('superseded', 'replaced_earlier')) AS notes
         FROM import_batches b ORDER BY b.id`,
    );
    // the first report held seven rows
    expect(history).toEqual([
      { file_name: 'april-1-5.json', records_inserted: 5, rows: 5, notes: 'superseded:2' },
      { file_name: 'april-4-7.json', records_inserted: 2, rows: 2, notes: 'replaced_earlier:2' },
    ]);

    // importing the revised report once more is recognised as nothing new: no rows change hands, no import is added
    const third = await importWith(apiUsageReportParser, 'april-4-7.json', revised);
    expect(third.preview.previousImport).toMatchObject({ batchId: second.result.batchId, sameSource: true });
    expect(third.preview).toMatchObject({ nothingNew: true, replaced: { usageRows: 0, costRows: 0, tokens: 0 }, usageRows: { total: 3, new: 0, duplicate: 3 } });
    expect(third.result).toMatchObject({ nothingNew: true, batchId: null, replaced: { usageRows: 0, costRows: 0 } });
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2500, '04-03': 3000, '04-04': 4400, '04-05': 5000, '04-06': 6000 });
    expect(await count('usage_records')).toBe(7);
    expect(await count('import_batches')).toBe(2);
  });

  it('deleting a later report takes away only what that report changed', async () => {
    const full = report(...[1, 2, 3, 4, 5].map((d) => bucket(d, [usageResult('claude-sonnet-4-6', d * 1000)])));
    const first = await importWith(apiUsageReportParser, 'april-all.json', full);
    // by mistake the same days again from a report that agrees with the first on 3 and 4 April and differs on the 5th
    const second = await importWith(
      apiUsageReportParser,
      'april-3-5.json',
      report(bucket(3, [usageResult('claude-sonnet-4-6', 3000)]), bucket(4, [usageResult('claude-sonnet-4-6', 4000)]), bucket(5, [usageResult('claude-sonnet-4-6', 5500)])),
    );
    expect(second.result).toMatchObject({ replaced: { usageRows: 1 }, inserted: { usageRows: 1 } });
    const { deleteBatch } = await import('@/import/delete');
    await deleteBatch(t.db, t.userId, second.result.batchId!);
    // 3 and 4 April still belong to the first import and are still there; only the restated 5th is gone
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2000, '04-03': 3000, '04-04': 4000 });
    expect((await rows<{ records_inserted: number }>(`SELECT records_inserted FROM import_batches WHERE id = ${first.result.batchId}`))[0].records_inserted).toBe(4);
    // and the first report brings its 5 April back when it is imported again
    const again = await importWith(apiUsageReportParser, 'april-all.json', full);
    expect(again.preview.usageRows).toMatchObject({ new: 1, duplicate: 4 });
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2000, '04-03': 3000, '04-04': 4000, '04-05': 5000 });
  });

  it('removes an earlier import from the history once a later report has replaced all of it', async () => {
    await importWith(apiUsageReportParser, 'first.json', report(bucket(1, [usageResult('claude-sonnet-4-6', 1000)]), bucket(2, [usageResult('claude-sonnet-4-6', 2000)])));
    const second = await importWith(apiUsageReportParser, 'second.json', report(bucket(1, [usageResult('claude-sonnet-4-6', 1100)]), bucket(2, [usageResult('claude-sonnet-4-6', 2200)])));
    expect(await rows(`SELECT file_name FROM import_batches ORDER BY id`)).toEqual([{ file_name: 'second.json' }]);
    expect(second.result.replaced.usageRows).toBe(2);
    expect(await inputPerDay()).toEqual({ '04-01': 1100, '04-02': 2200 });
  });

  it('refuses a report that starts or ends inside a stored total, instead of counting the time twice or losing part of it', async () => {
    const daily = report(...[1, 2, 3].map((d) => bucket(d, [usageResult('claude-sonnet-4-6', 2400)])));
    await importWith(apiUsageReportParser, 'daily.json', daily);
    const hour = (d: number, h: number) => `2026-04-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
    const hourly = (from: [number, number], hours: number) =>
      JSON.stringify({
        data: Array.from({ length: hours }, (_, i) => {
          const start = Date.parse(hour(from[0], from[1])) + i * 3_600_000;
          return { starting_at: new Date(start).toISOString(), ending_at: new Date(start + 3_600_000).toISOString(), results: [usageResult('claude-sonnet-4-6', 100)] };
        }),
        has_more: false,
        next_page: null,
      });

    // an hourly report that begins at 14:00 on 2 April: the daily total of that day cannot be replaced for its afternoon only
    await expect(importWith(apiUsageReportParser, 'hourly-from-afternoon.json', hourly([2, 14], 34))).rejects.toMatchObject({
      code: 'range_conflict',
      message: expect.stringContaining('the daily total for 2026-04-02 (UTC)'),
    });
    // ... and one that ends at noon on 2 April must not delete that day's total either
    await expect(importWith(apiUsageReportParser, 'hourly-until-noon.json', hourly([1, 0], 36))).rejects.toMatchObject({ code: 'range_conflict' });
    expect(await inputPerDay()).toEqual({ '04-01': 2400, '04-02': 2400, '04-03': 2400 });
    expect(await count('import_batches')).toBe(1);

    // an hourly report of whole days replaces the daily totals of those days, and nothing is counted twice
    const whole = await importWith(apiUsageReportParser, 'hourly-whole-days.json', hourly([2, 0], 48));
    expect(whole.result).toMatchObject({ replaced: { usageRows: 2 }, inserted: { usageRows: 48 } });
    expect(await inputPerDay()).toEqual({ '04-01': 2400, '04-02': 2400, '04-03': 2400 });
    // and the daily report of the same days takes them back the same way
    const back = await importWith(apiUsageReportParser, 'daily.json', daily);
    expect(back.result).toMatchObject({ replaced: { usageRows: 48 }, inserted: { usageRows: 2 } });
    expect(await inputPerDay()).toEqual({ '04-01': 2400, '04-02': 2400, '04-03': 2400 });
    expect(await count('usage_records')).toBe(3);
  });

  it('replaces a period also when the later report is grouped differently or has become empty', async () => {
    await importWith(apiUsageReportParser, 'by-model.json', report(bucket(1, [usageResult('claude-sonnet-4-6', 1000)]), bucket(2, [usageResult('claude-sonnet-4-6', 2000)]), bucket(3, [usageResult('claude-sonnet-4-6', 3000)])));

    // the same two days again, now split by service tier: other rows, other keys, same usage
    const split = report(
      bucket(1, [usageResult('claude-sonnet-4-6', 600, { service_tier: 'standard', speed: 'standard' }), usageResult('claude-sonnet-4-6', 400, { service_tier: 'batch', speed: 'standard' })]),
      bucket(2, [usageResult('claude-sonnet-4-6', 2000, { service_tier: 'standard', speed: 'standard' })]),
    );
    const second = await importWith(apiUsageReportParser, 'by-tier.json', split);
    expect(second.result.replaced.usageRows).toBe(2);
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2000, '04-03': 3000 });
    expect(await rows(`SELECT price_tier, sum(input_tokens)::int AS tokens FROM usage_records GROUP BY 1 ORDER BY 1`)).toEqual([
      { price_tier: 'batch', tokens: 400 },
      { price_tier: 'standard', tokens: 5600 },
    ]);

    // a report in which 3 April has no usage any more: the empty bucket clears the day
    const third = await importWith(apiUsageReportParser, 'day-2-3.json', report(bucket(2, [usageResult('claude-sonnet-4-6', 2100, { service_tier: 'standard', speed: 'standard' })]), bucket(3, [])));
    expect(third.parsed.replaceRanges).toEqual([{ start: '2026-04-02T00:00:00.000Z', end: '2026-04-04T00:00:00.000Z' }]);
    expect(third.result.replaced.usageRows).toBe(2);
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2100 });
  });

  it('treats a Console export and an API report of the same days as the same figures', async () => {
    const header =
      'usage_date_utc,model_version,api_key,workspace,usage_type,context_window,usage_input_tokens_no_cache,usage_input_tokens_cache_write_5m,usage_input_tokens_cache_write_1h,usage_input_tokens_cache_read,usage_output_tokens,web_search_count,inference_geo,speed';
    const csv = `${header}\n2026-04-01,claude-sonnet-4-6,key-a,Default,standard,≤ 200k,700,0,0,0,70,0,global,\n2026-04-01,claude-sonnet-4-6,key-b,Default,standard,≤ 200k,300,0,0,0,30,0,global,\n2026-04-02,claude-sonnet-4-6,key-a,Default,standard,≤ 200k,2000,0,0,0,200,0,global,\n`;
    const first = await importWith(consoleCsvParser, 'claude_api_tokens_2026_04.csv', csv);
    expect(first.parsed.format).toBe('anthropic/console-usage-csv');
    expect(first.result.inserted.usageRows).toBe(3);
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2000 });
    expect(await rows(`SELECT DISTINCT confidence::text AS confidence FROM usage_records`)).toEqual([{ confidence: 'exact' }]);

    // the API's report of 2 and 3 April replaces the export's 2 April and adds 3 April
    const second = await importWith(apiUsageReportParser, 'usage.json', report(bucket(2, [usageResult('claude-sonnet-4-6', 2050)]), bucket(3, [usageResult('claude-sonnet-4-6', 3000)])));
    expect(second.result.replaced.usageRows).toBe(1);
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2050, '04-03': 3000 });
    expect(await rows(`SELECT kind::text AS kind FROM data_sources`)).toEqual([{ kind: 'api_usage_report' }]);

    // and the export again restores its own view of its days
    await importWith(consoleCsvParser, 'claude_api_tokens_2026_04.csv', csv);
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2000, '04-03': 3000 });
  });

  it('leaves what is stored between two files of one import alone', async () => {
    const header =
      'usage_date_utc,model_version,api_key,workspace,usage_type,context_window,usage_input_tokens_no_cache,usage_input_tokens_cache_write_5m,usage_input_tokens_cache_write_1h,usage_input_tokens_cache_read,usage_output_tokens,web_search_count,inference_geo,speed';
    const month = (m: string, input: number) =>
      `${header}\n2026-${m}-05,claude-sonnet-4-6,k,Default,standard,≤ 200k,${input},0,0,0,10,0,global,\n2026-${m}-20,claude-sonnet-4-6,k,Default,standard,≤ 200k,${input},0,0,0,10,0,global,\n`;
    await importWith(consoleCsvParser, 'claude_api_tokens_2026_02.csv', month('02', 2000));

    // January and March are selected together. Neither file says anything about February.
    const both = await importFiles(consoleCsvParser, [
      ['claude_api_tokens_2026_01.csv', month('01', 1000)],
      ['claude_api_tokens_2026_03.csv', month('03', 3000)],
    ]);
    expect(both.parsed.replaceRanges).toEqual([
      { start: '2026-01-05T00:00:00.000Z', end: '2026-01-21T00:00:00.000Z' },
      { start: '2026-03-05T00:00:00.000Z', end: '2026-03-21T00:00:00.000Z' },
    ]);
    expect(both.preview.replaced).toEqual({ usageRows: 0, costRows: 0, tokens: 0 });
    expect(both.result.replaced).toEqual({ usageRows: 0, costRows: 0 });
    expect(await rows(`SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'MM') AS month, sum(input_tokens)::int AS tokens FROM usage_records GROUP BY 1 ORDER BY 1`)).toEqual([
      { month: '01', tokens: 2000 },
      { month: '02', tokens: 4000 },
      { month: '03', tokens: 6000 },
    ]);
    expect(await count('import_batches')).toBe(2);

    // a later export of February alone still replaces February, and only February
    const again = await importWith(consoleCsvParser, 'claude_api_tokens_2026_02.csv', month('02', 2500));
    expect(again.result.replaced.usageRows).toBe(2);
    expect((await rows<{ tokens: number }>(`SELECT sum(input_tokens)::int AS tokens FROM usage_records`))[0].tokens).toBe(13_000);
  });

  it('pages of a legacy report that are imported with one page missing do not clear the days of that page', async () => {
    const week = (from: number, more: boolean) =>
      JSON.stringify({ data: [0, 1, 2].map((i) => bucket(from + i, [usageResult('claude-sonnet-4-6', 100)])), has_more: more, next_page: more ? 'page_next' : null });
    // the whole report was imported once
    await importFiles(apiUsageReportParser, [['p1.json', week(1, true)], ['p2.json', week(4, true)], ['p3.json', week(7, false)]]);
    expect(await count('usage_records')).toBe(9);

    // later the first and the last page are imported again without the middle one
    const partial = await importFiles(apiUsageReportParser, [['p1.json', week(1, true)], ['p3.json', week(7, false)]]);
    expect(partial.preview.replaced).toMatchObject({ usageRows: 0 });
    expect(partial.preview.warnings.map((w) => w.code)).toContain('more_pages_available');
    expect(await count('usage_records')).toBe(9);
    expect(await inputPerDay()).toMatchObject({ '04-04': 100, '04-05': 100, '04-06': 100 });
  });

  it('lets an hourly Console export of a day replace that day in a stored month export, although it lists only the hours with usage', async () => {
    const header =
      'usage_date_utc,model_version,api_key,workspace,usage_type,context_window,usage_input_tokens_no_cache,usage_input_tokens_cache_write_5m,usage_input_tokens_cache_write_1h,usage_input_tokens_cache_read,usage_output_tokens,web_search_count,inference_geo,speed';
    const line = (when: string, input: number) => `${when},claude-sonnet-4-6,k,Default,standard,≤ 200k,${input},0,0,0,10,0,global,`;
    const monthFile = [header, line('2026-04-03', 500), line('2026-04-04', 900), line('2026-04-05', 700), ''].join('\n');
    const dayFile = [header, line('2026-04-04 09:00', 300), line('2026-04-04 13:00', 400), line('2026-04-04 16:00', 250), ''].join('\n');

    await importWith(consoleCsvParser, 'claude_api_tokens_2026_04.csv', monthFile);
    const hourly = await importWith(consoleCsvParser, 'claude_api_tokens_2026_04_04.csv', dayFile);
    expect(hourly.parsed.replaceRanges).toEqual([{ start: '2026-04-04T00:00:00.000Z', end: '2026-04-05T00:00:00.000Z' }]);
    expect(hourly.result).toMatchObject({ replaced: { usageRows: 1 }, inserted: { usageRows: 3 } });
    // the day now holds what the hours add up to, and its neighbours are as they were
    expect(await inputPerDay()).toEqual({ '04-03': 500, '04-04': 950, '04-05': 700 });

    // the month export again: its daily total takes the place of the hours
    const monthly = await importWith(consoleCsvParser, 'claude_api_tokens_2026_04.csv', monthFile);
    expect(monthly.result).toMatchObject({ replaced: { usageRows: 3 }, inserted: { usageRows: 1 } });
    expect(await inputPerDay()).toEqual({ '04-03': 500, '04-04': 900, '04-05': 700 });
  });

  it('keeps usage without a model, with no model attached', async () => {
    const { preview } = await importWith(apiUsageReportParser, 'ungrouped.json', report(bucket(1, [usageResult(null, 1000)]), bucket(2, [usageResult(null, 2000)])));
    expect(preview.usageRows).toMatchObject({ total: 2, new: 2, withoutModel: 2 });
    expect(preview.missingFields).toEqual(['model', 'service_tier', 'speed']);
    expect(preview.warnings.map((w) => w.code)).toEqual(['model_not_grouped']);
    expect(await rows(`SELECT model_id, price_tier, input_tokens::int AS input FROM usage_records ORDER BY occurred_at`)).toEqual([
      { model_id: null, price_tier: 'standard', input: 1000 },
      { model_id: null, price_tier: 'standard', input: 2000 },
    ]);
  });
});

describe('API cost reports in the database', () => {
  const costResult = (amount: string, over: Record<string, unknown> = {}) => ({
    amount,
    currency: 'USD',
    context_window: null,
    cost_type: 'tokens',
    description: 'Claude Sonnet 4.6 Usage - Output Tokens',
    inference_geo: null,
    model: 'claude-sonnet-4-6',
    service_tier: 'standard',
    speed: null,
    token_type: 'output_tokens',
    workspace_id: null,
    ...over,
  });
  const costs = () =>
    rows(
      `SELECT to_char(r.occurred_at AT TIME ZONE 'UTC', 'MM-DD') AS day, m.model_key, r.cost_type, r.token_type, r.description, r.amount_usd::text AS amount_usd, r.bucket_seconds
         FROM reported_costs r LEFT JOIN model_catalog m ON m.id = r.model_id ORDER BY r.occurred_at, r.amount_usd`,
    );

  it('stores amounts as exact dollars', async () => {
    const { preview, result } = await importWith(
      apiCostReportParser,
      'cost.json',
      report(
        // "123.45" cents is $1.2345
        bucket(1, [costResult('123.45'), costResult('1000', { cost_type: 'web_search', description: 'Web Search Usage', model: null, token_type: null, service_tier: null })]),
        bucket(2, [costResult('0.01'), costResult('41280.000000', { token_type: 'cache_read_input_tokens', description: 'Claude Sonnet 4.6 Usage - Cache Read' })]),
      ),
    );
    expect(preview.costRows).toEqual({ total: 4, new: 4, duplicate: 0 });
    expect(result.inserted.costRows).toBe(4);
    expect(await costs()).toEqual([
      { day: '04-01', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'output_tokens', description: 'Claude Sonnet 4.6 Usage - Output Tokens', amount_usd: '1.23450000', bucket_seconds: 86400 },
      { day: '04-01', model_key: null, cost_type: 'web_search', token_type: null, description: 'Web Search Usage', amount_usd: '10.00000000', bucket_seconds: 86400 },
      { day: '04-02', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'output_tokens', description: 'Claude Sonnet 4.6 Usage - Output Tokens', amount_usd: '0.00010000', bucket_seconds: 86400 },
      { day: '04-02', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'cache_read_input_tokens', description: 'Claude Sonnet 4.6 Usage - Cache Read', amount_usd: '412.80000000', bucket_seconds: 86400 },
    ]);
    expect(await rows(`SELECT sum(amount_usd)::text AS total FROM reported_costs`)).toEqual([{ total: '424.03460000' }]);
    expect(await rows(`SELECT kind::text AS kind, label FROM data_sources`)).toEqual([{ kind: 'api_cost_report', label: 'Anthropic API cost report' }]);
    // cost is spend, not usage
    expect(await count('usage_records')).toBe(0);
  });

  it('keeps amounts smaller than a millionth of a dollar, so that many small rows add up to what the report says', async () => {
    // an hourly report of a month with small cache-read rows: 720 rows of 0.000049 cents each
    const hours = Array.from({ length: 720 }, (_, i) => {
      const start = Date.parse('2026-04-01T00:00:00Z') + i * 3_600_000;
      return {
        starting_at: new Date(start).toISOString(),
        ending_at: new Date(start + 3_600_000).toISOString(),
        group: { model: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'cache_read_input_tokens' },
        cost: { currency: 'USD', amount: '0.000049', list_amount: '0.000049', requests: 1 },
      };
    });
    const { parsed } = await importWith(apiCostReportParser, 'hourly-cost.json', JSON.stringify({ data: hours, has_more: false, next_page: null }));
    expect(parsed.stats.totalUsd).toBe('0.0003528');
    expect(await rows(`SELECT sum(amount_usd)::text AS total, count(*)::int AS n, min(amount_usd)::text AS smallest FROM reported_costs`)).toEqual([
      { total: '0.00035280', n: 720, smallest: '0.00000049' },
    ]);
  });

  it('stores the documented examples: the legacy report and the Analytics API rows', async () => {
    await importWith(apiCostReportParser, 'legacy.json', fixture('cost-report.doc-example.json'));
    // "123.78912" cents is $1.2378912: stored as reported, to the hundred-millionth of a dollar
    expect(await costs()).toEqual([
      { day: '08-01', model_key: 'claude-opus-5-5', cost_type: 'tokens', token_type: 'cache_creation.ephemeral_1h_input_tokens', description: 'Claude Opus 5.5 Usage - Input Tokens', amount_usd: '1.23789120', bucket_seconds: 86400 },
    ]);

    await importWith(apiCostReportParser, 'analytics.json', fixture('analytics-cost.json'));
    expect((await costs()).slice(1)).toEqual([
      { day: '09-01', model_key: 'claude-opus-5', cost_type: 'web_search', token_type: null, description: null, amount_usd: '12.50000000', bucket_seconds: 2592000 },
      { day: '09-01', model_key: 'claude-opus-5', cost_type: 'tokens', token_type: 'cache_read_input_tokens', description: null, amount_usd: '412.80000000', bucket_seconds: 2592000 },
      { day: '09-01', model_key: 'claude-opus-5', cost_type: 'tokens', token_type: 'output_tokens', description: null, amount_usd: '987.65432100', bucket_seconds: 2592000 },
    ]);
  });

  it('replaces restated days, and leaves usage reports alone', async () => {
    await importWith(apiUsageReportParser, 'usage.json', report(bucket(1, [usageResult('claude-sonnet-4-6', 1000)]), bucket(2, [usageResult('claude-sonnet-4-6', 2000)])));
    await importWith(apiCostReportParser, 'cost-1.json', report(bucket(1, [costResult('100')]), bucket(2, [costResult('200')]), bucket(3, [costResult('300')])));
    const total = async () => (await rows<{ total: string }>(`SELECT sum(amount_usd)::text AS total FROM reported_costs`))[0].total;
    expect(await total()).toBe('6.00000000');

    const revised = await importWith(apiCostReportParser, 'cost-2.json', report(bucket(2, [costResult('250')]), bucket(3, [costResult('300'), costResult('50', { token_type: 'uncached_input_tokens' })]), bucket(4, [])));
    // 2 April is stated differently and replaced; the 3.00 of 3 April is stated as stored and stays
    expect(revised.preview.replaced).toMatchObject({ usageRows: 0, costRows: 1 });
    expect(revised.preview.costRows).toMatchObject({ total: 3, new: 2, duplicate: 1 });
    expect(revised.result.replaced).toEqual({ usageRows: 0, costRows: 1 });
    // 1.00 + 2.50 + 3.00 + 0.50
    expect(await total()).toBe('7.00000000');
    expect(await count('reported_costs')).toBe(4);
    // the two kinds of report are separate sources: the usage rows are untouched
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2000 });
    expect(await rows(`SELECT kind::text AS kind FROM data_sources ORDER BY 1`)).toEqual([{ kind: 'api_cost_report' }, { kind: 'api_usage_report' }]);
  });

  it('stores a Console cost export under the cost source, replacing the API report of the same days', async () => {
    await importWith(apiCostReportParser, 'cost.json', report(bucket(1, [costResult('100')])));
    const csv =
      'usage_date_utc,model,workspace,api_key,usage_type,context_window,token_type,cost_usd,cost_type,inference_geo,speed\n' +
      '2026-04-01,Claude Sonnet 4.6,Default,k,message,≤ 200k,output,0.70,token,global,\n' +
      '2026-04-01,Claude Sonnet 4.6,Default,k,message,≤ 200k,output,0.35,token,global,\n' +
      '2026-04-01,--,Default,k,--,--,--,0.02,web_search,--,--\n';
    const second = await importWith(consoleCsvParser, 'claude_api_cost_2026_04_01_to_2026_04_01.csv', csv);
    expect(second.result.replaced.costRows).toBe(1);
    expect(await costs()).toEqual([
      { day: '04-01', model_key: null, cost_type: 'web_search', token_type: null, description: null, amount_usd: '0.02000000', bucket_seconds: 86400 },
      { day: '04-01', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'output_tokens', description: null, amount_usd: '0.35000000', bucket_seconds: 86400 },
      { day: '04-01', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'output_tokens', description: null, amount_usd: '0.70000000', bucket_seconds: 86400 },
    ]);
    expect(await count('data_sources')).toBe(1);
  });
});
