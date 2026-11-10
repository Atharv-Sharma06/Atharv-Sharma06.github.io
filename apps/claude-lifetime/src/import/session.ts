'use client';

import { ImportError, type ImportFile, type ImportProgress, type ParsedImport } from '@/core/types';
import type { SqlDriver } from '@/db/driver';
import { commitImport, importGeneration, loadKnownRequestKeys, previewImport, type CommitResult, type ImportPreview } from './commit';
import type { Detected } from './detect';
import { resetStaging, StagingWriter } from './staging';
import type { FromWorker, ParseContextMessage, ToWorker } from './worker/protocol';

/**
 * One import, from the files the user picked to the committed records:
 *
 *   detect   → what are these files?
 *   prepare  → parse them (in a worker) into the staging tables and compute a preview
 *   commit   → merge the staged records into the real tables in one transaction
 *   discard  → throw the staged records away
 *
 * Nothing touches stored data before `commit`. The staging tables belong to the one
 * database session all tabs share, so a Web Lock allows a single import at a time.
 */
export interface PreparedImport {
  detected: Detected;
  parsed: ParsedImport;
  preview: ImportPreview;
  /** Import generation when parsing started; a later import by another tab invalidates this one. */
  generation: number;
}

const LOCK_NAME = 'claude-lifetime:import';

function acquireLock(): Promise<(() => void) | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(() => undefined);
  return new Promise((resolve) => {
    void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      return new Promise<void>((release) => resolve(release));
    });
  });
}

export class ImportSession {
  private worker: Worker | null = null;
  private release: (() => void) | null = null;
  private nextId = 1;
  private staged = false;

  constructor(
    private readonly db: SqlDriver,
    private readonly userId: number,
  ) {}

  private ensureWorker(): Worker {
    this.worker ??= new Worker(new URL('./worker/import.worker.ts', import.meta.url), { type: 'module' });
    return this.worker;
  }

  private stopWorker() {
    this.worker?.terminate();
    this.worker = null;
  }

  private send(message: ToWorker, transfer: Transferable[] = []) {
    this.ensureWorker().postMessage(message, transfer);
  }

  /** Looks at the files and says what they are. Reads only as much as that takes. */
  detect(files: ImportFile[]): Promise<Detected> {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    return new Promise<Detected>((resolve, reject) => {
      const onMessage = (event: MessageEvent<FromWorker>) => {
        const m = event.data;
        if (m.id !== id) return;
        if (m.type === 'detected') {
          cleanup();
          resolve(m.detected);
        } else if (m.type === 'error') {
          cleanup();
          reject(new ImportError(m.error.message, m.error.code, m.error.details));
        }
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(new ImportError(`The import worker stopped unexpectedly: ${event.message || 'unknown error'}`, 'worker_failed'));
      };
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      this.send({ type: 'detect', id, files });
    });
  }

  /** Parses the detected files into the staging tables and returns the preview. */
  async prepare(
    files: ImportFile[],
    detected: Detected,
    options: Record<string, unknown> = {},
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<PreparedImport> {
    if (!this.release) {
      const release = await acquireLock();
      if (!release) {
        throw new ImportError('Another import is being prepared in a different tab. Finish or cancel it there first.', 'import_in_progress');
      }
      this.release = release;
    }
    try {
      await resetStaging(this.db);
      this.staged = true;
      const generation = await importGeneration(this.db, this.userId);

      const context: ParseContextMessage = { options };
      const transfer: Transferable[] = [];
      if (detected.parser === 'claude-code' || detected.parser === 'claude-code-ledger') {
        const known = await loadKnownRequestKeys(this.db, this.userId);
        context.knownRequestKeys = BigInt64Array.from(known);
        transfer.push(context.knownRequestKeys.buffer);
        const sourceRef = typeof options.sourceRef === 'string' && options.sourceRef !== '' ? options.sourceRef : 'local';
        const { rows } = await this.db.query<{ path: string; size: unknown; last_modified: Date | string }>(
          `SELECT f.path, f.size, f.last_modified FROM synced_files f JOIN data_sources s ON s.id = f.source_id
            WHERE s.user_id = $1 AND s.kind = 'claude_code' AND s.external_ref = $2`,
          [this.userId, sourceRef],
        );
        context.knownFiles = rows.map((r) => [r.path, Number(r.size), new Date(r.last_modified).getTime()]);
      }

      const chosen = detected.fileIndexes.map((i) => files[i]);
      const writer = new StagingWriter(this.db);
      const parsed = await this.parse(detected, chosen, context, transfer, writer, onProgress);
      await writer.finish();
      const preview = await previewImport(this.db, this.userId, parsed);
      return { detected, parsed, preview, generation };
    } catch (error) {
      await this.discard();
      throw error;
    }
  }

  private parse(
    detected: Detected,
    files: ImportFile[],
    context: ParseContextMessage,
    transfer: Transferable[],
    writer: StagingWriter,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ParsedImport> {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    return new Promise<ParsedImport>((resolve, reject) => {
      // Batches are written strictly in order; an acknowledgement lets the worker send the next one.
      let writing: Promise<void> = Promise.resolve();
      let failed = false;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        cleanup();
        // A worker that is still parsing must not keep feeding a failed import.
        this.stopWorker();
        reject(error);
      };
      const onMessage = (event: MessageEvent<FromWorker>) => {
        const m = event.data;
        if (m.id !== id || failed) return;
        if (m.type === 'batch') {
          writing = writing
            .then(() => writer.addBatch(m.batch))
            .then(() => this.worker?.postMessage({ type: 'ack', id } satisfies ToWorker))
            .catch(fail);
        } else if (m.type === 'progress') {
          onProgress?.(m.progress);
        } else if (m.type === 'done') {
          writing.then(() => {
            if (failed) return;
            cleanup();
            resolve(m.parsed);
          }, fail);
        } else if (m.type === 'error') {
          fail(new ImportError(m.error.message, m.error.code, m.error.details));
        }
      };
      const onError = (event: ErrorEvent) => fail(new ImportError(`The import worker stopped unexpectedly: ${event.message || 'unknown error'}`, 'worker_failed'));
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        this.cancelCurrent = null;
      };
      this.cancelCurrent = () => fail(new ImportError('The import was cancelled.', 'cancelled'));
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      this.send({ type: 'parse', id, parser: detected.parser, files, context }, transfer);
    });
  }

  private cancelCurrent: (() => void) | null = null;

  /** Stops a running `prepare`. Its promise rejects with code `cancelled`. */
  cancel() {
    this.cancelCurrent?.();
  }

  /** Merges the staged records into the real tables. */
  async commit(prepared: PreparedImport): Promise<CommitResult> {
    try {
      return await commitImport(this.db, this.userId, prepared.parsed, { generation: prepared.generation });
    } finally {
      await this.discard();
    }
  }

  /** Throws the staged records away and lets other tabs import again. */
  async discard(): Promise<void> {
    if (this.staged) {
      this.staged = false;
      try {
        await resetStaging(this.db);
      } catch {
        // the staging tables are session-local and are reset before the next import anyway
      }
    }
    this.release?.();
    this.release = null;
  }

  /** Call when the import UI goes away. */
  async dispose(): Promise<void> {
    this.cancel();
    await this.discard();
    this.stopWorker();
  }
}

/** Turns browser File objects into the files the parsers work with. */
export function toImportFiles(files: Iterable<File>): ImportFile[] {
  const out: ImportFile[] = [];
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    out.push({ name: file.name, path: relative && relative !== '' ? relative : undefined, size: file.size, lastModified: file.lastModified, blob: file });
  }
  return out;
}
