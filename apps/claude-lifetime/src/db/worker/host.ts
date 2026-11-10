/// <reference lib="webworker" />
import { protocol, type PGlite } from '@electric-sql/pglite';
import type { PGliteWorkerOptions } from '@electric-sql/pglite/worker';

/**
 * The worker's half of sharing one database between the tabs of the app.
 *
 * Every tab starts a worker. One of them holds the database and serves all tabs; the
 * others wait and take over when that tab goes away. Pages talk to the serving worker
 * through PGlite's own page class, PGliteWorker, so this file speaks that class's
 * protocol (PGlite 0.5.16):
 *
 *   page to its worker        { type: 'init', options }
 *   worker to its page        { type: 'here' }, { type: 'ready', id }, and
 *                             { type: 'leader-now' } when this worker starts serving
 *   pglite-broadcast:<id>     worker: { type: 'leader-here', id }, { type: 'notify', … }
 *                             page:   { type: 'tab-here', id: <tab> }, repeated until it is answered
 *   pglite-tab:<tab>          page:   { type: 'rpc-call', callId, method, args }
 *                             worker: { type: 'connected' }, { type: 'rpc-return', callId, result },
 *                                     { type: 'rpc-error', callId, error: { message } }
 *   Web Locks                 pglite-election-lock:<id>, held by the worker that serves;
 *                             pglite-tab-close:<tab>, held by a page for as long as it lives
 *
 * PGlite ships a counterpart of its own for this (`worker()` in the same package).
 * This file replaces it because of what that one does when a tab goes away, which is
 * what closing a tab, reloading it or typing another address into it amounts to:
 *
 *  - A tab that went away while it was waiting in line for the database was still given
 *    its turn later, and nothing ever ended that turn. A page fires its queries
 *    together, so reloading a tab while it was loading was enough. From then on no tab
 *    got an answer, and a new tab stayed on "Preparing the database…", until the tab
 *    whose worker serves was reloaded.
 *  - A tab that went away in the middle of a transaction had its turn passed on before
 *    that transaction was rolled back. The next tab in line then went on inside it, and
 *    its COMMIT stored the unfinished work of the tab that was gone.
 *  - Answers were still posted to the channel of a tab that was gone, which raises an
 *    error for each of them.
 *
 * It is also stricter than that one about what it carries out. A statement is only run
 * for a tab during a turn that this worker gave it, and a turn at the server is only
 * given to a tab that holds the turn for a transaction. Pages never ask otherwise while
 * all is well. They can after the database has moved here from the worker of a tab that
 * went away: the page class then goes on with what it was doing there, and a statement
 * or a ROLLBACK that arrived here outside of a turn would be carried out between the
 * statements of whoever holds the turn now. (`PGliteWorker.runExclusive()`, which asks
 * for the turn at the server alone, is refused for the same reason. The app does not use it.)
 *
 * The database's name for the locks and channels is `options.id`, or one made from the
 * data directory. It does not depend on where this file ends up in a build: two builds
 * of the app open in two tabs must compete for the same lock, or both would open the
 * same stored database at once.
 */

/** What a page sends on its own channel to have something done with the database. */
interface Call {
  type: 'rpc-call';
  callId: string;
  method: string;
  args: unknown[];
}

type Answer = { type: 'rpc-return'; callId: string; result: unknown } | { type: 'rpc-error'; callId: string; error: { message: string } };

/**
 * The two turns a page can hold. PGlite lets one transaction (or single statement) at a
 * time at the database, and inside it one exchange with the server at a time; a page
 * asks for each turn, does its work in further calls, and gives the turn back.
 */
type Turn = 'query' | 'transaction';

/** Takes the Web Lock `name` and keeps it for as long as this worker lives. Resolves once it is held. */
function keepLock(name: string): Promise<void> {
  return new Promise((held) => {
    void navigator.locks.request(name, () => new Promise<never>(() => held()));
  });
}

/** Resolves when the Web Lock `name` can be had. For the lock a page holds while it lives, that is when the page is gone. */
function whenFree(name: string): Promise<void> {
  return new Promise((free) => {
    void navigator.locks.request(name, async () => free());
  });
}

