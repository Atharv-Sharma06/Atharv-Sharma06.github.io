import type { PGliteInterface, Transaction } from '@electric-sql/pglite';
import { DatabaseMovedError, DatabaseUnavailableError, type QueryResult, type SqlDriver, type SqlExecutor } from './driver';

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

export interface DriverOptions {
  /** Waits until what was committed is stored. Supplied by the caller because durability depends on where PGlite runs. */
  flush?: () => Promise<void>;
  /**
   * For a database that the tabs of the app share (see client.ts): calls `listener`
   * every time the database moves to the worker of another tab, until the function this
   * returns is called.
   */
  onMove?: (listener: () => void) => () => void;
  /**
   * True once the page has given this connection up (see client.ts). Nothing more is
   * sent through it then, so that code which was still waiting for the database when
   * that happened cannot go on with its work later, behind whatever the page shows now.
   */
  isOver?: () => boolean;
  /**
   * With `onMove`: what this tab's own attempt to open the database failed with, once it
   * has made one and failed, and how long an operation waits for this tab to be
   * connected to a worker that holds the database: in general, and once this tab's own
   * attempt has failed. After a move the wait is normally a second or two.
   */
  whyUnavailable?: () => string | null;
  connectTimeoutMs?: number;
  ownFailureTimeoutMs?: number;
}

/** Opening a large database from this device's storage takes a while, and the engine may have to be downloaded again first. */
const CONNECT_TIMEOUT_MS = 90_000;
/** Once this tab's own worker has failed, only another tab can open the database, and that one starts at once. */
const OWN_FAILURE_TIMEOUT_MS = 20_000;

/** Never settles. What waits for it goes no further. */
const forever = new Promise<never>(() => undefined);

/**
 * Wraps a PGlite instance (in-process, or the page's end of the worker that the tabs
 * share) as a SqlDriver.
 *
 * With `onMove`, the driver deals with the moment the shared database moves to another
 * tab's worker. PGlite's page class then fails the call it was waiting for, but goes on
 * with the rest of the operation (giving back its turn, rolling back) by asking a worker
 * that is not listening yet, and waits for an answer that never comes. So:
 *
 *  - Every operation that is under way when the database moves is rejected at once with
 *    a DatabaseMovedError, whatever PGlite goes on to do.
 *  - A transaction that was under way sends nothing more. Its transaction went with the
 *    worker that held it, and a statement, COMMIT or ROLLBACK that reached the new
 *    worker later would be carried out there outside of it, between the statements of
 *    whatever this tab is doing by then.
 *  - An operation that finds no worker holding the database waits for one, but not for
 *    good: when no tab gets the database open, it fails with a DatabaseUnavailableError.
 */
export function pgliteDriver(pg: PGliteInterface, opts: DriverOptions = {}): SqlDriver {
  const { onMove } = opts;
  let moves = 0;
  onMove?.(() => void moves++);
  const refuseWhenOver = () => {
    if (opts.isOver?.()) throw new Error('This connection to the database has been given up. Reload the page.');
  };

  /** Resolves once this tab is connected to a worker that holds the database. Rejects when none turns up in time. */
  const connected = () =>
    new Promise<void>((resolve, reject) => {
      const limit = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
      const limitAfterOwnFailure = Math.min(limit, opts.ownFailureTimeoutMs ?? OWN_FAILURE_TIMEOUT_MS);
      const since = Date.now();
      // Looked at again and again, because this tab's own attempt may fail while the operation already waits.
      const watching = setInterval(
        () => {
          const reason = opts.whyUnavailable?.() ?? null;
          const waited = Date.now() - since;
          if (waited < (reason === null ? limit : limitAfterOwnFailure)) return;
          clearInterval(watching);
          reject(new DatabaseUnavailableError(reason));
        },
        Math.min(250, Math.ceil(limitAfterOwnFailure / 2)),
      );
      pg.waitReady.then(
        () => {
          clearInterval(watching);
          resolve();
        },
        (error: unknown) => {
          clearInterval(watching);
          reject(error);
        },
      );
    });

  /** Settles the way `work` does, or rejects as soon as the database moves while `work` is under way. */
  const unlessMoved = async <T>(work: () => Promise<T>): Promise<T> => {
    refuseWhenOver();
    if (!onMove) return work();
    // While this tab is not connected (the database is just moving), the wait is here, where a further move
    // loses nothing: `work` has not asked the database for anything yet.
    await connected();
    return new Promise<T>((resolve, reject) => {
      const stopWatching = onMove(() => {
        stopWatching();
        reject(new DatabaseMovedError());
      });
      work().then(
        (value) => {
          stopWatching();
          resolve(value);
        },
        (error: unknown) => {
          stopWatching();
          reject(error);
        },
      );
    });
  };

  const direct = executor(pg);
  return {
    query: (sql, params) => unlessMoved(() => direct.query(sql, params)),
    exec: (sql) => unlessMoved(() => direct.exec(sql)),
    transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return unlessMoved(
        () =>
          pg.transaction(async (tx) => {
            const movesBefore = moves;
            const moved = () => moves !== movesBefore;
            const inside = executor(tx);
            const refuse = () => {
              if (moved()) throw new DatabaseMovedError();
              // Given up by the page while the worker is still there: this fails the transaction, and PGlite rolls it back.
              refuseWhenOver();
            };
            const statements: SqlExecutor = {
              async query(sql, params) {
                refuse();
                return inside.query(sql, params);
              },
              async exec(sql) {
                refuse();
                return inside.exec(sql);
              },
            };
            try {
              const result = await fn(statements);
              // PGlite would send COMMIT next, and ROLLBACK after an error. Neither may reach the new worker.
              if (moved()) await forever;
              return result;
            } catch (error) {
              if (moved()) await forever;
              throw error;
            }
          }) as Promise<T>,
      );
    },
    async flush() {
      await opts.flush?.();
    },
    async close() {
      await pg.close();
    },
  };
}
