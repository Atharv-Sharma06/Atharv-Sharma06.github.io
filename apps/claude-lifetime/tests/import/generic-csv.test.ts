import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParsedImport, ParseWarning, StagedConversation, StagedUsage } from '@/core/types';
import { genericCsvParser, previewCsv } from '@/import/generic';
import { collectingSink, fileOf } from '../helpers/sink';

/** tests/fixtures/generic/usage.csv is the example of the documented CSV shape (invented data). */
const fixture = (name: string) => readFileSync(new URL(`../fixtures/generic/${name}`, import.meta.url));

/** "Now" for the importer: timestamps later than the day after are refused. */
const NOW = Date.UTC(2026, 10, 10);

async function parse(content: string | Uint8Array | Array<string | Uint8Array>, options: Record<string, unknown> = {}) {
  const { out, sink } = collectingSink();
  const files = (Array.isArray(content) ? content : [content]).map((c, i) => fileOf(`usage-${i + 1}.csv`, c));
  const parsed = await genericCsvParser.parse(files, sink, { options: { now: NOW, ...options } });
  return { parsed, out };
}
const errorOf = (promise: Promise<unknown>) => promise.then(() => ({ code: 'no error', message: '' }), (e) => e as { code: string; message: string });
const codeOf = async (promise: Promise<unknown>) => (await errorOf(promise)).code;
const warning = (parsed: ParsedImport, code: string): ParseWarning | undefined => parsed.warnings.find((w) => w.code === code);

/** A file with the header `timestamp,model,input_tokens,output_tokens` and the given rows. */
const simple = (...rows: string[]) => `timestamp,model,input_tokens,output_tokens\n${rows.join('\n')}\n`;

