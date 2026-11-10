/// <reference lib="webworker" />
import { ImportError, type ImportParser, type ImportProgress, type ImportSink } from '@/core/types';
import { apiCostReportParser, apiUsageReportParser, consoleCsvParser } from '../api-reports';
import { claudeCodeLedgerParser, claudeCodeParser } from '../claude-code';
import { claudeExportParser } from '../claude-export';
import { detectImport } from '../detect';
import type { ParserKey } from '../formats';
import { genericCsvParser, genericJsonParser } from '../generic';
import type { StagedBatch } from '../staging';
import type { FromWorker, ToWorker, WorkerError } from './protocol';

/**
 * Import worker: identifies files and parses them off the main thread, so a
 * gigabyte-sized export never freezes the page. It has no access to the database.
 */
const PARSERS: Record<ParserKey, ImportParser> = {
  'claude-export': claudeExportParser,
  'claude-code': claudeCodeParser,
  'claude-code-ledger': claudeCodeLedgerParser,
  'api-usage': apiUsageReportParser,
  'api-cost': apiCostReportParser,
  'console-csv': consoleCsvParser,
  'generic-csv': genericCsvParser,
  'generic-json': genericJsonParser,
};

const BATCH_RECORDS = 2000;
/** Batches the page may still be writing before the parser is paused. */
const MAX_UNACKNOWLEDGED = 3;
const PROGRESS_INTERVAL_MS = 120;

const post = (message: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);

const emptyBatch = (): StagedBatch => ({ models: [], conversations: [], messages: [], usage: [], costs: [] });

class BatchingSink implements ImportSink {
  private batch = emptyBatch();
  private size = 0;
  private unacknowledged = 0;
  private resume: (() => void) | null = null;
  private lastProgress = 0;

  constructor(private readonly id: number) {}

  private added(): void | Promise<void> {
    if (++this.size >= BATCH_RECORDS) return this.flush();
  }

  conversation(c: StagedBatch['conversations'][number]) {
    this.batch.conversations.push(c);
    return this.added();
  }
  message(m: StagedBatch['messages'][number]) {
    this.batch.messages.push(m);
    return this.added();
  }
  usage(u: StagedBatch['usage'][number]) {
    this.batch.usage.push(u);
    return this.added();
  }
  cost(c: StagedBatch['costs'][number]) {
    this.batch.costs.push(c);
    return this.added();
  }
  model(m: StagedBatch['models'][number]) {
    this.batch.models.push(m);
    return this.added();
  }

  progress(p: ImportProgress) {
    const now = Date.now();
    if (now - this.lastProgress < PROGRESS_INTERVAL_MS && p.bytesRead < p.totalBytes) return;
    this.lastProgress = now;
    post({ type: 'progress', id: this.id, progress: p });
  }

  async flush(): Promise<void> {
    if (this.size === 0) return;
    const batch = this.batch;
    this.batch = emptyBatch();
    this.size = 0;
    this.unacknowledged++;
    post({ type: 'batch', id: this.id, batch });
    if (this.unacknowledged >= MAX_UNACKNOWLEDGED) await new Promise<void>((resolve) => (this.resume = resolve));
  }

  acknowledged() {
    this.unacknowledged--;
    const resume = this.resume;
    this.resume = null;
    resume?.();
  }
}

function describe(error: unknown): WorkerError {
  if (error instanceof ImportError) return { message: error.message, code: error.code, details: error.details };
  const message = error instanceof Error ? error.message : String(error);
  return { message: `The file could not be read: ${message}`, code: 'unexpected' };
}

const sinks = new Map<number, BatchingSink>();

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'ack') {
    sinks.get(message.id)?.acknowledged();
    return;
  }
  try {
    if (message.type === 'detect') {
      post({ type: 'detected', id: message.id, detected: await detectImport(message.files) });
      return;
    }
    const sink = new BatchingSink(message.id);
    sinks.set(message.id, sink);
    const { knownRequestKeys, knownFiles, options } = message.context;
    const parsed = await PARSERS[message.parser].parse(message.files, sink, {
      knownRequestKeys: knownRequestKeys ? new Set(knownRequestKeys) : undefined,
      knownFiles: knownFiles ? new Map(knownFiles.map(([path, size, lastModified]) => [path, { size, lastModified }])) : undefined,
      options,
    });
    await sink.flush();
    post({ type: 'done', id: message.id, parsed });
  } catch (error) {
    post({ type: 'error', id: message.id, error: describe(error) });
  } finally {
    sinks.delete(message.id);
  }
};
