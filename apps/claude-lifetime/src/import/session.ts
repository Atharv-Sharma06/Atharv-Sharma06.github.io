'use client';

import { ImportError, type ImportFile, type ImportProgress, type ParsedImport } from '@/core/types';
import type { SqlDriver } from '@/db/driver';
import { commitImport, importGeneration, loadKnownRequestKeys, previewImport, type CommitResult, type ImportPreview } from './commit';
import type { Detected } from './detect';
import { acquireImportLock } from './lock';
import { resetStaging, StagingWriter, type StagedBatch } from './staging';
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
 * database session all tabs share, so a lock (see lock.ts) allows a single import at a
 * time, and a commit proves with a token that the staged records are still its own.
 *
 * The lock only protects the tables while its holder is the only one writing to them.
 * Two rules keep that true. The steps of a session that use the tables or the lock run
 * strictly one after another (`inTurn`). And the lock is given back only when every
 * write that was started has finished and the tables are empty (`clear`). Cancelling
 * and disposing therefore never cut a step short: they are noticed at the next point
 * where the import can stop without leaving anything behind.
 */
export interface PreparedImport {
  detected: Detected;
  parsed: ParsedImport;
  preview: ImportPreview;
  /** Import generation when parsing started; a later import by another tab invalidates this one. */
  generation: number;
  /** Names the staged records this preview was computed from (see resetStaging). */
  staging: string;
}

/** A `prepare` that was asked for and has not settled yet. */
interface PrepareRun {
  /** Set by cancel() and dispose(). The import stops at its next step. */
  cancelled: boolean;
  /** Ends the parsing in the worker at once. Set only while the worker is parsing. */
  stopParsing: (() => void) | null;
}

/** A request the worker has not finished answering. */
interface PendingRequest {
  receive(message: FromWorker): void;
  /** The worker is gone, so nothing will answer this request any more. */
  abandon(reason: ImportError): void;
}

const cancelled = () => new ImportError('The import was cancelled.', 'cancelled');