describe('generic CSV: the documented shape', () => {
  it('imports every field of the example file', async () => {
    const bytes = fixture('usage.csv');
    const { parsed, out } = await parse(bytes);

    const base = { userMessageCount: 0, assistantMessageCount: 0, webSearchRequests: 0, confidence: 'estimated' as const };
    expect(out.usage).toEqual<StagedUsage[]>([
      {
        ...base, conversationKey: 'generic::conv-1', modelKey: 'claude-sonnet-4-6', occurredAt: '2026-03-01T09:15:00.000Z', bucketSeconds: 0, priceTier: 'standard',
        inputTokens: 1200, outputTokens: 350, cacheReadTokens: 8000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requestCount: 1, dedupKey: 'generic:req-0001',
      },
      {
        // +01:00 is converted to UTC
        ...base, conversationKey: 'generic::conv-1', modelKey: 'claude-sonnet-4-6', occurredAt: '2026-03-01T09:20:30.000Z', bucketSeconds: 0, priceTier: 'standard',
        inputTokens: 2200, outputTokens: 410, cacheReadTokens: 9100, cacheWrite5mTokens: 500, cacheWrite1hTokens: 0, requestCount: 1, dedupKey: 'generic:req-0002',
      },
      {
        // a date stands for the whole UTC day
        ...base, conversationKey: null, modelKey: 'claude-opus-4-6', occurredAt: '2026-03-02T00:00:00.000Z', bucketSeconds: 86400, priceTier: 'batch',
        inputTokens: 50000, outputTokens: 12000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requestCount: 40, dedupKey: 'generic:day-2026-03-02',
      },
      {
        // epoch seconds, an explicit bucket width, a dated model id, an empty price tier
        ...base, conversationKey: 'generic::conv-2', modelKey: 'claude-haiku-4-5', occurredAt: '2026-03-03T10:00:00.000Z', bucketSeconds: 60, priceTier: 'standard',
        inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 250, requestCount: 1, dedupKey: 'generic:req-0003',
      },
    ]);
    expect(out.conversations).toEqual<StagedConversation[]>([
      {
        dedupKey: 'generic::conv-1', kind: 'usage_bucket', externalId: 'conv-1', title: 'Refactoring notes', projectLabel: null, modelKey: 'claude-sonnet-4-6',
        createdAt: '2026-03-01T09:15:00.000Z', updatedAt: '2026-03-01T09:20:30.000Z',
      },
      {
        dedupKey: 'generic::conv-2', kind: 'usage_bucket', externalId: 'conv-2', title: 'Quoted, title', projectLabel: null, modelKey: 'claude-haiku-4-5',
        createdAt: '2026-03-03T10:00:00.000Z', updatedAt: '2026-03-03T10:00:00.000Z',
      },
    ]);
    expect(out.models).toEqual([]);
    expect(out.messages).toEqual([]);

    expect(parsed).toMatchObject({
      format: 'generic/csv',
      parserVersion: 'generic-1',
      source: { kind: 'generic_csv', label: 'Custom usage data', externalRef: '' },
      fileName: 'usage-1.csv',
      fileSize: bytes.length,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      recordsSeen: 4,
      recordsSkipped: 0,
      missingFields: [],
      warnings: [],
    });
    // rows are deduplicated by key, not replaced by range
    expect(parsed.replaceRanges).toBeUndefined();
    expect(parsed.stats).toMatchObject({
      rows: 4,
      tokens: 85010,
      conversations: 2,
      totalOnlyRows: 0,
      confidence: 'estimated',
      delimiter: 'comma',
      firstTimestamp: '2026-03-01T09:15:00.000Z',
      lastTimestamp: '2026-03-03T10:00:00.000Z',
    });
    expect(parsed.stats.mapping).toContain('timestamp=timestamp, model=model, input_tokens=input_tokens');
  });

  it('takes the confidence, the label and the reference of the source from the options', async () => {
    const text = fixture('usage.csv').toString('utf8');
    expect((await parse(text)).out.usage.every((u) => u.confidence === 'estimated')).toBe(true);
    expect((await parse(text, { confidence: 'estimated' })).out.usage.every((u) => u.confidence === 'estimated')).toBe(true);
    const exact = await parse(text, { confidence: 'exact', sourceLabel: '  Gateway logs  ', sourceRef: 'gateway-eu' });
    expect(exact.out.usage.every((u) => u.confidence === 'exact')).toBe(true);
    expect(exact.parsed.source).toEqual({ kind: 'generic_csv', label: 'Gateway logs', externalRef: 'gateway-eu' });
    expect(exact.parsed.stats.confidence).toBe('exact');
    // the reference scopes the keys, so two sources with the same ids do not collide
    expect(exact.out.usage.map((u) => u.dedupKey)).toEqual(['generic:gateway-eu:req-0001', 'generic:gateway-eu:req-0002', 'generic:gateway-eu:day-2026-03-02', 'generic:gateway-eu:req-0003']);
    expect(exact.out.usage.map((u) => u.conversationKey)).toEqual(['generic:gateway-eu:conv-1', 'generic:gateway-eu:conv-1', null, 'generic:gateway-eu:conv-2']);
    expect(exact.out.conversations.map((c) => c.dedupKey)).toEqual(['generic:gateway-eu:conv-1', 'generic:gateway-eu:conv-2']);

    expect(await codeOf(parse(text, { confidence: 'certain' }))).toBe('invalid_option');
    expect(await codeOf(parse(text, { mapping: 'timestamp' }))).toBe('invalid_option');
  });

  it('gives every row the same key each time the file is read', async () => {
    const text = simple('2026-03-01T10:00:00Z,claude-sonnet-4-6,1200,300', '2026-03-01T10:05:00Z,claude-sonnet-4-6,1200,300', '2026-03-02,claude-opus-4-6,10,20');
    const first = await parse(text);
    const second = await parse(text);
    const keys = first.out.usage.map((u) => u.dedupKey);
    expect(second.out.usage.map((u) => u.dedupKey)).toEqual(keys);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^generic:[0-9a-f]{64}$/);
    // the key follows the content, not the position or the confidence the user declares
    const reordered = await parse(simple('2026-03-02,claude-opus-4-6,10,20', '2026-03-01T10:00:00Z,claude-sonnet-4-6,1200,300'), { confidence: 'exact' });
    expect(reordered.out.usage.map((u) => u.dedupKey)).toEqual([keys[2], keys[0]]);
    // ... and another source reference gives other keys
    const other = await parse(text, { sourceRef: 'elsewhere' });
    expect(other.out.usage.some((u) => keys.includes(u.dedupKey))).toBe(false);
  });
});

