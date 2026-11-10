import { PGlite, protocol } from '@electric-sql/pglite';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabSession } from '@/db/worker/host';
import type { WorkerMeta } from '@/db/worker/pglite.worker';
import { after, installWebLocks, trackBroadcastChannels } from '../helpers/browser';
import {
  InProcessDatabaseWorker,
  pause,
  routeUnhandledRejections,
  sandboxTimers,
  serveEngineFiles,
  type RoutedRejections,
} from '../helpers/database-worker';

/**
 * Two tabs on one database: the real database worker serves both, and each tab talks to
 * it through PGlite's own page class, unchanged. What is under test is what the worker
 * does when one of the tabs goes away (is closed, reloaded or sent to another address)
 * at a bad moment. A tab that goes away lets go of its Web Lock and stops listening;
 * closing its client does exactly that.
 */
const meta = (name: string): WorkerMeta => ({ assetBase: 'https://app.test/pglite/0.5.16/', controlChannel: `claude-lifetime:db-control:${name}` });

type Listener = (event: { data: unknown }) => void;

/**
 * The worker of a tab that does not get to serve the database: it says that it is
 * there, names the database it was asked for, and then waits for a turn that does not
 * come while the other tab lives.
 */
class WaitingWorker {
  terminated = false;
  private listeners: Array<{ listener: Listener; once: boolean }> = [];
  constructor(private readonly id: string) {
    this.emit({ type: 'here' });
  }
  postMessage(message: { type?: string }) {
    if (message.type === 'init') this.emit({ type: 'ready', id: this.id });
  }
  addEventListener(type: string, listener: Listener, options?: { once?: boolean }) {
    if (type === 'message') this.listeners.push({ listener, once: options?.once === true });
  }
  removeEventListener(_type: string, listener: Listener) {
    this.listeners = this.listeners.filter((entry) => entry.listener !== listener);
  }
  terminate() {
    this.terminated = true;
  }
  private emit(data: unknown) {
    setTimeout(() => {
      if (this.terminated) return;
      const listeners = this.listeners;
      this.listeners = listeners.filter((entry) => !entry.once);
      for (const entry of listeners) entry.listener({ data });
    }, 0);
  }
}

let closeChannels: () => void;
let stopTimers: () => void;
let rejections: RoutedRejections | null;
let consoleErrors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  InProcessDatabaseWorker.created = [];
  rejections = null;
  closeChannels = trackBroadcastChannels();
  stopTimers = sandboxTimers();
  installWebLocks();
  serveEngineFiles();
  consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  stopTimers();
  for (const worker of InProcessDatabaseWorker.created) worker.terminate();
  await pause(50);
  closeChannels();
  await pause(50);
  rejections?.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Two tabs on database `name`: `one` is the tab whose worker serves it, `two` is another tab. */
async function twoTabs(name: string) {
  const id = `test:${name}`;
  const worker = new InProcessDatabaseWorker();
  const routed = routeUnhandledRejections(worker);
  rejections = routed;
  const one = new PGliteWorker(worker as unknown as Worker, { dataDir: `memory://${name}`, id, meta: meta(name) });
  await one.waitReady;
  const two = new PGliteWorker(new WaitingWorker(id) as unknown as Worker, { dataDir: `memory://${name}`, id, meta: meta(name) });
  await two.waitReady;
  await one.exec('CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL)');
  return { one, two, rejections: routed };
}

