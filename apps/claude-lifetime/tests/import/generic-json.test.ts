import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParsedImport, ParseWarning } from '@/core/types';
import { detectJsonFormat, genericCsvParser, genericJsonParser, isGenericUsageJson } from '@/import/generic';
import { collectingSink, fileOf } from '../helpers/sink';

/**
 * tests/fixtures/generic (invented data): usage.json is the example of the documented
 * JSON shape, usage.jsonl the same records one per line, usage.csv the same records
 * as CSV.
 */
const fixture = (name: string) => readFileSync(new URL(`../fixtures/generic/${name}`, import.meta.url));
const NOW = Date.UTC(2026, 10, 10);

async function parse(content: string | Uint8Array | Array<string | Uint8Array>, options: Record<string, unknown> = {}) {
  const { out, sink } = collectingSink();
  const files = (Array.isArray(content) ? content : [content]).map((c, i) => fileOf(`usage-${i + 1}.json`, c));
  const parsed = await genericJsonParser.parse(files, sink, { options: { now: NOW, ...options } });
  return { parsed, out };
}
const errorOf = (promise: Promise<unknown>) => promise.then(() => ({ code: 'no error', message: '' }), (e) => e as { code: string; message: string });
const codeOf = async (promise: Promise<unknown>) => (await errorOf(promise)).code;
const warning = (parsed: ParsedImport, code: string): ParseWarning | undefined => parsed.warnings.find((w) => w.code === code);

const wrap = (records: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ format: 'claude-lifetime/usage', version: 1, ...extra, records });
const record = (over: Record<string, unknown> = {}) => ({ timestamp: '2026-03-01T10:00:00Z', model: 'claude-opus-4-6', input_tokens: 100, output_tokens: 10, ...over });

