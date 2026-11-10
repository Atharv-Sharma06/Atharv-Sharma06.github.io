import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParseContext } from '@/core/types';
import { consoleCsvParser, detectConsoleCsvFormat } from '@/import/api-reports';
import { detectCsvFormat } from '@/import/generic';
import { collectingSink, fileOf } from '../helpers/sink';

/**
 * Fixtures (tests/fixtures/api-reports, rows invented):
 *  console-usage.csv        Claude Console usage export with the header verified against exported files
 *                           (see src/import/api-reports/console-csv.ts). The "batch" and "fast" rows use
 *                           the API's value names; no real export with such rows was available.
 *  console-usage.2025.csv   the shorter header of exports from mid-2025
 *  console-cost.csv         Claude Console cost export, header as verified
 */
const fixture = (name: string) => readFileSync(new URL(`../fixtures/api-reports/${name}`, import.meta.url));

const USAGE_HEADER =
  'usage_date_utc,model_version,api_key,workspace,usage_type,context_window,usage_input_tokens_no_cache,usage_input_tokens_cache_write_5m,usage_input_tokens_cache_write_1h,usage_input_tokens_cache_read,usage_output_tokens,web_search_count,inference_geo,speed';
const COST_HEADER = 'usage_date_utc,model,workspace,api_key,usage_type,context_window,token_type,cost_usd,cost_type,inference_geo,speed';

async function parse(content: string | Uint8Array | Array<string | Uint8Array>, ctx: ParseContext = {}) {
  const { out, sink } = collectingSink();
  const files = (Array.isArray(content) ? content : [content]).map((c, i) => fileOf(`export-${i + 1}.csv`, c));
  const parsed = await consoleCsvParser.parse(files, sink, ctx);
  return { parsed, out };
}
const codeOf = (promise: Promise<unknown>) => promise.then(() => 'no error', (e) => (e as { code?: string }).code ?? String(e));