/** A promise and the function that settles it, for holding a transaction open until the test says so. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const ids = async (pg: PGliteWorker) => (await pg.query<{ id: number }>('SELECT id FROM notes ORDER BY id')).rows.map((row) => row.id);
const answered = <T>(work: Promise<T>) => Promise.race([work, after(5_000, 'no answer' as const)]);

describe('the database worker, when a tab goes away', () => {
  it('serves both tabs', async () => {
    const { one, two, rejections } = await twoTabs('both');
    await two.query("INSERT INTO notes VALUES (1, 'from the second tab')");
    await one.transaction(async (tx) => {
      await tx.query("INSERT INTO notes VALUES (2, 'from the first tab')");
    });
    expect(await ids(two)).toEqual([1, 2]);
    expect(rejections.unhandled).toEqual([]);
    expect(consoleErrors).not.toHaveBeenCalled();
  });

  it('does not keep the database for a tab that left while it was waiting for its turn', async () => {
    const { one, two, rejections } = await twoTabs('left-in-line');
    // Tab one is in the middle of a transaction, so tab two's query has to wait.
    const inside = gate();
    const finish = gate();
    const first = one.transaction(async (tx) => {
      await tx.query("INSERT INTO notes VALUES (1, 'one')");
      inside.open();
      await finish.opened;
    });
    await inside.opened;
    two.query('SELECT 1').catch(() => undefined);
    await pause(50);
    // Tab two is closed while its request stands in line.
    await two.close();
    await pause(50);
    finish.open();
    await first;

    // Before the fix the turn went to the tab that was gone and never ended: no tab got an answer again.
    expect(await answered(ids(one))).toEqual([1]);
    expect(await answered(one.transaction(async (tx) => (await tx.query<{ n: number }>('SELECT 2 AS n')).rows))).toEqual([{ n: 2 }]);
    // Nothing is posted to the tab that is gone, which would raise an error for every answer.
    expect(rejections.unhandled).toEqual([]);
    expect(consoleErrors).not.toHaveBeenCalled();
  }, 60_000);

  it('does not keep it either when several of the tab’s queries were waiting, as on a page that is still loading', async () => {
    const { one, two, rejections } = await twoTabs('page-load');
    // A page fires its queries together. The first gets its turn and the others stand in line behind it.
    for (let n = 0; n < 6; n++) two.query('SELECT pg_sleep(0.05)').catch(() => undefined);
    await pause(20);
    await two.close();

    expect(await answered(ids(one))).toEqual([]);
    expect(rejections.unhandled).toEqual([]);
    expect(consoleErrors).not.toHaveBeenCalled();
  }, 60_000);

  it('rolls back what the tab left unfinished before the next tab gets its turn', async () => {
    const { one, two, rejections } = await twoTabs('left-in-transaction');
    const inside = gate();
    // Tab two is half way through a transaction: one row written, more to come.
    two
      .transaction(async (tx) => {
        await tx.query("INSERT INTO notes VALUES (1, 'half-finished')");
        inside.open();
        await new Promise(() => undefined);
      })
      .catch(() => undefined);
    await inside.opened;
    // Tab one wants to save something of its own and waits for its turn.
    const next = one.transaction(async (tx) => {
      await tx.query("INSERT INTO notes VALUES (2, 'complete')");
    });
    await pause(50);
    await two.close();

    expect(await answered(next)).toBeUndefined();
    // Before the fix tab one's transaction went on inside the one that was left open,
    // and its COMMIT stored the half-finished row as well: [1, 2].
    expect(await answered(ids(one))).toEqual([2]);
    expect(rejections.unhandled).toEqual([]);
    expect(consoleErrors).not.toHaveBeenCalled();
  }, 60_000);

  it('goes on serving a tab that is still there after another one left in the middle of a statement that failed', async () => {
    const { one, two, rejections } = await twoTabs('left-after-error');
    const inside = gate();
    two
      .transaction(async (tx) => {
        await tx.query("INSERT INTO notes VALUES (1, 'written')");
        await tx.query('SELECT * FROM no_such_table').catch(() => undefined);
        inside.open();
        await new Promise(() => undefined);
      })
      .catch(() => undefined);
    await inside.opened;
    await two.close();
    await pause(50);

    expect(await answered(ids(one))).toEqual([]);
    await one.query("INSERT INTO notes VALUES (2, 'after')");
    expect(await answered(ids(one))).toEqual([2]);
    expect(rejections.unhandled).toEqual([]);
  }, 60_000);
});

describe('what the database worker carries out for a tab', () => {
  let pg: PGlite;
  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec('CREATE TABLE notes (id integer PRIMARY KEY)');
  });
  afterEach(() => pg.close());

  const insert = (id: number) => protocol.serialize.query(`INSERT INTO notes VALUES (${id})`);
  const call = (session: TabSession, method: string, ...args: unknown[]) => (session.calls[method] as (...args: unknown[]) => Promise<unknown>)(...args);
  const stored = async () => (await pg.query<{ id: number }>('SELECT id FROM notes ORDER BY id')).rows.map((row) => row.id);

  it('runs a statement during the tab’s turn, and not outside of one', async () => {
    const session = new TabSession(pg);
    // What a page does after the database has moved: it goes on where it was, with a statement for a turn it no longer has.
    await expect(call(session, 'execProtocol', insert(1))).rejects.toThrow('outside of that tab’s turn');
    await expect(call(session, 'execProtocolStream', insert(1))).rejects.toThrow('outside of that tab’s turn');
    await expect(call(session, 'execProtocolRaw', insert(1))).rejects.toThrow('outside of that tab’s turn');
    await expect(call(session, '_handleBlob', new Blob(['x']))).rejects.toThrow('outside of that tab’s turn');
    expect(await stored()).toEqual([]);

    await call(session, '_acquireTransactionLock');
    await call(session, '_acquireQueryLock');
    await call(session, 'execProtocol', insert(1));
    await call(session, '_releaseQueryLock');
    await call(session, '_releaseTransactionLock');
    expect(await stored()).toEqual([1]);
  });

  it('gives no turn at the server to a tab that does not hold the turn for a transaction', async () => {
    const holder = new TabSession(pg);
    const stale = new TabSession(pg);
    // One tab is in the middle of a transaction, between two statements.
    await call(holder, '_acquireTransactionLock');
    await call(holder, '_acquireQueryLock');
    await call(holder, 'execProtocol', protocol.serialize.query('BEGIN'));
    await call(holder, 'execProtocol', insert(1));
    await call(holder, '_releaseQueryLock');

    // Another tab's page tries to roll back a transaction it had before the database moved here.
    // Before this rule it got the turn at once, and its ROLLBACK ended the first tab's transaction.
    await expect(call(stale, '_acquireQueryLock')).rejects.toThrow('outside of that tab’s turn');
    await call(stale, '_releaseTransactionLock');

    await call(holder, '_acquireQueryLock');
    await call(holder, 'execProtocol', insert(2));
    await call(holder, 'execProtocol', protocol.serialize.query('COMMIT'));
    await call(holder, '_releaseQueryLock');
    await call(holder, '_releaseTransactionLock');
    expect(await stored()).toEqual([1, 2]);
  });

  it('does nothing more for a tab that is gone, and leaves the database free', async () => {
    const session = new TabSession(pg);
    await call(session, '_acquireTransactionLock');
    await call(session, '_acquireQueryLock');
    await call(session, 'execProtocol', protocol.serialize.query('BEGIN'));
    await call(session, 'execProtocol', insert(1));

    await session.leave();

    expect(pg.isInTransaction()).toBe(false);
    expect(await answered(stored())).toEqual([]);
    expect(consoleErrors).not.toHaveBeenCalled();
  });

  it('also when the tab left in the middle of an exchange that had failed', async () => {
    const session = new TabSession(pg);
    await call(session, '_acquireTransactionLock');
    await call(session, '_acquireQueryLock');
    await call(session, 'execProtocol', protocol.serialize.query('BEGIN'));
    await call(session, 'execProtocol', insert(1));
    // The first step of a statement with parameters fails, and the tab is gone before it ends the exchange.
    // The server skips everything up to that end, a ROLLBACK included, so the worker has to send the end first.
    await expect(call(session, 'execProtocol', protocol.serialize.parse({ text: 'SELECT * FROM no_such_table' }))).rejects.toThrow('no_such_table');

    await session.leave();

    expect(pg.isInTransaction()).toBe(false);
    expect(await answered(stored())).toEqual([]);
    await pg.exec('INSERT INTO notes VALUES (7)');
    expect(await answered(stored())).toEqual([7]);
    expect(consoleErrors).not.toHaveBeenCalled();
  });
});
