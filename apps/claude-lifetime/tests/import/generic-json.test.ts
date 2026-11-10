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
    expect(parsed.replaceRanges).toBeUndefined();
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

  it('says that a count is too large, also when it is a number JSON has already rounded', async () => {
    const text = `[{"timestamp":"2026-03-01T10:00:00Z","input_tokens":9007199254740993},
      {"timestamp":"2026-03-01T10:00:01Z","input_tokens":5,"requests":3000000000},
      {"timestamp":"2026-03-01T10:00:02Z","input_tokens":5,"requests":"2"}]`;
    const { parsed, out } = await parse(text);
    expect(out.usage.map((u) => [u.inputTokens, u.requestCount])).toEqual([[5, 2]]);
    expect(warning(parsed, 'invalid_number')).toBeUndefined();
    const tooLarge = warning(parsed, 'number_too_large');
    expect(tooLarge).toMatchObject({ count: 2, sample: 'input_tokens: 9007199254740992 (record 1)' });
    expect(tooLarge?.message).toMatch(/^Rows with a token or request count that is too large were skipped/);
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

  it('reads a version written as text, and says plainly what is wrong with any other', async () => {
    for (const version of ['1', ' 1 ', '1.0', 1.0]) {
      expect((await parse(wrap([record()], { version }))).out.usage, JSON.stringify(version)).toHaveLength(1);
    }
    for (const version of [2, '2']) {
      const newer = await errorOf(parse(wrap([record()], { version })));
      expect(newer.code, JSON.stringify(version)).toBe('unsupported_version');
      expect(newer.message).toBe('The file is version 2 of the usage format; this version of the app reads version 1. Update the app, or export the data as version 1.');
    }
    // No file is told to update the app in order to read the version the app reads, or a version that does not exist.
    for (const version of ['one', '', null, true, 0, -1, { major: 1 }]) {
      const error = await errorOf(parse(wrap([record()], { version })));
      expect(error.code, JSON.stringify(version)).toBe('unsupported_version');
      expect(error.message, JSON.stringify(version)).toMatch(/^The file gives its "version" as .+, which is not a version of the usage format\. Write "version": 1, or leave the field out\.$/);
    }
    expect((await errorOf(parse(wrap([record()], { version: 'one' })))).message).toContain('as "one",');
  });

  it('refuses a wrapped file whose "records" are not a list, and names them', async () => {
    const keyed = await errorOf(parse(JSON.stringify({ format: 'claude-lifetime/usage', version: 1, records: { a: record() } })));
    expect(keyed.code).toBe('invalid_records');
    expect(keyed.message).toMatch(/^"records" in "usage-1\.json" is an object, not a list\. The usage records have to be a list in square brackets, for example "records": \[\{"timestamp": /);
    // It is not read as a single record that lacks its timestamp.
    expect(keyed.message).not.toMatch(/timestamp is missing|could be imported/);

    const missing = await errorOf(parse(JSON.stringify({ format: 'claude-lifetime/usage', version: 1 })));
    expect(missing.code).toBe('invalid_records');
    expect(missing.message).toMatch(/^"usage-1\.json" is marked as a "claude-lifetime\/usage" file but has no "records"\. The usage records have to be a list under "records", for example /);

    const text = await errorOf(parse(JSON.stringify({ records: 'none' })));
    expect(text.code).toBe('invalid_records');
    expect(text.message).toMatch(/^"records" in "usage-1\.json" is a string, not a list\./);

    // The format is looked at first: a file of another format is not told to repair its records.
    expect(await codeOf(parse(JSON.stringify({ format: 'somebody-else/v2', records: {} })))).toBe('wrong_format');

    // A record may have a field of that name. It is ignored like every other field the format does not know.
    const { parsed, out } = await parse([JSON.stringify(record({ records: 3 })), JSON.stringify(record({ records: 4, input_tokens: 2 }))].join('\n'));
    expect(out.usage.map((u) => u.inputTokens)).toEqual([100, 2]);
    expect(parsed.warnings).toEqual([]);
  });

  it('explains an import without usable records by what kept them out, not by a note about the file', async () => {
    // The first file was cut off inside its first record. The record of the second file has no timestamp.
    const error = await errorOf(parse(['[{"timestamp": "2026-03-0', JSON.stringify([{ model: 'claude-opus-4-6', input_tokens: 5 }])]));
    expect(error.code).toBe('no_valid_rows');
    expect(error.message).toMatch(/^None of the 1 row could be imported\. Rows whose timestamp is missing or cannot be read were skipped\./);
    expect(error.message).toMatch(/For example: \(empty\) \(record 1\)\./);
    expect(error.message).not.toMatch(/ends unexpectedly/);
  });
});

describe('generic JSON: the source a file names for itself', () => {
  const sourced = (source: Record<string, unknown> | null, records: unknown[]) => wrap(records, source === null ? {} : { source });
  // Two proxies, each numbering its requests from 1.
  const eu = sourced({ label: 'EU proxy', ref: 'proxy-eu-1' }, [record({ id: 'req-0001', input_tokens: 1000 }), record({ id: 'req-0002', input_tokens: 2000 })]);
  const us = sourced({ label: 'US proxy', ref: 'proxy-us-1' }, [
    record({ id: 'req-0001', input_tokens: 400 }),
    record({ id: 'req-0002', input_tokens: 500 }),
    record({ id: 'req-0003', input_tokens: 600 }),
  ]);
  const bare = JSON.stringify([record({ id: 'req-0004', input_tokens: 4000 })]);

  it('refuses files that name different sources, names both and says what to do', async () => {
    const error = await errorOf(parse([eu, us]));
    expect(error.code).toBe('mixed_sources');
    expect(error.message).toBe(
      '"usage-2.json" says its records come from "US proxy" (reference "proxy-us-1"), but the records read before it come from "EU proxy" (reference "proxy-eu-1"). ' +
        'One import is filed under one source. Import the files one at a time, so that each is filed under its own source.',
    );
    // Whichever file comes first, the second is not filed under the first one's source.
    const reversed = await errorOf(parse([us, eu]));
    expect(reversed.code).toBe('mixed_sources');
    expect(reversed.message).toMatch(/^"usage-2\.json" says its records come from "EU proxy" \(reference "proxy-eu-1"\), but the records read before it come from "US proxy" \(reference "proxy-us-1"\)\./);

    // Records without ids do not collide, and are still not filed under another file's source.
    const euWithoutIds = sourced({ label: 'EU proxy', ref: 'proxy-eu-1' }, [record({ input_tokens: 1000 })]);
    const usWithoutIds = sourced({ label: 'US proxy', ref: 'proxy-us-1' }, [record({ input_tokens: 400 })]);
    expect(await codeOf(parse([euWithoutIds, usWithoutIds]))).toBe('mixed_sources');

    // One at a time, each file keeps its own source and every one of its records.
    for (const [text, label, ref, count] of [[eu, 'EU proxy', 'proxy-eu-1', 2], [us, 'US proxy', 'proxy-us-1', 3]] as const) {
      const { parsed, out } = await parse(text);
      expect(parsed.source).toEqual({ kind: 'generic_json', label, externalRef: ref });
      expect(out.usage.map((u) => u.dedupKey)).toEqual(Array.from({ length: count }, (_, i) => `generic:${ref}:req-000${i + 1}`));
      expect(parsed.warnings).toEqual([]);
    }
  });

  it('reads files together that name the same source, or none', async () => {
    const more = sourced({ label: 'EU proxy', ref: 'proxy-eu-1' }, [record({ id: 'req-0003', input_tokens: 3000 })]);
    const referenceOnly = sourced({ ref: 'proxy-eu-1' }, [record({ id: 'req-0005', input_tokens: 5000 })]);
    const together = await parse([eu, more, bare, referenceOnly]);
    expect(together.parsed.source).toEqual({ kind: 'generic_json', label: 'EU proxy', externalRef: 'proxy-eu-1' });
    expect(together.out.usage.map((u) => u.dedupKey)).toEqual([1, 2, 3, 4, 5].map((n) => `generic:proxy-eu-1:req-000${n}`));
    expect(together.parsed.warnings).toEqual([]);

    // Files that name no source are the unnamed source, as before.
    const unnamed = await parse([bare, JSON.stringify([record({ id: 'req-0009' })])]);
    expect(unnamed.parsed.source).toEqual({ kind: 'generic_json', label: 'Custom usage data', externalRef: '' });
    expect(unnamed.out.usage.map((u) => u.dedupKey)).toEqual(['generic:req-0004', 'generic:req-0009']);

    // A name for records that have no reference can come late: nothing is filed differently because of it.
    const namedLate = await parse([bare, sourced({ label: 'Proxy' }, [record({ id: 'req-0006' })])]);
    expect(namedLate.parsed.source).toEqual({ kind: 'generic_json', label: 'Proxy', externalRef: '' });
    expect(namedLate.out.usage.map((u) => u.dedupKey)).toEqual(['generic:req-0004', 'generic:req-0006']);
  });

  it('refuses a source that is named after records were read without one', async () => {
    const error = await errorOf(parse([bare, us]));
    expect(error.code).toBe('mixed_sources');
    expect(error.message).toBe(
      '"usage-2.json" says its records come from "US proxy" (reference "proxy-us-1"), but the records read before it name no source. ' +
        'One import is filed under one source. Import the files one at a time, so that each is filed under its own source.',
    );
  });

  it('takes a label without a reference for a source of its own, not for the one it is selected with', async () => {
    // On its own this file is stored under no reference. It is not filed under "proxy-eu-1" because the names match.
    const labelOnly = sourced({ label: 'EU proxy' }, [record({ id: 'req-0007' })]);
    const error = await errorOf(parse([eu, labelOnly]));
    expect(error.code).toBe('mixed_sources');
    expect(error.message).toBe(
      '"usage-2.json" says its records come from "EU proxy" (no reference), but the records read before it come from "EU proxy" (reference "proxy-eu-1"). ' +
        'One import is filed under one source. Import the files one at a time, so that each is filed under its own source.',
    );
    // The same when the earlier file gave a reference and no name: the name is not put on that reference.
    const referenceThenName = await errorOf(parse([sourced({ ref: 'proxy-eu-1' }, [record({ id: 'a' })]), sourced({ label: 'Proxy' }, [record({ id: 'b' })])]));
    expect(referenceThenName.code).toBe('mixed_sources');
    expect(referenceThenName.message).toMatch(/come from "Proxy" \(no reference\), but the records read before it come from the source with the reference "proxy-eu-1"\./);
  });

  it('refuses a JSON Lines file whose parts name different sources', async () => {
    // Plain records first, then a wrapped document that names a source.
    const error = await errorOf(parse([JSON.stringify(record({ id: 'a' })), us].join('\n')));
    expect(error.code).toBe('mixed_sources');
    expect(error.message).toBe(
      '"usage-1.json" holds records of more than one source: some say they come from "US proxy" (reference "proxy-us-1"), but the records before them name no source. ' +
        'One import is filed under one source. Save the records of each source in a file of their own and import the files one at a time, so that each is filed under its own source.',
    );
    // Two wrapped documents, one per line.
    const twoDocuments = await errorOf(parse([eu, us].join('\n')));
    expect(twoDocuments.code).toBe('mixed_sources');
    expect(twoDocuments.message).toMatch(/some say they come from "US proxy" \(reference "proxy-us-1"\), but the records before them come from "EU proxy" \(reference "proxy-eu-1"\)\./);

    // Documents of one source in one file are read as before.
    const sameSource = await parse([eu, sourced({ label: 'EU proxy', ref: 'proxy-eu-1' }, [record({ id: 'req-0003' })])].join('\n'));
    expect(sameSource.out.usage.map((u) => u.dedupKey)).toEqual([1, 2, 3].map((n) => `generic:proxy-eu-1:req-000${n}`));
  });

  it('refuses another name for the same reference, and says that the two are one source', async () => {
    const renamed = sourced({ label: 'EU proxy (new)', ref: 'proxy-eu-1' }, [record({ id: 'req-0003' })]);
    const error = await errorOf(parse([eu, renamed]));
    expect(error.code).toBe('mixed_sources');
    expect(error.message).toBe(
      '"usage-2.json" says its records come from "EU proxy (new)" (reference "proxy-eu-1"), but the records read before it come from "EU proxy" (reference "proxy-eu-1"). ' +
        'One import is filed under one source. Import the files one at a time. Files with the same "ref", or without one, are stored as one source, shown under the name that was imported last; ' +
        'give each its own "ref" to keep them apart.',
    );
    const labelsOnly = await errorOf(parse([sourced({ label: 'Laptop' }, [record({ id: '1' })]), sourced({ label: 'Server' }, [record({ id: '2' })])]));
    expect(labelsOnly.code).toBe('mixed_sources');
    expect(labelsOnly.message).toMatch(/^"usage-2\.json" says its records come from "Server" \(no reference\), but the records read before it come from "Laptop" \(no reference\)\./);
  });

  it('takes label and reference from the same document when one without records comes first', async () => {
    const header = sourced({ label: 'Header', ref: 'header-ref' }, []);
    // Nothing was filed under the first document's source, so the second names the source: its label and its reference.
    expect((await parse([header, us])).parsed.source).toEqual({ kind: 'generic_json', label: 'US proxy', externalRef: 'proxy-us-1' });
    // A reference without a name does not get the name of the document before it.
    expect((await parse([header, sourced({ ref: 'other' }, [record({ id: 'a' })])])).parsed.source).toEqual({ kind: 'generic_json', label: 'Custom usage data', externalRef: 'other' });

    // A header line followed by plain records, as a tool that streams its export writes them.
    const stream = await parse([sourced({ label: 'Stream', ref: 'stream-1' }, []), JSON.stringify(record({ id: 'a' })), JSON.stringify(record({ id: 'b' }))].join('\n'));
    expect(stream.parsed.source).toEqual({ kind: 'generic_json', label: 'Stream', externalRef: 'stream-1' });
    expect(stream.out.usage.map((u) => u.dedupKey)).toEqual(['generic:stream-1:a', 'generic:stream-1:b']);
  });

  it('files everything under the source chosen in the UI, whatever the files say', async () => {
    const { parsed, out } = await parse([eu, us], { sourceLabel: 'All proxies', sourceRef: 'all-proxies' });
    expect(parsed.source).toEqual({ kind: 'generic_json', label: 'All proxies', externalRef: 'all-proxies' });
    expect(out.usage.map((u) => u.dedupKey)).toEqual(['generic:all-proxies:req-0001', 'generic:all-proxies:req-0002', 'generic:all-proxies:req-0003']);
    expect(warning(parsed, 'duplicate_ids')).toMatchObject({ count: 2 });
  });
});

describe('generic JSON: ids written as numbers', () => {
  it('does not use a number that cannot be read exactly as an id, and keeps the record', async () => {
    // 64-bit ids written as JSON numbers. JSON.parse keeps 53 bits, so all three arrive as 1234567890123456800.
    const text = `[{"timestamp":"2026-03-01T09:15:00Z","input_tokens":100,"id":1234567890123456789},
      {"timestamp":"2026-03-01T09:15:01Z","input_tokens":200,"id":1234567890123456790},
      {"timestamp":"2026-03-01T09:15:02Z","input_tokens":300,"id":1234567890123456791}]`;
    const { parsed, out } = await parse(text);
    expect(out.usage.map((u) => u.inputTokens)).toEqual([100, 200, 300]);
    // Each record is identified by its content, like a record without an id.
    for (const u of out.usage) expect(u.dedupKey).toMatch(/^generic:[0-9a-f]{64}$/);
    expect(new Set(out.usage.map((u) => u.dedupKey)).size).toBe(3);
    expect(parsed.recordsSkipped).toBe(0);
    expect(parsed.warnings.map((w) => w.code)).toEqual(['inexact_numeric_id']);
    const note = warning(parsed, 'inexact_numeric_id');
    expect(note).toMatchObject({ count: 3, sample: 'id read as 1234567890123456800 (record 1)' });
    expect(note?.message).toMatch(/were not used/);
    expect(note?.message).toMatch(/Write ids of this size as text, in quotation marks\.$/);

    // The same keys every time the file is read, so importing it again adds nothing.
    expect((await parse(text)).out.usage.map((u) => u.dedupKey)).toEqual(out.usage.map((u) => u.dedupKey));

    // Written as text, the same ids are exact and are used.
    const asText = await parse(text.replace(/"id":(\d+)/g, '"id":"$1"'));
    expect(asText.out.usage.map((u) => u.dedupKey)).toEqual(['generic:1234567890123456789', 'generic:1234567890123456790', 'generic:1234567890123456791']);
    expect(asText.parsed.warnings).toEqual([]);
  });

  it('leaves such a conversation id out instead of merging conversations', async () => {
    const text = `[{"timestamp":"2026-03-01T09:15:00Z","input_tokens":100,"conversation_id":12345678901234567890},
      {"timestamp":"2026-03-01T09:15:01Z","input_tokens":200,"conversation_id":12345678901234567891},
      {"timestamp":"2026-03-01T09:15:02Z","input_tokens":300,"conversation_id":7,"id":9007199254740991},
      {"timestamp":"2026-03-01T09:15:03Z","input_tokens":400,"conversation_id":12345678901234567892,"id":1.5}]`;
    const { parsed, out } = await parse(text);
    expect(out.usage.map((u) => [u.inputTokens, u.conversationKey])).toEqual([[100, null], [200, null], [300, 'generic::7'], [400, null]]);
    // Whole numbers that JSON holds exactly are ids as before.
    expect(out.usage[2].dedupKey).toBe('generic:9007199254740991');
    expect(out.usage[3].dedupKey).toMatch(/^generic:[0-9a-f]{64}$/);
    expect(out.conversations.map((c) => c.externalId)).toEqual(['7']);
    expect(parsed.recordsSkipped).toBe(0);
    // One warning for both kinds of id; a record with two such ids counts once.
    expect(parsed.warnings.map((w) => w.code)).toEqual(['inexact_numeric_id']);
    expect(warning(parsed, 'inexact_numeric_id')).toMatchObject({ count: 3, sample: 'conversation_id read as 12345678901234567000 (record 1)' });
  });
});

describe('generic JSON: advice in warnings', () => {
  it('is worded for a JSON file, which has no columns and no column mapping', async () => {
    const { parsed } = await parse(
      JSON.stringify([
        record({ id: 'a' }),
        record({ id: 'a', input_tokens: 6 }),
        record({ input_tokens: 7 }),
        record({ input_tokens: 7 }),
        record({ id: 'b', timestamp: '1999-01-01' }),
        record({ id: 'c', total_tokens: 999 }),
      ]),
    );
    expect(parsed.warnings.map((w) => w.code).sort()).toEqual(['duplicate_ids', 'duplicate_rows', 'timestamp_out_of_range', 'total_mismatch']);
    for (const w of parsed.warnings) expect(w.message, w.code).not.toMatch(/column|mapping/i);
    expect(warning(parsed, 'duplicate_ids')?.message).toBe(
      'Rows whose id already occurred earlier in the import were skipped, so each id is counted once. If "id" does not identify single records, leave it out of the records.',
    );
    expect(warning(parsed, 'duplicate_rows')?.message).toMatch(/give each one an "id" of its own\.$/);
    // the example speaks of counts as well, not of columns
    expect(warning(parsed, 'total_mismatch')?.sample).toBe('total 999, the individual counts add up to 110 (record 6)');

    const manyModels = await errorOf(parse(JSON.stringify(Array.from({ length: 250 }, (_, i) => record({ model: `customer-${i}`, id: `r${i}` })))));
    expect(manyModels.code).toBe('too_many_models');
    expect(manyModels.message).toMatch(/^The "model" field holds more than 200 different values/);
    expect(manyModels.message).not.toMatch(/column|mapping/i);
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
