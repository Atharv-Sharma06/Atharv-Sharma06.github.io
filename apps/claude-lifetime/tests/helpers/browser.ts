import { vi } from 'vitest';

/**
 * Stand-ins for the browser features the database client (src/db/client.ts) needs and
 * Node does not have: Web Locks, localStorage, the list of IndexedDB databases and the
 * Worker object. Each one is small and records what was done to it, so that a test can
 * state what the app did and in which order. They are installed with vi.stubGlobal;
 * call vi.unstubAllGlobals() after each test.
 */

/** What the stand-ins did, in order. Cleared by resetTimeline(). */
export const timeline: string[] = [];
export const resetTimeline = () => void (timeline.length = 0);

/** Waits until `probe` returns something truthy and returns it. */
export async function waitFor<T>(probe: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: nothing after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves to `value` after `ms`, for tests that must not wait for something that may never come. */
export const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

// ── Web Locks ────────────────────────────────────────────────────────────────────

export interface FakeLocks {
  /** Names of the locks that are held right now. */
  held(): string[];
  /**
   * Takes a lock the way another tab would and keeps it until the returned function is
   * called.
   */
  holdElsewhere(name: string): Promise<() => void>;
}

/**
 * An in-memory navigator.locks: exclusive locks, `ifAvailable`, waiting in line, and
 * `query()`. Pass `{ query: false }` for a browser that cannot list its locks.
 */
export function installWebLocks(options: { query?: boolean } = {}): FakeLocks {
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();

  const request = (name: string, a: unknown, b?: unknown): Promise<unknown> => {
    const settings = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
    const callback = (typeof a === 'function' ? a : b) as (lock: { name: string } | null) => unknown;
    // The lock is taken at once and the callback runs a moment later, as in a browser.
    const grant = () => {
      held.add(name);
      timeline.push(`lock ${name}`);
      return Promise.resolve()
        .then(() => callback({ name }))
        .finally(() => {
          held.delete(name);
          timeline.push(`unlock ${name}`);
          waiting.get(name)?.shift()?.();
        });
    };
    if (!held.has(name)) return grant();
    if (settings.ifAvailable) return Promise.resolve().then(() => callback(null));
    return new Promise((resolve, reject) => {
      const queue = waiting.get(name) ?? [];
      waiting.set(name, queue);
      queue.push(() => grant().then(resolve, reject));
    });
  };

  const query = async () => ({
    held: [...held].map((name) => ({ name, mode: 'exclusive', clientId: 'test' })),
    pending: [...waiting].flatMap(([name, queue]) => queue.map(() => ({ name, mode: 'exclusive', clientId: 'test' }))),
  });

  vi.stubGlobal('navigator', { locks: options.query === false ? { request } : { request, query } });
  return {
    held: () => [...held],
    holdElsewhere: (name) =>
      new Promise((resolve) => {
        void request(name, () => new Promise<void>((release) => resolve(release)));
      }),
  };
}

/** A browser without Web Locks. */
export function installNoWebLocks(): void {
  vi.stubGlobal('navigator', {});
}

// ── localStorage ─────────────────────────────────────────────────────────────────

/**
 * A `window` with a localStorage that behaves like the real one where the app looks:
 * getItem, setItem, removeItem, and stored keys that show up in Object.keys().
 */
export function installWindow(
  initial: Record<string, string> = {},
  options: { refuseWrites?: boolean } = {},
): { storage: Record<string, string>; reload: ReturnType<typeof vi.fn> } {
  const storage: Record<string, string> = { ...initial };
  const methods: Record<string, unknown> = {
    getItem: (key: string) => (Object.hasOwn(storage, key) ? storage[key] : null),
    setItem: (key: string, value: string) => {
      // what a browser does when the site may not store anything
      if (options.refuseWrites) throw new DOMException('The operation is insecure.', 'SecurityError');
      storage[key] = String(value);
      timeline.push(`localStorage ${key}=${value}`);
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  };
  const localStorage = new Proxy(storage, {
    get: (target, key) => (typeof key === 'string' && key in methods ? methods[key] : Reflect.get(target, key)),
  });
  const reload = vi.fn();
  vi.stubGlobal('window', {
    localStorage,
    // PGlite's loader reads these two as soon as a `window` object exists.
    location: { pathname: '/', reload },
    encodeURIComponent,
  });
  return { storage, reload };
}

// ── IndexedDB ────────────────────────────────────────────────────────────────────

export interface FakeIndexedDb {
  /** The databases that exist, by the names indexedDB.databases() reports. */
  names: Set<string>;
  /** Every deleteDatabase() request, in order. */
  deleted: string[];
  /** How often the list of databases was asked for. */
  listed: number;
  /** Runs when the list is asked for, before it is answered: the place to let another tab act in between. */
  whileListing: () => void;
}

/**
 * The two parts of indexedDB the database client uses directly: listing the databases
 * and deleting one. Pass `{ list: false }` for a browser that cannot list them.
 */
export function installIndexedDb(names: string[] = [], options: { list?: boolean } = {}): FakeIndexedDb {
  const fake: FakeIndexedDb = { names: new Set(names), deleted: [], listed: 0, whileListing: () => undefined };
  const indexedDB: Record<string, unknown> = {
    deleteDatabase(name: string) {
      fake.deleted.push(name);
      timeline.push(`delete ${name}`);
      fake.names.delete(name);
      const request: { onsuccess?: () => void } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
  };
  if (options.list !== false) {
    indexedDB.databases = async () => {
      fake.listed++;
      fake.whileListing();
      return [...fake.names].map((name) => ({ name, version: 21 }));
    };
  }
  vi.stubGlobal('indexedDB', indexedDB);
  return fake;
}

// ── Worker ───────────────────────────────────────────────────────────────────────

type Listener = (event: { data?: unknown; message?: string }) => void;

/**
 * A Worker that runs nothing. A test plays the worker's part by calling emit(), and
 * sees whether the page stopped it.
 */
export class WorkerStub {
  static created: WorkerStub[] = [];
  terminated = false;
  /** Called when the page stops the worker, so that whatever stands in for its contents can stop too. */
  readonly onTerminate: Array<() => void> = [];
  private listeners = new Map<string, Map<Listener, { once: boolean }>>();

  constructor() {
    WorkerStub.created.push(this);
  }
  addEventListener(type: string, listener: Listener, options?: { once?: boolean }) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Map());
    this.listeners.get(type)!.set(listener, { once: options?.once === true });
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage() {
    // nothing runs in here, so nothing reads what the page sends
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    timeline.push('worker stopped');
    for (const stop of this.onTerminate) stop();
  }
  /** Delivers a message or an error from the worker to the page, asynchronously as a browser does. */
  emit(type: 'message' | 'error', event: { data?: unknown; message?: string }) {
    setTimeout(() => {
      const registered = this.listeners.get(type);
      for (const [listener, { once }] of [...(registered ?? [])]) {
        if (once) registered!.delete(listener);
        listener(event);
      }
    }, 0);
  }
}

// ── BroadcastChannel ─────────────────────────────────────────────────────────────

/**
 * Keeps track of every BroadcastChannel opened from now on and returns a function that
 * closes them all. An open channel keeps Node's event loop alive, and the code under
 * test leaves channels open on purpose (a worker's channels live as long as the worker).
 */
export function trackBroadcastChannels(): () => void {
  const Real = globalThis.BroadcastChannel;
  const open = new Set<BroadcastChannel>();
  class Tracked extends Real {
    constructor(name: string) {
      super(name);
      open.add(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', Tracked);
  return () => {
    for (const channel of open) channel.close();
    open.clear();
  };
}
