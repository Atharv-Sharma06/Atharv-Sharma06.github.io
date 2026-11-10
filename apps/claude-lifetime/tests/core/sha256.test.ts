import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hash64, Sha256, sha256Hex } from '@/core/sha256';
import { readLines } from '@/import/util/lines';

describe('Sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches node:crypto for every length around the block boundaries and for chunked input', () => {
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65537]) {
      const data = randomBytes(n);
      const expected = createHash('sha256').update(data).digest('hex');
      expect(new Sha256().update(data).hex()).toBe(expected);
      const chunked = new Sha256();
      for (let i = 0; i < n; ) {
        const step = 1 + ((i * 7) % 97);
        chunked.update(data.subarray(i, i + step));
        i += step;
      }
      expect(chunked.hex()).toBe(expected);
    }
  });

  it('hash64 is a stable signed 64-bit value', () => {
    const a = hash64('msg_01ABC:req_011XYZ');
    expect(a).toBe(hash64('msg_01ABC:req_011XYZ'));
    expect(a).not.toBe(hash64('msg_01ABC:req_011XYW'));
    expect(a >= -(2n ** 63n) && a < 2n ** 63n).toBe(true);
    const expected = createHash('sha256').update('msg_01ABC:req_011XYZ').digest().readBigInt64BE(0);
    expect(a).toBe(expected);
  });
});

describe('readLines', () => {
  const streamOf = (parts: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });

  it('splits on newlines across arbitrary chunk boundaries, including inside multi-byte characters', async () => {
    const text = 'first\r\nsecond — ünïcödé 日本語\n\nlast without newline';
    const bytes = new TextEncoder().encode(text);
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
      const lines: string[] = [];
      let seen = 0;
      for await (const line of readLines(streamOf(parts), (c) => (seen += c.length))) lines.push(line);
      expect(lines).toEqual(['first', 'second — ünïcödé 日本語', '', 'last without newline']);
      expect(seen).toBe(bytes.length);
    }
  });
});