export class ImportSession {
  private worker: Worker | null = null;
  private detachWorker: (() => void) | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private release: (() => void) | null = null;
  private nextId = 1;
  private staged = false;
  private disposed = false;
  private readonly runs = new Set<PrepareRun>();
  /** The end of the step that was started last. The next step begins after it. */
  private turn: Promise<void> = Promise.resolve();
  /** The batches of the last parse that are being written to the staging tables. Never rejects. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: SqlDriver,
    private readonly userId: number,
  ) {}

  private ensureWorker(): Worker {
    // A session that was disposed of has given up its worker for good.
    if (this.disposed) throw cancelled();
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker/import.worker.ts', import.meta.url), { type: 'module' });
    const onMessage = (event: MessageEvent<FromWorker>) => this.pending.get(event.data.id)?.receive(event.data);
    // A worker that reports an error may never answer again (its script may not even have
    // loaded), so it is not kept: the next request starts a fresh one.
    const onError = (event: ErrorEvent) =>
      this.stopWorker(new ImportError('The part of the app that reads files stopped unexpectedly.', 'worker_failed', event.message || undefined));
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    this.worker = worker;
    this.detachWorker = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    return worker;
  }

  private stopWorker(reason: ImportError) {
    this.detachWorker?.();
    this.detachWorker = null;
    this.worker?.terminate();
    this.worker = null;
    // Nothing will answer what was still asked of this worker.
    for (const request of [...this.pending.values()]) request.abandon(reason);
  }

  private send(message: ToWorker, transfer: Transferable[] = []) {
    this.ensureWorker().postMessage(message, transfer);
  }

  /**
   * Runs a step that uses the staging tables or the lock after the steps started before
   * it have ended. Otherwise a clean-up could empty the tables under an import that is
   * still writing, or give back the lock the next import of this session relies on.
   */
  private inTurn<T>(step: () => Promise<T>): Promise<T> {
    const result = this.turn.then(step);
    this.turn = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Looks at the files and says what they are. Reads only as much as that takes. */
  detect(files: ImportFile[]): Promise<Detected> {
    return new Promise<Detected>((resolve, reject) => {
      const id = this.nextId++;
      // The answer cannot arrive before this function returns, so the request is registered after it was sent without error.
      this.send({ type: 'detect', id, files });
      const settled = () => this.pending.delete(id);
      this.pending.set(id, {
        receive: (m) => {
          if (m.type === 'detected') {
            settled();
            resolve(m.detected);
          } else if (m.type === 'error') {
            settled();
            reject(new ImportError(m.error.message, m.error.code, m.error.details));
          }
        },
        abandon: (reason) => {
          settled();
          reject(reason);
        },
      });
    });
  }

  /** Parses the detected files into the staging tables and returns the preview. */
  async prepare(
    files: ImportFile[],
    detected: Detected,
    options: Record<string, unknown> = {},
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<PreparedImport> {
    const run: PrepareRun = { cancelled: this.disposed, stopParsing: null };
    this.runs.add(run);
    try {
      return await this.inTurn(() => this.stage(run, files, detected, options, onProgress));
    } finally {
      this.runs.delete(run);
    }
  }

  private async stage(
    run: PrepareRun,
    files: ImportFile[],
    detected: Detected,
    options: Record<string, unknown>,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<PreparedImport> {
    // Called after everything that takes time, so that a cancelled import goes no further.
    const proceed = () => {
      if (run.cancelled) throw cancelled();
    };
    try {
      proceed();
      if (!this.release) {
        const release = await acquireImportLock();
        if (!release) {
          throw new ImportError('Another import is being prepared or is waiting to be saved, in this tab or another one. Save or cancel it first.', 'import_in_progress');
        }
        // Kept before anything else happens, so that the clean-up below gives the lock back when the import was cancelled while it waited.
        this.release = release;
        proceed();
      }
      const staging = await resetStaging(this.db);
      this.staged = true;
      proceed();
      const generation = await importGeneration(this.db, this.userId);
      proceed();

      const context: ParseContextMessage = { options };
      const transfer: Transferable[] = [];
      if (detected.parser === 'claude-code' || detected.parser === 'claude-code-ledger') {
        const known = await loadKnownRequestKeys(this.db, this.userId);
        proceed();
        context.knownRequestKeys = BigInt64Array.from(known);
        transfer.push(context.knownRequestKeys.buffer);
        const sourceRef = typeof options.sourceRef === 'string' && options.sourceRef !== '' ? options.sourceRef : 'local';
        const { rows } = await this.db.query<{ path: string; size: unknown; last_modified: Date | string }>(
          `SELECT f.path, f.size, f.last_modified FROM synced_files f JOIN data_sources s ON s.id = f.source_id
            WHERE s.user_id = $1 AND s.kind = 'claude_code' AND s.external_ref = $2`,
          [this.userId, sourceRef],
        );
        proceed();
        context.knownFiles = rows.map((r) => [r.path, Number(r.size), new Date(r.last_modified).getTime()]);
      }

      const chosen = detected.fileIndexes.map((i) => files[i]);
      const writer = new StagingWriter(this.db);
      const parsed = await this.parse(run, detected, chosen, context, transfer, writer, onProgress);
      proceed();
      await writer.finish();
      proceed();
      const preview = await previewImport(this.db, this.userId, parsed);
      proceed();
      return { detected, parsed, preview, generation, staging };
    } catch (error) {
      await this.clear();
      throw error;
    }
  }

  private parse(
    run: PrepareRun,
    detected: Detected,
    files: ImportFile[],
    context: ParseContextMessage,
    transfer: Transferable[],
    writer: StagingWriter,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ParsedImport> {
    return new Promise<ParsedImport>((resolve, reject) => {
      const id = this.nextId++;
      const worker = this.ensureWorker();
      this.send({ type: 'parse', id, parser: detected.parser, files, context }, transfer);

      // Batches are written strictly in order; an acknowledgement lets the worker send the next one.
      let writing: Promise<void> = Promise.resolve();
      let ended = false;
      const end = () => {
        ended = true;
        this.pending.delete(id);
        run.stopParsing = null;
      };
      const fail = (error: unknown) => {
        if (ended) return;
        end();
        reject(error);
        // A worker that is still parsing must not keep feeding a failed import. Anything else
        // that was asked of the same worker goes with it and ends as cancelled.
        if (this.worker === worker) this.stopWorker(cancelled());
      };
      const write = async (batch: StagedBatch) => {
        // One table at a time, in the order StagingWriter writes them. `ended` is looked at before
        // every statement, so nothing of an import that failed or was cancelled is still sent to the database.
        const tables: Partial<StagedBatch>[] = [
          { models: batch.models },
          { conversations: batch.conversations },
          { messages: batch.messages },
          { usage: batch.usage },
          { costs: batch.costs },
        ];
        for (const table of tables) {
          if (ended) return;
          await writer.addBatch(table);
        }
        if (!ended) worker.postMessage({ type: 'ack', id } satisfies ToWorker);
      };

      this.pending.set(id, {
        receive: (m) => {
          if (m.type === 'batch') {
            writing = writing.then(() => write(m.batch)).catch(fail);
            // The clean-up waits for this before it empties the tables (see clear).
            this.writes = writing;
          } else if (m.type === 'progress') {
            onProgress?.(m.progress);
          } else if (m.type === 'done') {
            void writing.then(() => {
              if (ended) return;
              end();
              resolve(m.parsed);
            });
          } else if (m.type === 'error') {
            fail(new ImportError(m.error.message, m.error.code, m.error.details));
          }
        },
        abandon: fail,
      });
      run.stopParsing = () => fail(cancelled());
    });
  }

  /** Stops a `prepare` that is running or waiting for its turn. Its promise rejects with code `cancelled`. */
  cancel() {
    for (const run of this.runs) {
      run.cancelled = true;
      run.stopParsing?.();
    }
  }

  /** Merges the staged records into the real tables. */
  commit(prepared: PreparedImport): Promise<CommitResult> {
    return this.inTurn(async () => {
      try {
        return await commitImport(this.db, this.userId, prepared.parsed, { generation: prepared.generation, staging: prepared.staging });
      } finally {
        await this.clear();
      }
    });
  }

  /**
   * Throws the staged records away and lets other tabs import again. An import that is
   * still being prepared is cancelled first.
   */
  async discard(): Promise<void> {
    this.cancel();
    await this.inTurn(() => this.clear());
  }

  /**
   * Call when the import UI goes away. Whatever the session was still doing ends with
   * code `cancelled`, and the session cannot be used again.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    this.stopWorker(cancelled());
    await this.inTurn(() => this.clear());
  }

  /** Empties the staging tables and gives the lock back. Only called inside a turn. */
  private async clear(): Promise<void> {
    // A batch that was on its way to the database when the import ended would otherwise arrive
    // after the tables were emptied and the lock was free, and become part of the next import.
    await this.writes;
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
