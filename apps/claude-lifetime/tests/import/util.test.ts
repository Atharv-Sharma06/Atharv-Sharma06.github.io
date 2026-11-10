import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ImportError } from '@/core/types';
import { iterateJsonArray } from '@/import/util/json-array-stream';
import { looksLikeZip, openZipEntry, readZipDirectory } from '@/import/util/zip';

const chunked = (bytes: Uint8Array, size: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });

const collect = async (json: string, size: number, opts = {}) => {
  const out: unknown[] = [];
  for await (const el of iterateJsonArray(chunked(new TextEncoder().encode(json), size), opts)) out.push(el);
  return out;
};

/** TypeScript's typed-array generics do not line up with BlobPart for arrays that come from libraries. */
const blobOf = (bytes: Uint8Array) => new Blob([bytes as unknown as BlobPart]);

const readAll = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

describe('iterateJsonArray', () => {
  const value = [
    { uuid: 'a', name: 'braces } ] in "strings" and \\ backslashes', nested: { list: [1, [2, { x: ']' }]], s: 'é日本語😀' } },
    'plain string, with [brackets] and a \\" quote',
    42,
    -1.5e3,
    true,
    null,
    [],
    {},
    { text: 'tab\tnewline\nunicode   escape \\u0041' },
  ];
  const compact = JSON.stringify(value);
  const pretty = '﻿ \n' + JSON.stringify(value, null, 2) + '\n\n';

  it('yields every element for every possible chunk size', async () => {
    for (const json of [compact, pretty]) {
      for (let size = 1; size <= 40; size++) expect(await collect(json, size)).toEqual(value);
      expect(await collect(json, 1 << 16)).toEqual(value);
    }
  });

  it('handles an empty array and reports completion', async () => {
    let end: unknown;
    expect(await collect(' [ ] ', 2, { onEnd: (i: unknown) => (end = i) })).toEqual([]);
    expect(end).toEqual({ truncated: false, elements: 0 });
  });

  it('keeps complete records from a truncated file and flags the truncation', async () => {
    let end: { truncated: boolean; elements: number } | undefined;
    const cut = compact.slice(0, compact.indexOf('"plain string') + 10);
    const got = await collect(cut, 7, { onEnd: (i: { truncated: boolean; elements: number }) => (end = i) });
    expect(got).toEqual([value[0]]);
    expect(end).toEqual({ truncated: true, elements: 1 });
  });

  it('rejects input that is not an array, with a specific error', async () => {
    await expect(collect('{"conversations": []}', 5)).rejects.toMatchObject({ code: 'not_a_json_array' });
    await expect(collect('', 5)).rejects.toMatchObject({ code: 'empty_file' });
    await expect(collect('[{"a": tru}]', 5)).rejects.toBeInstanceOf(ImportError);
  });

  it('reports raw bytes for progress', async () => {
    let seen = 0;
    await collect(compact, 11, { onBytes: (c: Uint8Array) => (seen += c.length) });
    expect(seen).toBe(new TextEncoder().encode(compact).length);
  });

  it('stays bounded on a large array of large records', async () => {
    const record = { uuid: 'x', chat_messages: Array.from({ length: 50 }, (_, i) => ({ text: 'lorem ipsum "quoted" \\ '.repeat(40), i })) };
    const one = JSON.stringify(record);
    const total = 400;
    const enc = new TextEncoder();
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (produced === 0) c.enqueue(enc.encode('['));
        if (produced < total) {
          c.enqueue(enc.encode((produced ? ',' : '') + one));
          produced++;
        } else {
          c.enqueue(enc.encode(']'));
          c.close();
        }
      },
    });
    let n = 0;
    for await (const el of iterateJsonArray(stream)) {
      n++;
      expect((el as typeof record).chat_messages).toHaveLength(50);
    }
    expect(n).toBe(total);
  });
});