/**
 * A result that is a view into the engine's memory is copied out, so that the answer
 * carries those bytes and not the whole memory they lie in.
 */
const copiedOut = (bytes: Uint8Array): Uint8Array => (bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice());

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The answer to a call that came outside of a turn. Hardly ever read: what sent the call has been told already that the database moved. */
const OUTSIDE_A_TURN = 'The database was asked to do this for a tab outside of that tab’s turn. What the tab was doing was started before the database moved, and is lost: do it again.';

/** One tab's dealings with the database: the calls it can make and the turns it holds. */
export class TabSession {
  /** True from the moment the tab is known to be gone. */
  gone = false;
  /** Ends the turn the tab holds, per kind of turn. */
  private readonly held: Record<Turn, (() => void) | null> = { query: null, transaction: null };

  constructor(private readonly db: PGlite) {}

  /** The calls a page can make, under the names PGliteWorker uses for them. */
  readonly calls: Record<string, (...args: never[]) => Promise<unknown>> = {
    getDebugLevel: async () => this.db.debug,
    execProtocol: this.inTurn(async (message: Uint8Array) => {
      const { messages, data } = await this.db.execProtocol(message);
      return { messages, data: copiedOut(data) };
    }),
    execProtocolStream: this.inTurn((message: Uint8Array) => this.db.execProtocolStream(message)),
    execProtocolRaw: this.inTurn(async (message: Uint8Array) => copiedOut(await this.db.execProtocolRaw(message))),
    dumpDataDir: (compression?: 'none' | 'gzip' | 'auto') => this.db.dumpDataDir(compression),
    syncToFs: () => this.db.syncToFs(),
    _handleBlob: this.inTurn((blob?: File | Blob) => this.db._handleBlob(blob)),
    _getWrittenBlob: this.inTurn(() => this.db._getWrittenBlob()),
    _cleanupBlob: this.inTurn(() => this.db._cleanupBlob()),
    _checkReady: () => this.db._checkReady(),
    _acquireQueryLock: () => this.take('query'),
    _releaseQueryLock: async () => this.giveBack('query'),
    _acquireTransactionLock: () => this.take('transaction'),
    _releaseTransactionLock: async () => this.giveBack('transaction'),
  };

  /** `work`, carried out only while the tab holds its turn at the server. */
  private inTurn<A extends unknown[], R>(work: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A) => {
      if (!this.held.query) throw new Error(OUTSIDE_A_TURN);
      return work(...args);
    };
  }

  /** Stands in line for a turn and resolves when the tab has it. */
  private async take(turn: Turn): Promise<void> {
    if (turn === 'query' && !this.held.transaction) throw new Error(OUTSIDE_A_TURN);
    const inLine = <T>(work: () => Promise<T>) => (turn === 'query' ? this.db._runExclusiveQuery(work) : this.db._runExclusiveTransaction(work));
    return new Promise<void>((granted, refused) => {
      inLine(
        () =>
          new Promise<void>((end) => {
            // A tab that left while it stood in line gets no turn: nobody would ever end it.
            if (this.gone) end();
            else this.held[turn] = end;
            granted();
          }),
      ).catch(refused);
    });
  }

  private giveBack(turn: Turn): void {
    this.held[turn]?.();
    this.held[turn] = null;
  }

  /**
   * The tab is gone. Ends what it had begun and gives up its turns, so that the next in
   * line starts with a database nobody is in the middle of.
   */
  async leave(): Promise<void> {
    this.gone = true;
    if (this.held.transaction) {
      const tidyUp = async () => {
        // First the end of an exchange the tab may have left half done; until then the server would skip whatever follows.
        await this.db.execProtocol(protocol.serialize.sync(), { throwOnError: false });
        // Then the transaction it may have left open. Without this the next tab would go on inside it.
        if (this.db.isInTransaction()) await this.db.execProtocol(protocol.serialize.query('ROLLBACK'), { throwOnError: false });
      };
      try {
        // The tab's own turn at the server is used when it has one; otherwise this waits for one like anybody else.
        await (this.held.query ? tidyUp() : this.db._runExclusiveQuery(tidyUp));
      } catch (error) {
        console.error('Claude Lifetime: what a closed tab left unfinished could not be rolled back.', error);
      }
    }
    this.giveBack('query');
    this.giveBack('transaction');
  }
}

