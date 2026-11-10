import type { SqlExecutor } from '@/db/driver';

/**
 * Makes sure PostgreSQL has table statistics before the conversation list is queried.
 *
 * The database in the browser never runs autovacuum, so after an import the planner
 * knows nothing about the size of the tables. It then joins every conversation to the
 * per-conversation token totals with a nested loop that recomputes the totals for each
 * row: about three seconds for the demo dataset, against a few milliseconds once
 * `ANALYZE` has run. Statistics only steer the planner; no data is changed.
 *
 * The check is two cheap reads, and ANALYZE itself runs only when the statistics are
 * missing or no longer match the table. This belongs with the import (after a commit
 * or a delete); it lives here until the shared code does it.
 */
const checked = new WeakMap<SqlExecutor, { version: number; done: Promise<void> }>();

async function refreshIfStale(db: SqlExecutor): Promise<void> {
  const { rows } = await db.query<{ estimated: number; actual: number }>(
    `SELECT c.reltuples::float8 AS estimated, (SELECT count(*) FROM conversations)::float8 AS actual
       FROM pg_class c WHERE c.oid = 'conversations'::regclass`,
  );
  const stats = rows[0];
  // reltuples is -1 for a table that was never analysed
  const stale = !stats || stats.estimated < 0 || Math.abs(stats.estimated - stats.actual) > Math.max(50, stats.actual * 0.2);
  if (stale) await db.exec('ANALYZE');
}

/** Resolves once the statistics are known to be usable for this version of the data. Never rejects. */
export function ensurePlannerStatistics(db: SqlExecutor, dataVersion: number): Promise<void> {
  const known = checked.get(db);
  if (known && known.version === dataVersion) return known.done;
  // A failure here only costs speed, so it must not keep the list from loading.
  const done = refreshIfStale(db).catch(() => undefined);
  checked.set(db, { version: dataVersion, done });
  return done;
}
