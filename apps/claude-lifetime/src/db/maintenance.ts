import type { SqlExecutor } from './driver';

/**
 * Planner statistics.
 *
 * A PostgreSQL server keeps its table statistics current with a background process
 * (autovacuum). The database in the browser has no background processes, so nothing
 * ever tells the planner how large the tables are, and it then chooses plans that are
 * orders of magnitude slower: the conversation list took three seconds instead of
 * fifteen milliseconds on the demo data. The app therefore runs ANALYZE itself after
 * every change that moves a meaningful number of rows. ANALYZE only samples the
 * tables; it changes no data.
 */
export async function refreshStatistics(db: SqlExecutor): Promise<void> {
  await db.exec('ANALYZE');
}

/**
 * Runs ANALYZE when the main tables have never been analysed, or have changed a lot
 * since. Called when the database is opened, which covers databases restored from a
 * backup and ones written by an earlier version of the app.
 */
export async function ensureStatistics(db: SqlExecutor): Promise<boolean> {
  const { rows } = await db.query<{ stale: boolean }>(
    `SELECT bool_or(c.reltuples < 0 OR abs(c.reltuples - t.n) > GREATEST(50, t.n * 0.2)) AS stale
       FROM (VALUES ('conversations', (SELECT count(*) FROM conversations)::float8),
                    ('usage_records', (SELECT count(*) FROM usage_records)::float8),
                    ('estimate_buckets', (SELECT count(*) FROM estimate_buckets)::float8)) AS t(name, n)
       JOIN pg_class c ON c.oid = t.name::regclass`,
  );
  if (rows[0]?.stale !== true) return false;
  await refreshStatistics(db);
  return true;
}
