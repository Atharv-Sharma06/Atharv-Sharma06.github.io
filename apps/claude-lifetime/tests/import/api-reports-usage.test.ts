import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParseContext, StagedUsage } from '@/core/types';
import { apiUsageReportParser, detectApiReportFormat, priceTierFor } from '@/import/api-reports';
import { detectJsonFormat } from '@/import/generic';
import { collectingSink, fileOf } from '../helpers/sink';

/**
 * Fixtures (tests/fixtures/api-reports, all synthetic):
 *  usage-report.doc-example.json      response example of GET /v1/organizations/usage_report/messages,
 *                                     copied from Anthropic's API reference
 *  analytics-usage.doc-example.json   response example of GET /v1/organizations/analytics/usage,
 *                                     copied from the Usage and Cost Analytics API guide
 *  usage-report.daily.page-1/2.json   two pages of a daily legacy report; shape per the reference, values invented
 *  analytics-usage.daily.json         daily Analytics API rows grouped by model and product; values invented
 */
const fixture = (name: string) => readFileSync(new URL(`../fixtures/api-reports/${name}`, import.meta.url));
const json = (name: string) => JSON.parse(fixture(name).toString('utf8'));

async function parse(content: string | Uint8Array | Array<string | Uint8Array>, ctx: ParseContext = {}) {
  const { out, sink } = collectingSink();
  const files = (Array.isArray(content) ? content : [content]).map((c, i) => fileOf(`report-${i + 1}.json`, c));
  const parsed = await apiUsageReportParser.parse(files, sink, ctx);
  return { parsed, out };
}

const codeOf = (promise: Promise<unknown>) => promise.then(() => 'no error', (e) => (e as { code?: string }).code ?? String(e));

/** A legacy result with every dimension null, as when the report is not grouped at all. */
const result = (over: Record<string, unknown> = {}) => ({
  uncached_input_tokens: 100,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_read_input_tokens: 0,
  output_tokens: 10,
  server_tool_use: { web_search_requests: 0 },
  account_id: null,
  api_key_id: null,
  context_window: null,
  inference_geo: null,
  model: null,
  service_account_id: null,
  service_tier: null,
  speed: null,
  workspace_id: null,
  ...over,
});

const day = (d: number) => `2026-04-${String(d).padStart(2, '0')}T00:00:00Z`;
const bucket = (d: number, results: unknown[]) => ({ starting_at: day(d), ending_at: day(d + 1), results });
const page = (data: unknown[], more = false) => ({ data, has_more: more, next_page: more ? 'page_abc' : null });

/** An Analytics API row. */
const row = (start: string, end: string, group: Record<string, unknown>, usage: Record<string, unknown> = {}) => ({
  starting_at: start,
  ending_at: end,
  group: { product: null, model: null, context_window: null, inference_geo: null, speed: null, workspace_id: null, service_tier: null, actor: null, actor_type: null, api_key_id: null, ...group },
  usage: {
    uncached_input_tokens: 100,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_read_input_tokens: 0,
    output_tokens: 10,
    total_tokens: 110,
    server_tool_use: { web_search_requests: 0 },
    requests: 1,
    ...usage,
  },
});

