import { Sha256 } from '@/core/sha256';
import {
  ImportError,
  type ImportFile,
  type ImportParser,
  type ImportSink,
  type ParseContext,
  type ParsedImport,
  type ParseWarning,
  type SyncedFileInfo,
} from '@/core/types';
import { aggregateUsage } from './aggregate';
import { deferInProgress, extractTranscripts, IN_PROGRESS_WINDOW_MS, isTranscriptRow } from './extract';
import { emptyLedger, LEDGER_FORMAT, LedgerError, ledgerRecords, looksLikeLedger, mergeIntoLedger, parseLedger } from './ledger';

/**
 * The two Claude Code importers.
 *
 *  - claudeCodeParser reads session transcripts: the `.jsonl` files under
 *    `~/.claude/projects/`, picked as a folder in the browser.
 *  - claudeCodeLedgerParser reads the ledger written by the collector CLI
 *    (public/tools/claude-lifetime-collect.mjs), which holds the same records in
 *    compact form and outlives Claude Code's transcript cleanup.
 *
 * Both end in the same step (aggregate.ts), and both identify a response by the same
 * key, so the two routes can be mixed freely: whatever one has counted, the other skips.
 *
 * Options (ParseContext.options):
 *   now          epoch milliseconds to treat as the current time (default Date.now())
 *   sourceLabel  label of the data source (default "Claude Code (this computer)")
 *   sourceRef    stable identity of the data source (default "local"); use one per
 *                computer to keep several computers apart
 */
export const CLAUDE_CODE_PARSER_VERSION = 'claude-code-1';
export const CLAUDE_CODE_TRANSCRIPT_FORMAT = 'claude-code/jsonl';
export const CLAUDE_CODE_LEDGER_FORMAT = 'claude-code/ledger';

export interface ClaudeCodeImportOptions {
  now?: number;
  sourceLabel?: string;
  sourceRef?: string;
}

export type ClaudeCodeFormat = typeof CLAUDE_CODE_TRANSCRIPT_FORMAT | typeof CLAUDE_CODE_LEDGER_FORMAT;

/**
 * Which Claude Code input a parsed JSON value is, or null for neither: the ledger (a
 * JSON document) or a transcript (JSON Lines: pass the value of the first line).
 * A pure function for the app's format detection, like the ones of the other importers.
 */
export function detectClaudeCodeFormat(value: unknown): ClaudeCodeFormat | null {
  if (typeof value === 'object' && value !== null && (value as { format?: unknown }).format === LEDGER_FORMAT) return CLAUDE_CODE_LEDGER_FORMAT;
  return isTranscriptRow(value) ? CLAUDE_CODE_TRANSCRIPT_FORMAT : null;
}

/**
 * The files that may be skipped by the next import, without those whose path names more than one file
 * of the selection. Files picked one by one come without a folder, so two of them can share a name
 * (the same session file from two project folders, the ledgers of two computers). Such a path identifies
 * neither file, and remembering it would let one stand in for the other.
 */
function withUniquePaths(candidates: SyncedFileInfo[], pathsGiven: readonly string[]): SyncedFileInfo[] {
  const times = new Map<string, number>();
  for (const path of pathsGiven) times.set(path, (times.get(path) ?? 0) + 1);
  return candidates.filter((f) => times.get(f.path) === 1);
}

const READING = 'Reading transcripts';
const COUNTING = 'Counting usage';

function readOptions(ctx: ParseContext): { now: number; sourceLabel: string; sourceRef: string } {
  const o = ctx.options ?? {};
  return {
    now: typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : Date.now(),
    sourceLabel: typeof o.sourceLabel === 'string' && o.sourceLabel !== '' ? o.sourceLabel : 'Claude Code (this computer)',
    sourceRef: typeof o.sourceRef === 'string' && o.sourceRef !== '' ? o.sourceRef : 'local',
  };
}

