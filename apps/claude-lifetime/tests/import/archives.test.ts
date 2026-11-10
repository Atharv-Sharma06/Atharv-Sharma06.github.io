import { strToU8, zipSync, type Zippable } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ImportError, type ImportFile, type ImportParser } from '@/core/types';
import { apiUsageReportParser, consoleCsvParser } from '@/import/api-reports';
import { entryPath, expandArchives, importFileName, isReadableEntry } from '@/import/archive';
import { claudeCodeParser } from '@/import/claude-code';
import { claudeExportParser } from '@/import/claude-export';
import { detectImport } from '@/import/detect';
import { detectSelection, filesToParse } from '@/import/selection';
import { assistant, at, jsonl, LATER, usage as tokens, user } from '../fixtures/claude-code/builders';
import { collectingSink, fileOf } from '../helpers/sink';

/**
 * ZIP archives in a selection: every readable file inside one takes the archive's place, and is
 * read from the archive without being unpacked first. A claude.ai export stays a ZIP.
 */
const fixture = (path: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url)));

const zipOf = (name: string, files: Zippable, extra: Partial<ImportFile> = {}) => fileOf(name, zipSync(files, { level: 6 }), extra);

const transcript = (session: string, responses = 2) =>
  jsonl([
    user('please do the thing', { ts: at('09:00:00'), session }),
    ...Array.from({ length: responses }, (_, i) =>
      assistant({ ts: at(`09:00:0${i + 1}`), session, id: `msg_${session}_${i}`, req: `req_${session}_${i}`, usage: tokens(100, 50) }),
    ),
  ]);

const S1 = transcript('s1', 3);
const S2 = transcript('s2', 2);

/** A zipped .claude folder: two transcripts and what lies around them. */
const claudeFolder = (): Zippable => ({
  '.claude/settings.json': strToU8('{"theme":"dark"}'),
  '.claude/projects/-home-alex-demo/s1.jsonl': strToU8(S1),
  '.claude/projects/-home-alex-demo/s2.jsonl': [strToU8(S2), { level: 0 }],
  '.claude/projects/-home-alex-demo/s1/tool-results/out.jsonl': strToU8('{"tool":"output"}\n'),
  '.claude/projects/-home-alex-demo/notes.md': strToU8('# notes'),
  '__MACOSX/.claude/projects/-home-alex-demo/._s1.jsonl': strToU8('resource fork'),
  '.claude/projects/-home-alex-demo/._s2.jsonl': strToU8('resource fork'),
  '.claude/projects/': new Uint8Array(0),
});

const text = async (blob: Blob) => new TextDecoder().decode(await blob.arrayBuffer());
const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImportError) return { code: error.code, message: error.message };
    throw error;
  }
  return null;
};

