/**
 * The only interface the rest of the app uses to talk to PostgreSQL.
 *
 * In the browser it is backed by PGlite running in a Web Worker (see client.ts);
 * in tests by an in-memory PGlite; and it is small enough to back with
 * node-postgres if the app is ever deployed with a server-side database.
 */
export interface QueryResult<T> {
  rows: T[];
  affectedRows?: number;
}

export interface SqlExecutor {
  /** Run one statement with positional parameters ($1, $2, ...). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run one or more statements without parameters (DDL, migrations). */
  exec(sql: string): Promise<void>;
}

export interface SqlDriver extends SqlExecutor {
  /** Run `fn` in a transaction. Commits when it resolves, rolls back when it throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Wait until everything committed so far is durably stored. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The database moved to the worker of another tab while something was under way,
 * because the tab that held it was closed or reloaded. Whatever was running at that
 * moment went with that tab's worker: something that was being read can simply be read
 * again, and of a change it is not known whether it was stored. The message is written
 * for the person using the app.
 */
export class DatabaseMovedError extends Error {
  constructor() {
    super(DATABASE_MOVED_MESSAGE);
    this.name = 'DatabaseMovedError';
  }
}

const DATABASE_MOVED_MESSAGE =
  'The tab that held the database was closed or reloaded at that moment, and another tab has taken over. It is not known whether your change was stored: check, and make it again if it is missing.';

/**
 * Whether the message of a failed change is the one for a database that moved. The
 * change may then have been stored all the same, so what stands above the message must
 * not say that it was not. (The places that show a failure keep its message, not the error.)
 */
export const outcomeUnknown = (message: string | null | undefined): boolean => message === DATABASE_MOVED_MESSAGE;

/**
 * The database has had no tab to hold it for too long: the tab that held it went away,
 * and no other tab got it open (the files of the database engine could not be loaded,
 * for one, on a device that is offline by then). `reason` is what this tab's own
 * attempt failed with, when it made one. The message is written for the person.
 */
export class DatabaseUnavailableError extends Error {
  constructor(readonly reason: string | null = null) {
    super(
      `The database is not answering. The tab that held it was closed, and no tab has been able to open it since${reason ? ` (${reason})` : ''}. Reload this page.`,
    );
    this.name = 'DatabaseUnavailableError';
  }
}

/** How often something is read again when the database moved in the middle of reading it. */
export const REREAD_ATTEMPTS = 4;

/**
 * Runs `read`, and runs it again when the database moved to another tab in the middle
 * of it. Only for reading: a change must not be made twice. The next attempt waits by
 * itself until the tab that takes over has the database open.
 */
export async function rereadIfMoved<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof DatabaseMovedError) || attempt >= REREAD_ATTEMPTS) throw error;
    }
  }
}

/** Postgres returns int8 as number when it is a safe integer and as bigint otherwise. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value !== '') return Number(value);
  return 0;
}

export function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

/** timestamptz comes back as a Date; normalise to an ISO string for transport to the UI. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}
