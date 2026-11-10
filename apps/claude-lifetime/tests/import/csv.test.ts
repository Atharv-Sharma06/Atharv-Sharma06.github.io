import { describe, expect, it } from 'vitest';
import { ImportError } from '@/core/types';
import { decodeText, detectDelimiter, readCsv, readCsvHead, type CsvOptions } from '@/import/util/csv';

const enc = new TextEncoder();

/** A stream that delivers `bytes` in pieces whose sizes are given (the last size repeats). */
function chunked(bytes: Uint8Array, ...sizes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      let at = 0;
      for (let i = 0; at < bytes.length; i++) {
        const size = sizes[Math.min(i, sizes.length - 1)];
        c.enqueue(bytes.slice(at, at + size));
        at += size;
      }
      c.close();
    },
  });
}

async function rows(input: string | Uint8Array, options: CsvOptions = {}, ...sizes: number[]): Promise<string[][]> {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  const out: string[][] = [];
  for await (const record of readCsv(chunked(bytes, ...(sizes.length ? sizes : [1 << 16])), options)) out.push(record.fields);
  return out;
}

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return bytes;
}

describe('readCsv', () => {
  it('reads plain rows, with or without a final line break', async () => {
    expect(await rows('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(await rows('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(await rows('single')).toEqual([['single']]);
    expect(await rows('')).toEqual([]);
    expect(await rows('\n\n')).toEqual([]);
  });

  it('keeps empty fields, including a trailing one', async () => {
    expect(await rows('a,,c\n,,\nx,y,\n')).toEqual([['a', '', 'c'], ['', '', ''], ['x', 'y', '']]);
    expect(await rows('a,b,')).toEqual([['a', 'b', '']]);
  });

  it('handles quoted fields: delimiters, escaped quotes and line breaks inside quotes', async () => {
    const text = 'id,title,note\n1,"Hello, world","say ""hi"""\n2,"line one\nline two\r\nline three",""\n3,"",plain\n';
    expect(await rows(text)).toEqual([
      ['id', 'title', 'note'],
      ['1', 'Hello, world', 'say "hi"'],
      ['2', 'line one\nline two\r\nline three', ''],
      ['3', '', 'plain'],
    ]);
  });

  it('keeps a row that consists of one quoted empty field, unlike a blank line', async () => {
    expect(await rows('a\n""\n\nb\n')).toEqual([['a'], [''], ['b']]);
  });

  it('accepts LF, CRLF and lone CR line ends, also mixed', async () => {
    const expected = [['a', 'b'], ['1', '2'], ['3', '4']];
    expect(await rows('a,b\n1,2\n3,4\n')).toEqual(expected);
    expect(await rows('a,b\r\n1,2\r\n3,4\r\n')).toEqual(expected);
    expect(await rows('a,b\r1,2\r3,4\r')).toEqual(expected);
    expect(await rows('a,b\r\n1,2\n3,4\r')).toEqual(expected);
    expect(await rows('a,b\r\n\r\n1,2\n\n\n3,4')).toEqual(expected);
  });

  it('strips a UTF-8 byte order mark and decodes multi-byte text', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('titel,größe\nñandú ✓ 日本語 😀,≤ 200k\n')]);
    const expected = [['titel', 'größe'], ['ñandú ✓ 日本語 😀', '≤ 200k']];
    expect(await rows(bytes)).toEqual(expected);
    // also when chunks cut the mark and the characters apart
    for (let size = 1; size <= 7; size++) expect(await rows(bytes, {}, size)).toEqual(expected);
  });

  it('reads UTF-16 text with a byte order mark (Excel "Unicode Text")', async () => {
    const text = 'date\tmodel\ttokens\r\n2026-01-01\tclaude-ünïcode\t1200\r\n';
    const expected = [['date', 'model', 'tokens'], ['2026-01-01', 'claude-ünïcode', '1200']];
    for (const littleEndian of [true, false]) {
      const bytes = utf16(text, littleEndian);
      expect(await rows(bytes)).toEqual(expected);
      for (const size of [1, 2, 3, 5]) expect(await rows(bytes, {}, size)).toEqual(expected);
    }
  });

  it('detects semicolon and tab delimiters from the header', async () => {
    expect(await rows('date;model;tokens\n2026-01-01;claude-x;1,5\n')).toEqual([['date', 'model', 'tokens'], ['2026-01-01', 'claude-x', '1,5']]);
    expect(await rows('date\tmodel\ttokens\n2026-01-01\tclaude, the model\t7\n')).toEqual([['date', 'model', 'tokens'], ['2026-01-01', 'claude, the model', '7']]);
    // a single column stays a single column
    expect(await rows('tokens\n12\n')).toEqual([['tokens'], ['12']]);
  });

  it('reports the delimiter in use', async () => {
    let seen = '';
    await rows('a;b\n1;2\n', { onDelimiter: (d) => (seen = d) });
    expect(seen).toBe(';');
    await rows('', { onDelimiter: (d) => (seen = d) });
    expect(seen).toBe(',');
  });

  it('does not count delimiters inside quotes when detecting', () => {
    expect(detectDelimiter('"a;b;c;d",x,y')).toBe(',');
    expect(detectDelimiter('"a,b,c";x;y')).toBe(';');
    expect(detectDelimiter('a\tb\tc,d')).toBe('\t');
    expect(detectDelimiter('nothing to see')).toBe(',');
    // ties: comma, then semicolon
    expect(detectDelimiter('a,b;c')).toBe(',');
    expect(detectDelimiter('a;b\tc')).toBe(';');
  });

  it('honours an explicit delimiter and Excel\'s sep= line', async () => {
    expect(await rows('a|b,c\n1|2,3\n', { delimiter: '|' })).toEqual([['a', 'b,c'], ['1', '2,3']]);
    expect(await rows('sep=;\na;b,c\n1;2\n')).toEqual([['a', 'b,c'], ['1', '2']]);
    expect(await rows('sep=\t\r\na\tb\r\n')).toEqual([['a', 'b']]);
    // the option wins over the hint, and the hint line is still not data
    expect(await rows('sep=;\na;b,c\n', { delimiter: ',' })).toEqual([['a;b', 'c']]);
    await expect(rows('a,b', { delimiter: '"' })).rejects.toMatchObject({ code: 'csv_invalid_delimiter' });
    await expect(rows('a,b', { delimiter: '::' })).rejects.toMatchObject({ code: 'csv_invalid_delimiter' });
  });

  it('gives the same result for every way of cutting a small file into chunks', async () => {
    const text =
      '﻿id;"quoted ""name""";note\r\n' +
      '1;"semi;colon";"multi\r\nline"\r\n' +
      '\r\n' +
      '2;plain;"ends with quote"""\r' +
      '3;"é😀";""\n' +
      '4;last;';
    const expected = [
      ['id', 'quoted "name"', 'note'],
      ['1', 'semi;colon', 'multi\r\nline'],
      ['2', 'plain', 'ends with quote"'],
      ['3', 'é😀', ''],
      ['4', 'last', ''],
    ];
    const bytes = enc.encode(text);
    expect(await rows(bytes)).toEqual(expected);
    // every single split point ...
    for (let cut = 1; cut < bytes.length; cut++) expect(await rows(bytes, {}, cut, bytes.length), `cut at ${cut}`).toEqual(expected);
    // ... and every fixed chunk size
    for (let size = 1; size <= 12; size++) expect(await rows(bytes, {}, size), `chunks of ${size}`).toEqual(expected);
  });

  it('numbers records by the line they start on', async () => {
    const text = 'h1,h2\n"a\nb\nc",1\n\n\nx,2\r\ny,3';
    const lines: Array<[number, string]> = [];
    for (let size = 1; size <= 5; size++) {
      lines.length = 0;
      for await (const r of readCsv(chunked(enc.encode(text), size))) lines.push([r.line, r.fields[0]]);
      expect(lines).toEqual([[1, 'h1'], [2, 'a\nb\nc'], [7, 'x'], [8, 'y']]);
    }
    // a sep= line is line 1
    const withHint: number[] = [];
    for await (const r of readCsv(chunked(enc.encode('sep=,\nh\n1\n'), 4))) withHint.push(r.line);
    expect(withHint).toEqual([2, 3]);
  });

  it('is lenient where files in the wild are sloppy', async () => {
    // a quote inside an unquoted field is a character like any other
    expect(await rows('5" disk,3\n')).toEqual([['5" disk', '3']]);
    // text after a closing quote is kept
    expect(await rows('"a" ,"b"x,c\n')).toEqual([['a ', 'bx', 'c']]);
    // spaces around values are data
    expect(await rows(' a , b \n')).toEqual([[' a ', ' b ']]);
  });

  it('rejects a quote that is never closed, naming the line', async () => {
    const err = await rows('a,b\n1,2\n3,"oops\n4,5\n6,7\n').catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.code).toBe('csv_unclosed_quote');
    expect(err.message).toContain('line 3');
  });

  it('bounds memory: a record longer than the limit is an error, not a buffer', async () => {
    const big = `a,b\n1,"${'x'.repeat(5000)}`;
    await expect(rows(big + '"\n', { maxRecordChars: 1000 }, 256)).rejects.toMatchObject({ code: 'csv_record_too_long' });
    await expect(rows(`${'y,'.repeat(3000)}\n`, { maxRecordChars: 1000 }, 256)).rejects.toMatchObject({ code: 'csv_record_too_long' });
    // within the limit it is fine
    expect((await rows(big + '"\n', { maxRecordChars: 10_000 }, 256))[1][1]).toHaveLength(5000);
  });

  it('streams: records arrive before the input is complete, and all bytes are reported', async () => {
    let produced = 0;
    const total = 5000;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (produced === 0) c.enqueue(enc.encode('n,text\n'));
        if (produced < total) {
          c.enqueue(enc.encode(`${produced},"row ${produced}, with ""quotes"""\n`));
          produced++;
        } else c.close();
      },
    });
    let bytes = 0;
    let n = 0;
    let maxLead = 0;
    for await (const record of readCsv(stream, { onBytes: (chunk) => (bytes += chunk.length) })) {
      if (n > 0) {
        expect(record.fields).toEqual([String(n - 1), `row ${n - 1}, with "quotes"`]);
        // the producer is never more than a couple of rows ahead of the consumer
        maxLead = Math.max(maxLead, produced - n);
      }
      n++;
    }
    expect(n).toBe(total + 1);
    expect(maxLead).toBeLessThan(10);
    expect(bytes).toBeGreaterThan(total * 20);
  });

  it('readCsvHead reads the first records only and cancels the rest', async () => {
    const blob = new Blob([`a;b\n${'1;2\n'.repeat(200_000)}`]);
    const head = await readCsvHead(blob, 3);
    expect(head.delimiter).toBe(';');
    expect(head.records.map((r) => r.fields)).toEqual([['a', 'b'], ['1', '2'], ['1', '2']]);
    expect((await readCsvHead(new Blob(['only,header']), 5)).records).toHaveLength(1);
    expect((await readCsvHead(new Blob(['']), 5)).records).toHaveLength(0);
  });
});

describe('decodeText', () => {
  const decode = async (bytes: Uint8Array, ...sizes: number[]) => {
    let text = '';
    for await (const part of decodeText(chunked(bytes, ...sizes))) text += part;
    return text;
  };

  it('decodes UTF-8 and UTF-16 for every chunk size, dropping the byte order mark', async () => {
    const text = 'aé€😀\n';
    const inputs = [enc.encode(text), new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(text)]), utf16(text, true), utf16(text, false)];
    for (const bytes of inputs) for (let size = 1; size <= 6; size++) expect(await decode(bytes, size)).toBe(text);
  });

  it('copes with empty input and single-byte input', async () => {
    expect(await decode(new Uint8Array(0), 1)).toBe('');
    expect(await decode(enc.encode('x'), 1)).toBe('x');
  });
});