describe('generic CSV: column mapping', () => {
  const custom = 'Date;Model Name;Prompt Tokens;Completion Tokens;Cached Tokens;Cost (USD)\n2026-02-01;claude-sonnet-4-6;1.000;200;5000;0,12\n2026-02-02;claude-opus-4-6;300;40;;0,01\n';

  it('maps columns by their usual names when no mapping is given', async () => {
    const { parsed, out } = await parse(custom.replace('1.000', '1000'));
    expect(out.usage.map((u) => [u.occurredAt.slice(0, 10), u.modelKey, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.bucketSeconds])).toEqual([
      ['2026-02-01', 'claude-sonnet-4-6', 1000, 200, 5000, 86400],
      ['2026-02-02', 'claude-opus-4-6', 300, 40, 0, 86400],
    ]);
    expect(parsed.stats).toMatchObject({ delimiter: 'semicolon', mapping: 'timestamp=Date, model=Model Name, input_tokens=Prompt Tokens, output_tokens=Completion Tokens, cache_read_tokens=Cached Tokens' });
  });

  it('uses the mapping chosen by the user, and only that', async () => {
    const text = 'When,Engine,In,Out,model,Total\n2026-02-01T08:00:00Z,claude-opus-4-6,10,20,claude-sonnet-4-6,999\n';
    const mapped = await parse(text, { mapping: { timestamp: 'When', model: 'Engine', input_tokens: 'In', output_tokens: 'Out' } });
    expect(mapped.out.usage.map((u) => [u.modelKey, u.inputTokens, u.outputTokens, u.priceTier])).toEqual([['claude-opus-4-6', 10, 20, 'standard']]);
    expect(mapped.parsed.stats.mapping).toBe('timestamp=When, model=Engine, input_tokens=In, output_tokens=Out');

    // a field the user left out stays out, even though a column "model" exists
    const withoutModel = await parse(text, { mapping: { timestamp: 'When', total_tokens: 'Total' } });
    expect(withoutModel.out.usage.map((u) => [u.modelKey, u.inputTokens, u.priceTier])).toEqual([[null, 999, 'uncategorised']]);
    expect(withoutModel.parsed.missingFields).toEqual(['model', 'input_tokens', 'output_tokens']);
  });

  it('refuses a file or a mapping that cannot work, in words the user can act on', async () => {
    const noTime = await errorOf(parse('model,input_tokens\nclaude-opus-4-6,5\n'));
    expect(noTime.code).toBe('missing_timestamp_column');
    expect(noTime.message).toMatch(/first row of the file must contain the column names \(it has: model, input_tokens\)/);

    // a file without a header row
    expect(await codeOf(parse('2026-02-01,claude-opus-4-6,5,6\n2026-02-02,claude-opus-4-6,7,8\n'))).toBe('missing_timestamp_column');
    expect(await codeOf(parse('timestamp,model,cost\n2026-02-01,claude-opus-4-6,5\n'))).toBe('no_token_columns');
    const missing = await errorOf(parse(simple('2026-02-01,m,1,2'), { mapping: { timestamp: 'Date', input_tokens: 'input_tokens' } }));
    expect(missing.code).toBe('mapping_column_not_found');
    expect(missing.message).toMatch(/"Date" chosen for "timestamp" is not in the file/);
    expect(await codeOf(parse(simple('2026-02-01,m,1,2'), { mapping: { timestamp: 'timestamp', input_tokens: 'input_tokens', total_tokens: 'input_tokens' } }))).toBe('column_mapped_twice');
    expect(await codeOf(parse(simple('2026-02-01,m,1,2'), { mapping: { timestamp: 'timestamp', input_tokens: 'input_tokens', price: 'model' } }))).toBe('unknown_mapping_field');
  });

  it('previews header, sample rows and the proposed mapping without reading the whole file', async () => {
    const big = new Blob([custom, '2026-02-03;claude-opus-4-6;1;1;;0\n'.repeat(50_000)]);
    const preview = await previewCsv(big, { rows: 3 });
    expect(preview.header).toEqual(['Date', 'Model Name', 'Prompt Tokens', 'Completion Tokens', 'Cached Tokens', 'Cost (USD)']);
    expect(preview.delimiter).toBe(';');
    expect(preview.sampleRows).toEqual([
      ['2026-02-01', 'claude-sonnet-4-6', '1.000', '200', '5000', '0,12'],
      ['2026-02-02', 'claude-opus-4-6', '300', '40', '', '0,01'],
      ['2026-02-03', 'claude-opus-4-6', '1', '1', '', '0'],
    ]);
    expect(preview.detected.mapping).toEqual({ timestamp: 'Date', model: 'Model Name', input_tokens: 'Prompt Tokens', output_tokens: 'Completion Tokens', cache_read_tokens: 'Cached Tokens' });
    expect(preview.detected.unmappedColumns).toEqual(['Cost (USD)']);
    expect(preview.detected.problems).toEqual([]);

    const unmappable = await previewCsv(new Blob(['a,b\n1,2\n']));
    expect(unmappable.detected.problems.map((p) => p.code)).toEqual(['missing_timestamp_column', 'no_token_columns']);
    expect(await codeOf(previewCsv(new Blob([''])))).toBe('empty_file');
  });
});

