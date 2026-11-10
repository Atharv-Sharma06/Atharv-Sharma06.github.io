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
