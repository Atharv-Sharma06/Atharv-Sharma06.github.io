import type { ImportFile, ImportProgress, ParsedImport } from '@/core/types';
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
  | { type: 'detect'; id: number; files: ImportFile[] }
  | { type: 'parse'; id: number; parser: ParserKey; files: ImportFile[]; context: ParseContextMessage }
  | { type: 'ack'; id: number };

export interface WorkerError {
  message: string;
  code: string;
  details?: string;
}

export type FromWorker =
  | { type: 'detected'; id: number; detected: Detected }
  | { type: 'batch'; id: number; batch: StagedBatch }
  | { type: 'progress'; id: number; progress: ImportProgress }
  | { type: 'done'; id: number; parsed: ParsedImport }
  | { type: 'error'; id: number; error: WorkerError };