describe('Claude Console usage export', () => {
  it('imports the rows as exact usage of the API usage source', async () => {
    const bytes = fixture('console-usage.csv');
    const { parsed, out } = await parse(bytes);
    expect(
      out.usage.map((u) => [u.occurredAt, u.modelKey, u.priceTier, u.inputTokens, u.cacheWrite5mTokens, u.cacheWrite1hTokens, u.cacheReadTokens, u.outputTokens, u.webSearchRequests]),
    ).toEqual([
      ['2026-07-05T00:00:00.000Z', 'claude-fable-5', 'standard', 5300, 58000, 0, 242000, 4600, 0],
      ['2026-07-05T00:00:00.000Z', 'claude-haiku-4-5', 'standard', 1000, 0, 0, 0, 40, 2],
      ['2026-07-06T00:00:00.000Z', 'claude-sonnet-5', 'standard', 51000, 1200, 300, 90000, 16000, 0],
      // "200k - 1M" on Claude Sonnet 4.5 is long-context usage
      ['2026-07-06T00:00:00.000Z', 'claude-sonnet-4-5', 'long_context', 400000, 0, 0, 0, 9000, 0],
      ['2026-07-08T00:00:00.000Z', 'claude-opus-4-8', 'batch', 7000, 0, 0, 0, 800, 0],
      ['2026-07-08T00:00:00.000Z', 'claude-opus-4-8', 'fast', 3000, 0, 0, 0, 500, 0],
    ]);
    expect(out.usage.every((u) => u.bucketSeconds === 86400 && u.confidence === 'exact' && u.requestCount === 0 && u.conversationKey === null)).toBe(true);
    expect(new Set(out.usage.map((u) => u.dedupKey)).size).toBe(6);
    expect(out.usage[0].dedupKey).toMatch(/^api-csv:2026-07-05T00:00:00\.000Z:86400:/);
    expect(out.models).toEqual([]);

    expect(parsed).toMatchObject({
      format: 'anthropic/console-usage-csv',
      formatLabel: 'Claude Console usage export (CSV)',
      parserVersion: 'api-reports-1',
      // the same source as API usage reports, so the two restate each other
      source: { kind: 'api_usage_report', label: 'Anthropic API usage report', externalRef: '' },
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      recordsSeen: 6,
      recordsSkipped: 0,
      missingFields: [],
      // 5 July up to the end of 8 July
      replaceRange: { start: '2026-07-05T00:00:00.000Z', end: '2026-07-09T00:00:00.000Z' },
    });
    expect(parsed.warnings.map((w) => [w.code, w.count])).toEqual([
      ['possible_overlap_claude_code', 1],
      ['us_inference_premium', 1],
    ]);
  });

  it('reads hourly exports, CRLF line ends and a byte order mark', async () => {
    const text = `﻿${USAGE_HEADER}\r\n2026-07-04 11:00,claude-opus-4-8,k,Default,standard,200k - 1M,8000,765000,0,31000000,24000,0,global,\r\n2026-07-04 12:00,claude-opus-4-8,k,Default,standard,≤ 200k,10,0,0,0,5,0,global,\r\n\r\n\r\n`;
    const { parsed, out } = await parse(text);
    expect(out.usage.map((u) => [u.occurredAt, u.bucketSeconds, u.priceTier, u.cacheReadTokens])).toEqual([
      ['2026-07-04T11:00:00.000Z', 3600, 'standard', 31000000],
      ['2026-07-04T12:00:00.000Z', 3600, 'standard', 5 - 5],
    ]);
    expect(parsed.replaceRange).toEqual({ start: '2026-07-04T11:00:00.000Z', end: '2026-07-04T13:00:00.000Z' });
    expect(parsed.recordsSeen).toBe(2);
  });

  it('handles the shorter header of older exports and says what it cannot tell apart', async () => {
    const { parsed, out } = await parse(fixture('console-usage.2025.csv'));
    expect(out.usage.map((u) => [u.modelKey, u.priceTier, u.inputTokens, u.cacheWrite5mTokens, u.cacheReadTokens, u.outputTokens, u.webSearchRequests])).toEqual([
      ['claude-3-5-haiku', 'standard', 9700, 0, 0, 450, 0],
      ['claude-sonnet-4', 'standard', 70, 31000, 76000, 800, 1],
    ]);
    // no speed column; and no context_window column although Claude Sonnet 4 had a long-context premium
    expect(parsed.missingFields).toEqual(['speed', 'context_window']);
    expect(parsed.warnings.find((w) => w.code === 'tier_columns_missing')?.message).toMatch(/no speed and no context_window column/);
  });

  it('reads a single cache-write column as 5-minute cache writes', async () => {
    const text =
      'usage_date_utc,model_version,api_key,workspace,usage_type,usage_input_tokens_no_cache,usage_input_tokens_cache_write,usage_input_tokens_cache_read,usage_output_tokens\n' +
      '2024-11-02,claude-3-5-sonnet-20241022,k,Default,standard,100,2500,900,40\n';
    const { out } = await parse(text);
    expect(out.usage.map((u) => [u.modelKey, u.inputTokens, u.cacheWrite5mTokens, u.cacheWrite1hTokens, u.cacheReadTokens, u.outputTokens])).toEqual([['claude-3-5-sonnet', 100, 2500, 0, 900, 40]]);
  });

  it('keeps rows with identical dimensions inside one file, drops a file that is chosen twice', async () => {
    const twoAlike = `${USAGE_HEADER}\n2026-07-05,claude-sonnet-5,k,Default,standard,≤ 200k,100,0,0,0,10,0,global,\n2026-07-05,claude-sonnet-5,k,Default,standard,≤ 200k,200,0,0,0,20,0,global,\n`;
    const once = await parse(twoAlike);
    expect(once.out.usage.map((u) => u.inputTokens)).toEqual([100, 200]);
    expect(once.out.usage[1].dedupKey).toBe(`${once.out.usage[0].dedupKey}#2`);

    const twice = await parse([twoAlike, twoAlike]);
    expect(twice.out.usage.map((u) => u.inputTokens)).toEqual([100, 200]);
    expect(twice.parsed.recordsSeen).toBe(4);
    expect(twice.parsed.recordsSkipped).toBe(2);
    expect(twice.parsed.warnings.find((w) => w.code === 'duplicate_rows')).toMatchObject({ count: 2 });

    // two months in one import
    const july = fixture('console-usage.csv').toString('utf8');
    const august = `${USAGE_HEADER}\n2026-08-01,claude-sonnet-5,k,Default,standard,≤ 200k,7,0,0,0,1,0,global,\n`;
    const both = await parse([july, august]);
    expect(both.out.usage).toHaveLength(7);
    expect(both.parsed.replaceRange).toEqual({ start: '2026-07-05T00:00:00.000Z', end: '2026-08-02T00:00:00.000Z' });
    expect(both.parsed.fileName).toBe('2 files');
  });

  it('refuses a daily and an hourly export of the same day in one import', async () => {
    const daily = `${USAGE_HEADER}\n2026-07-04,claude-opus-4-8,k,Default,standard,≤ 200k,1000,0,0,0,100,0,global,\n`;
    const hourly = `${USAGE_HEADER}\n2026-07-04 11:00,claude-opus-4-8,k,Default,standard,≤ 200k,1000,0,0,0,100,0,global,\n`;
    const error = await parse([daily, hourly]).catch((e) => e);
    expect(error.code).toBe('mixed_granularity');
    expect(error.message).toMatch(/one at a time/);
  });

  it('skips unreadable rows, and imports an unknown usage_type as standard with a warning', async () => {
    const text =
      `${USAGE_HEADER}\n` +
      '2026-07-05,claude-sonnet-5,k,Default,standard,≤ 200k,100,0,0,0,10,0,global,\n' +
      'July 6th,claude-sonnet-5,k,Default,standard,≤ 200k,100,0,0,0,10,0,global,\n' +
      '2026-07-07,claude-sonnet-5,k,Default,standard,≤ 200k,-100,0,0,0,10,0,global,\n' +
      '2026-07-08,claude-sonnet-5,k,Default,standard,≤ 200k,1.5,0,0,0,10,0,global,\n' +
      '2026-07-09,claude-sonnet-5,k,Default,something_new,≤ 200k,100,0,0,0,10,0,global,\n' +
      '2026-07-10,claude-nova-9-20270101,k,Default,standard,≤ 200k,100,0,0,0,10,0,global,\n' +
      ',,,,,,,,,,,,,\n';
    const { parsed, out } = await parse(text);
    expect(out.usage.map((u) => [u.occurredAt.slice(0, 10), u.modelKey, u.priceTier])).toEqual([
      ['2026-07-05', 'claude-sonnet-5', 'standard'],
      ['2026-07-09', 'claude-sonnet-5', 'standard'],
      ['2026-07-10', 'claude-nova-9', 'standard'],
    ]);
    expect(out.models).toEqual([{ key: 'claude-nova-9', displayName: 'claude-nova-9-20270101', family: 'other', tokenizerFamily: 'unknown' }]);
    expect(parsed.recordsSeen).toBe(6);
    expect(parsed.recordsSkipped).toBe(3);
    expect(parsed.warnings.find((w) => w.code === 'invalid_timestamp')).toMatchObject({ count: 1, sample: 'July 6th (line 3)' });
    expect(parsed.warnings.find((w) => w.code === 'invalid_number')).toMatchObject({ count: 2, sample: 'usage_input_tokens_no_cache: -100 (line 4)' });
    expect(parsed.warnings.find((w) => w.code === 'unknown_usage_type')).toMatchObject({ count: 1, sample: 'something_new (line 6)' });

    expect(await codeOf(parse(`${USAGE_HEADER}\n`))).toBe('no_rows');
    expect(await codeOf(parse(`${USAGE_HEADER}\nnever,claude-sonnet-5,k,Default,standard,≤ 200k,1,0,0,0,1,0,global,\n`))).toBe('no_valid_rows');
  });
});

