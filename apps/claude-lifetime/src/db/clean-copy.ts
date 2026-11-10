import type { PGliteInterface } from '@electric-sql/pglite';
import { migrate, NewerSchemaError, unknownMigrations } from './migrate';
import { MIGRATIONS, type Migration } from './migrations.generated';
import { pgliteDriver } from './pglite-driver';

/**
 * Copies a database into a new, empty one, row by row, so that the copy holds what
 * is stored now and nothing else. A backup is made from that copy.
 *
 * Why a backup is not simply the database's own files: PostgreSQL does not erase
 * what is deleted. A deleted row stays in its table file until the space is used
 * again, and the write-ahead log keeps every row as it was first written. Packed up
 * as they are, those files would hand out conversation titles and folder names that
 * the person has deleted, readable by anyone who unpacks the archive. The copy made
 * here has never seen a deleted row, so neither have its files.
 *
 * `fresh` must be a database nothing was done to yet. It gets the schema from the
 * migrations the source has, then the rows of every table as COPY reads them, which
 * is as any query would: rows that are deleted are not among them. Sequences are
 * set to where the source's are, so ids go on from the same place after a restore.
 *
 * The source is read in one transaction, and every table is counted on both sides
 * before the copy is accepted: a backup that lacks rows without saying so would be
 * worse than none.
 */
export interface CleanCopyReport {
  /** Rows copied, by table. */
  rows: Record<string, number>;
}

/** The schema of the stored data and of the copy do not match, so nothing can be copied. Written for the person. */
export class CleanCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanCopyError';
  }
}

const TABLES = `
  SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY c.relname`;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function tableNames(db: Pick<PGliteInterface, 'query'>): Promise<string[]> {
  return (await db.query<{ name: string }>(TABLES)).rows.map((r) => r.name);
}

export async function copyLiveRows(source: PGliteInterface, fresh: PGliteInterface, migrations: Migration[] = MIGRATIONS): Promise<CleanCopyReport> {
  // The copy is given the schema the source has: the migrations recorded there, as this build knows them.
  const recorded = await source.query<{ migration_name: string; checksum: string }>(
    `SELECT "migration_name", "checksum" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
  );
  const done = new Map(recorded.rows.map((r) => [r.migration_name, r.checksum]));
  const unknown = unknownMigrations(done.keys(), migrations);
  if (unknown.length > 0) throw new NewerSchemaError(unknown);
  const applied = migrations.filter((m) => done.has(m.name));
  const edited = applied.find((m) => done.get(m.name) !== m.checksum);
  if (edited) {
    throw new CleanCopyError(`The stored data was set up by a different build of the app (migration "${edited.name}" differs), so it cannot be copied.`);
  }
  await migrate(pgliteDriver(fresh), applied);

  const tables = await tableNames(source);
  const inCopy = await tableNames(fresh);
  if (tables.length === 0 || tables.join('\n') !== inCopy.join('\n')) {
    throw new CleanCopyError('The stored data has other tables than this version of the app sets up, so it cannot be copied.');
  }

  // Rows are loaded as they are: no foreign key is checked and no trigger fires while the tables fill in any order.
  await fresh.exec(`SET session_replication_role = replica`);
  // Whatever the migrations put into their tables comes from the source like everything else.
  await fresh.exec(`TRUNCATE ${tables.map(quote).join(', ')} RESTART IDENTITY CASCADE`);

  const rows: Record<string, number> = {};
  const sequences = await source.transaction(async (tx) => {
    // One point in time for all tables. Nothing else runs on this connection meanwhile, and this says so to the database too.
    await tx.exec(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    for (const table of tables) {
      const out = await tx.query(`COPY ${quote(table)} TO '/dev/blob' WITH (FORMAT binary)`);
      if (!out.blob) throw new CleanCopyError(`The rows of "${table}" could not be read.`);
      await fresh.query(`COPY ${quote(table)} FROM '/dev/blob' WITH (FORMAT binary)`, [], { blob: out.blob });
      const stored = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quote(table)}`)).rows[0].n;
      const copied = (await fresh.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quote(table)}`)).rows[0].n;
      if (stored !== copied) {
        throw new CleanCopyError(`The copy of "${table}" is incomplete: ${copied} of ${stored} rows arrived. No backup was made.`);
      }
      rows[table] = Number(stored);
    }
    return (
      await tx.query<{ name: string; last: string | null }>(
        `SELECT quote_ident(schemaname) || '.' || quote_ident(sequencename) AS name, last_value::text AS last
           FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
      )
    ).rows;
  });

  // A sequence that was never used has no last value; the copy's is in the same state after the TRUNCATE above.
  for (const sequence of sequences) {
    if (sequence.last !== null) await fresh.query(`SELECT setval($1::regclass, $2::bigint, true)`, [sequence.name, sequence.last]);
  }
  await fresh.exec(`SET session_replication_role = DEFAULT`);
  // The restored database starts with statistics, as the source had them.
  await fresh.exec('ANALYZE');
  return { rows };
}

/**
 * A backup of `source`: the data directory of a copy that holds only the rows
 * stored now, as a gzip-compressed archive. `createFresh` supplies the new, empty
 * database the copy is made in; it is closed again when the archive is packed.
 */
export async function cleanBackup(source: PGliteInterface, createFresh: () => PGliteInterface | Promise<PGliteInterface>): Promise<Blob> {
  const fresh = await createFresh();
  try {
    await fresh.waitReady;
    await copyLiveRows(source, fresh);
    // Everything is on disk in the copy before its files are packed.
    await fresh.exec('CHECKPOINT');
    return (await fresh.dumpDataDir('gzip')) as Blob;
  } finally {
    await fresh.close().catch(() => undefined);
  }
}