describe('API usage report: the documented examples', () => {
  it('parses the legacy usage report example', async () => {
    const bytes = fixture('usage-report.doc-example.json');
    const { parsed, out } = await parse(bytes);

    expect(out.usage).toEqual<StagedUsage[]>([
      {
        conversationKey: null,
        modelKey: 'claude-opus-5-5',
        occurredAt: '2025-08-01T00:00:00.000Z',
        bucketSeconds: 86400,
        priceTier: 'standard',
        inputTokens: 1500,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        requestCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        webSearchRequests: 10,
        confidence: 'exact',
        // nine dimensions make a long key, which is stored as its hash
        dedupKey: expect.stringMatching(/^api:2025-08-01T00:00:00\.000Z:86400:#[0-9a-f]{64}$/),
      },
    ]);
    expect(out.models).toEqual([]);
    expect(out.costs).toEqual([]);

    expect(parsed).toMatchObject({
      format: 'anthropic/usage-report',
      parserVersion: 'api-reports-1',
      source: { kind: 'api_usage_report', label: 'Anthropic API usage report', externalRef: '' },
      fileName: 'report-1.json',
      fileSize: bytes.length,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      recordsSeen: 1,
      recordsSkipped: 0,
      missingFields: [],
      replaceRange: { start: '2025-08-01T00:00:00.000Z', end: '2025-08-02T00:00:00.000Z' },
    });
    expect(parsed.stats).toMatchObject({ api: 'usage-cost', pages: 1, timeBuckets: 1, emptyBuckets: 0, rows: 1, inputTokens: 1500, outputTokens: 500 });
    // the example says has_more: true and the next page is not in the file
    expect(parsed.warnings.map((w) => w.code)).toEqual(['more_pages_available']);
  });

  it('parses the Analytics API usage example', async () => {
    const { parsed, out } = await parse(fixture('analytics-usage.doc-example.json'));

    expect(out.usage).toEqual<StagedUsage[]>([
      {
        conversationKey: null,
        modelKey: 'claude-sonnet-5',
        occurredAt: '2026-09-03T00:00:00.000Z',
        bucketSeconds: 86400,
        priceTier: 'standard',
        inputTokens: 1284500,
        outputTokens: 891000,
        cacheReadTokens: 3200000,
        cacheWrite5mTokens: 215300,
        cacheWrite1hTokens: 0,
        requestCount: 4210,
        userMessageCount: 0,
        assistantMessageCount: 0,
        webSearchRequests: 12,
        confidence: 'exact',
        dedupKey: 'api:2026-09-03T00:00:00.000Z:86400:model=claude-sonnet-5',
      },
    ]);
    expect(parsed).toMatchObject({
      format: 'anthropic/analytics-usage',
      source: { kind: 'api_usage_report', label: 'Anthropic API usage report', externalRef: '' },
      recordsSeen: 1,
      recordsSkipped: 0,
      replaceRange: { start: '2026-09-03T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z' },
    });
    expect(parsed.stats).toMatchObject({ api: 'analytics', pages: 1, rows: 1, groupedBy: 'model', requests: 4210, dataRefreshedAt: '2026-09-18T16:02:11Z' });
    // grouped by model only: the tiers cannot be told apart, and the example has a next page
    expect(parsed.missingFields).toEqual(['service_tier', 'speed']);
    expect(parsed.warnings.map((w) => w.code)).toEqual(['tier_not_grouped', 'more_pages_available']);
  });

  it('is recognised by the detection helpers', () => {
    expect(detectApiReportFormat(json('usage-report.doc-example.json'))).toBe('anthropic/usage-report');
    expect(detectApiReportFormat(json('analytics-usage.doc-example.json'))).toBe('anthropic/analytics-usage');
    expect(detectJsonFormat([json('usage-report.daily.page-1.json'), json('usage-report.daily.page-2.json')])).toBe('anthropic/usage-report');
  });
});

describe('API usage report: several pages', () => {
  const page1 = fixture('usage-report.daily.page-1.json').toString('utf8');
  const page2 = fixture('usage-report.daily.page-2.json').toString('utf8');
  const compact = (text: string) => JSON.stringify(JSON.parse(text));

  const expectedRows = [
    ['2026-03-01T00:00:00.000Z', 'claude-sonnet-4-6', 'standard', 120000, 45000, 900000, 30000, 4000, 3],
    ['2026-03-01T00:00:00.000Z', 'claude-haiku-4-5', 'batch', 500000, 80000, 0, 0, 0, 0],
    ['2026-03-03T00:00:00.000Z', 'claude-sonnet-4-6', 'standard', 60000, 20000, 100000, 0, 0, 0],
    ['2026-03-04T00:00:00.000Z', 'claude-opus-4-8', 'fast', 7000, 3000, 0, 0, 0, 0],
    ['2026-03-06T00:00:00.000Z', 'claude-sonnet-4-5', 'long_context', 250000, 9000, 0, 0, 0, 0],
    ['2026-03-06T00:00:00.000Z', 'claude-nova-9', 'priority', 1000, 200, 0, 0, 0, 0],
  ];
  const flat = (rows: StagedUsage[]) =>
    rows.map((u) => [u.occurredAt, u.modelKey, u.priceTier, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWrite5mTokens, u.cacheWrite1hTokens, u.webSearchRequests]);

  it('combines pages given as a JSON array, as JSON Lines, or as separate files', async () => {
    const asArray = await parse(`[${page1},${page2}]`);
    const asLines = await parse(`${compact(page1)}\n${compact(page2)}\n`);
    const asLinesCrLf = await parse(`${compact(page1)}\r\n\r\n${compact(page2)}`);
    const asFiles = await parse([page1, page2]);

    for (const { parsed, out } of [asArray, asLines, asLinesCrLf, asFiles]) {
      expect(flat(out.usage)).toEqual(expectedRows);
      expect(out.usage.every((u) => u.bucketSeconds === 86400 && u.confidence === 'exact' && u.conversationKey === null && u.requestCount === 0)).toBe(true);
      expect(parsed.format).toBe('anthropic/usage-report');
      expect(parsed.recordsSeen).toBe(6);
      expect(parsed.recordsSkipped).toBe(0);
      expect(parsed.stats).toMatchObject({ pages: 2, timeBuckets: 7, emptyBuckets: 3, rows: 6 });
      // the last page says has_more: false, so nothing is missing
      expect(parsed.warnings.map((w) => w.code)).not.toContain('more_pages_available');
      // 1 March up to and including the empty bucket of 7 March
      expect(parsed.replaceRange).toEqual({ start: '2026-03-01T00:00:00.000Z', end: '2026-03-08T00:00:00.000Z' });
    }
    expect(asArray.parsed.stats.layout).toBe('array');
    expect(asLines.parsed.stats.layout).toBe('lines');
    expect(asFiles.parsed).toMatchObject({ fileName: '2 files', fileSize: Buffer.byteLength(page1) + Buffer.byteLength(page2) });
    expect(asFiles.parsed.contentHash).toBe(createHash('sha256').update(page1).update(page2).digest('hex'));

    // every row has its own key, and the keys do not depend on how the pages were saved
    const keys = asArray.out.usage.map((u) => u.dedupKey);
    expect(new Set(keys).size).toBe(6);
    expect(asLines.out.usage.map((u) => u.dedupKey)).toEqual(keys);
    expect(asFiles.out.usage.map((u) => u.dedupKey)).toEqual(keys);
  });

  it('keeps an unknown model identifier verbatim and announces it once', async () => {
    const { out } = await parse(`[${page1},${page2}]`);
    expect(out.models).toEqual([{ key: 'claude-nova-9', displayName: 'claude-nova-9-20270101', family: 'other', tokenizerFamily: 'unknown' }]);

    const twice = await parse(
      JSON.stringify(
        page([
          bucket(1, [result({ model: 'claude-sonnet-99' }), result({ model: 'Claude-Sonnet-99-20300101', service_tier: 'batch' })]),
          bucket(2, [result({ model: 'claude-sonnet-99' }), result({ model: 'my-finetune' })]),
        ]),
      ),
    );
    expect(twice.out.usage.map((u) => u.modelKey)).toEqual(['claude-sonnet-99', 'claude-sonnet-99', 'claude-sonnet-99', 'my-finetune']);
    expect(twice.out.models).toEqual([
      { key: 'claude-sonnet-99', displayName: 'claude-sonnet-99', family: 'sonnet', tokenizerFamily: 'unknown' },
      { key: 'my-finetune', displayName: 'my-finetune', family: 'other', tokenizerFamily: 'unknown' },
    ]);
    expect(twice.parsed.stats.unknownModels).toBe(2);
  });

  it('warns when the file stops at a page that has more', async () => {
    const { parsed } = await parse(page1);
    const warning = parsed.warnings.find((w) => w.code === 'more_pages_available');
    expect(warning?.message).toMatch(/next_page/);
    // the range ends with the last bucket that is in the file
    expect(parsed.replaceRange).toEqual({ start: '2026-03-01T00:00:00.000Z', end: '2026-03-04T00:00:00.000Z' });
  });

  it('counts a page that is in the input twice only once', async () => {
    const { parsed, out } = await parse(`[${page1},${page2},${page1}]`);
    expect(flat(out.usage)).toEqual(expectedRows);
    expect(parsed.recordsSeen).toBe(9);
    expect(parsed.recordsSkipped).toBe(3);
    expect(parsed.warnings.find((w) => w.code === 'duplicate_rows')).toMatchObject({ count: 3 });
  });

  it('accepts rows and buckets saved without the page around them', async () => {
    const buckets = [...JSON.parse(page1).data, ...JSON.parse(page2).data];
    const asList = await parse(JSON.stringify(buckets));
    const asLines = await parse(buckets.map((b) => JSON.stringify(b)).join('\n'));
    expect(flat(asList.out.usage)).toEqual(expectedRows);
    expect(flat(asLines.out.usage)).toEqual(expectedRows);
    expect(asList.parsed.replaceRange).toEqual({ start: '2026-03-01T00:00:00.000Z', end: '2026-03-08T00:00:00.000Z' });
    expect(asList.parsed.stats).toMatchObject({ pages: 0, timeBuckets: 7, emptyBuckets: 3 });

    const rows = json('analytics-usage.daily.json').data as unknown[];
    const analytics = await parse(rows.map((r) => JSON.stringify(r)).join('\n'));
    expect(analytics.parsed.format).toBe('anthropic/analytics-usage');
    expect(analytics.out.usage).toHaveLength(4);
  });

  it('reads pretty-printed, compact and UTF-16 files alike', async () => {
    const reference = flat((await parse(page1)).out.usage);
    expect(flat((await parse(compact(page1))).out.usage)).toEqual(reference);
    expect(flat((await parse(`﻿${page1}`)).out.usage)).toEqual(reference);
    // what `curl … > usage.json` produces in Windows PowerShell 5
    const utf16 = new Uint8Array(2 + page1.length * 2);
    const view = new DataView(utf16.buffer);
    view.setUint16(0, 0xfeff, true);
    for (let i = 0; i < page1.length; i++) view.setUint16(2 + i * 2, page1.charCodeAt(i), true);
    expect(flat((await parse(utf16)).out.usage)).toEqual(reference);
  });
});

describe('API usage report: price tiers', () => {
  it('maps speed, service tier and context window to a tier', () => {
    const tier = (modelKey: string | null, serviceTier: unknown, speed: unknown, contextWindow: unknown) => priceTierFor({ modelKey, serviceTier, speed, contextWindow });
    const table: Array<[string | null, unknown, unknown, unknown, string]> = [
      // model, service_tier, speed, context_window -> tier
      ['claude-opus-5-5', 'standard', 'standard', '0-200k', 'standard'],
      ['claude-opus-5-5', null, null, null, 'standard'],
      [null, null, null, null, 'standard'],
      ['claude-opus-5-5', 'standard', 'fast', '0-200k', 'fast'],
      ['claude-opus-5-5', 'batch', 'standard', '0-200k', 'batch'],
      ['claude-opus-5-5', 'priority', 'standard', null, 'priority'],
      ['claude-opus-5-5', 'priority_on_demand', null, null, 'priority'],
      ['claude-opus-5-5', 'flex', null, null, 'flex'],
      ['claude-opus-5-5', 'flex_discount', null, null, 'flex'],
      // fast mode wins over the service tier, the service tier over the context window
      ['claude-opus-5-5', 'batch', 'fast', '200k-1M', 'fast'],
      ['claude-sonnet-4-5', 'batch', 'standard', '200k-1M', 'batch'],
      ['claude-sonnet-4-5', 'standard', 'fast', '200k-1M', 'fast'],
      // the long-context premium existed on Claude Sonnet 4 and 4.5 only
      ['claude-sonnet-4', 'standard', 'standard', '200k-1M', 'long_context'],
      ['claude-sonnet-4-5', 'standard', 'standard', '200k-1M', 'long_context'],
      ['claude-sonnet-4-5', null, null, '200k-1M', 'long_context'],
      ['claude-sonnet-4-5', 'standard', 'standard', '0-200k', 'standard'],
      ['claude-sonnet-4-5', 'standard', 'standard', null, 'standard'],
      ['claude-sonnet-4-6', 'standard', 'standard', '200k-1M', 'standard'],
      ['claude-opus-4-8', 'standard', 'standard', '200k-1M', 'standard'],
      // Haiku 5.5's threshold is 100k tokens, which the two buckets cannot show
      ['claude-haiku-5-5', 'standard', 'standard', '200k-1M', 'standard'],
      ['claude-haiku-5-5', 'standard', 'standard', '0-200k', 'standard'],
      [null, 'standard', 'standard', '200k-1M', 'standard'],
      // the Console's CSV export spells the windows differently
      ['claude-sonnet-4', 'standard', '', '200k - 1M', 'long_context'],
      ['claude-sonnet-4', 'standard', '', '≤ 200k', 'standard'],
      ['claude-sonnet-4', 'Batch', 'Standard', '≤ 200k', 'batch'],
    ];
    for (const [model, serviceTier, speed, contextWindow, expected] of table) {
      expect(tier(model, serviceTier, speed, contextWindow), JSON.stringify([model, serviceTier, speed, contextWindow])).toBe(expected);
    }
  });

  it('applies the table to report rows of both shapes, resolving dated model ids first', async () => {
    const legacy = await parse(
      JSON.stringify(
        page([
          bucket(1, [
            result({ model: 'claude-sonnet-4-20250514', service_tier: 'standard', speed: 'standard', context_window: '200k-1M' }),
            result({ model: 'claude-sonnet-4-20250514', service_tier: 'standard', speed: 'standard', context_window: '0-200k' }),
            result({ model: 'claude-opus-5-5', service_tier: 'flex_discount', speed: 'standard', context_window: '0-200k' }),
            result({ model: 'claude-opus-5-5', service_tier: 'priority_on_demand', speed: 'standard', context_window: '0-200k' }),
            result({ model: 'claude-opus-5-5', service_tier: 'batch', speed: 'standard', context_window: '0-200k' }),
            result({ model: 'claude-opus-5-5', service_tier: 'standard', speed: 'fast', context_window: '0-200k' }),
          ]),
        ]),
      ),
    );
    expect(legacy.out.usage.map((u) => [u.modelKey, u.priceTier])).toEqual([
      ['claude-sonnet-4', 'long_context'],
      ['claude-sonnet-4', 'standard'],
      ['claude-opus-5-5', 'flex'],
      ['claude-opus-5-5', 'priority'],
      ['claude-opus-5-5', 'batch'],
      ['claude-opus-5-5', 'fast'],
    ]);
    expect(legacy.parsed.missingFields).toEqual([]);
    expect(legacy.parsed.warnings).toEqual([]);

    const analytics = await parse(
      JSON.stringify(
        page([
          row(day(1), day(2), { model: 'claude-sonnet-4-5-20250929', context_window: '200k-1M', service_tier: 'standard', speed: 'standard' }),
          row(day(1), day(2), { model: 'claude-fable-5-2', context_window: '200k-1M', service_tier: 'batch', speed: 'standard' }),
          row(day(1), day(2), { model: 'claude-fable-5-2', context_window: '0-200k', service_tier: null, speed: 'fast' }),
        ]),
      ),
    );
    expect(analytics.out.usage.map((u) => [u.modelKey, u.priceTier])).toEqual([
      ['claude-sonnet-4-5', 'long_context'],
      ['claude-fable-5-2', 'batch'],
      ['claude-fable-5-2', 'fast'],
    ]);
  });
});

describe('API usage report: what a report lacks', () => {
  it('keeps rows that are not grouped by model, without a model, and says how to fix it', async () => {
    const { parsed, out } = await parse(JSON.stringify(page([bucket(1, [result({ uncached_input_tokens: 5000 })]), bucket(2, [result()])])));
    expect(out.usage.map((u) => [u.modelKey, u.priceTier, u.inputTokens])).toEqual([
      [null, 'standard', 5000],
      [null, 'standard', 100],
    ]);
    expect(out.usage[0].dedupKey).toBe('api:2026-04-01T00:00:00.000Z:86400:*');
    expect(out.models).toEqual([]);
    expect(parsed.missingFields).toEqual(['model', 'service_tier', 'speed']);
    const warning = parsed.warnings.find((w) => w.code === 'model_not_grouped');
    expect(warning).toMatchObject({ count: 2 });
    expect(warning?.message).toMatch(/group_by\[\]=model/);
    expect(warning?.message).toMatch(/no price can be applied/);
    // prices cannot be applied at all, so the remark about tiers would only be noise
    expect(parsed.warnings.map((w) => w.code)).toEqual(['model_not_grouped']);
    expect(parsed.stats.groupedBy).toBe('');
  });

  it('flags missing tier dimensions only where they matter', async () => {
    const onlyModel = await parse(JSON.stringify(page([bucket(1, [result({ model: 'claude-opus-5-5' })])])));
    expect(onlyModel.parsed.missingFields).toEqual(['service_tier', 'speed']);
    expect(onlyModel.parsed.warnings.find((w) => w.code === 'tier_not_grouped')?.message).toMatch(/group_by\[\]=service_tier&group_by\[\]=speed/);

    // the context window matters for the two models that had a long-context premium
    const sonnet = await parse(JSON.stringify(page([bucket(1, [result({ model: 'claude-sonnet-4-5', service_tier: 'standard', speed: 'standard' })])])));
    expect(sonnet.parsed.missingFields).toEqual(['context_window']);
    const opus = await parse(JSON.stringify(page([bucket(1, [result({ model: 'claude-opus-5-5', service_tier: 'standard', speed: 'standard' })])])));
    expect(opus.parsed.missingFields).toEqual([]);
    expect(opus.parsed.warnings).toEqual([]);
  });

  it('extends the replaced range over empty buckets at both ends', async () => {
    const { parsed, out } = await parse(
      JSON.stringify(page([bucket(1, []), bucket(2, []), bucket(3, [result({ model: 'claude-opus-5-5', service_tier: 'standard', speed: 'standard' })]), bucket(4, []), bucket(5, [])])),
    );
    expect(out.usage.map((u) => u.occurredAt)).toEqual(['2026-04-03T00:00:00.000Z']);
    expect(parsed.replaceRange).toEqual({ start: '2026-04-01T00:00:00.000Z', end: '2026-04-06T00:00:00.000Z' });
    expect(parsed.stats).toMatchObject({ timeBuckets: 5, emptyBuckets: 4 });
  });

  it('imports a report without time buckets and warns that it is attributed to the start of the range', async () => {
    const whole = page([
      row('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', { model: 'claude-opus-5', service_tier: 'standard', speed: 'standard' }, { uncached_input_tokens: 9_000_000, total_tokens: 9_000_010 }),
      row('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', { model: 'claude-sonnet-5', service_tier: 'standard', speed: 'standard' }),
    ]);
    const { parsed, out } = await parse(JSON.stringify(whole));
    expect(out.usage.map((u) => [u.occurredAt, u.bucketSeconds, u.modelKey, u.inputTokens])).toEqual([
      ['2026-09-01T00:00:00.000Z', 30 * 86400, 'claude-opus-5', 9_000_000],
      ['2026-09-01T00:00:00.000Z', 30 * 86400, 'claude-sonnet-5', 100],
    ]);
    expect(parsed.replaceRange).toEqual({ start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' });
    const warning = parsed.warnings.find((w) => w.code === 'no_time_buckets');
    expect(warning).toMatchObject({ count: 2, sample: '2026-09-01 to 2026-10-01' });
    expect(warning?.message).toMatch(/start of the range/);
    expect(warning?.message).toMatch(/time_bucket_width=1d/);

    // minute, hour and day buckets are what the APIs offer: no warning
    for (const [end, seconds] of [['2026-09-01T00:01:00Z', 60], ['2026-09-01T01:00:00Z', 3600], ['2026-09-02T00:00:00Z', 86400]] as const) {
      const bucketed = await parse(JSON.stringify(page([row('2026-09-01T00:00:00Z', end, { model: 'claude-opus-5', service_tier: 'standard', speed: 'standard' })])));
      expect(bucketed.out.usage[0].bucketSeconds).toBe(seconds);
      expect(bucketed.parsed.warnings).toEqual([]);
    }
  });

  it('warns that Claude Code usage may also be in imported transcripts', async () => {
    const { parsed, out } = await parse(fixture('analytics-usage.daily.json'));
    expect(out.usage.map((u) => [u.occurredAt.slice(0, 10), u.modelKey, u.requestCount])).toEqual([
      ['2026-09-01', 'claude-sonnet-5', 310],
      ['2026-09-01', 'claude-haiku-5-5', 77],
      ['2026-09-02', 'claude-opus-5', 45],
      ['2026-09-02', null, 3],
    ]);
    const overlap = parsed.warnings.find((w) => w.code === 'possible_overlap_claude_code');
    expect(overlap).toMatchObject({ count: 2 });
    expect(overlap?.message).toMatch(/Claude Code transcripts/);
    // Haiku 5.5's 100k price threshold cannot be seen in a report
    expect(parsed.warnings.find((w) => w.code === 'haiku_long_context_unknown')).toMatchObject({ count: 1 });
    expect(parsed.stats.groupedBy).toBe('model, product');
    // one row has no model (the report is grouped by model all the same)
    expect(parsed.missingFields).not.toContain('model');
    expect(parsed.warnings.map((w) => w.code)).not.toContain('more_pages_available');
  });

  it('notes US-only inference and totals that do not add up', async () => {
    const { parsed, out } = await parse(
      JSON.stringify(
        page([
          row(day(1), day(2), { model: 'claude-opus-5', service_tier: 'standard', speed: 'standard', inference_geo: 'us' }),
          row(day(2), day(3), { model: 'claude-opus-5', service_tier: 'standard', speed: 'standard', inference_geo: 'global' }, { total_tokens: 500 }),
        ]),
      ),
    );
    expect(out.usage).toHaveLength(2);
    expect(parsed.warnings.find((w) => w.code === 'us_inference_premium')).toMatchObject({ count: 1 });
    expect(parsed.warnings.find((w) => w.code === 'total_mismatch')).toMatchObject({ count: 1 });
    expect(parsed.recordsSkipped).toBe(0);
  });
});

describe('API usage report: deduplication keys', () => {
  it('builds the key from the bucket and from every dimension', async () => {
    const base = { model: 'claude-opus-5', service_tier: 'standard', speed: 'standard' };
    const variants: Array<Record<string, unknown>> = [
      base,
      { ...base, model: 'claude-sonnet-5' },
      { ...base, service_tier: 'batch' },
      { ...base, speed: 'fast' },
      { ...base, context_window: '0-200k' },
      { ...base, inference_geo: 'us' },
      { ...base, workspace_id: 'wrkspc_01' },
      { ...base, api_key_id: 'apikey_01' },
      { ...base, product: 'claude_code' },
      { ...base, actor_type: 'user_actor' },
      { ...base, actor: { type: 'user_actor', user_id: 'user_01' } },
      { ...base, actor: { type: 'user_actor', user_id: 'user_02' } },
      { ...base, some_future_dimension: 'x' },
    ];
    const { out } = await parse(JSON.stringify(page(variants.map((g) => row(day(1), day(2), g)))));
    const keys = out.usage.map((u) => u.dedupKey);
    expect(new Set(keys).size).toBe(variants.length);
    expect(keys[0]).toBe('api:2026-04-01T00:00:00.000Z:86400:model=claude-opus-5|service_tier=standard|speed=standard');
    // an actor is an object that may name a person: it is only ever part of a hash
    expect(keys[10]).toMatch(/^api:2026-04-01T00:00:00\.000Z:86400:#[0-9a-f]{64}$/);
    expect(keys.join(' ')).not.toContain('user_01');

    // same dimensions, other bucket or other width
    const other = await parse(JSON.stringify(page([row(day(2), day(3), base), row(day(4), '2026-04-04T01:00:00Z', base)])));
    expect(other.out.usage.map((u) => u.dedupKey)).toEqual([
      'api:2026-04-02T00:00:00.000Z:86400:model=claude-opus-5|service_tier=standard|speed=standard',
      'api:2026-04-04T00:00:00.000Z:3600:model=claude-opus-5|service_tier=standard|speed=standard',
    ]);
  });

  it('does not depend on the order of keys in the file, and legacy account dimensions count', async () => {
    const a = await parse(JSON.stringify(page([row(day(1), day(2), { actor: { type: 'user_actor', user_id: 'u1' }, model: 'claude-opus-5' })])));
    const b = await parse(JSON.stringify(page([row(day(1), day(2), { model: 'claude-opus-5', actor: { user_id: 'u1', type: 'user_actor' } })])));
    expect(a.out.usage[0].dedupKey).toBe(b.out.usage[0].dedupKey);

    const legacy = await parse(
      JSON.stringify(
        page([
          bucket(1, [
            result({ model: 'claude-opus-5', account_id: 'user_01' }),
            result({ model: 'claude-opus-5', account_id: 'user_02' }),
            result({ model: 'claude-opus-5', service_account_id: 'svac_01' }),
          ]),
        ]),
      ),
    );
    expect(new Set(legacy.out.usage.map((u) => u.dedupKey)).size).toBe(3);
    expect(legacy.out.usage[0].dedupKey).toBe('api:2026-04-01T00:00:00.000Z:86400:account_id=user_01|model=claude-opus-5');
  });
});

describe('API usage report: bad input', () => {
  it('explains files that are not what they claim to be', async () => {
    expect(await codeOf(parse(''))).toBe('empty_file');
    expect(await codeOf(parse('   \n  '))).toBe('empty_file');
    expect(await codeOf(apiUsageReportParser.parse([], collectingSink().sink, {}))).toBe('no_files');
    expect(await codeOf(parse('usage_date_utc,model_version\n2026-01-01,claude'))).toBe('invalid_json');
    expect(await codeOf(parse('{"data": [{"starting_at": "2026-01-01T00:00:00Z", "results": ['))).toBe('invalid_json');
    expect(await codeOf(parse('{"hello": "world"}'))).toBe('not_a_report');
    expect(await codeOf(parse('{"data": []}'))).toBe('not_a_report');
    // another list endpoint of the API
    expect(await codeOf(parse('{"data": [{"type": "model", "id": "claude-opus-5"}], "has_more": false, "first_id": "x", "last_id": "x"}'))).toBe('not_a_report');
    expect(await codeOf(parse('[1, 2, 3]'))).toBe('not_a_report');
    expect(await codeOf(parse(fixture('cost-report.doc-example.json')))).toBe('wrong_report_type');
    expect(await codeOf(parse(fixture('analytics-cost.json')))).toBe('wrong_report_type');
  });

  it('recognises an API error that was saved instead of a report', async () => {
    const error = await parse('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011"}').catch((e) => e);
    expect(error.code).toBe('api_error_response');
    expect(error.message).toContain('invalid x-api-key');
    expect(error.message).toContain('authentication_error');
  });

  it('says so when a report has no usage in it', async () => {
    const empty = await parse(JSON.stringify(page([bucket(1, []), bucket(2, [])]))).catch((e) => e);
    expect(empty.code).toBe('no_rows');
    expect(empty.message).toMatch(/2 time buckets between 2026-04-01 and 2026-04-03/);
    const emptyAnalytics = await parse('{"data": [], "has_more": false, "next_page": null, "data_refreshed_at": null}').catch((e) => e);
    expect(emptyAnalytics.code).toBe('no_rows');
  });

  it('refuses a mix of the two APIs, and one day at two granularities', async () => {
    const legacy = JSON.stringify(page([bucket(1, [result({ model: 'claude-opus-5' })])]));
    const analytics = JSON.stringify(page([row(day(2), day(3), { model: 'claude-opus-5' })]));
    expect(await codeOf(parse(`[${legacy},${analytics}]`))).toBe('mixed_report_shapes');
    expect(await codeOf(parse([analytics, legacy]))).toBe('mixed_report_shapes');

    const daily = JSON.stringify(page([row(day(1), day(2), { model: 'claude-opus-5' })]));
    const hourly = JSON.stringify(page([row('2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', { model: 'claude-opus-5' })]));
    const mixed = await parse([daily, hourly]).catch((e) => e);
    expect(mixed.code).toBe('mixed_granularity');
    expect(mixed.message).toMatch(/daily and hourly figures for the same days \(for example 2026-04-01\)/);
    // a total for a range next to the days of that range
    const month = JSON.stringify(page([row('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', { model: 'claude-opus-5' })]));
    expect(await codeOf(parse([month, daily]))).toBe('mixed_granularity');
    // different days at different granularities are fine
    const otherDay = JSON.stringify(page([row('2026-04-02T10:00:00Z', '2026-04-02T11:00:00Z', { model: 'claude-opus-5' })]));
    expect((await parse([daily, otherDay])).out.usage).toHaveLength(2);
  });

  it('skips rows with invalid values and reports them', async () => {
    const { parsed, out } = await parse(
      JSON.stringify(
        page([
          bucket(1, [
            result({ model: 'claude-opus-5', service_tier: 'standard', speed: 'standard' }),
            result({ model: 'claude-opus-5', service_tier: 'batch', speed: 'standard', output_tokens: -5 }),
            result({ model: 'claude-opus-5', service_tier: 'flex', speed: 'standard', uncached_input_tokens: 'lots' }),
            result({ model: 'claude-opus-5', service_tier: 'priority', speed: 'standard', cache_creation: { ephemeral_5m_input_tokens: 1.5 } }),
          ]),
          { starting_at: 'yesterday', ending_at: day(3), results: [result({ model: 'claude-opus-5' }), result({ model: 'claude-sonnet-5' })] },
          bucket(3, [result({ model: 'claude-opus-5', service_tier: 'standard', speed: 'standard', cache_creation: null, server_tool_use: null })]),
        ]),
      ),
    );
    expect(out.usage.map((u) => [u.occurredAt.slice(0, 10), u.priceTier])).toEqual([
      ['2026-04-01', 'standard'],
      ['2026-04-03', 'standard'],
    ]);
    expect(parsed.recordsSeen).toBe(7);
    expect(parsed.recordsSkipped).toBe(5);
    expect(parsed.warnings.find((w) => w.code === 'invalid_number')).toMatchObject({ count: 3, sample: 'output_tokens: -5 (2026-04-01T00:00:00.000Z)' });
    expect(parsed.warnings.find((w) => w.code === 'invalid_timestamp')).toMatchObject({ count: 2, sample: 'yesterday' });
    // the bucket with the unreadable start is not part of the range that gets replaced
    expect(parsed.replaceRange).toEqual({ start: '2026-04-01T00:00:00.000Z', end: '2026-04-04T00:00:00.000Z' });

    expect(await codeOf(parse(JSON.stringify(page([bucket(1, [result({ output_tokens: -1 })])]))))).toBe('no_valid_rows');
  });

  it('reports progress and can be cancelled', async () => {
    const { out, sink } = collectingSink();
    const file = fileOf('usage.json', fixture('usage-report.daily.page-1.json'));
    await apiUsageReportParser.parse([file], sink, {});
    expect(out.progress.length).toBeGreaterThan(0);
    expect(out.progress.at(-1)).toMatchObject({ phase: 'Reading usage report', bytesRead: file.size, totalBytes: file.size, records: 3 });

    const controller = new AbortController();
    controller.abort();
    expect(await codeOf(apiUsageReportParser.parse([file], collectingSink().sink, { signal: controller.signal }))).toBe('cancelled');
  });
});

describe('detectApiReportFormat', () => {
  it('tells the four reports apart, also for pages, lists of pages and bare rows', () => {
    const usagePage = page([bucket(1, []), bucket(2, [result()])]);
    const costPage = page([bucket(1, [{ amount: '1.5', currency: 'USD' }])]);
    const analyticsUsage = page([row(day(1), day(2), {})]);
    const analyticsCost = page([{ starting_at: day(1), ending_at: day(2), group: {}, cost: { currency: 'USD', amount: '1.000000', list_amount: '1.000000', requests: null } }]);
    expect(detectApiReportFormat(usagePage)).toBe('anthropic/usage-report');
    expect(detectApiReportFormat(costPage)).toBe('anthropic/cost-report');
    expect(detectApiReportFormat(analyticsUsage)).toBe('anthropic/analytics-usage');
    expect(detectApiReportFormat(analyticsCost)).toBe('anthropic/analytics-cost');
    expect(detectApiReportFormat([page([bucket(1, [])]), costPage])).toBe('anthropic/cost-report');
    expect(detectApiReportFormat(usagePage.data)).toBe('anthropic/usage-report');
    expect(detectApiReportFormat(analyticsCost.data[0])).toBe('anthropic/analytics-cost');
  });

  it('still recognises a report with nothing in it', () => {
    expect(detectApiReportFormat(page([bucket(1, []), bucket(2, [])]))).toBe('anthropic/usage-report');
    expect(detectApiReportFormat({ data: [], has_more: false, next_page: null })).toBe('anthropic/usage-report');
    expect(detectApiReportFormat({ data: [], has_more: false, next_page: null, data_refreshed_at: null })).toBe('anthropic/analytics-usage');
  });

  it('returns null for everything else', () => {
    for (const value of [
      null,
      undefined,
      42,
      'text',
      [],
      {},
      { data: [] },
      { data: 'x' },
      { data: [], has_more: false, first_id: null, last_id: null },
      { data: [{ type: 'model', id: 'claude-opus-5' }], has_more: false },
      [{ uuid: 'c1', chat_messages: [] }],
      { type: 'error', error: { type: 'not_found_error', message: 'x' } },
      { data: [{ starting_at: 5, results: [] }] },
      { data: [{ results: [{ amount: '1' }] }] },
      [{ timestamp: '2026-01-01', input_tokens: 5 }],
    ]) {
      expect(detectApiReportFormat(value), JSON.stringify(value)).toBeNull();
    }
  });
});
