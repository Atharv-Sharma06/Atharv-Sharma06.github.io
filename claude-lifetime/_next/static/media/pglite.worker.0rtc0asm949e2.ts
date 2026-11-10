/// <reference lib="webworker" />
import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';

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
 * for it.
 */
export interface WorkerMeta {
  /** Base URL of the gzip-compressed PGlite assets, with a trailing slash. */
  assetBase: string;
  /** Name of the BroadcastChannel used for flush requests. */
  controlChannel: string;
}

async function fetchAsset(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
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

/**
 * With relaxed durability PGlite starts some syncs without awaiting them. One of those
 * can fail harmlessly while the data directory is being created (a file it was about
 * to copy is renamed by PostgreSQL). Swallow that rejection and sync again.
 */
self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { name?: string } | undefined;
  if (reason?.name === 'ErrnoError') {
    event.preventDefault();
    void db?.syncToFs();
  }
});

async function flush(): Promise<void> {
  const instance = db;
  if (!instance) return;
  // No query may run while the files are copied, so the snapshot is consistent.
  await instance.runExclusive(async () => {
    const fs = (instance as unknown as { fs?: { syncToFs(relaxed?: boolean): Promise<void> } }).fs;
    await fs?.syncToFs(false);
  });
}

worker({
  async init(options) {
    const meta = options.meta as WorkerMeta;
    const [wasm, initdb, data] = await Promise.all([
      fetchAsset(`${meta.assetBase}pglite.wasm.gz`),
      fetchAsset(`${meta.assetBase}initdb.wasm.gz`),
      fetchAsset(`${meta.assetBase}pglite.data.gz`),
    ]);
    const [pgliteWasmModule, initdbWasmModule] = await Promise.all([WebAssembly.compile(wasm), WebAssembly.compile(initdb)]);
    db = new PGlite({
      dataDir: options.dataDir,
      // Set when a backup is being restored: the data directory starts from that tarball.
      loadDataDir: options.loadDataDir,
      relaxedDurability: true,
      pgliteWasmModule,
      initdbWasmModule,
      fsBundle: new Blob([data]),
    });
    await db.waitReady;

    // Only the leader (this worker) answers flush requests; follower tabs hold no database.
    const control = new BroadcastChannel(meta.controlChannel);
    control.onmessage = async (event: MessageEvent<{ op: string; id: string }>) => {
      if (event.data?.op !== 'flush') return;
      try {
        await flush();
        control.postMessage({ op: 'flushed', id: event.data.id, ok: true });
      } catch (err) {
        control.postMessage({ op: 'flushed', id: event.data.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    return db;
  },
});
