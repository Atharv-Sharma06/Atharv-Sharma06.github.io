import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParseContext, StagedCost } from '@/core/types';
import { apiCostReportParser, centsToUsd, detectApiReportFormat } from '@/import/api-reports';
import { collectingSink, fileOf } from '../helpers/sink';

/**
 * Fixtures (tests/fixtures/api-reports, all synthetic):
 *  cost-report.doc-example.json   response example of GET /v1/organizations/cost_report, copied from the API reference
 *  analytics-cost.json            Analytics API cost rows; the first is the example row of the guide with
 *                                 its abbreviated `group` written out, the other two are invented
 */
const fixture = (name: string) => readFileSync(new URL(`../fixtures/api-reports/${name}`, import.meta.url));

async function parse(content: string | Uint8Array | Array<string | Uint8Array>, ctx: ParseContext = {}) {
  const { out, sink } = collectingSink();
  const files = (Array.isArray(content) ? content : [content]).map((c, i) => fileOf(`cost-${i + 1}.json`, c));
  const parsed = await apiCostReportParser.parse(files, sink, ctx);
  return { parsed, out };
}

const codeOf = (promise: Promise<unknown>) => promise.then(() => 'no error', (e) => (e as { code?: string }).code ?? String(e));

/** A legacy cost result; every dimension is null unless the report is grouped. */
const result = (amount: unknown, over: Record<string, unknown> = {}) => ({
  amount,
  currency: 'USD',
  context_window: null,
  cost_type: null,
  description: null,
  inference_geo: null,
  model: null,
  service_tier: null,
  speed: null,
  token_type: null,
  workspace_id: null,
  ...over,
});
const day = (d: number) => `2026-04-${String(d).padStart(2, '0')}T00:00:00Z`;
const bucket = (d: number, results: unknown[]) => ({ starting_at: day(d), ending_at: day(d + 1), results });
const page = (data: unknown[], more = false) => ({ data, has_more: more, next_page: more ? 'page_abc' : null });
const tokens = (amount: unknown, over: Record<string, unknown> = {}) =>
  result(amount, { cost_type: 'tokens', description: 'Claude Opus 5 Usage - Output Tokens', model: 'claude-opus-5', token_type: 'output_tokens', service_tier: 'standard', ...over });

describe('centsToUsd', () => {
  it('converts cents to dollars exactly', () => {
    const table: Array<[unknown, string | null]> = [
      // the reference's own example: "123.45" in USD is $1.23 (and 45 hundredths of a cent)
      ['123.45', '1.2345'],
      ['123.78912', '1.2378912'],
      // the Analytics guide's example: "41280.000000" is $412.80
      ['41280.000000', '412.8'],
      ['98765.432100', '987.654321'],
      ['0', '0'],
      ['0.000000', '0'],
      ['100', '1'],
      ['1', '0.01'],
      ['0.01', '0.0001'],
      ['0.000001', '0.00000001'],
      ['123456789012.345678', '1234567890.12345678'],
      ['-250.5', '-2.505'],
      ['+7', '0.07'],
      ['.5', '0.005'],
      ['1e2', '1'],
      [' 12.5 ', '0.125'],
      // a number is taken by its shortest spelling, not through floating-point division
      [123.45, '1.2345'],
      [0.1, '0.001'],
      [7, '0.07'],
      ['abc', null],
      ['', null],
      ['1,5', null],
      ['12.3.4', null],
      ['$5', null],
      [null, null],
      [undefined, null],
      [Number.NaN, null],
      [{}, null],
      // more than the amount column can hold: not an amount
      ['1e30', null],
      ['-100000000000000', null],
      ['99999999999999', '999999999999.99'],
    ];
    for (const [cents, usd] of table) expect(centsToUsd(cents), JSON.stringify(cents)).toBe(usd);
  });

  it('does decimal arithmetic, not binary floating point', () => {
    // as doubles: 1.005 / 100 = 0.010049999999999998, 8.2 / 100 = 0.08199999999999999, 0.07 / 100 = 0.0007000000000000001
    expect(1.005 / 100).not.toBe(0.01005);
    expect(centsToUsd('1.005')).toBe('0.01005');
    expect(centsToUsd('8.2')).toBe('0.082');
    expect(centsToUsd('0.07')).toBe('0.0007');
    expect(centsToUsd(8.2)).toBe('0.082');
    // twelve fractional digits of a dollar are kept; the APIs send six of a cent
    expect(centsToUsd('0.1234567891')).toBe('0.001234567891');
    expect(centsToUsd('0.30000000000000004')).toBe('0.003');
  });
});