function cancelIfAborted(ctx: ParseContext): void {
  if (ctx.signal?.aborted) throw new ImportError('The import was cancelled.', 'cancelled');
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function deferralWarnings(deferredResponses: number, deferredPrompts: number): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  if (deferredResponses > 0) {
    warnings.push({
      code: 'in_progress_deferred',
      message:
        `${plural(deferredResponses, 'response is', 'responses are')} still being written by Claude Code and ` +
        `${deferredResponses === 1 ? 'was' : 'were'} left out for now. Import again in a few minutes to add ${deferredResponses === 1 ? 'it' : 'them'}.`,
      count: deferredResponses,
    });
  }
  if (deferredPrompts > 0) {
    warnings.push({
      code: 'prompts_deferred',
      message: `${plural(deferredPrompts, 'prompt has', 'prompts have')} no recorded answer yet and will be counted together with the answer.`,
      count: deferredPrompts,
    });
  }
  return warnings;
}

export const claudeCodeParser: ImportParser = {
  async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
    if (files.length === 0) throw new ImportError('No file was selected.', 'no_files');
    const options = readOptions(ctx);
    cancelIfAborted(ctx);

    const extraction = await extractTranscripts(files, {
      knownFiles: ctx.knownFiles,
      onProgress: (p) => {
        cancelIfAborted(ctx);
        sink.progress?.({ phase: READING, bytesRead: p.bytesRead, totalBytes: p.totalBytes, records: p.usageRows });
      },
    });
    const c = extraction.counters;

    if (c.transcriptFiles === 0) {
      throw new ImportError(
        'No Claude Code transcripts were found in this selection. Choose your Claude Code folder ' +
          '(normally ".claude" in your home folder) or its "projects" folder; transcripts are the .jsonl files inside it.',
        'no_usage_found',
        `${files.length} file(s) given, none of them a .jsonl transcript`,
      );
    }
    // Files that are skipped as unchanged had usage when they were imported, so an
    // incremental sync that finds nothing new is not an error.
    if (c.usageRows === 0 && c.filesSkippedUnchanged === 0) {
      throw new ImportError(
        'These files contain no token usage. Claude Code records usage on the assistant rows of a session transcript; ' +
          `none of the ${plural(c.filesRead, 'file', 'files')} read has one. If you have not used Claude Code on this computer ` +
          'in the last 30 days, its transcripts have already been cleaned up.',
        'no_usage_found',
        `${c.filesRead} transcript file(s), ${c.lines} line(s), ${c.malformedLines} malformed`,
      );
    }

    const deferral = deferInProgress(extraction, options.now);
    cancelIfAborted(ctx);
    sink.progress?.({ phase: COUNTING, bytesRead: c.bytesRead, totalBytes: c.bytesRead, records: c.usageRows });
    const outcome = await aggregateUsage(
      { responses: deferral.responses, prompts: deferral.prompts, sessions: extraction.sessions },
      sink,
      ctx.knownRequestKeys,
    );

    const warnings: ParseWarning[] = [];
    if (c.malformedLines > 0) {
      warnings.push({
        code: 'malformed_lines',
        message:
          `${plural(c.malformedLines, 'line', 'lines')} could not be read as JSON and ${c.malformedLines === 1 ? 'was' : 'were'} skipped. ` +
          'A cut-off last line is normal while a session is running.',
        count: c.malformedLines,
        sample: extraction.samples.malformedLine,
      });
    }
    if (c.filesUnreadable > 0) {
      warnings.push({
        code: 'unreadable_files',
        message: `${plural(c.filesUnreadable, 'file', 'files')} could not be read to the end (often because Claude Code was writing to it). What was read is counted; the rest follows with the next import.`,
        count: c.filesUnreadable,
        sample: extraction.samples.unreadableFile,
      });
    }
    if (c.usageRowsWithoutCounts > 0) {
      warnings.push({
        code: 'usage_without_counts',
        message: `${plural(c.usageRowsWithoutCounts, 'usage row has', 'usage rows have')} neither input nor output token counts and ${c.usageRowsWithoutCounts === 1 ? 'was' : 'were'} skipped.`,
        count: c.usageRowsWithoutCounts,
      });
    }
    if (c.rowsWithoutTimestamp > 0) {
      warnings.push({
        code: 'rows_without_timestamp',
        message: `${plural(c.rowsWithoutTimestamp, 'row', 'rows')} could not be placed in time (no timestamp in the row, the file or its neighbours) and ${c.rowsWithoutTimestamp === 1 ? 'was' : 'were'} skipped.`,
        count: c.rowsWithoutTimestamp,
      });
    }
    warnings.push(...deferralWarnings(deferral.deferredResponses, deferral.deferredPrompts), ...outcome.warnings);

    // A file is remembered as synced only when nothing in it can still change: it has
    // been quiet for a while and nothing read from it was set aside for later.
    const syncedFiles: SyncedFileInfo[] = [];
    extraction.files.forEach((f, i) => {
      if (f.status !== 'read' || f.lastModified === undefined) return;
      if (options.now - f.lastModified < IN_PROGRESS_WINDOW_MS || deferral.hotFiles.has(i)) return;
      syncedFiles.push({ path: f.path, size: f.size, lastModified: f.lastModified });
    });
    const remembered = withUniquePaths(syncedFiles, extraction.files.map((f) => f.path));

    const read = extraction.files.filter((f) => f.status !== 'unchanged');
    return {
      format: CLAUDE_CODE_TRANSCRIPT_FORMAT,
      formatLabel: 'Claude Code session transcripts',
      parserVersion: CLAUDE_CODE_PARSER_VERSION,
      source: { kind: 'claude_code', label: options.sourceLabel, externalRef: options.sourceRef },
      fileName: read.length === 1 ? read[0].name : `${read.length} transcript files`,
      fileSize: c.bytesRead,
      contentHash: null,
      recordsSeen: c.usageRows,
      recordsSkipped: c.malformedLines + c.syntheticRows + c.usageRowsWithoutCounts + c.rowsWithoutTimestamp + deferral.deferredResponses,
      missingFields: outcome.missingFields,
      warnings,
      requestKeys: outcome.requestKeys,
      duplicateRequests: outcome.duplicateRequests,
      syncedFiles: remembered,
      stats: {
        files: c.transcriptFiles,
        filesRead: c.filesRead,
        filesSkippedUnchanged: c.filesSkippedUnchanged,
        filesUnreadable: c.filesUnreadable,
        filesIgnored: c.filesIgnored,
        subagentFiles: c.subagentFiles,
        bytesRead: c.bytesRead,
        lines: c.lines,
        malformedLines: c.malformedLines,
        usageRows: c.usageRows,
        syntheticRows: c.syntheticRows,
        duplicateLines: c.duplicateLines,
        sidechainReplaysDropped: c.sidechainReplaysDropped,
        messageIdsReused: c.messageIdsReused,
        summariesUnresolved: c.summariesUnresolved,
        deferredInProgress: deferral.deferredResponses,
        deferredPrompts: deferral.deferredPrompts,
        ...outcome.stats,
      },
    };
  },
};