describe('Claude Console cost export', () => {
  it('imports the rows as actual spend in exact dollars', async () => {
    const bytes = fixture('console-cost.csv');
    const { parsed, out } = await parse(bytes);
    expect(out.costs.map((c) => [c.occurredAt.slice(0, 10), c.modelKey, c.costType, c.tokenType, c.amountUsd])).toEqual([
      // "--" means "does not apply"
      ['2026-02-12', null, 'web_search', null, '0.05'],
      ['2026-02-12', 'claude-haiku-4-5', 'tokens', 'uncached_input_tokens', '0.11'],
      // two rows the file does not tell apart are two amounts
      ['2026-02-12', 'claude-sonnet-4-5', 'tokens', 'cache_creation.ephemeral_5m_input_tokens', '0.7'],
      ['2026-02-12', 'claude-sonnet-4-5', 'tokens', 'cache_creation.ephemeral_5m_input_tokens', '1.2'],
      ['2026-02-12', 'claude-sonnet-4-5', 'tokens', 'output_tokens', '1.8'],
      ['2026-02-14', 'claude-sonnet-4-5', 'tokens', 'cache_read_input_tokens', '7'],
      // a display name the catalog does not know is kept as it is
      ['2026-02-14', 'claude nova 9', 'tokens', 'output_tokens', '2.14'],
    ]);
    expect(out.costs.every((c) => c.bucketSeconds === 86400 && c.description === null)).toBe(true);
    expect(new Set(out.costs.map((c) => c.dedupKey)).size).toBe(7);
    expect(out.costs[3].dedupKey).toBe(`${out.costs[2].dedupKey}#2`);
    expect(out.models).toEqual([{ key: 'claude nova 9', displayName: 'Claude Nova 9', family: 'other', tokenizerFamily: 'unknown' }]);
    expect(out.usage).toEqual([]);

    expect(parsed).toMatchObject({
      format: 'anthropic/console-cost-csv',
      source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' },
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      recordsSeen: 7,
      recordsSkipped: 0,
      replaceRange: { start: '2026-02-12T00:00:00.000Z', end: '2026-02-15T00:00:00.000Z' },
      warnings: [],
    });
    expect(parsed.stats.totalUsd).toBe('13');
  });

  it('skips rows whose amount is not a number', async () => {
    const { parsed, out } = await parse(`${COST_HEADER}\n2026-02-12,Claude Haiku 4.5,Default,k,message,≤ 200k,output,0.03,token,global,\n2026-02-12,Claude Haiku 4.5,Default,k,message,≤ 200k,input_no_cache,$0.09,token,global,\n`);
    expect(out.costs.map((c) => c.amountUsd)).toEqual(['0.03']);
    expect(parsed.warnings.find((w) => w.code === 'invalid_amount')).toMatchObject({ count: 1, sample: '$0.09 (line 3)' });
  });
});

