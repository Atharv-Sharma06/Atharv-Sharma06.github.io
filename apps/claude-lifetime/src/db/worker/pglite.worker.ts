/// <reference lib="webworker" />
import { PGlite } from '@electric-sql/pglite';
import { worker, type PGliteWorkerOptions } from '@electric-sql/pglite/worker';
import { cleanBackup, CleanCopyError } from '../clean-copy';
import { NewerSchemaError } from '../migrate';

/**
 * Hosts PostgreSQL (PGlite) for every tab of the app.
 *
 * `worker()` elects one leader tab; only that tab's worker runs `init` and owns the
 * database, the others proxy their queries to it. The data directory is persisted to
 * IndexedDB, so nothing leaves the device.
 *
 * Durability: PGlite runs with relaxed durability (it does not wait for IndexedDB
 * after every query, which would cost ~80 ms each). After a write that must not be
 * lost, the page asks for an explicit flush over the control channel below and waits
 * for the answer, which says whether the copy to IndexedDB worked.
 *
 * Backups are made here as well, on request over the same channel: an archive of a
 * second, temporary database that is filled with the rows stored now (see
 * ../clean-copy.ts for why the database's own files are not handed out).
 *
 * The messages this worker exchanges with pages are declared here. The other side is
 * src/db/client.ts, which imports these types.
 */
export interface WorkerMeta {
  /** Base URL of the gzip-compressed PGlite assets, with a trailing slash. */
  assetBase: string;
  /** Name of the BroadcastChannel used for flush requests. */
  controlChannel: string;
}

/** A page asks, on the control channel, for everything committed so far to be copied to IndexedDB. */
export interface FlushRequest {
  op: 'flush';
  /** Chosen by the page; the answer carries it back. */
  id: string;
}

/**
 * The answer to a flush request. `ok` is true only when the copy completed. Otherwise
 * `error` is the browser's own description of what went wrong, for example
 * "QuotaExceededError: The quota has been exceeded."
 */
export type FlushAnswer = { op: 'flushed'; id: string; ok: true } | { op: 'flushed'; id: string; ok: false; error: string };

/** A page asks, on the control channel, for a backup of what is stored now. */
export interface BackupRequest {
  op: 'backup';
  /** Chosen by the page; the answers carry it back. */
  id: string;
}

/**
 * Sent as soon as a backup request is taken up, before the work begins. A page that
 * hears nothing knows that no tab hosts the database at that moment, and does not
 * have to wait for as long as a large backup may take.
 */
export interface BackupStarted {
  op: 'backup-started';
  id: string;
}

/**
 * The answer to a backup request: the archive, or why there is none. `explained` is
 * true when `error` is a sentence written for the person, false when it is the
 * engine's own error text.
 */
export type BackupAnswer =
  | { op: 'backed-up'; id: string; ok: true; backup: Blob }
  | { op: 'backed-up'; id: string; ok: false; error: string; explained: boolean };

/**
 * Posted to the worker's own page when the database could not be started. PGlite's
 * worker library keeps a failed start to itself, so without this message the page
 * could only give up after a long wait, without knowing the reason.
 */
export interface StartFailure {
  type: 'claude-lifetime:start-failed';
  error: string;
}

/** An error in the browser's own words, with the kind of error in front when it has one. */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    const text = typeof message === 'string' ? message : '';
    // "Error" says nothing; a name such as QuotaExceededError tells the page what happened.
    if (typeof name === 'string' && name !== '' && name !== 'Error') return text ? `${name}: ${text}` : name;
    if (text) return text;
  }
  return String(error);
}

async function fetchAsset(url: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    // No connection, typically. The browser's own error does not say which file it was about.
    throw new Error(`Could not load ${url} (${describeError(error)})`);
  }
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  // Assets ship pre-compressed. Some hosts already decompress .gz transparently, so sniff the gzip magic.
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  return buf;
}

let db: PGlite | null = null;
/** The engine as it was loaded for the database, kept so that a second one can be started for a backup without the network. */
let engine: { pgliteWasmModule: WebAssembly.Module; initdbWasmModule: WebAssembly.Module; fsBundle: Blob } | null = null;
/** Whether the database is up. Until then, anything that stops this worker is a failed start. */
let started = false;
/** What stopped the start, once that has been reported to the page. */
let startFailure: { reason: unknown } | null = null;

/**
 * Tells the page why the database did not start. The page shows the reason and stops
 * this worker, which also lets the worker of another tab try.
 */
function reportStartFailure(reason: unknown): void {
  if (started || startFailure) return;
  startFailure = { reason };
  self.postMessage({ type: 'claude-lifetime:start-failed', error: describeError(reason) } satisfies StartFailure);
}