/** The archive's bytes with the central directory entry of `name` changed. */
function patchCentral(zip: Uint8Array, name: string, change: (view: DataView, at: number) => void): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let p = 0; p + 46 <= out.length; p++) {
    if (view.getUint32(p, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(p + 28, true);
    if (new TextDecoder().decode(out.subarray(p + 46, p + 46 + nameLength)) === name) {
      change(view, p);
      return out;
    }
  }
  throw new Error(`no central directory entry for ${name}`);
}

describe('entry paths', () => {
  it('cannot climb out of the archive or be written two ways', () => {
    expect(entryPath('a/./b//c.jsonl')).toBe('a/b/c.jsonl');
    expect(entryPath('../../etc/x.json')).toBe('etc/x.json');
    expect(entryPath('C:\\Users\\alex\\.claude\\projects\\p\\s.jsonl')).toBe('Users/alex/.claude/projects/p/s.jsonl');
    expect(entryPath('/abs/path.csv')).toBe('abs/path.csv');
  });

  it('keeps the files a dropped folder keeps', () => {
    expect(isReadableEntry('.claude/projects/p/s.jsonl')).toBe(true);
    expect(isReadableEntry('.claude/projects/p/s.jsonl.superseded-2026')).toBe(true);
    expect(isReadableEntry('usage.CSV')).toBe(true);
    expect(isReadableEntry('parts/part-2.zip')).toBe(true);
    expect(isReadableEntry('.claude/projects/p/s/tool-results/x.jsonl')).toBe(false);
    expect(isReadableEntry('__MACOSX/report.json')).toBe(false);
    expect(isReadableEntry('p/._s.jsonl')).toBe(false);
    expect(isReadableEntry('notes.md')).toBe(false);
    expect(isReadableEntry('folder/')).toBe(false);
  });
});

describe('opening archives', () => {
  it('puts the readable files of an archive in its place, in order, with their paths and times', async () => {
    const when = new Date(2026, 0, 15, 10, 30, 42);
    const zip = zipSync({ ...claudeFolder(), 'loose/usage.csv': [strToU8('date,input_tokens\n'), { mtime: when }] });
    const loose = fileOf('before.json', '[]');
    const expanded = await expandArchives([loose, fileOf('claude.zip', zip, { path: 'backups/claude.zip' })]);
    expect(expanded.map((f) => f.path ?? f.name)).toEqual([
      'before.json',
      'backups/claude.zip/.claude/settings.json',
      'backups/claude.zip/.claude/projects/-home-alex-demo/s1.jsonl',
      'backups/claude.zip/.claude/projects/-home-alex-demo/s2.jsonl',
      'backups/claude.zip/loose/usage.csv',
    ]);
    expect(expanded[0]).toBe(loose);
    expect(expanded.slice(1).map((f) => [f.name, f.archive])).toEqual([
      ['settings.json', 'claude.zip'],
      ['s1.jsonl', 'claude.zip'],
      ['s2.jsonl', 'claude.zip'],
      ['usage.csv', 'claude.zip'],
    ]);
    expect(expanded[2].size).toBe(strToU8(S1).length);
    expect(await text(expanded[2].blob)).toBe(S1);
    expect(await text(expanded[3].blob)).toBe(S2);
    // MS-DOS times are local and kept to two seconds.
    expect(expanded[4].lastModified).toBe(when.getTime());
  });

  it('prefers the exact modification time of the extended timestamp field', async () => {
    const seconds = Date.UTC(2026, 2, 3, 4, 5, 7) / 1000;
    const stamp = new Uint8Array(5);
    stamp[0] = 1;
    new DataView(stamp.buffer).setUint32(1, seconds, true);
    const [file] = await expandArchives([zipOf('t.zip', { 'a.csv': [strToU8('a,b\n'), { extra: { 0x5455: stamp } }] })]);
    expect(file.lastModified).toBe(seconds * 1000);
  });

  it('leaves a claude.ai export, an archive with nothing readable and a damaged one as they are', async () => {
    const exportZip = fileOf('claude-export-sample.zip', fixture('claude-export/claude-export-sample.zip'));
    const pictures = zipOf('pictures.zip', { 'a.png': new Uint8Array([1, 2, 3]), 'notes.md': strToU8('# hi') });
    const cut = fileOf('cut.zip', zipSync(claudeFolder()).subarray(0, 200));
    const notZip = fileOf('not-a.zip', 'just text, long enough to be looked at');
    const given = [exportZip, pictures, cut, notZip];
    expect(await expandArchives(given)).toEqual(given);
  });

  it('opens archives inside archives, two levels deep', async () => {
    const innermost = zipSync({ 'c.csv': strToU8('a,b\n1,2\n') });
    const inner = zipSync({ 'b.csv': strToU8('a,b\n3,4\n'), 'deeper.zip': innermost });
    const expanded = await expandArchives([zipOf('outer.zip', { 'parts/inner.zip': inner })]);
    expect(expanded.map((f) => [f.path, f.archive])).toEqual([
      ['outer.zip/parts/inner.zip/b.csv', 'outer.zip'],
      ['outer.zip/parts/inner.zip/deeper.zip', 'outer.zip'],
    ]);
    expect(await text(expanded[0].blob)).toBe('a,b\n3,4\n');
    // The third level stays an archive; detection says why it was not read.
    expect(expanded[1].blob).toBeInstanceOf(Blob);
    const problem = await caught(detectImport([expanded[1]]));
    expect(problem).toMatchObject({ code: 'unknown_format' });
    expect(problem?.message).toContain('"deeper.zip" is a ZIP archive that was not opened');
  });

  it('looks inside a ZIP whose name does not say it is one, in a small selection', async () => {
    const expanded = await expandArchives([fileOf('download', zipSync({ 'a.csv': strToU8('a,b\n') }))]);
    expect(expanded.map((f) => f.path)).toEqual(['download/a.csv']);
  });

  it('refuses password-protected entries and compression methods it cannot unpack', async () => {
    const zip = zipSync({ 'a.csv': strToU8('a,b\n'), 'b.csv': strToU8('c,d\n') });
    const locked = patchCentral(zip, 'b.csv', (v, p) => v.setUint16(p + 8, v.getUint16(p + 8, true) | 1, true));
    expect(await caught(expandArchives([fileOf('locked.zip', locked)]))).toMatchObject({
      code: 'zip_encrypted',
      message: '"b.csv" in "locked.zip" is password-protected. Remove the password from the archive and try again.',
    });
    const lzma = patchCentral(zip, 'a.csv', (v, p) => v.setUint16(p + 10, 14, true));
    expect(await caught(expandArchives([fileOf('lzma.zip', lzma)]))).toMatchObject({ code: 'zip_unsupported_compression' });
  });

});

describe('a file read out of an archive', () => {
  const content = Array.from({ length: 4000 }, (_, i) => `line ${i}: ${'x'.repeat(i % 50)}`).join('\n');
  const real = new Blob([content]);
  const fromArchive = async () => (await expandArchives([zipOf('a.zip', { 'big.jsonl': strToU8(content) })]))[0].blob;

  it('is read in parts as a Blob is', async () => {
    const blob = await fromArchive();
    expect(blob.size).toBe(real.size);
    for (const [start, end] of [
      [0, 10],
      [0, 256 * 1024],
      [500, 1500],
      [-100, undefined],
      [-100, -50],
      [10, 5],
      [real.size - 3, real.size + 10],
      [undefined, undefined],
    ] as Array<[number | undefined, number | undefined]>) {
      const part = blob.slice(start, end);
      const expected = real.slice(start, end);
      expect(part.size).toBe(expected.size);
      expect(await part.text()).toBe(await expected.text());
      expect(await new Response(part.stream()).text()).toBe(await expected.text());
      // A part of a part.
      expect(await part.slice(1, 7).text()).toBe(await expected.slice(1, 7).text());
    }
    expect(await blob.text()).toBe(content);
    expect(await new Response(blob.stream()).text()).toBe(content);
  });

  it('fails with a message that names it when the archive does not hold what its directory says', async () => {
    const zip = zipSync({ 'a.csv': strToU8('date,tokens\n2026-01-01,5\n') });
    const longer = patchCentral(zip, 'a.csv', (v, p) => v.setUint32(p + 24, v.getUint32(p + 24, true) + 10, true));
    const [file] = await expandArchives([fileOf('a.zip', longer)]);
    expect(await caught(file.blob.text())).toMatchObject({ code: 'zip_corrupt', message: '"a.csv" in the ZIP archive is damaged and could not be unpacked.' });
  });
});

describe('detecting and parsing what is in an archive', () => {
  const parse = async (parser: ImportParser, files: ImportFile[], options: Record<string, unknown> = {}) => {
    const detected = await detectSelection(files);
    const { sink, out } = collectingSink();
    const parsed = await parser.parse(await filesToParse(files, detected.fileIndexes), sink, { options });
    return { detected, parsed, out };
  };

  it('reads a zipped Claude Code folder as the folder itself would be read', async () => {
    const files = [zipOf('claude.zip', claudeFolder())];
    const { detected, parsed, out } = await parse(claudeCodeParser, files, { now: LATER });
    expect(detected).toMatchObject({
      parser: 'claude-code',
      recognisedAs: '2 Claude Code transcript files, from the ZIP archive "claude.zip"',
      leadName: 's1.jsonl',
      ignoredFiles: 1,
    });
    expect(parsed.fileName).toBe('claude.zip (2 transcript files)');
    expect(parsed.stats).toMatchObject({ filesRead: 2, usageRows: 5 });
    expect(out.usage.reduce((sum, u) => sum + u.requestCount, 0)).toBe(5);
  });

  it('reads one transcript in an archive, and transcripts from an archive next to loose ones', async () => {
    const one = await parse(claudeCodeParser, [zipOf('one.zip', { 's1.jsonl': strToU8(transcript('s1', 3)) })], { now: LATER });
    expect(one.detected).toMatchObject({ parser: 'claude-code', recognisedAs: 'Claude Code session transcript, from the ZIP archive "one.zip"' });
    expect(one.parsed.fileName).toBe('one.zip (s1.jsonl)');

    const mixed = await parse(claudeCodeParser, [zipOf('two.zip', { 'p/s2.jsonl': strToU8(transcript('s2')) }), fileOf('s1.jsonl', transcript('s1'))], { now: LATER });
    expect(mixed.detected.recognisedAs).toBe('2 Claude Code transcript files, some of them from the ZIP archive "two.zip"');
    expect(mixed.parsed.fileName).toBe('2 transcript files');
  });

  it('reads Console CSV exports, API report pages and a CSV of your own from archives', async () => {
    const csv = await parse(consoleCsvParser, [zipOf('console.zip', { 'console-usage.csv': fixture('api-reports/console-usage.csv') })]);
    expect(csv.detected).toMatchObject({ parser: 'console-csv', recognisedAs: 'usage export from the Claude Console, from the ZIP archive "console.zip"' });
    expect(csv.out.usage.length).toBeGreaterThan(0);

    const pages = await parse(apiUsageReportParser, [
      zipOf('report.zip', {
        'report/page-1.json': fixture('api-reports/usage-report.daily.page-1.json'),
        'report/page-2.json': fixture('api-reports/usage-report.daily.page-2.json'),
      }),
    ]);
    expect(pages.detected).toMatchObject({ parser: 'api-usage', fileIndexes: [0, 1] });
    expect(pages.detected.recognisedAs).toMatch(/^2 files: .*, from the ZIP archive "report.zip"$/);
    expect(pages.parsed.fileName).toBe('report.zip (2 files)');

    const own = await detectSelection([zipOf('mine.zip', { 'usage.csv': fixture('generic/usage.csv') })]);
    expect(own).toMatchObject({ parser: 'generic-csv', leadName: 'usage.csv' });
    expect(own.csv?.header.length).toBeGreaterThan(1);
  });

  it('reads a claude.ai export as before, also when it arrives inside another archive', async () => {
    const sample = fixture('claude-export/claude-export-sample.zip');
    const direct = await parse(claudeExportParser, [fileOf('claude-export-sample.zip', sample)]);
    expect(direct.detected).toMatchObject({ parser: 'claude-export', recognisedAs: 'ZIP archive of a claude.ai data export' });
    expect(direct.parsed.fileName).toBe('claude-export-sample.zip');

    const wrapped = await parse(claudeExportParser, [zipOf('downloads.zip', { 'claude-export-sample.zip': sample, 'readme.json': strToU8('{"a":1}') })]);
    expect(wrapped.detected).toMatchObject({ parser: 'claude-export', ignoredFiles: 1, leadName: 'claude-export-sample.zip' });
    expect(wrapped.parsed.fileName).toBe('downloads.zip (claude-export-sample.zip)');
    expect(wrapped.out.conversations.length).toBe(direct.out.conversations.length);
  });

  it('says what an archive holds when nothing in it can be read', async () => {
    expect(await caught(detectSelection([zipOf('pictures.zip', { 'a.png': new Uint8Array([1]), 'b.md': strToU8('#') })]))).toMatchObject({
      code: 'unknown_format',
      message: expect.stringMatching(/^"pictures.zip" is a ZIP archive, but none of the files in it is one this app can read \(it contains a.png, b.md\)\. Claude Lifetime reads: /),
    });
  });

  it('picks the files to parse by the positions detection returned, and notices a selection that changed', async () => {
    const files = [fileOf('a.csv', 'a,b\n'), zipOf('z.zip', { 'b.csv': strToU8('c,d\n'), 'c.csv': strToU8('e,f\n') })];
    expect((await filesToParse(files, [2, 0])).map((f) => f.path ?? f.name)).toEqual(['z.zip/c.csv', 'a.csv']);
    expect(await caught(filesToParse(files.slice(0, 1), [2]))).toMatchObject({ code: 'selection_changed' });
  });
});

describe('import names', () => {
  it('names the archive when everything came from one', () => {
    expect(importFileName([{ name: 'a.jsonl' }], undefined)).toBe('a.jsonl');
    expect(importFileName([{ name: 'a' }, { name: 'b' }], undefined, 'transcript files')).toBe('2 transcript files');
    expect(importFileName([{ name: 'a' }, { name: 'b' }], 'x.zip')).toBe('x.zip (2 files)');
    expect(importFileName([], 'x.zip', 'ledger files')).toBe('x.zip (0 ledger files)');
  });
});