/** True when the file starts like a collector ledger (reads the first kilobytes only). */
export async function isClaudeCodeLedgerFile(file: Pick<ImportFile, 'blob'>): Promise<boolean> {
  return looksLikeLedger(await file.blob.slice(0, 4096).text());
}

export const claudeCodeLedgerParser: ImportParser = {
  async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
    if (files.length === 0) throw new ImportError('No file was selected.', 'no_files');
    const options = readOptions(ctx);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const combined = emptyLedger();
    const read: ImportFile[] = [];
    const machines = new Set<string>();
    let skippedUnchanged = 0;
    let bytesRead = 0;
    let rowsRead = 0;
    let contentHash: string | null = null;
    let generatedAt = '';

    for (const file of files) {
      cancelIfAborted(ctx);
      const known = ctx.knownFiles?.get(file.path ?? file.name);
      if (known !== undefined && file.lastModified !== undefined && known.size === file.size && Math.abs(known.lastModified - file.lastModified) < 1) {
        skippedUnchanged++;
        continue;
      }
      sink.progress?.({ phase: 'Reading the ledger', bytesRead, totalBytes, records: rowsRead });
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      bytesRead += bytes.length;
      // Several ledgers (one per computer) can be imported together; a content hash
      // only identifies the input when it is a single file.
      contentHash = files.length === 1 ? new Sha256().update(bytes).hex() : null;
      let ledger;
      try {
        ledger = parseLedger(new TextDecoder('utf-8').decode(bytes));
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        throw new ImportError(
          err.code === 'not_a_ledger'
            ? `"${file.name}" is not a ledger written by the Claude Lifetime collector.`
            : `"${file.name}" could not be imported: ${err.message}`,
          err.code === 'not_a_ledger' ? 'not_a_ledger' : err.code === 'unsupported_version' ? 'unsupported_ledger_version' : 'invalid_ledger',
          err.message,
        );
      }
      rowsRead += ledger.responses.size;
      if (ledger.machine !== '') machines.add(ledger.machine);
      if ((ledger.generatedAt ?? '') > generatedAt) generatedAt = ledger.generatedAt ?? '';
      mergeIntoLedger(combined, ledgerRecords(ledger));
      read.push(file);
    }

    if (read.length > 0 && combined.responses.size === 0 && combined.prompts.size === 0) {
      throw new ImportError(
        'The ledger is empty: the collector has not found any Claude Code usage yet. Run it again after using Claude Code.',
        'no_usage_found',
      );
    }

    const records = ledgerRecords(combined);
    // The collector already leaves out what was still being written when it ran; this
    // only matters for a ledger from a computer whose clock is ahead of this one.
    const deferral = deferInProgress(records, options.now);
    cancelIfAborted(ctx);
    sink.progress?.({ phase: COUNTING, bytesRead, totalBytes: bytesRead, records: rowsRead });
    const outcome = await aggregateUsage(
      { responses: deferral.responses, prompts: deferral.prompts, sessions: records.sessions },
      sink,
      ctx.knownRequestKeys,
    );

    const syncedFiles: SyncedFileInfo[] = [];
    // A ledger is replaced atomically by the collector, so it is never half-written.
    if (deferral.deferredResponses + deferral.deferredPrompts === 0) {
      for (const f of read) {
        if (f.lastModified !== undefined) syncedFiles.push({ path: f.path ?? f.name, size: f.size, lastModified: f.lastModified });
      }
    }

    return {
      format: CLAUDE_CODE_LEDGER_FORMAT,
      formatLabel: 'Claude Code usage ledger (collector)',
      parserVersion: CLAUDE_CODE_PARSER_VERSION,
      source: { kind: 'claude_code', label: options.sourceLabel, externalRef: options.sourceRef },
      fileName: read.length === 1 ? read[0].name : `${read.length} ledger files`,
      fileSize: bytesRead,
      contentHash,
      recordsSeen: rowsRead,
      recordsSkipped: deferral.deferredResponses,
      missingFields: outcome.missingFields,
      warnings: [...deferralWarnings(deferral.deferredResponses, deferral.deferredPrompts), ...outcome.warnings],
      requestKeys: outcome.requestKeys,
      duplicateRequests: outcome.duplicateRequests,
      syncedFiles: withUniquePaths(syncedFiles, files.map((f) => f.path ?? f.name)),
      stats: {
        files: files.length,
        filesRead: read.length,
        filesSkippedUnchanged: skippedUnchanged,
        bytesRead,
        machine: [...machines].sort().join(', '),
        generatedAt,
        deferredInProgress: deferral.deferredResponses,
        deferredPrompts: deferral.deferredPrompts,
        ...outcome.stats,
      },
    };
  },
};
