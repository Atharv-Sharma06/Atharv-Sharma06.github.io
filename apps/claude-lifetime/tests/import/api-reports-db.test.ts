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

async function importWith(parser: ImportParser, name: string, content: string | Uint8Array, ctx: ParseContext = {}) {
  await resetStaging(t.db);
  const writer = new StagingWriter(t.db);
  const parsed = await parser.parse([fileOf(name, content)], writer, ctx);
  await writer.finish();
  const preview = await previewImport(t.db, t.userId, parsed);
  const result = await commitImport(t.db, t.userId, parsed);
  return { parsed, preview, result };
}

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
    expect(second.parsed.replaceRange).toEqual({ start: '2026-04-04T00:00:00.000Z', end: '2026-04-08T00:00:00.000Z' });
    // three stored rows (4 April, and two of 5 April) fall into the restated range
    expect(second.preview.replaced).toEqual({ usageRows: 3, costRows: 0, tokens: Math.round((4000 + 5000 + 700) * 1.1) });
    expect(second.preview.usageRows).toMatchObject({ total: 3, new: 3, duplicate: 0 });
    expect(second.preview.nothingNew).toBe(false);
    expect(second.result.replaced).toEqual({ usageRows: 3, costRows: 0 });
    expect(second.result.inserted.usageRows).toBe(3);

    // days 1-3 as first reported, days 4-6 as restated: the totals are the revised values
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2500, '04-03': 3000, '04-04': 4400, '04-05': 5000, '04-06': 6000 });
    expect(await count('usage_records')).toBe(7);
    expect(await count('data_sources')).toBe(1);
    expect(await count('import_batches')).toBe(2);

    // importing the revised report once more changes nothing
    const third = await importWith(apiUsageReportParser, 'april-4-7.json', revised);
    expect(third.preview.previousImport?.batchId).toBe(second.result.batchId);
    expect(third.result.replaced.usageRows).toBe(3);
    expect(await inputPerDay()).toEqual({ '04-01': 1000, '04-02': 2500, '04-03': 3000, '04-04': 4400, '04-05': 5000, '04-06': 6000 });
    expect(await count('usage_records')).toBe(7);
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
    expect(third.parsed.replaceRange).toEqual({ start: '2026-04-02T00:00:00.000Z', end: '2026-04-04T00:00:00.000Z' });
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
      { day: '04-01', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'output_tokens', description: 'Claude Sonnet 4.6 Usage - Output Tokens', amount_usd: '1.234500', bucket_seconds: 86400 },
      { day: '04-01', model_key: null, cost_type: 'web_search', token_type: null, description: 'Web Search Usage', amount_usd: '10.000000', bucket_seconds: 86400 },
      { day: '04-02', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'output_tokens', description: 'Claude Sonnet 4.6 Usage - Output Tokens', amount_usd: '0.000100', bucket_seconds: 86400 },
      { day: '04-02', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'cache_read_input_tokens', description: 'Claude Sonnet 4.6 Usage - Cache Read', amount_usd: '412.800000', bucket_seconds: 86400 },
    ]);
    expect(await rows(`SELECT sum(amount_usd)::text AS total FROM reported_costs`)).toEqual([{ total: '424.034600' }]);
    expect(await rows(`SELECT kind::text AS kind, label FROM data_sources`)).toEqual([{ kind: 'api_cost_report', label: 'Anthropic API cost report' }]);
    // cost is spend, not usage
    expect(await count('usage_records')).toBe(0);
  });

  it('stores the documented examples: the legacy report and the Analytics API rows', async () => {
    await importWith(apiCostReportParser, 'legacy.json', fixture('cost-report.doc-example.json'));
    // "123.78912" cents is $1.2378912; the amount column keeps six decimals
    expect(await costs()).toEqual([
      { day: '08-01', model_key: 'claude-opus-5-5', cost_type: 'tokens', token_type: 'cache_creation.ephemeral_1h_input_tokens', description: 'Claude Opus 5.5 Usage - Input Tokens', amount_usd: '1.237891', bucket_seconds: 86400 },
    ]);

    await importWith(apiCostReportParser, 'analytics.json', fixture('analytics-cost.json'));
    expect((await costs()).slice(1)).toEqual([
      { day: '09-01', model_key: 'claude-opus-5', cost_type: 'web_search', token_type: null, description: null, amount_usd: '12.500000', bucket_seconds: 2592000 },
      { day: '09-01', model_key: 'claude-opus-5', cost_type: 'tokens', token_type: 'cache_read_input_tokens', description: null, amount_usd: '412.800000', bucket_seconds: 2592000 },
      { day: '09-01', model_key: 'claude-opus-5', cost_type: 'tokens', token_type: 'output_tokens', description: null, amount_usd: '987.654321', bucket_seconds: 2592000 },
    ]);
  });

  it('replaces restated days, and leaves usage reports alone', async () => {
    await importWith(apiUsageReportParser, 'usage.json', report(bucket(1, [usageResult('claude-sonnet-4-6', 1000)]), bucket(2, [usageResult('claude-sonnet-4-6', 2000)])));
    await importWith(apiCostReportParser, 'cost-1.json', report(bucket(1, [costResult('100')]), bucket(2, [costResult('200')]), bucket(3, [costResult('300')])));
    const total = async () => (await rows<{ total: string }>(`SELECT sum(amount_usd)::text AS total FROM reported_costs`))[0].total;
    expect(await total()).toBe('6.000000');

    const revised = await importWith(apiCostReportParser, 'cost-2.json', report(bucket(2, [costResult('250')]), bucket(3, [costResult('300'), costResult('50', { token_type: 'uncached_input_tokens' })]), bucket(4, [])));
    expect(revised.preview.replaced).toMatchObject({ usageRows: 0, costRows: 2 });
    expect(revised.result.replaced).toEqual({ usageRows: 0, costRows: 2 });
    // 1.00 + 2.50 + 3.00 + 0.50
    expect(await total()).toBe('7.000000');
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
      { day: '04-01', model_key: null, cost_type: 'web_search', token_type: null, description: null, amount_usd: '0.020000', bucket_seconds: 86400 },
      { day: '04-01', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'output_tokens', description: null, amount_usd: '0.350000', bucket_seconds: 86400 },
      { day: '04-01', model_key: 'claude-sonnet-4-6', cost_type: 'tokens', token_type: 'output_tokens', description: null, amount_usd: '0.700000', bucket_seconds: 86400 },
    ]);
    expect(await count('data_sources')).toBe(1);
  });
});