self.addEventListener('unhandledrejection', (event) => {
  // After a failed start the library rejects once more for every tab that asks for the database.
  // The page already has the reason, so these repeats are kept out of the console.
  if (startFailure && event.reason === startFailure.reason) {
    event.preventDefault();
    return;
  }
  // With relaxed durability PGlite starts some syncs without awaiting them. One of those can fail
  // harmlessly while the data directory is being created (a file it was about to copy is renamed by
  // PostgreSQL). Swallow that rejection and sync again.
  const reason = event.reason as { name?: string } | undefined;
  if (reason?.name === 'ErrnoError') {
    event.preventDefault();
    void db?.syncToFs();
  }
});

async function flush(): Promise<void> {
  const instance = db;
  const fs = instance?.fs;
  // A flush that copied nothing must not be answered as done.
  if (!instance || !fs) throw new Error('The database is not open.');
  // No query may run while the files are copied, so the snapshot is consistent.
  await instance.runExclusive(() => fs.syncToFs(false));
}

/** Backups are made one after the other: each needs a whole second database in memory while it is made. */
let backups: Promise<unknown> = Promise.resolve();

function backup(): Promise<Blob> {
  const made = backups.then(() => {
    const instance = db;
    const files = engine;
    if (!instance || !files) throw new Error('The database is not open.');
    // In memory only: the copy exists until its archive is packed, and never touches this device's storage.
    return cleanBackup(instance, () => new PGlite({ ...files }));
  });
  backups = made.catch(() => undefined);
  return made;
}

/** Why no backup was made, and whether that is already a sentence for the person. */
function backupFailure(error: unknown): { error: string; explained: boolean } {
  if (error instanceof NewerSchemaError) {
    return {
      error: 'The stored data was last written by a newer version of Claude Lifetime than the one running in the tab that holds the database. Reload every open tab of the app, then download the backup again.',
      explained: true,
    };
  }
  if (error instanceof CleanCopyError) return { error: error.message, explained: true };
  return { error: describeError(error), explained: false };
}

async function start(options: PGliteWorkerOptions): Promise<PGlite> {
  const meta = options.meta as WorkerMeta;
  const [wasm, initdb, data] = await Promise.all([
    fetchAsset(`${meta.assetBase}pglite.wasm.gz`),
    fetchAsset(`${meta.assetBase}initdb.wasm.gz`),
    fetchAsset(`${meta.assetBase}pglite.data.gz`),
  ]);
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([WebAssembly.compile(wasm), WebAssembly.compile(initdb)]);
  const files = { pgliteWasmModule, initdbWasmModule, fsBundle: new Blob([data]) };
  const instance = new PGlite({
    dataDir: options.dataDir,
    // Set when a backup is being restored: the data directory starts from that tarball.
    loadDataDir: options.loadDataDir,
    relaxedDurability: true,
    ...files,
  });
  db = instance;
  await instance.waitReady;
  engine = files;

  // Only the leader (this worker) answers requests on the control channel; follower tabs hold no database.
  const control = new BroadcastChannel(meta.controlChannel);
  control.onmessage = async (event: MessageEvent<Partial<FlushRequest | BackupRequest> | undefined>) => {
    const request = event.data;
    if (typeof request?.id !== 'string') return;
    const id = request.id;
    if (request.op === 'flush') {
      let answer: FlushAnswer;
      try {
        await flush();
        answer = { op: 'flushed', id, ok: true };
      } catch (error) {
        answer = { op: 'flushed', id, ok: false, error: describeError(error) };
      }
      control.postMessage(answer);
    } else if (request.op === 'backup') {
      control.postMessage({ op: 'backup-started', id } satisfies BackupStarted);
      let answer: BackupAnswer;
      try {
        answer = { op: 'backed-up', id, ok: true, backup: await backup() };
      } catch (error) {
        answer = { op: 'backed-up', id, ok: false, ...backupFailure(error) };
      }
      control.postMessage(answer);
    }
  };
  started = true;
  return instance;
}

worker({
  async init(options) {
    try {
      return await start(options);
    } catch (error) {
      // There is no database to sync or flush after this, whatever state the engine was left in.
      db = null;
      reportStartFailure(error);
      throw error;
    }
  },
}).catch((error: unknown) => {
  // Nothing is expected to fail once the database is up; if something does, it stays visible in the console.
  if (started) throw error;
  // A failed `init` was reported above. Whatever else stops the library before the database is up
  // (a browser without Web Locks, for one) leaves the page waiting just the same, so it is reported too.
  reportStartFailure(error);
});