describe('generic JSON: the documented shape', () => {
  it('imports the example file exactly like the same records in CSV', async () => {
    const bytes = fixture('usage.json');
    const { parsed, out } = await parse(bytes);

    const { out: csvOut, sink } = collectingSink();
    await genericCsvParser.parse([fileOf('usage.csv', fixture('usage.csv'))], sink, { options: { now: NOW } });
    expect(out.usage).toEqual(csvOut.usage);
    expect(out.conversations).toEqual(csvOut.conversations);
    expect(out.usage.map((u) => [u.occurredAt, u.modelKey, u.priceTier, u.bucketSeconds, u.dedupKey])).toEqual([
      ['2026-03-01T09:15:00.000Z', 'claude-sonnet-4-6', 'standard', 0, 'generic:req-0001'],
      ['2026-03-01T09:20:30.000Z', 'claude-sonnet-4-6', 'standard', 0, 'generic:req-0002'],
      ['2026-03-02T00:00:00.000Z', 'claude-opus-4-6', 'batch', 86400, 'generic:day-2026-03-02'],
      ['2026-03-03T10:00:00.000Z', 'claude-haiku-4-5', 'standard', 60, 'generic:req-0003'],
    ]);

    expect(parsed).toMatchObject({
      format: 'claude-lifetime/usage',
      parserVersion: 'generic-1',
      // the file names its source; nothing was chosen in the UI
      source: { kind: 'generic_json', label: 'My proxy logs', externalRef: '' },
      fileName: 'usage-1.json',
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      recordsSeen: 4,
      recordsSkipped: 0,
      missingFields: [],
      warnings: [],
    });
    expect(parsed.replaceRange).toBeUndefined();
    expect(parsed.stats).toMatchObject({ rows: 4, tokens: 85010, conversations: 2, confidence: 'estimated', layout: 'document' });
  });

  it('accepts a bare array of records and JSON Lines, with the same result', async () => {
    const records = JSON.parse(fixture('usage.json').toString('utf8')).records as unknown[];
    const reference = (await parse(fixture('usage.json'))).out;

    const array = await parse(JSON.stringify(records));
    const prettyArray = await parse(JSON.stringify(records, null, 2));
    const lines = await parse(fixture('usage.jsonl'));
    for (const { parsed, out } of [array, prettyArray, lines]) {
      expect(out.usage).toEqual(reference.usage);
      expect(out.conversations).toEqual(reference.conversations);
      expect(parsed.format).toBe('claude-lifetime/usage');
      // no wrapper, so no label from the file
      expect(parsed.source).toEqual({ kind: 'generic_json', label: 'Custom usage data', externalRef: '' });
    }
    expect(array.parsed.stats.layout).toBe('array');
    expect(lines.parsed.stats.layout).toBe('lines');

    // a single record on its own, and a wrapper without "format"
    expect((await parse(JSON.stringify(records[0]))).out.usage).toEqual([reference.usage[0]]);
    expect((await parse(JSON.stringify({ records }))).out.usage).toEqual(reference.usage);
  });

  it('gives records without an id the same key in JSON and in CSV', async () => {
    const json = await parse(JSON.stringify([{ timestamp: '2026-03-01T10:00:00Z', model: 'claude-opus-4-6', input_tokens: 100, output_tokens: 10 }, { timestamp: '2026-03-02', input_tokens: 5 }]));
    const { out: csvOut, sink } = collectingSink();
    await genericCsvParser.parse([fileOf('same.csv', 'timestamp,model,input_tokens,output_tokens\n2026-03-01T10:00:00Z,claude-opus-4-6,100,10\n2026-03-02,,5,\n')], sink, { options: { now: NOW } });
    expect(json.out.usage.map((u) => u.dedupKey)).toEqual(csvOut.usage.map((u) => u.dedupKey));
    expect(json.out.usage).toEqual(csvOut.usage);
  });

  it('lets the options override what the file says about its source', async () => {
    const text = wrap([record({ id: 'a', conversation_id: 'c' })], { source: { label: 'From the file', ref: 'file-ref' } });
    const fromFile = await parse(text);
    expect(fromFile.parsed.source).toEqual({ kind: 'generic_json', label: 'From the file', externalRef: 'file-ref' });
    expect(fromFile.out.usage[0]).toMatchObject({ dedupKey: 'generic:file-ref:a', conversationKey: 'generic:file-ref:c', confidence: 'estimated' });
    expect(fromFile.out.conversations[0].dedupKey).toBe('generic:file-ref:c');

    const chosen = await parse(text, { sourceLabel: 'Chosen', sourceRef: 'chosen-ref', confidence: 'exact' });
    expect(chosen.parsed.source).toEqual({ kind: 'generic_json', label: 'Chosen', externalRef: 'chosen-ref' });
    expect(chosen.out.usage[0]).toMatchObject({ dedupKey: 'generic:chosen-ref:a', conversationKey: 'generic:chosen-ref:c', confidence: 'exact' });
  });

  it('reads numbers given as text and ignores fields it does not know', async () => {
    const { parsed, out } = await parse(
      wrap([
        { timestamp: 1772532000, model: 'claude-opus-4-6', input_tokens: '1,200', output_tokens: '300', cache_read_tokens: null, requests: '2', cost_usd: 0.5, prompt: 'not stored', id: 17 },
        { timestamp: '1772532060', input_tokens: 5, total_tokens: 5, conversation_id: 42 },
      ]),
    );
    expect(out.usage.map((u) => [u.occurredAt, u.modelKey, u.inputTokens, u.outputTokens, u.requestCount, u.dedupKey.slice(0, 11), u.conversationKey])).toEqual([
      ['2026-03-03T10:00:00.000Z', 'claude-opus-4-6', 1200, 300, 2, 'generic:17', null],
      ['2026-03-03T10:01:00.000Z', null, 5, 0, 0, expect.stringMatching(/^generic:[0-9a-f]{3}$/), 'generic::42'],
    ]);
    expect(JSON.stringify(out)).not.toContain('not stored');
    expect(parsed.warnings).toEqual([]);
  });
});