describe('generic CSV: timestamps', () => {
  it('accepts ISO date-times with and without offset, dates and epochs', async () => {
    const { parsed, out } = await parse(
      simple(
        '2026-03-01T14:30:00Z,m1,1,1',
        '2026-03-01T14:30:00,m2,1,1',
        '2026-03-01 14:30,m3,1,1',
        '2026-03-01T14:30:00+02:00,m4,1,1',
        '2026-03-01T14:30:00.250-08:00,m5,1,1',
        '2026-03-01,m6,1,1',
        '1772532000,m7,1,1',
        '1772532000000,m8,1,1',
      ),
    );
    expect(out.usage.map((u) => [u.occurredAt, u.bucketSeconds])).toEqual([
      ['2026-03-01T14:30:00.000Z', 0],
      ['2026-03-01T14:30:00.000Z', 0],
      ['2026-03-01T14:30:00.000Z', 0],
      ['2026-03-01T12:30:00.000Z', 0],
      ['2026-03-01T22:30:00.250Z', 0],
      ['2026-03-01T00:00:00.000Z', 86400],
      ['2026-03-03T10:00:00.000Z', 0],
      ['2026-03-03T10:00:00.000Z', 0],
    ]);
    expect(parsed.recordsSkipped).toBe(0);
  });

  it('lets bucket_seconds override the default width, also for dates', async () => {
    const { out } = await parse('timestamp,input_tokens,bucket_seconds\n2026-03-01,5,\n2026-03-01,6,604800\n2026-03-02T10:00:00Z,7,3600\n2026-03-02T11:00:00Z,8,0\n2026-03-02T12:00:00Z,9,an hour\n');
    expect(out.usage.map((u) => [u.inputTokens, u.bucketSeconds])).toEqual([[5, 86400], [6, 604800], [7, 3600], [8, 0], [9, 0]]);
  });

  it('skips rows whose timestamp cannot be read and reports them with one sample', async () => {
    const { parsed, out } = await parse(
      simple(
        '2026-03-01T10:00:00Z,m,1,1',
        ',m,2,1',
        'yesterday,m,3,1',
        '03/04/2026,m,4,1',
        '2026-13-01,m,5,1',
        '2026-02-30,m,6,1',
        '2026-03-01T25:00:00Z,m,7,1',
        '14:30,m,8,1',
        '2026-03-02T10:00:00Z,m,9,1',
      ),
    );
    expect(out.usage.map((u) => u.inputTokens)).toEqual([1, 9]);
    expect(parsed.recordsSeen).toBe(9);
    expect(parsed.recordsSkipped).toBe(7);
    const invalid = warning(parsed, 'invalid_timestamp');
    expect(invalid).toMatchObject({ count: 7, sample: '(empty) (line 3)' });
    expect(invalid?.message).toMatch(/ISO 8601/);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('skips dates no Claude usage can have, which usually means a wrong column', async () => {
    const { parsed, out } = await parse(simple('2026-03-01,m,1,1', '1999-12-31,m,2,1', '12345,m,3,1', '2020-12-31T23:59:59Z,m,4,1', '2026-11-12,m,5,1', '2031-01-01,m,6,1', '2021-01-01,m,7,1', '2026-11-10T23:00:00Z,m,8,1'));
    // 2021-01-01 is the earliest accepted day; "now" is 2026-11-10 and a day of slack is allowed
    expect(out.usage.map((u) => u.inputTokens)).toEqual([1, 7, 8]);
    expect(warning(parsed, 'timestamp_out_of_range')).toMatchObject({ count: 5, sample: '1999-12-31 (line 3)' });
  });
});

describe('generic CSV: counts', () => {
  it('rejects negative and non-numeric token values, row by row', async () => {
    const { parsed, out } = await parse(
      'timestamp,model,input_tokens,output_tokens,cache_read_tokens,requests\n' +
        '2026-03-01,m,100,10,,1\n' +
        '2026-03-02,m,-100,10,,1\n' +
        '2026-03-03,m,100,-1,,1\n' +
        '2026-03-04,m,100,10,-7,1\n' +
        '2026-03-05,m,abc,10,,1\n' +
        '2026-03-06,m,12.5,10,,1\n' +
        '2026-03-07,m,100,10,,many\n' +
        '2026-03-08,m,100,10,,3000000000\n' +
        '2026-03-09,m,"1,234",1234.0,1e3,2\n' +
        '2026-03-10,m,,,,\n' +
        '2026-03-11,m,0,0,0,0\n',
    );
    expect(out.usage.map((u) => [u.occurredAt.slice(8, 10), u.inputTokens, u.outputTokens, u.cacheReadTokens, u.requestCount])).toEqual([
      ['01', 100, 10, 0, 1],
      ['09', 1234, 1234, 1000, 2],
      // explicit zeros are a statement; a row without any number is not
      ['11', 0, 0, 0, 0],
    ]);
    expect(parsed.recordsSeen).toBe(11);
    expect(parsed.recordsSkipped).toBe(8);
    expect(warning(parsed, 'negative_value')).toMatchObject({ count: 3, sample: 'input_tokens: -100 (line 3)' });
    expect(warning(parsed, 'invalid_number')).toMatchObject({ count: 4, sample: 'input_tokens: abc (line 6)' });
    expect(warning(parsed, 'no_usage_values')).toMatchObject({ count: 1, sample: '2026-03-10 (line 11)' });
  });

  it('stores a bare total as uncategorised input tokens and warns once', async () => {
    const { parsed, out } = await parse(
      'timestamp,model,input_tokens,output_tokens,total_tokens,price_tier\n' +
        '2026-03-01,claude-opus-4-6,,,5000,\n' +
        '2026-03-02,claude-opus-4-6,0,0,7000,batch\n' +
        '2026-03-03,claude-opus-4-6,300,200,500,\n' +
        '2026-03-04,claude-opus-4-6,300,200,,batch\n' +
        '2026-03-05,claude-opus-4-6,300,200,900,\n',
    );
    expect(out.usage.map((u) => [u.inputTokens, u.outputTokens, u.priceTier])).toEqual([
      // never priced: no price exists for the tier "uncategorised", whatever tier the row names
      [5000, 0, 'uncategorised'],
      [7000, 0, 'uncategorised'],
      [300, 200, 'standard'],
      [300, 200, 'batch'],
      [300, 200, 'standard'],
    ]);
    const totalOnly = parsed.warnings.filter((w) => w.code === 'total_only');
    expect(totalOnly).toHaveLength(1);
    expect(totalOnly[0]).toMatchObject({ count: 2, sample: '5000 tokens (line 2)' });
    expect(totalOnly[0].message).toMatch(/never priced/);
    // the last row's total does not match its columns: the columns win, and it is said
    expect(warning(parsed, 'total_mismatch')).toMatchObject({ count: 1, sample: 'total 900, columns add up to 500 (line 6)' });
    expect(parsed.stats.totalOnlyRows).toBe(2);
    expect(parsed.missingFields).toEqual([]);

    const onlyTotals = await parse('date,tokens\n2026-03-01,5000\n2026-03-02,100\n');
    expect(onlyTotals.out.usage.map((u) => [u.inputTokens, u.priceTier, u.modelKey])).toEqual([[5000, 'uncategorised', null], [100, 'uncategorised', null]]);
    expect(onlyTotals.parsed.missingFields).toEqual(['model', 'input_tokens', 'output_tokens']);
  });

  it('puts cache writes of unknown lifetime in the 5-minute column, without counting a total twice', async () => {
    const { out } = await parse(
      'timestamp,input_tokens,cache_write_tokens,cache_write_5m_tokens,cache_write_1h_tokens\n' +
        '2026-03-01,1,400,,\n' +
        '2026-03-02,1,400,300,100\n' +
        '2026-03-03,1,,300,100\n' +
        '2026-03-04,1,1000,300,100\n' +
        '2026-03-05,1,50,300,100\n',
    );
    expect(out.usage.map((u) => [u.cacheWrite5mTokens, u.cacheWrite1hTokens])).toEqual([
      [400, 0],
      // the total is the sum of its breakdown: nothing is added
      [300, 100],
      [300, 100],
      // 600 tokens the breakdown does not account for
      [900, 100],
      [300, 100],
    ]);
    // without the breakdown columns the single column is all there is
    const single = await parse('timestamp,input_tokens,cache_creation_input_tokens\n2026-03-01,1,250\n');
    expect(single.out.usage[0]).toMatchObject({ cacheWrite5mTokens: 250, cacheWrite1hTokens: 0 });
  });

  it('normalises price tiers and reports the ones it has no prices for', async () => {
    const { parsed, out } = await parse('timestamp,input_tokens,tier\n2026-03-01,1,\n2026-03-02,1,Batch\n2026-03-03,1,long-context\n2026-03-04,1,FAST\n2026-03-05,1,priority_on_demand\n2026-03-06,1,Flex\n2026-03-07,1,enterprise\n2026-03-08,1,??\n');
    expect(out.usage.map((u) => u.priceTier)).toEqual(['standard', 'batch', 'long_context', 'fast', 'priority', 'flex', 'enterprise', 'uncategorised']);
    expect(warning(parsed, 'unknown_price_tier')).toMatchObject({ count: 2, sample: 'enterprise (line 8)' });
  });
});

describe('generic CSV: rows, models and conversations', () => {
  it('counts rows that repeat inside one file once', async () => {
    const { parsed, out } = await parse(simple('2026-03-01T10:00:00Z,claude-opus-4-6,100,10', '2026-03-01T10:00:00Z,claude-opus-4-6,100,10', '2026-03-01T10:00:01Z,claude-opus-4-6,100,10', '2026-03-01T10:00:00Z,claude-opus-4-6,100,10'));
    expect(out.usage.map((u) => u.occurredAt)).toEqual(['2026-03-01T10:00:00.000Z', '2026-03-01T10:00:01.000Z']);
    expect(parsed.recordsSeen).toBe(4);
    expect(parsed.recordsSkipped).toBe(2);
    const duplicates = warning(parsed, 'duplicate_rows');
    expect(duplicates?.count).toBe(2);
    expect(duplicates?.message).toMatch(/map it as "id"/);

    // with an id column the id decides: same id, different content -> the first one counts
    const withIds = await parse('id,timestamp,input_tokens\na,2026-03-01,100\nb,2026-03-01,100\na,2026-03-02,999\n,2026-03-03,5\n,2026-03-03,5\n');
    expect(withIds.out.usage.map((u) => [u.dedupKey.slice(0, 12), u.inputTokens])).toEqual([
      ['generic:a', 100],
      ['generic:b', 100],
      // rows without an id fall back to the hash of their content
      [expect.stringMatching(/^generic:[0-9a-f]{4}$/), 5],
    ]);
    expect(warning(withIds.parsed, 'duplicate_ids')).toMatchObject({ count: 1, sample: 'a (line 4)' });
    expect(warning(withIds.parsed, 'duplicate_rows')).toMatchObject({ count: 1 });
  });

  it('counts the same rows in two files of one import once', async () => {
    const text = simple('2026-03-01T10:00:00Z,claude-opus-4-6,100,10', '2026-03-02T10:00:00Z,claude-opus-4-6,200,20');
    const { parsed, out } = await parse([text, text]);
    expect(out.usage).toHaveLength(2);
    expect(parsed).toMatchObject({ recordsSeen: 4, recordsSkipped: 2, fileName: '2 files' });
    expect(parsed.contentHash).toBe(createHash('sha256').update(text).update(text).digest('hex'));
  });

  it('keeps unknown model identifiers, ignores values that are not identifiers', async () => {
    const prompt = 'Please summarise the attached contract and tell me whether clause seven is enforceable in Germany.';
    const { parsed, out } = await parse(
      simple('2026-03-01,claude-sonnet-4-5-20250929,1,1', '2026-03-02,gpt-4o,1,1', '2026-03-03,gpt-4o,1,1', '2026-03-04,,1,1', '2026-03-05,unknown,1,1', `2026-03-06,"${prompt}",1,1`, '2026-03-07,us.anthropic.claude-opus-4-1-20250805-v1:0,1,1'),
    );
    expect(out.usage.map((u) => u.modelKey)).toEqual(['claude-sonnet-4-5', 'gpt-4o', 'gpt-4o', null, null, null, 'claude-opus-4-1']);
    expect(out.models).toEqual([{ key: 'gpt-4o', displayName: 'gpt-4o', family: 'other', tokenizerFamily: 'unknown' }]);
    // a short display name of a few words is a model name; a long id without spaces is one too
    const names = await parse(simple('2026-03-01,Claude Sonnet 4.5,1,1', '2026-03-02,arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0,1,1', '2026-03-03,tell me a joke about the sea please,1,1'));
    expect(names.out.usage.map((u) => u.modelKey === null)).toEqual([false, false, true]);
    const invalid = warning(parsed, 'invalid_model');
    expect(invalid?.count).toBe(1);
    // the content of the cell is not repeated in the warning
    expect(invalid?.sample).toBe(`text of ${prompt.length} characters (line 7)`);
    expect(parsed.stats.unknownModels).toBe(1);
    expect(parsed.missingFields).toEqual([]);

    const junk = simple(...Array.from({ length: 250 }, (_, i) => `2026-03-01T00:${String(i % 60).padStart(2, '0')}:00Z,customer-${i},1,1`));
    expect(await codeOf(parse(junk))).toBe('too_many_models');
  });

  it('builds one conversation per id with its time span, latest title and first model', async () => {
    const { out } = await parse(
      'timestamp,model,input_tokens,conversation_id,conversation_title\n' +
        '2026-03-05T10:00:00Z,claude-opus-4-6,1,c1,First title\n' +
        '2026-03-01T10:00:00Z,claude-sonnet-4-6,1,c1,\n' +
        '2026-03-09T10:00:00Z,claude-sonnet-4-6,1,c1,Renamed\n' +
        '2026-03-02T10:00:00Z,,1,c2,\n' +
        '2026-03-03T10:00:00Z,claude-haiku-4-5,1,,Title without a conversation\n' +
        'not a date,claude-haiku-4-5,1,c3,Skipped row\n',
    );
    expect(out.conversations).toEqual<StagedConversation[]>([
      { dedupKey: 'generic::c1', kind: 'usage_bucket', externalId: 'c1', title: 'Renamed', projectLabel: null, modelKey: 'claude-opus-4-6', createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-09T10:00:00.000Z' },
      { dedupKey: 'generic::c2', kind: 'usage_bucket', externalId: 'c2', title: null, projectLabel: null, modelKey: null, createdAt: '2026-03-02T10:00:00.000Z', updatedAt: '2026-03-02T10:00:00.000Z' },
    ]);
    expect(out.usage.map((u) => u.conversationKey)).toEqual(['generic::c1', 'generic::c1', 'generic::c1', 'generic::c2', null]);
  });

  it('reads semicolon files with quotes, a byte order mark, padding rows and ragged rows', async () => {
    const text = '﻿timestamp;model;input_tokens;output_tokens;conversation_id;conversation_title\r\n' +
      '2026-03-01;claude-opus-4-6;100;10;c1;"Title; with ""quotes""\r\nand a line break"\r\n' +
      ';;;;;\r\n' +
      '2026-03-02;claude-opus-4-6;200\r\n' +
      '2026-03-03;claude-opus-4-6;300;30;c1;x;surplus\r\n';
    const { parsed, out } = await parse(text);
    expect(out.usage.map((u) => [u.inputTokens, u.outputTokens])).toEqual([[100, 10], [200, 0], [300, 30]]);
    expect(out.conversations[0].title).toBe('x');
    expect(parsed.recordsSeen).toBe(3);
    expect(parsed.stats.delimiter).toBe('semicolon');
    expect(warning(parsed, 'column_count_mismatch')).toMatchObject({ count: 2, sample: 'line 5: 3 values, 6 columns' });

    const tabs = await parse('timestamp\tinput_tokens\n2026-03-01\t5\n', { delimiter: '\t' });
    expect(tabs.out.usage[0].inputTokens).toBe(5);
    expect(tabs.parsed.stats.delimiter).toBe('tab');
  });
});

describe('generic CSV: files with nothing to import', () => {
  it('explains empty files and files whose rows are all unusable', async () => {
    expect(await codeOf(parse(''))).toBe('empty_file');
    expect(await codeOf(genericCsvParser.parse([], collectingSink().sink, {}))).toBe('no_files');
    expect(await codeOf(parse('\n\n'))).toBe('empty_file');
    const headerOnly = await errorOf(parse('timestamp,model,input_tokens,output_tokens\n'));
    expect(headerOnly.code).toBe('no_rows');
    expect(headerOnly.message).toMatch(/header row but no data rows/);

    const allBad = await errorOf(parse(simple('31/12/2025,m,1,1', '01/01/2026,m,1,1')));
    expect(allBad.code).toBe('no_valid_rows');
    expect(allBad.message).toMatch(/None of the 2 rows could be imported/);
    expect(allBad.message).toMatch(/For example: 31\/12\/2025 \(line 2\)/);
    expect(await codeOf(parse('timestamp,input_tokens\n"2026-03-01,1\n'))).toBe('csv_unclosed_quote');
  });

  it('reports progress and can be cancelled', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `${1767225600 + i * 60},claude-opus-4-6,${i},1`);
    const text = simple(...rows);
    const { out, sink } = collectingSink();
    const file = fileOf('big.csv', text);
    const parsed = await genericCsvParser.parse([file], sink, { options: { now: NOW } });
    expect(out.usage).toHaveLength(5000);
    expect(parsed.recordsSeen).toBe(5000);
    expect(out.progress.at(-1)).toMatchObject({ phase: 'Reading rows', bytesRead: file.size, totalBytes: file.size, records: 5000 });

    const controller = new AbortController();
    controller.abort();
    expect(await codeOf(genericCsvParser.parse([file], collectingSink().sink, { options: { now: NOW }, signal: controller.signal }))).toBe('cancelled');
  });
});
