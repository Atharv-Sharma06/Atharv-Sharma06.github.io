import type { PGliteInterface, Transaction } from '@electric-sql/pglite';
import type { QueryResult, SqlDriver, SqlExecutor } from './driver';

type Queryable = Pick<PGliteInterface, 'query' | 'exec'> | Pick<Transaction, 'query' | 'exec'>;

function executor(q: Queryable): SqlExecutor {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await q.query<T>(sql, params as any[]);
      return { rows: res.rows, affectedRows: res.affectedRows };
    },
    async exec(sql: string): Promise<void> {
      await q.exec(sql);
    },
  };
}

/**
 * Wraps a PGlite instance (in-process, or the cross-tab worker proxy) as a SqlDriver.
 * `flush` is supplied by the caller because durability depends on where PGlite runs.
 */
export function pgliteDriver(pg: PGliteInterface, opts: { flush?: () => Promise<void> } = {}): SqlDriver {
  return {
    ...executor(pg),
    transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return pg.transaction((tx) => fn(executor(tx))) as Promise<T>;
    },
    async flush() {
      await opts.flush?.();
    },
    async close() {
      await pg.close();
    },
  };
}
