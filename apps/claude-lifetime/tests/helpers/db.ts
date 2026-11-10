import { PGlite } from '@electric-sql/pglite';
import type { SqlDriver } from '@/db/driver';
import { migrate } from '@/db/migrate';
import { pgliteDriver } from '@/db/pglite-driver';
import { ensureSeeded } from '@/db/seed';

export interface TestDb {
  db: SqlDriver;
  userId: number;
  /** Removes all imported data but keeps the user and the built-in catalog. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A real, in-memory PostgreSQL with the app's migrations and built-in catalog applied. */
export async function createTestDb(timezone = 'UTC'): Promise<TestDb> {
  const pg = new PGlite();
  const db = pgliteDriver(pg);
  await migrate(db);
  const userId = await ensureSeeded(db, { timezone });
  return {
    db,
    userId,
    async reset() {
      await db.exec(
        `TRUNCATE "data_sources", "subscription_periods" RESTART IDENTITY CASCADE;
         DELETE FROM "model_catalog" WHERE NOT "is_builtin";
         DELETE FROM "pricing_history" WHERE NOT "is_builtin";`,
      );
    },
    close: () => db.close(),
  };
}