/** Rewrites a small ZIP so its end-of-central-directory and first entry use ZIP64 fields. */
function toZip64(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  const entries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  // central directory with a ZIP64 extra field on the first entry
  const cd = zip.slice(cdOffset, cdOffset + cdSize);
  const cdView = new DataView(cd.buffer);
  const nameLen = cdView.getUint16(28, true);
  const extraLen = cdView.getUint16(30, true);
  const first = 46 + nameLen + extraLen;
  const extra = new Uint8Array(4 + 24);
  const ev = new DataView(extra.buffer);
  ev.setUint16(0, 0x0001, true);
  ev.setUint16(2, 24, true);
  ev.setBigUint64(4, BigInt(cdView.getUint32(24, true)), true); // uncompressed
  ev.setBigUint64(12, BigInt(cdView.getUint32(20, true)), true); // compressed
  ev.setBigUint64(20, BigInt(cdView.getUint32(42, true)), true); // local header offset
  cdView.setUint32(20, 0xffffffff, true);
  cdView.setUint32(24, 0xffffffff, true);
  cdView.setUint32(42, 0xffffffff, true);
  cdView.setUint16(30, extraLen + extra.length, true);
  const newCd = new Uint8Array(cd.length + extra.length);
  newCd.set(cd.subarray(0, first), 0);
  newCd.set(extra, first);
  newCd.set(cd.subarray(first), first + extra.length);

  const record = new Uint8Array(56);
  const rv = new DataView(record.buffer);
  rv.setUint32(0, 0x06064b50, true);
  rv.setBigUint64(4, 44n, true);
  rv.setUint16(12, 45, true);
  rv.setUint16(14, 45, true);
  rv.setBigUint64(24, BigInt(entries), true);
  rv.setBigUint64(32, BigInt(entries), true);
  rv.setBigUint64(40, BigInt(newCd.length), true);
  rv.setBigUint64(48, BigInt(cdOffset), true);

  const locator = new Uint8Array(20);
  const lv = new DataView(locator.buffer);
  lv.setUint32(0, 0x07064b50, true);
  lv.setBigUint64(8, BigInt(cdOffset + newCd.length), true);
  lv.setUint32(16, 1, true);

  const end = zip.slice(eocd);
  const endView = new DataView(end.buffer);
  endView.setUint16(8, 0xffff, true);
  endView.setUint16(10, 0xffff, true);
  endView.setUint32(12, 0xffffffff, true);
  endView.setUint32(16, 0xffffffff, true);

  const out = new Uint8Array(cdOffset + newCd.length + record.length + locator.length + end.length);
  out.set(zip.subarray(0, cdOffset), 0);
  out.set(newCd, cdOffset);
  out.set(record, cdOffset + newCd.length);
  out.set(locator, cdOffset + newCd.length + record.length);
  out.set(end, cdOffset + newCd.length + record.length + locator.length);
  return out;
}

describe('zip reader', () => {
  const conversations = JSON.stringify([{ uuid: 'c1', name: 'ünïcode ✓', chat_messages: [] }]) + ' '.repeat(5000);
  const files = {
    'data-2026/conversations.json': strToU8(conversations),
    'data-2026/users.json': [strToU8('[{"uuid":"u1"}]'), { level: 0 as const }] as [Uint8Array, { level: 0 }],
    'data-2026/projects/': new Uint8Array(0),
  };
  const zip = zipSync(files, { level: 6 });

  it('lists entries and streams deflated and stored files', async () => {
    const blob = blobOf(zip);
    expect(looksLikeZip(zip.subarray(0, 4))).toBe(true);
    expect(looksLikeZip(strToU8('[{"a"'))).toBe(false);
    const entries = await readZipDirectory(blob);
    expect(entries.map((e) => e.name)).toEqual(['data-2026/conversations.json', 'data-2026/users.json', 'data-2026/projects/']);
    const conv = entries[0];
    expect(conv.method).toBe(8);
    expect(conv.uncompressedSize).toBe(strToU8(conversations).length);
    expect(new TextDecoder().decode(await readAll(await openZipEntry(blob, conv)))).toBe(conversations);
    expect(entries[1].method).toBe(0);
    expect(new TextDecoder().decode(await readAll(await openZipEntry(blob, entries[1])))).toBe('[{"uuid":"u1"}]');
    expect(entries[2].isDirectory).toBe(true);
  });

  it('reads ZIP64 archives', async () => {
    const blob = blobOf(toZip64(zip));
    const entries = await readZipDirectory(blob);
    expect(entries).toHaveLength(3);
    expect(entries[0].uncompressedSize).toBe(strToU8(conversations).length);
    expect(new TextDecoder().decode(await readAll(await openZipEntry(blob, entries[0])))).toBe(conversations);
  });

  it('feeds a zipped conversations.json straight into the array reader', async () => {
    const blob = blobOf(zip);
    const [entry] = await readZipDirectory(blob);
    const got: unknown[] = [];
    for await (const el of iterateJsonArray(await openZipEntry(blob, entry))) got.push(el);
    expect(got).toEqual([{ uuid: 'c1', name: 'ünïcode ✓', chat_messages: [] }]);
  });

  it('explains truncated and non-ZIP files', async () => {
    await expect(readZipDirectory(blobOf(zip.subarray(0, zip.length - 40)))).rejects.toMatchObject({ code: 'not_a_zip' });
    await expect(readZipDirectory(blobOf(strToU8('hello')))).rejects.toMatchObject({ code: 'not_a_zip' });
    // directory intact but data cut out of the middle
    const entries = await readZipDirectory(blobOf(zip));
    const broken = blobOf(zip.subarray(0, 60));
    await expect(openZipEntry(broken, entries[0])).rejects.toMatchObject({ code: 'zip_truncated' });
  });
});
