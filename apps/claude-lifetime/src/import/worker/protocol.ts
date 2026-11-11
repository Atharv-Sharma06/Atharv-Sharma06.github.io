import { ImportError, type ImportFile, type ImportProgress, type ParsedImport } from '@/core/types';
import { ExportManifestFound, type ExportManifest } from '../claude-export/manifest';
import type { Detected } from '../detect';
import type { ParserKey } from '../formats';
import type { StagedBatch } from '../staging';

/**
 * Messages between the page and the import worker. The worker reads and parses the
 * files; the page owns the database connection and writes the parsed records into
 * the staging tables. Records travel in batches and the worker waits for an
 * acknowledgement before sending more, so memory stays bounded for large files.
 */
export interface ParseContextMessage {
  knownRequestKeys?: BigInt64Array;
  knownFiles?: Array<[path: string, size: number, lastModified: number]>;
  options?: Record<string, unknown>;
}

export type ToWorker =
  /** `manifest`: the export manifest whose parts these files are meant to be (see detectImport). */
  | { type: 'detect'; id: number; files: ImportFile[]; manifest?: ExportManifest }
  /** `files` is the selection as it was detected; `fileIndexes` are the positions detection returned (see selection.ts). */
  | { type: 'parse'; id: number; parser: ParserKey; files: ImportFile[]; fileIndexes: number[]; context: ParseContextMessage }
  | { type: 'ack'; id: number };

export interface WorkerError {
  message: string;
  code: string;
  details?: string;
  /** For code `export_manifest`: the manifest that was chosen, so the page can show its parts. `details` is then the problem of another file chosen with it. */
  manifest?: ExportManifest;
}

/** The error a WorkerError stands for, on the page's side of the worker. */
export function errorFrom(error: WorkerError): ImportError {
  return error.manifest ? new ExportManifestFound(error.manifest, error.details) : new ImportError(error.message, error.code, error.details);
}

export type FromWorker =
  | { type: 'detected'; id: number; detected: Detected }
  | { type: 'batch'; id: number; batch: StagedBatch }
  | { type: 'progress'; id: number; progress: ImportProgress }
  | { type: 'done'; id: number; parsed: ParsedImport }
  | { type: 'error'; id: number; error: WorkerError };
