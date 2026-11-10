import { AsyncLocalStorage } from 'node:async_hooks';
import { vi } from 'vitest';
import type { SqlDriver } from '@/db/driver';
import type { FromWorker, ToWorker } from '@/import/worker/protocol';

/**
 * What src/import/session.ts needs from a browser, so that ImportSession can be tested
 * under Node:
 *
 *  - installWebLocks(): an in-memory Web Locks API (navigator.locks) that honours
 *    `ifAvailable`, so the import lock behaves as it does between tabs.
 *  - ScriptedWorker: a Worker whose answers a test writes by hand, to reproduce exact
 *    message timings (a cancel between two batches, a worker that dies).
 *  - RealWorker: runs the real worker module (src/import/worker/import.worker.ts)
 *    in-process, with messages copied and delivered asynchronously as postMessage does.
 *  - observed(): a database wrapper that records when each statement starts and ends,
 *    and can make every statement take as long as it does in the browser.
 *
 * The globals are replaced with vi.stubGlobal; call vi.unstubAllGlobals() after a test.
 */

// ── Web Locks ────────────────────────────────────────────────────────────────
export interface LockLog {
  /** Names of the locks that are held right now. */
  held: Set<string>;
  /** When (performance.now()) each lock was given back, in order. */
  released: number[];
  refused: number;
}

/**
 * `grantAfterMs` makes the answer to a request take that long, as it can in a browser,
 * where the lock manager lives in another process.
 */
export function installWebLocks(options: { grantAfterMs?: number } = {}): LockLog {
  const log: LockLog = { held: new Set(), released: [], refused: 0 };
  const waiting = new Map<string, Array<() => void>>();
  const locks = {
    request(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const asked = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
      const callback = (typeof a === 'function' ? a : b) as (lock: { name: string } | null) => unknown;
      const hold = async () => {
        try {
          if (options.grantAfterMs) await sleep(options.grantAfterMs);
          return await callback({ name });
        } finally {
          log.held.delete(name);
          log.released.push(performance.now());
          waiting.get(name)?.shift()?.();
        }
      };
      if (log.held.has(name)) {
        if (asked.ifAvailable) {
          log.refused++;
          return Promise.resolve(callback(null));
        }
        return new Promise((resolve, reject) => {
          const queue = waiting.get(name) ?? [];
          waiting.set(name, queue);
          queue.push(() => {
            log.held.add(name);
            hold().then(resolve, reject);
          });
        });
      }
      // The lock is taken from the moment it is asked for, also while the answer is still on its way.
      log.held.add(name);
      return hold();
    },
  };
  vi.stubGlobal('navigator', { locks });
  return log;
}

// ── Workers ──────────────────────────────────────────────────────────────────
type Listener = (event: { data: unknown; message?: string }) => void;

class FakeWorker {
  static created: FakeWorker[] = [];
  terminated = false;
  /** Everything the page posted to this worker. */
  readonly received: ToWorker[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    FakeWorker.created.push(this);
  }
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  terminate() {
    this.terminated = true;
  }
  /** Delivers a message from the worker to the page, asynchronously as postMessage does. A terminated worker delivers nothing. */
  emit(message: FromWorker) {
    const copy: unknown = structuredClone(message);
    setTimeout(() => {
      if (this.terminated) return;
      for (const listener of [...(this.listeners.get('message') ?? [])]) listener({ data: copy });
    }, 0);
  }
  /** An `error` event, as the browser raises it when the worker's script fails. */
  emitError(message: string) {
    setTimeout(() => {
      for (const listener of [...(this.listeners.get('error') ?? [])]) listener({ data: undefined, message });
    }, 0);
  }
  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** A worker a test drives by hand: `respond` is called with every message the page posts. */
export class ScriptedWorker extends FakeWorker {
  static respond: (worker: ScriptedWorker, message: ToWorker) => void = () => undefined;
  postMessage(message: ToWorker) {
    if (this.terminated) return;
    this.received.push(message);
    ScriptedWorker.respond(this, message);
  }
}

// The real worker module talks to the global `self`. Every RealWorker gets a scope of
// its own, selected through AsyncLocalStorage, so that two workers never share state.
interface Scope {
  onmessage: ((event: { data: unknown }) => unknown) | null;
  postMessage(message: FromWorker): void;
}
const scopes = new AsyncLocalStorage<Scope>();
let loading: Scope | null = null;
const currentScope = (): Record<string | symbol, unknown> => {
  const scope = scopes.getStore() ?? loading;
  if (!scope) throw new Error('worker code ran outside of a worker scope');
  return scope as unknown as Record<string | symbol, unknown>;
};
const selfProxy = new Proxy(
  {},
  {
    get: (_target, key) => currentScope()[key],
    set: (_target, key, value) => {
      currentScope()[key] = value;
      return true;
    },
  },
);

/** Runs the real import worker module in-process. */
export class RealWorker extends FakeWorker {
  private readonly scope: Scope;
  private readonly ready: Promise<unknown>;

  constructor() {
    super();
    this.scope = { onmessage: null, postMessage: (message) => this.emit(message) };
    vi.stubGlobal('self', selfProxy);
    loading = this.scope;
    // A fresh copy of the module for every worker, as every real worker has its own.
    vi.resetModules();
    this.ready = scopes.run(this.scope, () => import('@/import/worker/import.worker'));
    void this.ready.then(() => {
      if (loading === this.scope) loading = null;
    });
  }

  postMessage(message: ToWorker, transfer: Transferable[] = []) {
    if (this.terminated) return;
    this.received.push(message);
    const copy: unknown = structuredClone(message, { transfer });
    void this.ready.then(() =>
      setTimeout(() => {
        if (this.terminated) return;
        scopes.run(this.scope, () => this.scope.onmessage?.({ data: copy }));
      }, 0),
    );
  }
}

/** Makes `new Worker(...)` create workers of the given kind, and forgets the workers of earlier tests. */
export function useWorker(kind: typeof RealWorker | typeof ScriptedWorker) {
  FakeWorker.created = [];
  vi.stubGlobal('Worker', kind);
}

/** The workers created since useWorker(), in order. */
export const workersCreated = (): FakeWorker[] => FakeWorker.created;

// ── Database ─────────────────────────────────────────────────────────────────
export interface Statement {
  sql: string;
  /** When the statement was handed to the database, and when it had finished (performance.now()). */
  startedAt: number;
  endedAt: number | null;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The same database, with every statement recorded. `delayMs` makes each one take a few
 * milliseconds, which is what a statement costs in the browser: there it travels to the
 * database worker and back. `onStatement` is called as a statement starts.
 */
export function observed(db: SqlDriver, options: { delayMs?: number; onStatement?: (sql: string) => void } = {}) {
  const statements: Statement[] = [];
  const run = async <T>(sql: string, work: () => Promise<T>): Promise<T> => {
    const entry: Statement = { sql, startedAt: performance.now(), endedAt: null };
    statements.push(entry);
    options.onStatement?.(sql);
    try {
      if (options.delayMs) await sleep(options.delayMs);
      return await work();
    } finally {
      entry.endedAt = performance.now();
    }
  };
  const wrapped: SqlDriver = {
    ...db,
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return run(sql, () => db.query<T>(sql, params));
    },
    exec(sql: string) {
      return run(sql, () => db.exec(sql));
    },
  };
  return { db: wrapped, statements };
}
