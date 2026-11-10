import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { PriceRow } from '@/analytics/settings';
import {
  backupFileName,
  checkPassphrase,
  checkPriceForm,
  checkTimezone,
  effectiveLabel,
  EMPTY_PRICE_FORM,
  filterPrices,
  formatPrice,
  isWholeValueInput,
  listTimezones,
  inspectBackupFile,
  looksLikeDatabaseDump,
  looksLikeGzip,
  normalisePrice,
  parsePostgresVersion,
  replacedByUserPrices,
  sortPrices,
  sourceHost,
  tierLabel,
  utcOffsetLabel,
} from '@/features/settings/logic';
import { notABackup } from '@/features/settings/backup-section';
import { decryptBackup, encryptBackup, isEncryptedBackup, MIN_PASSPHRASE_LENGTH } from '@/lib/backup-crypto';

const blob = (bytes: Uint8Array | Buffer) => new Blob([bytes as unknown as BlobPart]);

describe('timezone', () => {
  const known = ['UTC', 'Europe/Berlin', 'America/New_York', 'Pacific/Auckland', 'Etc/GMT+5'];

  it('accepts a listed zone in any capitalisation and returns its proper spelling', () => {
    expect(checkTimezone('Europe/Berlin', known)).toEqual({ ok: true, timezone: 'Europe/Berlin' });
    expect(checkTimezone('  pacific/auckland ', known)).toEqual({ ok: true, timezone: 'Pacific/Auckland' });
    expect(checkTimezone('utc', known)).toEqual({ ok: true, timezone: 'UTC' });
    expect(checkTimezone('Etc/GMT+5', known)).toEqual({ ok: true, timezone: 'Etc/GMT+5' });
  });

  it('accepts an IANA name that is missing from the list, without renaming an alias', () => {
    expect(checkTimezone('Asia/Kolkata', known)).toMatchObject({ ok: true });
    const alias = checkTimezone('asia/kolkata', known);
    // whatever the engine calls the zone internally, the user's choice of name is not swapped for another one
    expect(alias.ok && alias.timezone.toLowerCase()).toBe('asia/kolkata');
    expect(checkTimezone('UTC', [])).toEqual({ ok: true, timezone: 'UTC' });
  });

  it('turns away abbreviations and offsets, which PostgreSQL and the browser read differently', () => {
    for (const value of ['PST', 'EST', 'CET', 'UTC+5', '+02:00', 'Z', '2', 'GMT']) {
      const result = checkTimezone(value, known);
      expect(result.ok, value).toBe(false);
      expect(!result.ok && result.message).toContain('not a full timezone name');
    }
  });

  it('turns away empty input and names no timezone database has', () => {
    expect(checkTimezone('   ', known)).toEqual({ ok: false, message: 'Enter a timezone, for example Europe/Berlin.' });
    const unknown = checkTimezone('Mars/Olympus_Mons', known);
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toBe('"Mars/Olympus_Mons" is not a timezone this browser knows. Use an IANA name such as America/New_York.');
    expect(checkTimezone('America/Indiana', known).ok).toBe(false);
  });

  it('lists zones once each, including UTC', () => {
    const zones = listTimezones();
    expect(zones).toContain('UTC');
    expect(zones).toContain('Europe/Berlin');
    expect(new Set(zones).size).toBe(zones.length);
  });

  it('writes the current offset of a zone', () => {
    expect(utcOffsetLabel('UTC', new Date('2026-01-15T12:00:00Z'))).toBe('UTC+00:00');
    expect(utcOffsetLabel('Europe/Berlin', new Date('2026-01-15T12:00:00Z'))).toBe('UTC+01:00');
    expect(utcOffsetLabel('Europe/Berlin', new Date('2026-07-15T12:00:00Z'))).toBe('UTC+02:00');
    expect(utcOffsetLabel('America/St_Johns', new Date('2026-01-15T12:00:00Z'))).toBe('UTC−03:30');
    expect(utcOffsetLabel('Not/A_Zone')).toBeNull();
  });

  it('saves at once only when a whole value arrives, not while a name is being typed', () => {
    expect(isWholeValueInput('insertReplacementText')).toBe(true);
    expect(isWholeValueInput('insertFromPaste')).toBe(true);
    expect(isWholeValueInput(undefined)).toBe(true);
    expect(isWholeValueInput('insertText')).toBe(false);
    expect(isWholeValueInput('deleteContentBackward')).toBe(false);
  });
});

