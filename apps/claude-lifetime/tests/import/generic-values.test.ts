import { describe, expect, it } from 'vitest';
import { checkCsvMapping, detectCsvMapping, GENERIC_FIELDS, GENERIC_FIELD_SPECS } from '@/import/generic';
import { normaliseHeader } from '@/import/generic/fields';
import { normalisePriceTier, parseCount, parseTimestamp, sampleOf } from '@/import/generic/values';

const iso = (value: unknown) => {
  const t = parseTimestamp(value);
  return t === null ? null : `${new Date(t.ms).toISOString()}${t.dateOnly ? ' (day)' : ''}`;
};

describe('parseTimestamp', () => {
  it('reads ISO 8601 date-times, taking a missing offset as UTC', () => {
    const table: Array<[unknown, string]> = [
      ['2025-03-01T14:30:00Z', '2025-03-01T14:30:00.000Z'],
      ['2025-03-01T14:30:00', '2025-03-01T14:30:00.000Z'],
      ['2025-03-01 14:30:00', '2025-03-01T14:30:00.000Z'],
      ['2025-03-01 14:30', '2025-03-01T14:30:00.000Z'],
      ['2025-03-01T14:30Z', '2025-03-01T14:30:00.000Z'],
      ['2025-03-01t14:30:00z', '2025-03-01T14:30:00.000Z'],
      ['2025-03-01 14:30:00 UTC', '2025-03-01T14:30:00.000Z'],
      ['  2025-03-01T14:30:00Z  ', '2025-03-01T14:30:00.000Z'],
      // offsets
      ['2025-03-01T14:30:00+02:00', '2025-03-01T12:30:00.000Z'],
      ['2025-03-01T14:30:00-0800', '2025-03-01T22:30:00.000Z'],
      ['2025-03-01T14:30:00+05', '2025-03-01T09:30:00.000Z'],
      ['2025-03-01T00:15:00+05:30', '2025-02-28T18:45:00.000Z'],
      ['2025-03-01 14:30:00 +01:00', '2025-03-01T13:30:00.000Z'],
      // fractions of a second, to the millisecond
      ['2025-03-01T14:30:00.5Z', '2025-03-01T14:30:00.500Z'],
      ['2025-03-01T14:30:00.123456Z', '2025-03-01T14:30:00.123Z'],
      ['2025-03-01T14:30:00,250', '2025-03-01T14:30:00.250Z'],
      // leap day
      ['2024-02-29T23:59:59Z', '2024-02-29T23:59:59.000Z'],
    ];
    for (const [value, expected] of table) expect(iso(value), String(value)).toBe(expected);
  });

  it('reads a plain date as the whole UTC day', () => {
    expect(iso('2025-03-01')).toBe('2025-03-01T00:00:00.000Z (day)');
    expect(iso(' 2024-02-29 ')).toBe('2024-02-29T00:00:00.000Z (day)');
    expect(parseTimestamp('2025-03-01T00:00:00Z')?.dateOnly).toBe(false);
  });

  it('reads Unix epoch seconds and milliseconds, as numbers or digits', () => {
    expect(iso(1772532000)).toBe('2026-03-03T10:00:00.000Z');
    expect(iso('1772532000')).toBe('2026-03-03T10:00:00.000Z');
    expect(iso(1772532000000)).toBe('2026-03-03T10:00:00.000Z');
    expect(iso('1772532000000')).toBe('2026-03-03T10:00:00.000Z');
    expect(iso(1772532000.75)).toBe('2026-03-03T10:00:00.750Z');
    expect(iso('1772532000.5')).toBe('2026-03-03T10:00:00.500Z');
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('rejects everything that could mean two things or nothing', () => {
    for (const value of [
      '',
      '   ',
      'yesterday',
      'n/a',
      '03/04/2025',
      '3/4/25',
      '2025/03/01',
      '01.03.2025',
      'March 1, 2025',
      'Sat, 01 Mar 2025 14:30:00 GMT',
      '2025-3-1',
      '2025-03',
      '2025-13-01',
      '2025-00-10',
      '2025-02-30',
      '2023-02-29',
      '2025-03-01T24:00:00Z',
      '2025-03-01T14:60:00Z',
      '2025-03-01T14:30:60Z',
      '2025-03-01T14',
      '2025-03-01T14:30:00+15:00',
      '2025-03-01T14:30:00 PST',
      '14:30',
      '-5',
      null,
      undefined,
      true,
      {},
      Number.NaN,
      -1,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(parseTimestamp(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('parseCount', () => {
  it('reads whole numbers in the spellings spreadsheets and scripts produce', () => {
    const table: Array<[unknown, number]> = [
      [0, 0],
      [1200, 1200],
      ['1200', 1200],
      [' 1200 ', 1200],
      ['+7', 7],
      ['007', 7],
      ['1,234,567', 1234567],
      ['1 234 567', 1234567],
      ['1 234', 1234],
      ["1'234'567", 1234567],
      ['1_000', 1000],
      ['1.234.567', 1234567],
      ['1234.0', 1234],
      ['1234.000', 1234],
      [1234.0, 1234],
      ['1.5e6', 1500000],
      ['2E3', 2000],
      ['-0', 0],
    ];
    for (const [value, expected] of table) expect(parseCount(value), JSON.stringify(value)).toEqual({ ok: true, value: expected });
    expect(Object.is((parseCount('-0') as { value: number }).value, 0)).toBe(true);
  });

  it('treats empty cells and "no value" markers as no value', () => {
    for (const value of [null, undefined, '', '   ', '-', '--', 'null', 'NULL', 'None', 'NaN', 'n/a', 'N/A']) {
      expect(parseCount(value), JSON.stringify(value)).toEqual({ ok: true, value: null });
    }
  });

  it('rejects negative numbers, fractions and text', () => {
    for (const value of [-1, '-1', '-1,000', '-12.0']) expect(parseCount(value), JSON.stringify(value)).toEqual({ ok: false, reason: 'negative' });
    for (const value of ['12.5', 12.5, '1.234', 'abc', '12 tokens', '1,23', '1e-3', '0x10', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY, '∞']) {
      expect(parseCount(value), JSON.stringify(value)).toEqual({ ok: false, reason: 'not_a_number' });
    }
  });

  it('enforces an upper bound', () => {
    expect(parseCount(2_147_483_647, 2_147_483_647)).toEqual({ ok: true, value: 2_147_483_647 });
    expect(parseCount(2_147_483_648, 2_147_483_647)).toEqual({ ok: false, reason: 'too_large' });
    expect(parseCount('9007199254740993')).toEqual({ ok: false, reason: 'too_large' });
    expect(parseCount('1e30')).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('normalisePriceTier and sampleOf', () => {
  it('normalises tier labels', () => {
    const table: Array<[unknown, string | null]> = [
      [undefined, 'standard'],
      [null, 'standard'],
      ['', 'standard'],
      ['Standard', 'standard'],
      ['default', 'standard'],
      ['BATCH', 'batch'],
      ['Batch API', 'batch'],
      ['fast', 'fast'],
      ['Fast mode', 'fast'],
      ['long-context', 'long_context'],
      ['Long Context', 'long_context'],
      ['priority', 'priority'],
      ['priority_on_demand', 'priority'],
      ['flex_discount', 'flex'],
      ['enterprise', 'enterprise'],
      ['uncategorised', 'uncategorised'],
      ['what is this?!', null],
      [5, null],
    ];
    for (const [value, expected] of table) expect(normalisePriceTier(value), JSON.stringify(value)).toBe(expected);
  });

  it('never puts a long text into a warning sample', () => {
    expect(sampleOf('03/04/2025')).toBe('03/04/2025');
    expect(sampleOf('  spaced\n out  ')).toBe('spaced out');
    expect(sampleOf('')).toBe('(empty)');
    expect(sampleOf(undefined)).toBe('(empty)');
    expect(sampleOf(null)).toBe('(empty)');
    expect(sampleOf(-5)).toBe('-5');
    const secret = 'Please summarise the attached contract and tell me whether clause 7 is enforceable.';
    expect(sampleOf(secret)).toBe(`text of ${secret.length} characters`);
    expect(sampleOf(secret)).not.toContain('contract');
  });
});

describe('detectCsvMapping', () => {
  it('maps the documented header one to one', () => {
    const header = [...GENERIC_FIELDS];
    const result = detectCsvMapping(header);
    expect(result.mapping).toEqual(Object.fromEntries(header.map((h) => [h, h])));
    expect(result.missingFields).toEqual([]);
    expect(result.unmappedColumns).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('matches aliases without regard to case, spaces, underscores and punctuation', () => {
    const header = ['Date', 'Model Name', 'Prompt Tokens', 'completion-tokens', 'CACHED_TOKENS', 'Cache Creation Input Tokens', 'Request Count', 'Session ID', 'Cost (USD)', 'Notes'];
    const result = detectCsvMapping(header);
    expect(result.mapping).toEqual({
      timestamp: 'Date',
      model: 'Model Name',
      input_tokens: 'Prompt Tokens',
      output_tokens: 'completion-tokens',
      cache_read_tokens: 'CACHED_TOKENS',
      cache_write_tokens: 'Cache Creation Input Tokens',
      requests: 'Request Count',
      conversation_id: 'Session ID',
    });
    expect(result.unmappedColumns).toEqual(['Cost (USD)', 'Notes']);
    expect(result.missingFields).toEqual(['cache_write_5m_tokens', 'cache_write_1h_tokens', 'total_tokens', 'conversation_title', 'id', 'price_tier', 'bucket_seconds']);
    expect(result.problems).toEqual([]);
    expect(normaliseHeader(' Input_Tokens (uncached) ')).toBe('inputtokensuncached');
  });

  it('prefers the more specific name when two columns could be the same field', () => {
    expect(detectCsvMapping(['date', 'timestamp', 'tokens']).mapping).toEqual({ timestamp: 'timestamp', total_tokens: 'tokens' });
    expect(detectCsvMapping(['date', 'timestamp', 'tokens']).unmappedColumns).toEqual(['date']);
    expect(detectCsvMapping(['id', 'request_id', 'day', 'total_tokens']).mapping).toEqual({ id: 'id', timestamp: 'day', total_tokens: 'total_tokens' });
    // the Console's column names are known as well
    expect(detectCsvMapping(['usage_date_utc', 'model_version', 'usage_input_tokens_no_cache', 'usage_output_tokens', 'usage_input_tokens_cache_write_5m']).mapping).toEqual({
      timestamp: 'usage_date_utc',
      model: 'model_version',
      input_tokens: 'usage_input_tokens_no_cache',
      output_tokens: 'usage_output_tokens',
      cache_write_5m_tokens: 'usage_input_tokens_cache_write_5m',
    });
  });

  it('does not guess columns that usually hold text or money', () => {
    const result = detectCsvMapping(['time', 'input', 'output', 'total', 'conversation', 'name']);
    expect(result.mapping).toEqual({ timestamp: 'time' });
    expect(result.unmappedColumns).toEqual(['input', 'output', 'total', 'conversation', 'name']);
    expect(result.problems.map((p) => p.code)).toEqual(['no_token_columns']);
  });

  it('says what keeps a file from being imported', () => {
    const noTime = detectCsvMapping(['model', 'input_tokens', 'output_tokens']);
    expect(noTime.problems.map((p) => p.code)).toEqual(['missing_timestamp_column']);
    expect(noTime.problems[0].message).toMatch(/it has: model, input_tokens, output_tokens/);
    expect(noTime.missingFields).toContain('timestamp');

    const nothing = detectCsvMapping(['a', 'b']);
    expect(nothing.problems.map((p) => p.code)).toEqual(['missing_timestamp_column', 'no_token_columns']);
    expect(detectCsvMapping([]).problems.map((p) => p.code)).toEqual(['missing_timestamp_column', 'no_token_columns']);
    expect(detectCsvMapping([]).problems[0].message).toMatch(/no named columns/);
  });

  it('describes every field for the mapping screen', () => {
    for (const field of GENERIC_FIELDS) {
      const spec = GENERIC_FIELD_SPECS[field];
      expect(spec.label.length, field).toBeGreaterThan(0);
      expect(spec.hint.length, field).toBeGreaterThan(0);
      // a field is always found under its own name
      expect(spec.aliases[0], field).toBe(field);
    }
    // no alias is claimed by two fields
    const all = GENERIC_FIELDS.flatMap((f) => GENERIC_FIELD_SPECS[f].aliases.map(normaliseHeader));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('checkCsvMapping', () => {
  const header = ['When', 'Model', 'In', 'Out', 'model', 'Total'];

  it('uses a chosen mapping as it is, without filling in the rest', () => {
    const result = checkCsvMapping(header, { timestamp: 'When', input_tokens: 'In', output_tokens: 'Out' });
    expect(result.mapping).toEqual({ timestamp: 'When', input_tokens: 'In', output_tokens: 'Out' });
    // "Model" would be detected, but the user left it out
    expect(result.missingFields).toContain('model');
    expect(result.unmappedColumns).toEqual(['Model', 'model', 'Total']);
    expect(result.problems).toEqual([]);
  });

  it('finds columns by their exact name first, then ignoring case and spacing', () => {
    expect(checkCsvMapping(header, { timestamp: 'When', model: 'model', total_tokens: 'Total' }).mapping.model).toBe('model');
    expect(checkCsvMapping(header, { timestamp: 'When', model: 'Model', total_tokens: 'Total' }).mapping.model).toBe('Model');
    expect(checkCsvMapping(header, { timestamp: ' when ', total_tokens: 'TOTAL' }).mapping).toEqual({ timestamp: 'When', total_tokens: 'Total' });
    // empty entries count as "not mapped"
    expect(checkCsvMapping(header, { timestamp: 'When', total_tokens: 'Total', model: '', id: null, requests: undefined }).mapping).toEqual({ timestamp: 'When', total_tokens: 'Total' });
  });

  it('reports a mapping that cannot work', () => {
    const codes = (mapping: Record<string, unknown>) => checkCsvMapping(header, mapping).problems.map((p) => p.code);
    expect(codes({ timestamp: 'Date', total_tokens: 'Total' })).toEqual(['mapping_column_not_found']);
    expect(checkCsvMapping(header, { timestamp: 'Date', total_tokens: 'Total' }).problems[0].message).toMatch(/"Date" chosen for "timestamp" is not in the file \(it has: When, Model, In, Out, model, Total\)/);
    expect(codes({ timestamp: 'When', total_tokens: 'Total', cost: 'Out' })).toEqual(['unknown_mapping_field']);
    expect(codes({ timestamp: 'When', input_tokens: 'In', total_tokens: 'In' })).toEqual(['column_mapped_twice']);
    expect(codes({ timestamp: 'When', input_tokens: 5 })).toEqual(['mapping_column_not_found']);
    expect(codes({ input_tokens: 'In' })).toEqual(['missing_timestamp_column']);
    expect(codes({ timestamp: 'When', model: 'Model' })).toEqual(['no_token_columns']);
    expect(codes({})).toEqual(['missing_timestamp_column', 'no_token_columns']);
  });
});
