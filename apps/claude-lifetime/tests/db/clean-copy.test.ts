import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { cleanBackup, CleanCopyError, copyLiveRows } from '@/db/clean-copy';
import { migrate, NewerSchemaError } from '@/db/migrate';
import { MIGRATIONS } from '@/db/migrations.generated';
import { pgliteDriver } from '@/db/pglite-driver';
import { ensureSeeded } from '@/db/seed';
import { deleteAllData, deleteBatch, deleteSource } from '@/import/delete';
import { looksLikeDatabaseDump } from '@/lib/backup-format';
import { NEWER_MIGRATIONS } from '../helpers/fake-pglite-worker';
import { conv, importRecords, msg, usage } from '../helpers/staged';

/**
 * What "Download backup" hands out. PostgreSQL keeps deleted rows in its files (in
 * the table files until the space is reused, and in the write-ahead log), so the
 * database's own files are not what a backup may be made of: they would give away
 * titles and folder names the person has deleted. The backup is the data directory
 * of a copy that only ever received the rows stored now.
 *
 * Every archive is unpacked here and searched file by file, the way anyone could
 * who got hold of a backup.
 */
const TITLE = 'Severance negotiation with ACME-CORP-7731';
const PROJECT = '/home/alex/clients/acme-corp-7731-lawsuit';
const KEPT_TITLE = 'Planning the allotment for spring';

async function database() {
  const pg = new PGlite();
  const db = pgliteDriver(pg);
  await migrate(db);
  const userId = await ensureSeeded(db, { timezone: 'UTC' });
  return { pg, db, userId };
}

const unpacked = async (archive: Blob) => gunzipSync(Buffer.from(await archive.arrayBuffer()));
const rawDump = async (pg: PGlite) => unpacked((await pg.dumpDataDir('gzip')) as Blob);

/** Names of the files in the archive whose content holds `text`. */
function filesHolding(tar: Buffer, text: string): string[] {
  const needle = Buffer.from(text, 'utf8');
  const found: string[] = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('latin1').split('\0')[0];
    const size = parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
    if (tar.subarray(offset + 512, offset + 512 + size).includes(needle)) found.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

type Db = Awaited<ReturnType<typeof database>>['db'];

async function importAll(db: Db, userId: number) {
  const chat = await importRecords(db, userId, { conversations: [conv('a', { title: TITLE })], messages: [msg('a', 0), msg('a', 1)] }, { contentHash: 'chat' });
  const code = await importRecords(
    db,
    userId,
    {
      conversations: [conv('s1', { dedupKey: 'claude_code:s1', kind: 'code_session', title: null, projectLabel: PROJECT })],
      usage: [usage('cc:u1', { conversationKey: 'claude_code:s1' })],
    },
    { source: { kind: 'claude_code', label: 'Claude Code (this computer)', externalRef: 'local' }, contentHash: 'code' },
  );
  const kept = await importRecords(
    db,
    userId,
    { conversations: [conv('k', { title: KEPT_TITLE })], messages: [msg('k', 0), msg('k', 1), msg('k', 2)], usage: [usage('k:u1'), usage('k:u2', { occurredAt: '2025-06-02T00:00:00.000Z' })] },
    { source: { kind: 'generic_json', label: 'Notes', externalRef: 'notes' }, contentHash: 'kept' },
  );
  return { chat, code, kept };
}

const tablesOf = async (pg: PGlite) =>
  (
    await pg.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
    )
  ).rows.map((r) => r.name);

/** Every row of every table as text, so that two databases can be compared value for value. */
async function contents(pg: PGlite): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of await tablesOf(pg)) {
    out[table] = (await pg.query<{ row: string }>(`SELECT t::text AS row FROM "${table}" t ORDER BY 1`)).rows.map((r) => r.row);
  }
  return out;
}

const backupOf = (pg: PGlite) => cleanBackup(pg, () => new PGlite());

describe('a backup made after data was deleted', () => {
  it('holds neither the title nor the folder of what was deleted, in any of its files', async () => {
    const { pg, db, userId } = await database();
    const { chat, code } = await importAll(db, userId);
    await deleteBatch(db, userId, chat.result.batchId!);
    await deleteSource(db, userId, code.result.sourceId!);

    // The database's own files still hold both, which is why they are not handed out.
    const raw = await rawDump(pg);
    expect(filesHolding(raw, TITLE).length).toBeGreaterThan(0);
    expect(filesHolding(raw, PROJECT).length).toBeGreaterThan(0);

    const backup = await unpacked(await backupOf(pg));
    expect(filesHolding(backup, TITLE)).toEqual([]);
    expect(filesHolding(backup, PROJECT)).toEqual([]);
    // What is still stored is in the backup.
    expect(filesHolding(backup, KEPT_TITLE).length).toBeGreaterThan(0);
    await pg.close();
  }, 120_000);

  it('holds none of it after "Delete all imported data" either', async () => {
    const { pg, db, userId } = await database();
    await importAll(db, userId);
    await deleteAllData(db, userId);
    expect(filesHolding(await rawDump(pg), TITLE).length).toBeGreaterThan(0);

    const backup = await unpacked(await backupOf(pg));
    for (const text of [TITLE, PROJECT, KEPT_TITLE]) expect(filesHolding(backup, text), text).toEqual([]);
    await pg.close();
  }, 120_000);

  it('does not hold a title that was changed, in its earlier wording', async () => {
    // An import that is read again can rename a conversation; the old name is a deleted version of the row.
    const { pg, db, userId } = await database();
    await importRecords(db, userId, { conversations: [conv('a', { title: TITLE })], messages: [msg('a', 0)] }, { contentHash: 'one' });
    await db.query(`UPDATE conversations SET title = $1`, ['Renamed']);
    expect(filesHolding(await rawDump(pg), TITLE).length).toBeGreaterThan(0);
    const backup = await unpacked(await backupOf(pg));
    expect(filesHolding(backup, TITLE)).toEqual([]);
    expect(filesHolding(backup, 'Renamed').length).toBeGreaterThan(0);
    await pg.close();
  }, 120_000);
});

