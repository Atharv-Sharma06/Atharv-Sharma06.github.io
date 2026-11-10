import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { vi } from 'vitest';

/**
 * Runs the real database worker (src/db/worker/pglite.worker.ts) inside the test
 * process, on the page's side of a Worker object.
 *
 * The worker module and PGlite's worker library are loaded unchanged. What a worker's
 * global scope provides is stubbed: `self`, `postMessage` and `addEventListener` carry
 * messages to and from the object a page would hold. Web Locks and `fetch` have to be
 * installed by the test (installWebLocks, serveEngineFiles or a stub of its own).
 * One worker at a time: the stubs are global.
 */
type Listener = (event: { data: unknown }) => void;
type RejectionListener = (event: { reason: unknown; preventDefault(): void }) => void;
interface Registered {
  listener: Listener;
  once: boolean;
}

/** The real timer, kept for waiting after a test has stopped the timers of the code under test. */
const realSetTimeout = globalThis.setTimeout;
export const pause = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

export class InProcessDatabaseWorker {
  static created: InProcessDatabaseWorker[] = [];
  /** Everything the worker posted to its page, in order. */
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;
  /** Called when the page stops the worker. */
  readonly onTerminate: Array<() => void> = [];
  /** What the worker registered for promise rejections that nothing handles (see routeUnhandledRejections). */
  readonly rejectionListeners: RejectionListener[] = [];
  private pageListeners: Registered[] = [];
  private scopeListeners: Registered[] = [];

  constructor() {
    InProcessDatabaseWorker.created.push(this);
    const scope = {
      postMessage: (data: unknown) => this.deliver('page', data),
      addEventListener: (type: string, listener: unknown, options?: { once?: boolean }) => {
        if (type === 'message') this.scopeListeners.push({ listener: listener as Listener, once: options?.once === true });
        if (type === 'unhandledrejection') this.rejectionListeners.push(listener as RejectionListener);
      },
    };
    vi.stubGlobal('self', scope);
    vi.stubGlobal('postMessage', scope.postMessage);
    vi.stubGlobal('addEventListener', scope.addEventListener);
    // A fresh copy of the module for every worker, as in a browser.
    vi.resetModules();
    void import('@/db/worker/pglite.worker');
  }

  /** Messages arrive later and in order, and a listener registered with `once` hears one message. */
  private deliver(to: 'page' | 'worker', data: unknown) {
    if (to === 'page') this.posted.push(data as Record<string, unknown>);
    setTimeout(() => {
      if (this.terminated) return;
      const listeners = to === 'page' ? this.pageListeners : this.scopeListeners;
      const remaining = listeners.filter((entry) => !entry.once);
      if (to === 'page') this.pageListeners = remaining;
      else this.scopeListeners = remaining;
      for (const entry of listeners) entry.listener({ data });
    }, 0);
  }

  // ── the page's side ──
  postMessage(data: unknown) {
    this.deliver('worker', data);
  }
  addEventListener(type: string, listener: Listener, options?: { once?: boolean }) {
    if (type === 'message') this.pageListeners.push({ listener, once: options?.once === true });
  }
  removeEventListener(_type: string, listener: Listener) {
    this.pageListeners = this.pageListeners.filter((entry) => entry.listener !== listener);
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    for (const stop of this.onTerminate) stop();
  }
}

/**
 * Answers the worker's requests for the engine files from the installed PGlite package:
 * `fetch` for "<anything>/pglite.wasm.gz", "initdb.wasm.gz" and "pglite.data.gz". One
 * file is sent compressed and two as they are, because the worker has to cope with a
 * host that has already unpacked them.
 */
export function serveEngineFiles(): void {
  const dist = dirname(createRequire(import.meta.url).resolve('@electric-sql/pglite'));
  vi.stubGlobal('fetch', async (url: string) => {
    const file = String(url).split('/').pop()!.replace(/\.gz$/, '');
    const bytes = readFileSync(join(dist, file));
    return new Response(file === 'initdb.wasm' ? gzipSync(bytes) : bytes);
  });
}

export interface RoutedRejections {
  /** How many rejections nothing handled were offered to the worker. */
  offered: number;
  /** Those the worker did not take care of: in a browser these end up in the console. */
  unhandled: unknown[];
  /** Hands unhandled rejections back to the test runner. */
  restore(): void;
}

/**
 * In a browser, a promise rejection that nothing handles inside a worker raises
 * `unhandledrejection` in that worker, where its code may deal with it. Here the worker
 * shares the process with the test, so Node raises it for the whole process: as
 * `unhandledRejection`, or as `uncaughtException` when the promise came from an async
 * event listener, which is how Node treats those. This routes both to the worker's
 * listeners the way the browser would, and collects the ones no listener prevented.
 */
export function routeUnhandledRejections(worker: InProcessDatabaseWorker): RoutedRejections {
  const runner = { rejections: process.listeners('unhandledRejection'), exceptions: process.listeners('uncaughtException') };
  const offer = (reason: unknown) => {
    routed.offered++;
    let prevented = false;
    for (const listener of worker.rejectionListeners) listener({ reason, preventDefault: () => void (prevented = true) });
    if (!prevented) routed.unhandled.push(reason);
  };
  const routed: RoutedRejections = {
    offered: 0,
    unhandled: [],
    restore() {
      process.removeAllListeners('unhandledRejection');
      process.removeAllListeners('uncaughtException');
      for (const listener of runner.rejections) process.on('unhandledRejection', listener);
      for (const listener of runner.exceptions) process.on('uncaughtException', listener);
    },
  };
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
  process.on('unhandledRejection', offer);
  process.on('uncaughtException', offer);
  return routed;
}

/**
 * Puts every timer started from now on under the test's control and returns the
 * function that stops them all, for good. PGlite's page class keeps asking for the
 * database every few milliseconds for as long as it is not connected, and a test of a
 * database that never starts has to end that somehow.
 */
export function sandboxTimers(): () => void {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  vi.stubGlobal('setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (stopped) return 0;
    const id = realSetTimeout(() => {
      pending.delete(id);
      if (!stopped) callback(...args);
    }, ms);
    pending.add(id);
    return id;
  });
  return () => {
    stopped = true;
    for (const id of pending) clearTimeout(id);
    pending.clear();
  };
}
