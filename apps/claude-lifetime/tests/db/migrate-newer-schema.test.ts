import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { SqlDriver } from '@/db/driver';
import { migrate, MigrationError, NewerSchemaError, unknownMigrations } from '@/db/migrate';
import { MIGRATIONS, type Migration } from '@/db/migrations.generated';
import { pgliteDriver } from '@/db/pglite-driver';

/**
 * A static site keeps being served from the browser's cache for a while after a
 * release. A page of the previous version can therefore meet a database that the new
 * version has already upgraded, in another tab or through a backup. Its queries were
 * written for the older schema, so migrate() has to notice and refuse, with an error
 * the app can tell apart from a migration that failed.
 */
const LATER: Migration = {
  name: '20991231000000_from_a_later_release',
  checksum: 'b'.repeat(64),
  sql: 'ALTER TABLE "usage_records" ADD COLUMN "added_later" integer NOT NULL DEFAULT 0;',
};
const EVEN_LATER: Migration = { name: '20991231000100_another', checksum: 'c'.repeat(64), sql: 'CREATE TABLE "added_even_later" (id int);' };

async function withDatabase(test: (db: SqlDriver) => Promise<void>): Promise<void> {
  const db = pgliteDriver(new PGlite());
  try {
    await test(db);
  } finally {
    await db.close();
  }
}

const recorded = async (db: SqlDriver) =>
  (await db.query<{ migration_name: string }>(`SELECT "migration_name" FROM "_prisma_migrations" ORDER BY 1`)).rows.map((r) => r.migration_name);

describe('migrate() on a database written by a newer version of the app', () => {
  it('refuses with a NewerSchemaError that lists the migrations it does not know', async () => {
    await withDatabase(async (db) => {
      await migrate(db, [...MIGRATIONS, EVEN_LATER, LATER]);

      const failure = await migrate(db).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, 'an older build must not accept the newer database').not.toBeNull();
      expect(failure).toBeInstanceOf(NewerSchemaError);
      // oldest first, whatever order the database returns them in
      expect((failure as NewerSchemaError).unknownMigrations).toEqual([LATER.name, EVEN_LATER.name]);
      expect((failure as NewerSchemaError).message).toContain(LATER.name);
      expect((failure as NewerSchemaError).message).toContain(EVEN_LATER.name);
      // Not the error of a migration that failed: the two need different advice.
      expect(failure).not.toBeInstanceOf(MigrationError);
    });
  });

  it('applies nothing to it, not even migrations of its own that are missing there', async () => {
    await withDatabase(async (db) => {
      // A history this build only knows in part: its first migration, then one from elsewhere.
      await migrate(db, [MIGRATIONS[0], LATER]);
      const before = await recorded(db);

      await expect(migrate(db)).rejects.toBeInstanceOf(NewerSchemaError);
      expect(await recorded(db)).toEqual(before);
    });
  });

  it('accepts the database again once the build knows the migration', async () => {
    await withDatabase(async (db) => {
      await migrate(db, [...MIGRATIONS, LATER]);
      const report = await migrate(db, [...MIGRATIONS, LATER]);
      expect(report.applied).toEqual([]);
      expect(report.alreadyApplied).toEqual([...MIGRATIONS.map((m) => m.name), LATER.name]);
    });
  });

  it('does not count a migration that never finished or was rolled back', async () => {
    await withDatabase(async (db) => {
      await migrate(db);
      // What Prisma leaves behind for a migration that failed, and for one that was rolled back by hand.
      await db.exec(`
        INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "finished_at")
          VALUES ('unfinished', '${'d'.repeat(64)}', '20991231000200_unfinished', NULL);
        INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "finished_at", "rolled_back_at")
          VALUES ('rolled-back', '${'e'.repeat(64)}', '20991231000300_rolled_back', now(), now());
      `);
      const report = await migrate(db);
      expect(report.alreadyApplied).toEqual(MIGRATIONS.map((m) => m.name));
    });
  });

  it('still reports an edited or failing migration as a MigrationError, not as a newer version', async () => {
    await withDatabase(async (db) => {
      await migrate(db);
      const edited = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, checksum: 'f'.repeat(64) } : m));
      const first = await migrate(db, edited).catch((error: unknown) => error);
      expect(first).toBeInstanceOf(MigrationError);
      expect(first).not.toBeInstanceOf(NewerSchemaError);

      const failing = [...MIGRATIONS, { name: '99999999999999_broken', checksum: 'a'.repeat(64), sql: 'SELECT 1/0;' }];
      const second = await migrate(db, failing).catch((error: unknown) => error);
      expect(second).toBeInstanceOf(MigrationError);
      expect(second).not.toBeInstanceOf(NewerSchemaError);
    });
  });
});

describe('unknownMigrations()', () => {
  const known = [{ name: '20260101000000_a' }, { name: '20260201000000_b' }];

  it('is empty for a database this build wrote, complete or not', () => {
    expect(unknownMigrations(['20260101000000_a', '20260201000000_b'], known)).toEqual([]);
    expect(unknownMigrations(['20260101000000_a'], known)).toEqual([]);
    expect(unknownMigrations([], known)).toEqual([]);
  });

  it('names what the build does not have, oldest first and each once', () => {
    expect(unknownMigrations(['20270301000000_z', '20260101000000_a', '20270101000000_y', '20270301000000_z'], known)).toEqual([
      '20270101000000_y',
      '20270301000000_z',
    ]);
  });
});
