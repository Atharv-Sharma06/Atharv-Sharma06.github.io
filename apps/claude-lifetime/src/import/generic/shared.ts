import { resolveModel } from '@/core/models';
import { Sha256 } from '@/core/sha256';
import { ImportError, type ImportFile, type ImportSink, type ParseContext, type ParseWarning } from '@/core/types';

/**
 * Plumbing shared by the usage-report, cost-report, CSV and JSON importers:
 * counting warnings, hashing and progress while reading, and model identifiers.
 */

/** Collects warnings by code: how many records each applies to, and one example. */
export class WarningList {
  private readonly entries = new Map<string, { message: string; count: number; sample?: string }>();

  /** Counts `count` more records under `code`. The first message and the first sample are kept. */
  add(code: string, message: string, sample?: string, count = 1): void {
    const entry = this.entries.get(code);
    if (entry === undefined) {
      this.entries.set(code, { message, count, sample });
      return;
    }
    entry.count += count;
    if (entry.sample === undefined) entry.sample = sample;
  }

  count(code: string): number {
    return this.entries.get(code)?.count ?? 0;
  }

  toArray(): ParseWarning[] {
    return [...this.entries.entries()].map(([code, e]) => ({
      code,
      message: e.message,
      count: e.count,
      ...(e.sample === undefined ? {} : { sample: e.sample }),
    }));
  }
}

/** Progress is reported at most this often, so a worker does not flood the page with messages. */
const REPORT_EVERY_BYTES = 1024 * 1024;

/**
 * Follows the bytes of an import as they are read: hashes them (the content hash
 * identifies a file that was imported before), counts them and reports progress.
 * With several files the hash covers their bytes in the order given.
 */
export class InputMeter {
  readonly totalBytes: number;
  bytesRead = 0;
  /** Records read so far, for the progress display. */
  records = 0;
  private readonly hash = new Sha256();
  private reportedAt = 0;

  constructor(
    files: ImportFile[],
    private readonly sink: ImportSink,
    private readonly ctx: ParseContext,
    private readonly phase: string,
  ) {
    this.totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  }

  /** Give this to a reader as its `onBytes`. */
  readonly onBytes = (chunk: Uint8Array): void => {
    this.bytesRead += chunk.length;
    this.hash.update(chunk);
    if (this.bytesRead - this.reportedAt >= REPORT_EVERY_BYTES) this.report();
  };

  report(): void {
    this.reportedAt = this.bytesRead;
    this.sink.progress?.({ phase: this.phase, bytesRead: this.bytesRead, totalBytes: this.totalBytes, records: this.records });
  }

  checkCancelled(): void {
    if (this.ctx.signal?.aborted) throw new ImportError('The import was cancelled.', 'cancelled');
  }

  contentHash(): string {
    return this.hash.hex();
  }
}

export function requireFiles(files: ImportFile[]): void {
  if (files.length === 0) throw new ImportError('No file was selected.', 'no_files');
  if (files.every((f) => f.size === 0)) {
    throw new ImportError(files.length === 1 ? `"${files[0].name}" is empty.` : 'The selected files are empty.', 'empty_file');
  }
}

export function describeFiles(files: ImportFile[]): { fileName: string; fileSize: number } {
  return {
    fileName: files.length === 1 ? files[0].name : `${files.length} files`,
    fileSize: files.reduce((sum, f) => sum + f.size, 0),
  };
}

/**
 * Turns model identifiers from the input into catalog keys and announces each
 * identifier the catalog does not know to the sink exactly once, so it is stored
 * verbatim instead of being dropped or mapped to a guess.
 */
export class ModelRegistry {
  private readonly keys = new Map<string, string | null>();
  private readonly announced = new Set<string>();

  constructor(private readonly sink: ImportSink) {}

  /** Number of distinct identifiers that are not in the built-in catalog. */
  get unknownCount(): number {
    return this.announced.size;
  }

  get unknownKeys(): string[] {
    return [...this.announced];
  }

  /** Null when the input names no model (empty, "unknown", ...). */
  async resolve(raw: unknown): Promise<string | null> {
    if (typeof raw !== 'string') return null;
    const cached = this.keys.get(raw);
    if (cached !== undefined) return cached;
    const resolved = resolveModel(raw);
    const key = resolved?.key ?? null;
    // Bounded: a column of free text mapped as "model" must not grow this without limit.
    if (this.keys.size < 5000) this.keys.set(raw, key);
    if (resolved !== null && !resolved.known && !this.announced.has(resolved.key)) {
      this.announced.add(resolved.key);
      await this.sink.model({
        key: resolved.key,
        displayName: resolved.model.displayName,
        family: resolved.model.family,
        tokenizerFamily: resolved.model.tokenizer,
      });
    }
    return key;
  }
}