/** Starts answering the tab `tabId`, once. Stops, and tidies up after it, when the tab is gone. */
function serveTab(tabId: string, db: PGlite, served: Set<string>): void {
  if (served.has(tabId)) return;
  served.add(tabId);
  const channel = new BroadcastChannel(`pglite-tab:${tabId}`);
  const session = new TabSession(db);

  void whenFree(`pglite-tab-close:${tabId}`).then(() => {
    channel.close();
    served.delete(tabId);
    return session.leave();
  });

  const answer = async ({ callId, method, args }: Call): Promise<void> => {
    let reply: Answer;
    try {
      await db.waitReady;
      // Nothing is done any more for a tab that is gone: its transaction has been rolled back,
      // and a statement of it that ran now would be stored on its own.
      if (session.gone) return;
      const call = session.calls[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
      if (!call) throw new Error(`The database worker has no call named "${method}".`);
      reply = { type: 'rpc-return', callId, result: await call(...args) };
    } catch (error) {
      reply = { type: 'rpc-error', callId, error: { message: messageOf(error) } };
    }
    // Nobody listens on the channel of a tab that is gone, and posting to a closed channel is an error.
    if (session.gone) return;
    try {
      channel.postMessage(reply);
    } catch (error) {
      // A result that cannot be sent (it holds something that cannot be copied) must not leave the page waiting.
      channel.postMessage({ type: 'rpc-error', callId, error: { message: messageOf(error) } } satisfies Answer);
    }
  };
  channel.addEventListener('message', (event: MessageEvent<Partial<Call> | undefined>) => {
    const message = event.data;
    if (message?.type !== 'rpc-call' || typeof message.callId !== 'string' || typeof message.method !== 'string') return;
    void answer({ type: 'rpc-call', callId: message.callId, method: message.method, args: Array.isArray(message.args) ? message.args : [] });
  });
  channel.postMessage({ type: 'connected' });
}

/**
 * Runs this worker's part: waits for the page's options, then for its turn to serve the
 * database, starts the database with `start` and answers the tabs. Resolves once the
 * database is up, and rejects when it could not be started.
 */
export async function host(start: (options: PGliteWorkerOptions) => Promise<PGlite>): Promise<void> {
  self.postMessage({ type: 'here' });
  const options = await new Promise<PGliteWorkerOptions>((resolve) => {
    self.addEventListener('message', (event: MessageEvent<{ type?: string; options?: PGliteWorkerOptions }>) => {
      if (event.data?.type === 'init') resolve(event.data.options ?? {});
    });
  });
  const id = options.id ?? `claude-lifetime:${options.dataDir ?? ''}`;
  self.postMessage({ type: 'ready', id });

  // For as long as another tab's worker serves the database, this waits here.
  await keepLock(`pglite-election-lock:${id}`);

  const starting = start(options);
  const served = new Set<string>();
  const broadcast = new BroadcastChannel(`pglite-broadcast:${id}`);
  broadcast.onmessage = (event: MessageEvent<{ type?: string; id?: unknown } | undefined>) => {
    const message = event.data;
    if (message?.type !== 'tab-here' || typeof message.id !== 'string') return;
    const tabId = message.id;
    // A database that did not start serves nobody. Its page is told why by the caller of this function.
    starting.then(
      (db) => serveTab(tabId, db, served),
      () => undefined,
    );
  };
  // Said before the database is up: pages then know at once that whatever they had asked the previous worker is lost.
  broadcast.postMessage({ type: 'leader-here', id });
  self.postMessage({ type: 'leader-now' });

  const db = await starting;
  db.onNotification((channel, payload) => broadcast.postMessage({ type: 'notify', channel, payload }));
}