describe('generic JSON: validation is the CSV importer\'s', () => {
  it('skips and reports invalid timestamps of several kinds', async () => {
    const { parsed, out } = await parse(
      wrap([
        record({ input_tokens: 1 }),
        record({ input_tokens: 2, timestamp: 'yesterday' }),
        record({ input_tokens: 3, timestamp: '03/04/2026' }),
        record({ input_tokens: 4, timestamp: null }),
        { model: 'claude-opus-4-6', input_tokens: 5 },
        record({ input_tokens: 6, timestamp: '2026-02-30' }),
        record({ input_tokens: 7, timestamp: true }),
        record({ input_tokens: 8, timestamp: { $date: '2026-03-01' } }),
        record({ input_tokens: 9, timestamp: '2026-03-02' }),
        record({ input_tokens: 10, timestamp: 1772532000 }),
        record({ input_tokens: 11, timestamp: 1772532000000 }),
        record({ input_tokens: 12, timestamp: 17 }),
        record({ input_tokens: 13, timestamp: '2031-01-01T00:00:00Z' }),
      ]),
    );
    expect(out.usage.map((u) => [u.inputTokens, u.occurredAt, u.bucketSeconds])).toEqual([
      [1, '2026-03-01T10:00:00.000Z', 0],
      [9, '2026-03-02T00:00:00.000Z', 86400],
      [10, '2026-03-03T10:00:00.000Z', 0],
      // the same instant, given in milliseconds
      [11, '2026-03-03T10:00:00.000Z', 0],
    ]);
    expect(warning(parsed, 'invalid_timestamp')).toMatchObject({ count: 7, sample: 'yesterday (record 2)' });
    expect(warning(parsed, 'timestamp_out_of_range')).toMatchObject({ count: 2, sample: '17 (record 12)' });
    expect(warning(parsed, 'duplicate_rows')).toBeUndefined();
    expect(parsed.recordsSeen).toBe(13);
  });

  it('rejects negative and non-numeric counts, handles totals and duplicates', async () => {
    const { parsed, out } = await parse(
      wrap([
        record({ id: 'ok' }),
        record({ id: 'neg', output_tokens: -3 }),
        record({ id: 'text', input_tokens: 'many' }),
        record({ id: 'fraction', input_tokens: 10.5 }),
        record({ id: 'bool', input_tokens: true }),
        record({ id: 'ok' }),
        { timestamp: '2026-03-05', model: 'claude-opus-4-6', total_tokens: 4200, id: 'total' },
        'not a record',
        null,
        [1, 2],
        record({ id: 'tier', price_tier: 'Batch' }),
      ]),
    );
    expect(out.usage.map((u) => [u.dedupKey, u.inputTokens, u.priceTier])).toEqual([
      ['generic:ok', 100, 'standard'],
      ['generic:total', 4200, 'uncategorised'],
      ['generic:tier', 100, 'batch'],
    ]);
    expect(warning(parsed, 'negative_value')).toMatchObject({ count: 1, sample: 'output_tokens: -3 (record 2)' });
    expect(warning(parsed, 'invalid_number')).toMatchObject({ count: 3, sample: 'input_tokens: many (record 3)' });
    expect(warning(parsed, 'duplicate_ids')).toMatchObject({ count: 1, sample: 'ok (record 6)' });
    expect(warning(parsed, 'total_only')).toMatchObject({ count: 1, sample: '4200 tokens (record 7)' });
    expect(warning(parsed, 'not_a_record')).toMatchObject({ count: 3, sample: 'a string (record 8)' });
    expect(parsed.recordsSeen).toBe(11);
    expect(parsed.recordsSkipped).toBe(8);
  });

  it('counts identical records without an id once', async () => {
    const { parsed, out } = await parse(JSON.stringify([record(), record(), record({ output_tokens: 11 }), record()]));
    expect(out.usage.map((u) => u.outputTokens)).toEqual([10, 11]);
    expect(warning(parsed, 'duplicate_rows')).toMatchObject({ count: 2 });
  });

  it('keeps unknown models and builds conversations', async () => {
    const { out } = await parse(
      JSON.stringify([
        record({ model: 'claude-nova-9-20270101', conversation_id: 'c1', conversation_title: 'One' }),
        record({ model: 'claude-nova-9-20270101', conversation_id: 'c1', timestamp: '2026-03-04T00:00:00Z' }),
        record({ model: 12345, timestamp: '2026-03-05T00:00:00Z' }),
      ]),
    );
    expect(out.models).toEqual([{ key: 'claude-nova-9', displayName: 'claude-nova-9-20270101', family: 'other', tokenizerFamily: 'unknown' }]);
    expect(out.usage.map((u) => u.modelKey)).toEqual(['claude-nova-9', 'claude-nova-9', null]);
    expect(out.conversations).toEqual([
      { dedupKey: 'generic::c1', kind: 'usage_bucket', externalId: 'c1', title: 'One', projectLabel: null, modelKey: 'claude-nova-9', createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-04T00:00:00.000Z' },
    ]);
  });

  it('streams a large array record by record', async () => {
    const count = 20_000;
    const records = Array.from({ length: count }, (_, i) => ({ timestamp: 1767225600 + i * 60, model: 'claude-opus-4-6', input_tokens: i, output_tokens: 1, id: `r${i}` }));
    const { out, sink } = collectingSink();
    const file = fileOf('big.json', JSON.stringify(records));
    const parsed = await genericJsonParser.parse([file], sink, { options: { now: NOW } });
    expect(out.usage).toHaveLength(count);
    expect(out.usage[count - 1]).toMatchObject({ inputTokens: count - 1, dedupKey: `generic:r${count - 1}` });
    expect(parsed.stats).toMatchObject({ rows: count, layout: 'array' });
    expect(out.progress.at(-1)).toMatchObject({ phase: 'Reading records', bytesRead: file.size, totalBytes: file.size, records: count });
  });
});

describe('generic JSON: files that are something else', () => {
  it('explains what is wrong', async () => {
    expect(await codeOf(parse(''))).toBe('empty_file');
    expect(await codeOf(genericJsonParser.parse([], collectingSink().sink, {}))).toBe('no_files');
    expect(await codeOf(parse('timestamp,model\n2026-01-01,x\n'))).toBe('invalid_json');
    expect(await codeOf(parse('{"records": [{"timestamp": "2026-01-01", "input_tokens": 5},'))).toBe('invalid_json');

    const otherFormat = await errorOf(parse(JSON.stringify({ format: 'somebody-else/v2', records: [] })));
    expect(otherFormat.code).toBe('wrong_format');
    expect(otherFormat.message).toMatch(/"somebody-else\/v2"/);
    const newer = await errorOf(parse(wrap([record()], { version: 2 })));
    expect(newer.code).toBe('unsupported_version');
    expect(newer.message).toMatch(/version 2/);

    const empty = await errorOf(parse(wrap([])));
    expect(empty.code).toBe('no_rows');
    expect(empty.message).toMatch(/"timestamp"/);
    expect(await codeOf(parse('[]'))).toBe('no_rows');

    // a claude.ai export, or any other list of objects
    const conversations = await errorOf(parse(JSON.stringify([{ uuid: 'c1', name: 'Chat', chat_messages: [] }, { uuid: 'c2', name: 'Chat', chat_messages: [] }])));
    expect(conversations.code).toBe('no_valid_rows');
    expect(conversations.message).toMatch(/None of the 2 rows could be imported/);
    expect(conversations.message).toMatch(/Each record needs a "timestamp"/);

    // an API report belongs to the other importer
    const report = readFileSync(new URL('../fixtures/api-reports/usage-report.doc-example.json', import.meta.url));
    const wrong = await errorOf(parse(report));
    expect(wrong.code).toBe('wrong_format');
    expect(wrong.message).toMatch(/API usage report/);
  });

  it('reports a file that was cut off but keeps what is complete', async () => {
    const records = [record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c' })];
    const text = JSON.stringify(records);
    const cut = text.slice(0, text.lastIndexOf('{') + 20);
    const { parsed, out } = await parse(cut);
    expect(out.usage.map((u) => u.dedupKey)).toEqual(['generic:a', 'generic:b']);
    expect(warning(parsed, 'truncated_file')).toMatchObject({ count: 1 });
  });
});

describe('detectJsonFormat', () => {
  it('recognises the app\'s own format in its three layouts', () => {
    const wrapped = JSON.parse(fixture('usage.json').toString('utf8'));
    expect(detectJsonFormat(wrapped)).toBe('claude-lifetime/usage');
    expect(detectJsonFormat(wrapped.records)).toBe('claude-lifetime/usage');
    // the first line of a JSON Lines file
    expect(detectJsonFormat(wrapped.records[0])).toBe('claude-lifetime/usage');
    expect(detectJsonFormat({ format: 'claude-lifetime/usage', version: 1, records: [] })).toBe('claude-lifetime/usage');
    expect(detectJsonFormat({ records: [{ timestamp: '2026-01-01', total_tokens: 5 }] })).toBe('claude-lifetime/usage');
    expect(isGenericUsageJson([{ timestamp: 1772532000, output_tokens: 5 }])).toBe(true);
  });

  it('gives API reports precedence and returns null for everything else', () => {
    const page = JSON.parse(readFileSync(new URL('../fixtures/api-reports/analytics-usage.doc-example.json', import.meta.url), 'utf8'));
    expect(detectJsonFormat(page)).toBe('anthropic/analytics-usage');
    expect(detectJsonFormat(JSON.parse(readFileSync(new URL('../fixtures/api-reports/cost-report.doc-example.json', import.meta.url), 'utf8')))).toBe('anthropic/cost-report');
    for (const value of [
      null,
      42,
      'text',
      [],
      {},
      [{ uuid: 'c1', name: 'Chat', chat_messages: [] }],
      [{ timestamp: '2026-01-01' }],
      { timestamp: '2026-01-01', message: 'hello' },
      [{ input_tokens: 5 }],
      { format: 'somebody-else/v2', records: [{ timestamp: '2026-01-01', input_tokens: 5 }] },
      { records: [] },
      { records: 'x' },
      [[{ timestamp: '2026-01-01', input_tokens: 5 }]],
    ]) {
      expect(detectJsonFormat(value), JSON.stringify(value)).toBeNull();
    }
  });
});