describe('Console CSV detection and fall-through', () => {
  it('recognises the two exports by their header', () => {
    expect(detectConsoleCsvFormat(USAGE_HEADER.split(','))).toBe('anthropic/console-usage-csv');
    expect(detectConsoleCsvFormat(COST_HEADER.split(','))).toBe('anthropic/console-cost-csv');
    // older headers, other case, stray spaces
    expect(detectConsoleCsvFormat(fixture('console-usage.2025.csv').toString('utf8').split('\n')[0].split(','))).toBe('anthropic/console-usage-csv');
    expect(detectConsoleCsvFormat(COST_HEADER.replace(',inference_geo,speed', '').split(','))).toBe('anthropic/console-cost-csv');
    expect(detectConsoleCsvFormat(USAGE_HEADER.toUpperCase().split(',').map((h) => ` ${h} `))).toBe('anthropic/console-usage-csv');
    expect(detectCsvFormat(USAGE_HEADER.split(','))).toBe('anthropic/console-usage-csv');

    expect(detectConsoleCsvFormat(['timestamp', 'model', 'input_tokens', 'output_tokens'])).toBeNull();
    expect(detectConsoleCsvFormat(['usage_date_utc', 'something'])).toBeNull();
    expect(detectConsoleCsvFormat([])).toBeNull();
    expect(detectCsvFormat(['timestamp', 'model', 'input_tokens', 'output_tokens'])).toBe('generic/csv');
    expect(detectCsvFormat(['a', 'b'])).toBeNull();
  });

  it('hands any other CSV file to the generic importer', async () => {
    const { parsed, out } = await parse('timestamp,model,input_tokens,output_tokens\n2026-03-01T10:00:00Z,claude-sonnet-4-6,1200,300\n', { options: { now: Date.UTC(2026, 10, 10) } });
    expect(parsed).toMatchObject({ format: 'generic/csv', source: { kind: 'generic_csv', label: 'Custom usage data', externalRef: '' } });
    expect(parsed.replaceRange).toBeUndefined();
    expect(out.usage).toHaveLength(1);
    expect(out.usage[0]).toMatchObject({ confidence: 'estimated', modelKey: 'claude-sonnet-4-6', inputTokens: 1200, outputTokens: 300 });
  });

  it('refuses a mix of kinds, and empty input', async () => {
    const usage = fixture('console-usage.csv');
    const cost = fixture('console-cost.csv');
    expect(await codeOf(parse([usage, cost]))).toBe('mixed_files');
    expect(await codeOf(parse([usage, 'timestamp,input_tokens\n2026-01-01,5\n']))).toBe('mixed_files');
    expect(await codeOf(parse(''))).toBe('empty_file');
    expect(await codeOf(consoleCsvParser.parse([], collectingSink().sink, {}))).toBe('no_files');
  });
});