describe('a backup is a complete copy of what is stored', () => {
  it('restores to the same rows in every table, and is recognised as a backup', async () => {
    const { pg, db, userId } = await database();
    const { chat } = await importAll(db, userId);
    await deleteBatch(db, userId, chat.result.batchId!);
    const before = await contents(pg);
    expect(Object.keys(before)).toContain('_prisma_migrations');
    expect(before.conversations.length).toBe(2);

    const archive = await backupOf(pg);
    expect(await looksLikeDatabaseDump(archive)).toBe(true);

    const restored = new PGlite({ loadDataDir: archive });
    const report = await migrate(pgliteDriver(restored));
    // Nothing is left to set up: the copy has the schema and the record of how it was made.
    expect(report.applied).toEqual([]);
    expect(report.alreadyApplied).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await contents(restored)).toEqual(before);
    await Promise.all([pg.close(), restored.close()]);
  }, 120_000);

  it('goes on counting ids where the stored data stopped, so that nothing new takes the id of something deleted', async () => {
    const { pg, db, userId } = await database();
    const { chat, kept } = await importAll(db, userId);
    await deleteBatch(db, userId, kept.result.batchId!);
    const highest = Math.max(chat.result.batchId!, kept.result.batchId!);

    const restored = new PGlite({ loadDataDir: await backupOf(pg) });
    const rdb = pgliteDriver(restored);
    await migrate(rdb);
    const next = await importRecords(rdb, userId, { conversations: [conv('new')], messages: [msg('new', 0)] }, { contentHash: 'new' });
    expect(next.result.batchId).toBeGreaterThan(highest);
    // The same in the database the backup was made of: making a backup changes nothing there.
    const here = await importRecords(db, userId, { conversations: [conv('new')], messages: [msg('new', 0)] }, { contentHash: 'new' });
    expect(here.result.batchId).toBe(next.result.batchId);
    await Promise.all([pg.close(), restored.close()]);
  }, 120_000);

  it('copies every table and says how many rows of each', async () => {
    const { pg, db, userId } = await database();
    await importAll(db, userId);
    const fresh = new PGlite();
    const report = await copyLiveRows(pg, fresh);
    expect(Object.keys(report.rows)).toEqual(await tablesOf(pg));
    expect(report.rows.conversations).toBe(3);
    expect(report.rows.messages).toBe(5);
    expect(report.rows.usage_records).toBe(3);
    expect(report.rows._prisma_migrations).toBe(MIGRATIONS.length);
    // Constraints and triggers work again in the copy once it is filled.
    await expect(fresh.query(`INSERT INTO conversations (user_id, source_id, dedup_key, kind) VALUES (999999, 999999, 'x', 'chat')`)).rejects.toThrow();
    await Promise.all([pg.close(), fresh.close()]);
  }, 120_000);

  it('leaves the database it copies as it was, and usable', async () => {
    const { pg, db, userId } = await database();
    await importAll(db, userId);
    const before = await contents(pg);
    await backupOf(pg);
    expect(await contents(pg)).toEqual(before);
    await db.query(`UPDATE conversations SET title = 'still writable' WHERE title = $1`, [KEPT_TITLE]);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE title = 'still writable'`)).rows[0].n).toBe(1);
    await pg.close();
  }, 120_000);
});

describe('a copy that cannot be complete is not made', () => {
  it('refuses data that a newer version of the app has written', async () => {
    const pg = new PGlite();
    await migrate(pgliteDriver(pg), NEWER_MIGRATIONS);
    await ensureSeeded(pgliteDriver(pg), { timezone: 'UTC' });
    await expect(copyLiveRows(pg, new PGlite())).rejects.toBeInstanceOf(NewerSchemaError);
    await pg.close();
  }, 120_000);

  it('refuses data with a table this version does not set up, instead of leaving the table out', async () => {
    const { pg } = await database();
    await pg.exec(`CREATE TABLE "left_by_something_else" (id integer)`);
    await expect(copyLiveRows(pg, new PGlite())).rejects.toBeInstanceOf(CleanCopyError);
    await expect(backupOf(pg)).rejects.toThrow('The stored data has other tables than this version of the app sets up, so it cannot be copied.');
    await pg.close();
  }, 120_000);

  it('gives the copy the schema the stored data has, when that is older than this build', async () => {
    // Data last written before the newest migration: the copy is made with the migrations the data has.
    const older = MIGRATIONS.slice(0, -1);
    const pg = new PGlite();
    await migrate(pgliteDriver(pg), older);
    const fresh = new PGlite();
    const report = await copyLiveRows(pg, fresh);
    expect(report.rows._prisma_migrations).toBe(older.length);
    await Promise.all([pg.close(), fresh.close()]);
  }, 120_000);
});
