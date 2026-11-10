import { PGlite } from '@electric-sql/pglite';
import type { SqlDriver } from '@/db/driver';
import { migrate } from '@/db/migrate';
import { MIGRATIONS, type Migration } from '@/db/migrations.generated';
import { pgliteDriver } from '@/db/pglite-driver';
import { ensureSeeded } from '@/db/seed';
import type { FlushAnswer, FlushRequest, WorkerMeta } from '@/db/worker/pglite.worker';
import { timeline } from './browser';

/**
 * Stands in for PGliteWorker, the page's half of PGlite's multi-tab worker, so that
 * src/db/client.ts can run under Node. A test file swaps it in with
 *
 *   vi.mock('@electric-sql/pglite/worker', async (original) => ({
 *     ...(await original<object>()),
 *     PGliteWorker: (await import('../helpers/fake-pglite-worker')).FakePGliteWorker,
 *   }));
 *
 * Every connection is a real PostgreSQL in memory, so migrations, queries and backups
 * are the real thing. What a browser keeps in IndexedDB is `fakeDatabases.stored`; what
 * the database worker answers to a flush request is `fakeDatabases.answerFlush`.
 */
interface WorkerLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  postMessage(message: unknown): void;
  onTerminate?: Array<() => void>;
}

export interface OpenedDatabase {
  name: string;
  /** Whether it was opened to unpack a backup into it. */
  fromBackup: boolean;
  /** Whether the page closed the connection, which stops the real worker. */
  closed: boolean;
}

const confirm = (request: FlushRequest): FlushAnswer | null => ({ op: 'flushed', id: request.id, ok: true });

export const fakeDatabases = {
  /** Data directories "in IndexedDB", by database name. A connection to a name starts from its entry. */
  stored: new Map<string, Blob>(),
  /** Every connection the page opened, in order. */
  opened: [] as OpenedDatabase[],
  /**
   * What the worker of database `name` answers to a flush request. Null leaves the
   * request unanswered; a promise answers when it settles, like a copy that takes a while.
   */
  answerFlush: confirm as (request: FlushRequest, name: string) => FlushAnswer | null | Promise<FlushAnswer | null>,
  /** False for a database whose worker never gets it started: the page then waits and is told nothing by PGlite. */
  becomeReady: true,
  reset() {
    this.stored.clear();
    this.opened.length = 0;
    this.answerFlush = confirm;
    this.becomeReady = true;
  },
};

export class FakePGliteWorker {
  readonly waitReady: Promise<void>;
  private pg: PGlite | null = null;
  private control: BroadcastChannel | null = null;
  private readonly record: OpenedDatabase;

  constructor(worker: WorkerLike, options: { dataDir: string; loadDataDir?: Blob; meta: WorkerMeta }) {
    const name = options.dataDir.replace(/^idb:\/\//, '');
    this.record = { name, fromBackup: options.loadDataDir !== undefined, closed: false };
    fakeDatabases.opened.push(this.record);
    timeline.push(`open ${name}`);
    // The real class answers the worker's "here" with the options. A worker that really runs waits for them.
    worker.addEventListener('message', (event) => {
      if ((event.data as { type?: unknown } | undefined)?.type === 'here') worker.postMessage({ type: 'init', options });
    });
    worker.onTerminate?.push(() => this.shutDown());

    if (!fakeDatabases.becomeReady) {
      this.waitReady = new Promise<void>(() => undefined);
      return;
    }
    const pg = new PGlite({ loadDataDir: options.loadDataDir ?? fakeDatabases.stored.get(name) });
    this.pg = pg;
    this.waitReady = pg.waitReady.then(() => {
      // As in the real worker, flush requests are answered from the moment the database is up.
      const control = new BroadcastChannel(options.meta.controlChannel);
      this.control = control;
      control.onmessage = async (event: MessageEvent<FlushRequest>) => {
        if (event.data?.op !== 'flush') return;
        timeline.push(`flush requested ${name}`);
        const answer = await fakeDatabases.answerFlush(event.data, name);
        timeline.push(`flush ${name}: ${answer === null ? 'no answer' : answer.ok ? 'ok' : 'failed'}`);
        // The worker may have been stopped while the copy was under way.
        if (answer && this.control === control) control.postMessage(answer);
      };
    });
  }

  private get database(): PGlite {
    if (!this.pg) throw new Error('This database never started.');
    return this.pg;
  }

  query(sql: string, params?: unknown[]) {
    return this.database.query(sql, params as never[]);
  }
  exec(sql: string) {
    return this.database.exec(sql);
  }
  transaction(fn: never) {
    return this.database.transaction(fn);
  }
  dumpDataDir(compression?: 'gzip' | 'none' | 'auto') {
    return this.database.dumpDataDir(compression);
  }

  /** PGliteWorker.close() stops the worker at once; here the database in memory goes with it. */
  async close() {
    if (this.record.closed) return;
    this.record.closed = true;
    timeline.push(`close ${this.record.name}`);
    this.shutDown();
  }

  private shutDown() {
    this.control?.close();
    this.control = null;
    const pg = this.pg;
    this.pg = null;
    void pg?.close().catch(() => undefined);
  }
}

/**
 * The data directory of a database with the app's schema and built-in catalog, as one
 * gzip-compressed archive: exactly what "Download backup" hands out, and what
 * `fakeDatabases.stored` holds. `migrations` are the ones of the build that wrote it;
 * `change` can alter the database before it is packed.
 */
export async function dataDirectory(migrations: Migration[] = MIGRATIONS, change?: (db: SqlDriver) => Promise<void>): Promise<Blob> {
  const pg = new PGlite();
  const db = pgliteDriver(pg);
  await migrate(db, migrations);
  await ensureSeeded(db);
  await change?.(db);
  const archive = (await pg.dumpDataDir('gzip')) as Blob;
  await pg.close();
  return archive;
}

/** The migrations of a later release: everything this build has plus one more. */
export const NEWER_MIGRATIONS: Migration[] = [
  ...MIGRATIONS,
  { name: '20991231000000_from_a_later_release', checksum: 'b'.repeat(64), sql: 'ALTER TABLE "usage_records" ADD COLUMN "added_later" integer NOT NULL DEFAULT 0;' },
];