describe('API cost report: the documented examples', () => {
  it('parses the legacy cost report example', async () => {
    const bytes = fixture('cost-report.doc-example.json');
    const { parsed, out } = await parse(bytes);
    expect(out.costs).toEqual<StagedCost[]>([
      {
        modelKey: 'claude-opus-5-5',
        occurredAt: '2025-08-01T00:00:00.000Z',
        bucketSeconds: 86400,
        costType: 'tokens',
        tokenType: 'cache_creation.ephemeral_1h_input_tokens',
        description: 'Claude Opus 5.5 Usage - Input Tokens',
        amountUsd: '1.2378912',
        dedupKey: expect.stringMatching(/^cost:2025-08-01T00:00:00\.000Z:86400:#[0-9a-f]{64}$/),
      },
    ]);
    expect(out.usage).toEqual([]);
    expect(parsed).toMatchObject({
      format: 'anthropic/cost-report',
      parserVersion: 'api-reports-1',
      source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' },
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      recordsSeen: 1,
      recordsSkipped: 0,
      missingFields: [],
      replaceRanges: [{ start: '2025-08-01T00:00:00.000Z', end: '2025-08-02T00:00:00.000Z' }],
    });
    expect(parsed.stats).toMatchObject({ api: 'usage-cost', pages: 1, rows: 1, totalUsd: '1.2378912' });
    expect(parsed.warnings.map((w) => w.code)).toEqual(['more_pages_available']);
    expect(detectApiReportFormat(JSON.parse(bytes.toString('utf8')))).toBe('anthropic/cost-report');
  });

  it('parses Analytics API cost rows: cents with six decimals, list_amount only in the statistics', async () => {
    const { parsed, out } = await parse(fixture('analytics-cost.json'));
    expect(out.costs.map((c) => [c.modelKey, c.costType, c.tokenType, c.description, c.amountUsd, c.occurredAt, c.bucketSeconds])).toEqual([
      // "41280.000000" is $412.80
      ['claude-opus-5', 'tokens', 'cache_read_input_tokens', null, '412.8', '2026-09-01T00:00:00.000Z', 30 * 86400],
      ['claude-opus-5', 'tokens', 'output_tokens', null, '987.654321', '2026-09-01T00:00:00.000Z', 30 * 86400],
      ['claude-opus-5', 'web_search', null, null, '12.5', '2026-09-01T00:00:00.000Z', 30 * 86400],
    ]);
    expect(out.costs[0].dedupKey).toBe('cost:2026-09-01T00:00:00.000Z:2592000:cost_type=tokens|model=claude-opus-5|token_type=cache_read_input_tokens');
    expect(new Set(out.costs.map((c) => c.dedupKey)).size).toBe(3);
    expect(parsed).toMatchObject({
      format: 'anthropic/analytics-cost',
      source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' },
      recordsSeen: 3,
      missingFields: [],
      replaceRanges: [{ start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' }],
    });
    expect(parsed.stats).toMatchObject({ api: 'analytics', totalUsd: '1412.954321', listTotalUsd: '1516.154321', groupedBy: 'cost_type, model, token_type' });
    // the rows cover a whole month each
    expect(parsed.warnings.map((w) => w.code)).toEqual(['no_time_buckets']);
    expect(parsed.warnings[0]).toMatchObject({ count: 3, sample: '2026-09-01 to 2026-10-01' });
    expect(detectApiReportFormat(JSON.parse(fixture('analytics-cost.json').toString('utf8')))).toBe('anthropic/analytics-cost');
  });
});

describe('API cost report: rows', () => {
  it('imports several pages and extends the replaced range over empty days', async () => {
    const page1 = page([bucket(1, []), bucket(2, [tokens('250'), result('1000', { cost_type: 'web_search', description: 'Web Search Usage' })])], true);
    const page2 = page([bucket(3, [tokens('75.5')]), bucket(4, [])]);
    for (const input of [JSON.stringify([page1, page2]), `${JSON.stringify(page1)}\n${JSON.stringify(page2)}`]) {
      const { parsed, out } = await parse(input);
      expect(out.costs.map((c) => [c.occurredAt.slice(0, 10), c.costType, c.amountUsd])).toEqual([
        ['2026-04-02', 'tokens', '2.5'],
        ['2026-04-02', 'web_search', '10'],
        ['2026-04-03', 'tokens', '0.755'],
      ]);
      expect(parsed.replaceRanges).toEqual([{ start: '2026-04-01T00:00:00.000Z', end: '2026-04-05T00:00:00.000Z' }]);
      expect(parsed.stats).toMatchObject({ pages: 2, timeBuckets: 4, emptyBuckets: 2, totalUsd: '13.255' });
      expect(parsed.warnings).toEqual([]);
    }
  });

  it('skips amounts in another currency and warns', async () => {
    const { parsed, out } = await parse(
      JSON.stringify(
        page([
          bucket(1, [
            tokens('100'),
            tokens('200', { currency: 'EUR', token_type: 'uncached_input_tokens' }),
            tokens('300', { currency: 'eur', token_type: 'cache_read_input_tokens' }),
            // "usd" in another case, and no currency at all (the reference: "currently always USD")
            tokens('400', { currency: 'usd', model: 'claude-sonnet-5' }),
            tokens('500', { currency: undefined, model: 'claude-haiku-5-5' }),
          ]),
        ]),
      ),
    );
    expect(out.costs.map((c) => c.amountUsd)).toEqual(['1', '4', '5']);
    expect(parsed.recordsSeen).toBe(5);
    expect(parsed.recordsSkipped).toBe(2);
    const warning = parsed.warnings.find((w) => w.code === 'non_usd_currency');
    expect(warning).toMatchObject({ count: 2, sample: 'EUR (2026-04-01T00:00:00.000Z)' });
    expect(warning?.message).toMatch(/not converted/);
    expect(parsed.stats.totalUsd).toBe('10');

    expect(await codeOf(parse(JSON.stringify(page([bucket(1, [tokens('100', { currency: 'GBP' })])]))))).toBe('no_valid_rows');
  });

  it('skips amounts that are not numbers, keeps negative ones', async () => {
    const { parsed, out } = await parse(
      JSON.stringify(
        page([
          bucket(1, [
            tokens('12.5'),
            tokens('n/a', { token_type: 'a' }),
            tokens(null, { token_type: 'b' }),
            tokens('-1250', { token_type: 'cache_read_input_tokens' }),
            tokens(1999, { token_type: 'c' }),
          ]),
        ]),
      ),
    );
    expect(out.costs.map((c) => c.amountUsd)).toEqual(['0.125', '-12.5', '19.99']);
    expect(parsed.warnings.find((w) => w.code === 'invalid_amount')).toMatchObject({ count: 2, sample: 'n/a (2026-04-01T00:00:00.000Z)' });
    expect(parsed.stats.totalUsd).toBe('7.615');
  });

  it('flags a report that is not itemised', async () => {
    const { parsed, out } = await parse(JSON.stringify(page([bucket(1, [result('12345.67')]), bucket(2, [result('100')])])));
    expect(out.costs).toEqual<StagedCost[]>([
      { modelKey: null, occurredAt: '2026-04-01T00:00:00.000Z', bucketSeconds: 86400, costType: null, tokenType: null, description: null, amountUsd: '123.4567', dedupKey: 'cost:2026-04-01T00:00:00.000Z:86400:*' },
      { modelKey: null, occurredAt: '2026-04-02T00:00:00.000Z', bucketSeconds: 86400, costType: null, tokenType: null, description: null, amountUsd: '1', dedupKey: 'cost:2026-04-02T00:00:00.000Z:86400:*' },
    ]);
    expect(parsed.missingFields).toEqual(['cost_type', 'model']);
    const warning = parsed.warnings.find((w) => w.code === 'cost_not_itemised');
    expect(warning).toMatchObject({ count: 2 });
    expect(warning?.message).toMatch(/group_by\[\]=description/);

    // web search has a cost type but no model: that is an itemised report
    const itemised = await parse(JSON.stringify(page([bucket(1, [result('100', { cost_type: 'web_search', description: 'Web Search Usage' })])])));
    expect(itemised.parsed.missingFields).toEqual(['model']);
    expect(itemised.parsed.warnings).toEqual([]);
  });

  it('keys rows by bucket and dimensions, never by the amount', async () => {
    const rows = [
      tokens('1'),
      tokens('1', { token_type: 'uncached_input_tokens', description: 'Claude Opus 5 Usage - Input Tokens' }),
      tokens('1', { workspace_id: 'wrkspc_01' }),
      tokens('1', { service_tier: 'batch' }),
      tokens('1', { context_window: '200k-1M' }),
      tokens('1', { inference_geo: 'us' }),
      tokens('1', { speed: 'fast' }),
      tokens('1', { model: 'claude-sonnet-5' }),
    ];
    const first = await parse(JSON.stringify(page([bucket(1, rows)])));
    const keys = first.out.costs.map((c) => c.dedupKey);
    expect(new Set(keys).size).toBe(rows.length);

    // the same report, restated with other amounts: same keys
    const restated = await parse(JSON.stringify(page([bucket(1, rows.map((r, i) => ({ ...r, amount: String(100 + i) })))])));
    expect(restated.out.costs.map((c) => c.dedupKey)).toEqual(keys);
    // another day: other keys
    const nextDay = await parse(JSON.stringify(page([bucket(2, rows)])));
    expect(nextDay.out.costs.some((c) => keys.includes(c.dedupKey))).toBe(false);

    // a row that is in the file twice counts once
    const twice = await parse(JSON.stringify(page([bucket(1, [tokens('5'), tokens('5')])])));
    expect(twice.out.costs).toHaveLength(1);
    expect(twice.parsed.warnings.find((w) => w.code === 'duplicate_rows')).toMatchObject({ count: 1 });
  });

  it('keeps an unknown model identifier verbatim', async () => {
    const { out } = await parse(JSON.stringify(page([bucket(1, [tokens('5', { model: 'claude-nova-9-20270101' })]), bucket(2, [tokens('6', { model: 'claude-nova-9-20270101' })])])));
    expect(out.costs.map((c) => c.modelKey)).toEqual(['claude-nova-9', 'claude-nova-9']);
    expect(out.models).toEqual([{ key: 'claude-nova-9', displayName: 'claude-nova-9-20270101', family: 'other', tokenizerFamily: 'unknown' }]);
  });
});

describe('API cost report: one period stated twice', () => {
  it('refuses daily totals next to the same days itemised, which would double the spend', async () => {
    // $10.00 on 1 April and $4.00 on 2 April, once as totals and once by what was billed
    const totals = JSON.stringify(page([bucket(1, [result('1000')]), bucket(2, [result('400')])]));
    const itemised = JSON.stringify(
      page([
        bucket(1, [tokens('600.000001'), tokens('399.999999', { token_type: 'uncached_input_tokens', description: 'Claude Opus 5 Usage - Input Tokens' })]),
        // rounded row by row, the items miss the total by a millionth of a cent
        bucket(2, [tokens('133.333333'), tokens('133.333333', { model: 'claude-sonnet-5', description: 'Claude Sonnet 5 Usage - Output Tokens' }), result('133.333333', { cost_type: 'web_search', description: 'Web Search Usage' })]),
      ]),
    );
    const error = await parse([totals, itemised]).catch((e) => e);
    expect(error.code).toBe('mixed_grouping');
    expect(error.message).toMatch(/same cost twice/);
    expect(await codeOf(parse(itemised))).toBe('no error');
    expect((await parse(totals)).parsed.stats.totalUsd).toBe('14');

    // two reports of different days, grouped differently, are not the same cost
    const otherDays = JSON.stringify(page([bucket(5, [tokens('600'), tokens('400', { token_type: 'uncached_input_tokens' })])]));
    expect((await parse([totals, otherDays])).parsed.stats.totalUsd).toBe('24');
    // ... nor are reports of the same days whose amounts differ (another workspace, say)
    const otherAmounts = JSON.stringify(page([bucket(1, [tokens('700'), tokens('200', { token_type: 'uncached_input_tokens' })])]));
    expect(await codeOf(parse([totals, otherAmounts]))).toBe('no error');
  });
});

describe('API cost report: bad input', () => {
  it('explains files that are not cost reports', async () => {
    expect(await codeOf(parse(''))).toBe('empty_file');
    expect(await codeOf(parse('not json at all'))).toBe('invalid_json');
    expect(await codeOf(parse('{"data": {"nope": true}}'))).toBe('not_a_report');
    expect(await codeOf(parse(fixture('usage-report.doc-example.json')))).toBe('wrong_report_type');
    expect(await codeOf(parse(fixture('analytics-usage.doc-example.json')))).toBe('wrong_report_type');
    const empty = await parse(JSON.stringify(page([bucket(1, []), bucket(2, [])]))).catch((e) => e);
    expect(empty.code).toBe('no_rows');
    // empty buckets look the same in both kinds of report, so the message names both
    expect(empty.message).toBe('The report has 2 time buckets between 2026-04-01 and 2026-04-03, but none of them contains any usage or cost. There is nothing to import.');
    expect(await codeOf(parse('{"type":"error","error":{"type":"permission_error","message":"Admin API key required"}}'))).toBe('api_error_response');
    const usage = await parse(fixture('usage-report.doc-example.json')).catch((e) => e);
    expect(usage.message).toMatch(/usage report, not a cost report/);
  });
});