const price = (over: Partial<PriceRow>): PriceRow => ({
  id: 1,
  modelKey: 'claude-sonnet-4-5',
  displayName: 'Claude Sonnet 4.5',
  priceTier: 'standard',
  effectiveFrom: null,
  effectiveTo: null,
  input: '3',
  output: '15',
  cacheRead: '0.3',
  cacheWrite5m: '3.75',
  cacheWrite1h: '6',
  sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  sourceRetrievedOn: '2026-11-10',
  sourceNote: null,
  isBuiltin: true,
  ...over,
});

describe('price table', () => {
  it('names the tiers', () => {
    expect(tierLabel('standard')).toBe('Standard');
    expect(tierLabel('batch')).toBe('Batch API');
    expect(tierLabel('fast')).toBe('Fast mode');
    expect(tierLabel('long_context')).toBe('Long context');
    // a tier that only an imported report knows is shown as written, not hidden
    expect(tierLabel('priority')).toBe('Priority');
    expect(tierLabel('flex_batch')).toBe('Flex batch');
  });

  it('writes prices from their exact decimal strings without rounding digits away', () => {
    expect(formatPrice('3')).toBe('$3.00');
    expect(formatPrice('0.25')).toBe('$0.25');
    expect(formatPrice('0.8')).toBe('$0.80');
    expect(formatPrice('18.75')).toBe('$18.75');
    expect(formatPrice('0.005')).toBe('$0.005');
    expect(formatPrice('0.0625')).toBe('$0.0625');
    expect(formatPrice('3.000000')).toBe('$3.00');
    expect(formatPrice('1500')).toBe('$1,500.00');
    expect(formatPrice('0')).toBe('$0.00');
  });

  it('shows a missing price as a dash, never as zero', () => {
    expect(formatPrice(null)).toBe('–');
    expect(formatPrice(undefined)).toBe('–');
    expect(formatPrice('')).toBe('–');
  });

  it('describes when a price applies, with the last day in effect rather than the exclusive end', () => {
    expect(effectiveLabel(null, null)).toBe('Since launch');
    expect(effectiveLabel('2025-03-04', null)).toBe('From Mar 4, 2025');
    expect(effectiveLabel(null, '2025-03-04')).toBe('Until Mar 3, 2025');
    expect(effectiveLabel('2024-12-03', '2025-03-01')).toBe('Dec 3, 2024 – Feb 28, 2025');
  });

  it('keeps the model order and lists each model with its standard tier first', () => {
    const rows = [
      price({ id: 1, modelKey: 'b', priceTier: 'batch' }),
      price({ id: 2, modelKey: 'b', priceTier: 'fast' }),
      price({ id: 3, modelKey: 'b', priceTier: 'priority' }),
      price({ id: 4, modelKey: 'b', priceTier: 'standard' }),
      price({ id: 5, modelKey: 'b', priceTier: 'standard', effectiveFrom: '2026-01-01', isBuiltin: false }),
      price({ id: 6, modelKey: 'a', priceTier: 'long_context' }),
      price({ id: 7, modelKey: 'a', priceTier: 'standard' }),
    ];
    expect(sortPrices(rows).map((r) => r.id)).toEqual([4, 5, 1, 2, 3, 7, 6]);
    expect(sortPrices([])).toEqual([]);
  });

  it('filters by every word of the query, in the name or the identifier', () => {
    const rows = [
      price({ id: 1 }),
      price({ id: 2, modelKey: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' }),
      price({ id: 3, modelKey: 'claude-opus-4-5', displayName: 'Claude Opus 4.5' }),
    ];
    expect(filterPrices(rows, '').map((r) => r.id)).toEqual([1, 2, 3]);
    expect(filterPrices(rows, '  SONNET ').map((r) => r.id)).toEqual([1, 2]);
    expect(filterPrices(rows, 'sonnet 4.5').map((r) => r.id)).toEqual([1]);
    expect(filterPrices(rows, '4.5').map((r) => r.id)).toEqual([1, 3]);
    expect(filterPrices(rows, 'claude-opus').map((r) => r.id)).toEqual([3]);
    expect(filterPrices(rows, 'gpt')).toEqual([]);
  });

  it('marks the built-in prices a user-entered price takes the place of', () => {
    const builtin = price({ id: 1 });
    const batch = price({ id: 2, priceTier: 'batch' });
    const otherModel = price({ id: 3, modelKey: 'claude-opus-4-5' });
    // no user prices: nothing is replaced
    expect(replacedByUserPrices([builtin, batch, otherModel]).size).toBe(0);

    // a user price without dates covers the whole built-in price of the same model and tier, and only that one
    const always = price({ id: 10, isBuiltin: false, input: '100' });
    const all = replacedByUserPrices([builtin, batch, otherModel, always]);
    expect([...all.entries()]).toEqual([[1, { scope: 'all' }]]);

    // from a date on: the built-in price still applies before it
    const later = price({ id: 11, isBuiltin: false, effectiveFrom: '2026-10-15' });
    expect(replacedByUserPrices([builtin, later]).get(1)).toEqual({ scope: 'part', from: '2026-10-15' });

    // a built-in price that ended before the user's price starts is untouched; the one in effect is fully covered
    const old = price({ id: 4, effectiveTo: '2026-01-01' });
    const current = price({ id: 5, effectiveFrom: '2026-01-01' });
    const fromNewYear = price({ id: 12, isBuiltin: false, effectiveFrom: '2026-01-01' });
    const split = replacedByUserPrices([old, current, fromNewYear]);
    expect(split.has(4)).toBe(false);
    expect(split.get(5)).toEqual({ scope: 'all' });

    // two user prices with a gap in between are not claimed to cover everything
    const first = price({ id: 13, isBuiltin: false, effectiveFrom: '2025-01-01', effectiveTo: '2025-06-01' });
    const second = price({ id: 14, isBuiltin: false, effectiveFrom: '2026-01-01' });
    expect(replacedByUserPrices([builtin, first, second]).get(1)).toEqual({ scope: 'part', from: null });
  });

  it('shows the site a price was read from', () => {
    expect(sourceHost('https://platform.claude.com/docs/en/about-claude/pricing')).toBe('platform.claude.com');
    expect(sourceHost('https://www.anthropic.com/news/claude-3-family')).toBe('anthropic.com');
    expect(sourceHost('not a url')).toBe('not a url');
  });
});

describe('"Add a price" form', () => {
  const filled = {
    ...EMPTY_PRICE_FORM,
    modelKey: 'claude-sonnet-4-5',
    input: '3',
    output: '15',
    sourceUrl: 'https://example.com/prices',
  };

  it('turns a complete form into the input saveUserPrice expects', () => {
    const { errors, input } = checkPriceForm({ ...filled, cacheRead: ' 0,30 ', effectiveFrom: '2026-03-01', sourceNote: '  after the March change ' });
    expect(errors).toEqual({});
    expect(input).toEqual({
      modelKey: 'claude-sonnet-4-5',
      priceTier: 'standard',
      effectiveFrom: '2026-03-01',
      input: '3',
      output: '15',
      cacheRead: '0.30',
      cacheWrite5m: null,
      cacheWrite1h: null,
      sourceUrl: 'https://example.com/prices',
      sourceNote: 'after the March change',
    });
  });

  it('leaves optional fields out as null', () => {
    const { input } = checkPriceForm(filled);
    expect(input).toMatchObject({ effectiveFrom: null, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null, sourceNote: null });
  });

  it('reports each problem on its own field and saves nothing', () => {
    const { errors, input } = checkPriceForm({ ...EMPTY_PRICE_FORM, output: 'fifteen', cacheWrite1h: '-1', effectiveFrom: '2026-02-31x' });
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['cacheWrite1h', 'effectiveFrom', 'input', 'modelKey', 'output', 'sourceUrl']);
    expect(errors.input).toContain('US dollars per million tokens');
    expect(errors.output).toContain('plain number');
  });

  it('insists on a web address as the source, so the figure stays traceable', () => {
    expect(checkPriceForm({ ...filled, sourceUrl: '' }).errors.sourceUrl).toContain('traceable');
    expect(checkPriceForm({ ...filled, sourceUrl: 'example.com/prices' }).errors.sourceUrl).toContain('https://');
    expect(checkPriceForm({ ...filled, sourceUrl: 'https://example.com/a b' }).input).toBeNull();
    expect(checkPriceForm({ ...filled, sourceUrl: ' http://example.com/prices ' }).input?.sourceUrl).toBe('http://example.com/prices');
  });

  it('accepts a decimal comma but not a thousands separator', () => {
    expect(normalisePrice(' 0,25 ')).toBe('0.25');
    expect(normalisePrice('1,234.5')).toBe('1,234.5');
    expect(checkPriceForm({ ...filled, input: '1,234.5' }).errors.input).toBeDefined();
    expect(checkPriceForm({ ...filled, input: '0.1234567' }).errors.input).toBeDefined();
    expect(checkPriceForm({ ...filled, input: '0.123456' }).errors.input).toBeUndefined();
  });
});

describe('backup files', () => {
  it('names a backup after the device date, with its own extension when it is protected', () => {
    expect(backupFileName(new Date(2026, 10, 10, 23, 59))).toBe('claude-lifetime-backup-2026-11-10.tar.gz');
    expect(backupFileName(new Date(2026, 0, 5))).toBe('claude-lifetime-backup-2026-01-05.tar.gz');
    expect(backupFileName(new Date(2026, 10, 10), true)).toBe('claude-lifetime-backup-2026-11-10.clbackup');
  });

  it('checks the two passphrase fields', () => {
    const min = MIN_PASSPHRASE_LENGTH;
    expect(checkPassphrase('', '', min)).toEqual({ ok: true, passphrase: null });
    expect(checkPassphrase('correct horse 42', 'correct horse 42', min)).toEqual({ ok: true, passphrase: 'correct horse 42' });
    // taken exactly as typed: the same characters have to be typed again to restore
    expect(checkPassphrase(' spaces count ', ' spaces count ', min)).toEqual({ ok: true, passphrase: ' spaces count ' });
    expect(checkPassphrase('short', 'short', min)).toMatchObject({ ok: false, field: 'passphrase' });
    expect(checkPassphrase('', 'correct horse 42', min)).toMatchObject({ ok: false, field: 'passphrase' });
    expect(checkPassphrase('correct horse 42', '', min)).toMatchObject({ ok: false, field: 'repeat' });
    expect(checkPassphrase('correct horse 42', 'correct horse 43', min)).toEqual({ ok: false, field: 'repeat', message: 'The two passphrases are not the same.' });
  });

  it('recognises a gzip stream by its first bytes', async () => {
    expect(await looksLikeGzip(blob(gzipSync(Buffer.from('hello'))))).toBe(true);
    expect(await looksLikeGzip(blob(Buffer.from('this is plain text, long enough to pass the size check')))).toBe(false);
    expect(await looksLikeGzip(blob(new Uint8Array([0x1f, 0x8b])))).toBe(false);
    expect(await looksLikeGzip(blob(new Uint8Array(0)))).toBe(false);
  });

  /** A minimal tar archive: one 512-byte header per file, content padded to 512 bytes, two empty blocks at the end. */
  const tarOf = (files: Array<{ name: string; content: string }>) => {
    const blocks: Buffer[] = [];
    for (const file of files) {
      const header = Buffer.alloc(512);
      header.write(file.name, 0, 'latin1');
      header.write(Buffer.byteLength(file.content).toString(8).padStart(11, '0'), 124, 'latin1');
      header.write('ustar', 257, 'latin1');
      const content = Buffer.alloc(Math.ceil(Buffer.byteLength(file.content) / 512) * 512);
      content.write(file.content);
      blocks.push(header, content);
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
  };

  it('accepts a real dump of a database and nothing else as a plain backup', async () => {
    const pg = new PGlite();
    await pg.exec('CREATE TABLE t (id int); INSERT INTO t SELECT generate_series(1, 2000);');
    const dump = (await pg.dumpDataDir('gzip')) as Blob;
    await pg.close();
    expect(await looksLikeGzip(dump)).toBe(true);
    expect(await looksLikeDatabaseDump(dump)).toBe(true);

    // other things a file picker might hand over
    expect(await looksLikeDatabaseDump(blob(Buffer.from('this is plain text, long enough to pass the size check')))).toBe(false);
    expect(await looksLikeDatabaseDump(blob(gzipSync(Buffer.from('a gzip file, but not a database '.repeat(50)))))).toBe(false);
    expect(await looksLikeDatabaseDump(blob(gzipSync(tarOf([{ name: 'photos/readme.txt', content: 'x'.repeat(2000) }, { name: 'notes.md', content: 'hello' }]))))).toBe(false);
    expect(await looksLikeDatabaseDump(blob(gzipSync(Buffer.alloc(4096))))).toBe(false);
    // a gzip stream that stops half-way
    expect(await looksLikeDatabaseDump(blob(gzipSync(tarOf([{ name: 'a.txt', content: 'x'.repeat(50_000) }])).subarray(0, 40)))).toBe(false);
  });

  it('finds PG_VERSION wherever it stands in the archive, with either spelling of the path', async () => {
    const big = 'x'.repeat(70_000);
    expect(await looksLikeDatabaseDump(blob(gzipSync(tarOf([{ name: '/base/1/1259', content: big }, { name: '/PG_VERSION', content: '18\n' }]))))).toBe(true);
    expect(await looksLikeDatabaseDump(blob(gzipSync(tarOf([{ name: './PG_VERSION', content: '18\n' }]))))).toBe(true);
    expect(await looksLikeDatabaseDump(blob(gzipSync(tarOf([{ name: 'PG_VERSION', content: '18\n' }]))))).toBe(true);
    // a file of that name deeper down is not the data directory's own
    expect(await looksLikeDatabaseDump(blob(gzipSync(tarOf([{ name: 'backup/old/PG_VERSION', content: '18\n' }]))))).toBe(false);
  });

  it('tells a backup that was cut short from a file that never was one', async () => {
    const pg = new PGlite();
    await pg.exec('CREATE TABLE t (id int); INSERT INTO t SELECT generate_series(1, 2000);');
    const dump = Buffer.from(await ((await pg.dumpDataDir('gzip')) as Blob).arrayBuffer());
    await pg.close();
    expect(await inspectBackupFile(blob(dump))).toBe('backup');

    // A download that broke off half-way. The root PG_VERSION stands near the end of the archive, so the
    // quick check never reaches it. Before the fix this file was called "not a Claude Lifetime backup".
    const half = blob(dump.subarray(0, Math.floor(dump.length / 2)));
    expect(await looksLikeDatabaseDump(half)).toBe(false);
    expect(await inspectBackupFile(half)).toBe('cut_short');
    expect(await inspectBackupFile(blob(dump.subarray(0, Math.floor(dump.length / 10))))).toBe('cut_short');
    // Nearly all of it: PG_VERSION is there, so the quick check passes it, and only reading to the end finds out.
    const nearlyAll = blob(dump.subarray(0, dump.length - 60));
    expect(await looksLikeDatabaseDump(nearlyAll)).toBe(true);
    expect(await inspectBackupFile(nearlyAll)).toBe('cut_short');
    // All of it, with one byte changed on the way: gzip's checksum at the end does not match.
    const damaged = Buffer.from(dump);
    damaged[Math.floor(damaged.length / 2)] ^= 0xff;
    expect(await inspectBackupFile(blob(damaged))).not.toBe('backup');

    // Files that never were a backup stay "not a backup", whole or cut off.
    const photos = gzipSync(tarOf([{ name: 'photos/a.jpg', content: randomBytes(60_000).toString('latin1') }, { name: 'notes.md', content: 'hello' }]));
    expect(await inspectBackupFile(blob(photos))).toBe('other');
    expect(await inspectBackupFile(blob(photos.subarray(0, Math.floor(photos.length / 2))))).toBe('other');
    expect(await inspectBackupFile(blob(Buffer.from('this is plain text, long enough to pass the size check')))).toBe('other');
    expect(await inspectBackupFile(blob(gzipSync(Buffer.from('a gzip file, but not a database '.repeat(50)))))).toBe('other');
    // An archive that ends properly but has no data directory at its root.
    expect(await inspectBackupFile(blob(gzipSync(tarOf([{ name: 'backup/old/PG_VERSION', content: '18\n' }, { name: 'base/1/1259', content: 'x' }]))))).toBe('other');
  });

  it('says of a backup that was cut short what it is and what to do, instead of calling it something else', () => {
    expect(notABackup('half.tar.gz', 'cut_short')).toBe(
      '“half.tar.gz” is a Claude Lifetime backup, but not all of it: the file ends before the backup does, or it was damaged. That happens when a download or a copy is cut off. Get the file again from where you keep it, then choose it here. Nothing was changed.',
    );
    expect(notABackup('holiday.tar.gz', 'other')).toBe(
      '“holiday.tar.gz” is not a Claude Lifetime backup. Choose the .tar.gz or .clbackup file that “Download backup” saved.',
    );
  });

  it('says of a protected backup that does not open that it may have been cut short as well', async () => {
    const sealed = Buffer.from(await (await encryptBackup(blob(gzipSync(tarOf([{ name: '/PG_VERSION', content: '18\n' }]))), 'correct horse 42')).arrayBuffer());
    await expect(decryptBackup(blob(sealed.subarray(0, sealed.length - 40)), 'correct horse 42')).rejects.toThrow(
      'The passphrase does not match this backup, or the file was changed or cut short after it was saved.',
    );
  });

  it('leaves a protected backup to its passphrase: it is recognised as one, not as a plain dump', async () => {
    const sealed = await encryptBackup(blob(gzipSync(tarOf([{ name: '/PG_VERSION', content: '18\n' }]))), 'correct horse 42');
    expect(await isEncryptedBackup(sealed)).toBe(true);
    expect(await looksLikeDatabaseDump(sealed)).toBe(false);
  });
});

describe('about', () => {
  it('reads the server version and the engine out of version()', () => {
    expect(parsePostgresVersion('PostgreSQL 18.6 (PGlite 0.5.16) on wasm32-unknown-emscripten, compiled by emcc, 32-bit')).toEqual({
      postgres: '18.6',
      engine: 'PGlite 0.5.16',
    });
    expect(parsePostgresVersion('PostgreSQL 17.2 on x86_64-pc-linux-gnu')).toEqual({ postgres: '17.2', engine: null });
    expect(parsePostgresVersion('something else')).toEqual({ postgres: null, engine: null });
  });
});
