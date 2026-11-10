import { ImportError, type ImportFile } from '@/core/types';
import { apiErrorMessage, isUndecidedReport } from './api-reports/detect';
import { isTranscriptRow, transcriptPathInfo } from './claude-code/extract';
import { looksLikeLedger } from './claude-code/ledger';
import { previewCsv, type CsvPreview } from './generic/csv';
import { detectCsvFormat, detectJsonFormat } from './generic/detect';
import type { ParserKey } from './formats';
import { entryPath, isReadableEntry } from './archive';
import { looksLikeZip, readZipDirectory } from './util/zip';

/**
 * Works out what the selected files are, by looking at their contents rather than
 * trusting their names. Only the beginning of each file is read, except for small
 * JSON documents, which are parsed whole. Of a folder with many .jsonl files only a
 * sample is looked at, so that choosing a Claude Code folder with a hundred thousand
 * transcripts stays quick.
 *
 * The result names the parser to use and which of the given files it should read.
 * When nothing matches, the error says what was found and what the app can read.
 */
export interface Detected {
  parser: ParserKey;
  /** Indexes into the given files of the ones the parser should read. */
  fileIndexes: number[];
  /** Total size of those files in bytes. */
  totalBytes: number;
  /** What was recognised, for the user: "ZIP archive with conversations.json". */
  recognisedAs: string;
  /** Selected files that are not part of this import and will be ignored. */
  ignoredFiles: number;
  /** For a CSV of the user's own making: header, sample rows and the proposed column mapping. */
  csv?: CsvPreview;
  /**
   * The name of the first file to be read, for the user. Set by the import worker, whose positions
   * count the files inside ZIP archives (see selection.ts), so the page cannot look the name up itself.
   */
  leadName?: string;
}

const HEAD_BYTES = 256 * 1024;
/**
 * JSON documents up to this size are parsed whole to be identified. The first line of
 * a JSON Lines file is read up to the same length when it does not end inside the head.
 */
const PARSE_WHOLE_BYTES = 96 * 1024 * 1024;
/** How much is read at a time while looking for the end of a long first line. */
const LINE_STEP_BYTES = 1024 * 1024;
/** Files that are not found by their name are looked at one by one, up to this many. */
const MAX_SEPARATE_FILES = 200;
/** How many of the .jsonl files of a selection are opened to see what they hold. */
const SAMPLE_FILES = 20;

const SUPPORTED =
  'Claude Lifetime reads: the claude.ai data export (ZIP or conversations.json), Claude Code transcripts (.jsonl files or the whole .claude folder), ' +
  'Anthropic API usage and cost reports (JSON), Claude Console CSV exports, and usage tables as CSV or JSON. Any of them can also be in a ZIP archive.';

type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be';

async function readHead(blob: Blob, bytes = HEAD_BYTES): Promise<{ bytes: Uint8Array; text: string; utf8: boolean; encoding: Encoding }> {
  const buffer = new Uint8Array(await blob.slice(0, bytes).arrayBuffer());
  let encoding: Encoding = 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf-16le';
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf-16be';
  const text = new TextDecoder(encoding).decode(buffer);
  return { bytes: buffer, utf8: encoding === 'utf-8', encoding, text: text.replace(/^﻿/, '') };
}

/** What tells a usage report from a cost report in the text of a file: a row's amount, or one of its token counts. */
const COST_MARK = /"amount"\s*:/;
const USAGE_MARK = /"(?:uncached_input_tokens|cache_read_input_tokens|output_tokens|cache_creation|total_tokens)"\s*:/;
/** Longest text one of the two marks can span, so that a mark cut in two by a chunk boundary is still found. */
const MARK_OVERLAP = 64;

/** Which report a text is from, going by whichever of the two marks comes first. Null when it holds neither. */
function reportByMarks(text: string): 'api-usage' | 'api-cost' | null {
  const cost = text.search(COST_MARK);
  const usage = text.search(USAGE_MARK);
  if (cost === -1 && usage === -1) return null;
  if (usage === -1) return 'api-cost';
  return cost !== -1 && cost < usage ? 'api-cost' : 'api-usage';
}

/**
 * Reads a file to the end, a megabyte at a time, until it shows whether it is a usage or
 * a cost report. Only used for a report that begins with nothing but empty time buckets:
 * those look the same in both, and a cost report that starts before the first spend
 * begins exactly like that. Null when the whole file holds neither a count nor an amount.
 */
async function scanForReportKind(blob: Blob, encoding: Encoding): Promise<'api-usage' | 'api-cost' | null> {
  const decoder = new TextDecoder(encoding);
  let carry = '';
  for (let offset = 0; offset < blob.size; offset += LINE_STEP_BYTES) {
    const text = carry + decoder.decode(new Uint8Array(await blob.slice(offset, offset + LINE_STEP_BYTES).arrayBuffer()), { stream: true });
    const found = reportByMarks(text);
    if (found !== null) return found;
    carry = text.slice(-MARK_OVERLAP);
  }
  return null;
}

/**
 * The first line of a UTF-8 file whose head ends inside that line, read on until the
 * line or the file ends. Null when the line is longer than `limit` bytes.
 */
async function readFirstLine(blob: Blob, head: Uint8Array, limit: number): Promise<string | null> {
  const parts = [head];
  let length = head.length;
  while (length < blob.size) {
    if (length >= limit) return null;
    const part = new Uint8Array(await blob.slice(length, length + LINE_STEP_BYTES).arrayBuffer());
    if (part.length === 0) break;
    // In UTF-8 a line feed is one byte, and that byte is never part of another character.
    const end = part.indexOf(0x0a);
    parts.push(end === -1 ? part : part.subarray(0, end));
    length += part.length;
    if (end !== -1) break;
  }
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder('utf-8').decode(bytes).trimStart();
}

/**
 * The first complete JSON value that starts at or after `from`, parsed, or undefined
 * when the text ends before the value does. A small scanner that only tracks strings
 * and nesting; the value itself is handed to JSON.parse.
 */
function firstJsonValue(text: string, from: number): unknown {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  const open = text[i];
  if (open !== '{' && open !== '[') return undefined;
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (ch === '\\') j++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, j + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

type Kind =
  | {
      parser: ParserKey;
      recognisedAs: string;
      csv?: CsvPreview;
      /** Set when the parsed JSON itself showed what the file is, rather than its name or a pattern in its text. */
      fromJson?: true;
      /**
       * Set for a report that holds only empty time buckets, to its very end: it is a usage or a cost
       * report, and nothing in it says which. Among other files it goes with whichever report they are.
       */
      undecided?: true;
    }
  | { parser: null; problem: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function looksLikeConversation(value: unknown): boolean {
  return isObject(value) && (Array.isArray(value.chat_messages) || (typeof value.uuid === 'string' && 'name' in value && 'created_at' in value));
}

function fromJsonFormat(format: ReturnType<typeof detectJsonFormat>, what: string): Kind | null {
  switch (format) {
    case 'anthropic/usage-report':
    case 'anthropic/analytics-usage':
      return { parser: 'api-usage', recognisedAs: `${what} with an Anthropic API usage report`, fromJson: true };
    case 'anthropic/cost-report':
    case 'anthropic/analytics-cost':
      return { parser: 'api-cost', recognisedAs: `${what} with an Anthropic API cost report`, fromJson: true };
    case 'claude-lifetime/usage':
      return { parser: 'generic-json', recognisedAs: `${what} with usage records in the Claude Lifetime format`, fromJson: true };
    default:
      return null;
  }
}

/**
 * What one file is, going by its contents. A .jsonl file whose contents do not say
 * what it is passes for a Claude Code transcript, as its name suggests.
 */
async function classify(file: ImportFile): Promise<Kind> {
  if (file.size === 0) return { parser: null, problem: `"${file.name}" is empty.` };
  const head = await readHead(file.blob);
  const name = file.name.toLowerCase();

  /** What a parsed value is. `value` is the part of the file that was looked at: its first page, its first line, or all of it. */
  const fromValue = async (value: unknown, what: string): Promise<Kind | null> => {
    const kind = fromJsonFormat(detectJsonFormat(value), what);
    if (kind === null || kind.parser !== 'api-usage' || !isUndecidedReport(value)) return kind;
    // Nothing but empty time buckets so far. The rest of the file says which report this is.
    const found = await scanForReportKind(file.blob, head.encoding);
    if (found === 'api-cost') return { parser: 'api-cost', recognisedAs: `${what} with an Anthropic API cost report`, fromJson: true };
    if (found === 'api-usage') return kind;
    return { parser: 'api-usage', recognisedAs: `${what} with an Anthropic API report that has no figures in it`, fromJson: true, undecided: true };
  };

  if (looksLikeZip(head.bytes)) {
    const entries = await readZipDirectory(file.blob);
    const names = entries.filter((e) => !e.isDirectory).map((e) => e.name);
    const base = (n: string) => n.split('/').pop() ?? n;
    if (names.some((n) => /^conversations(?:[-_.]\d+)?\.(json|zip)$/i.test(base(n)))) {
      return { parser: 'claude-export', recognisedAs: 'ZIP archive of a claude.ai data export' };
    }
    // Any other archive was opened before detection (see archive.ts), unless it lies too deep inside other archives,
    // or it is one of a large selection and its name does not say it is an archive.
    if (names.some((n) => isReadableEntry(entryPath(n)))) {
      return {
        parser: null,
        problem: `"${file.name}" is a ZIP archive that was not opened, because it lies too deep inside other archives or its name does not end in .zip. Unpack it and choose the files inside it.`,
      };
    }
    const listed = names.slice(0, 6).join(', ');
    return {
      parser: null,
      problem:
        `"${file.name}" is a ZIP archive, but none of the files in it is one this app can read` +
        (listed ? ` (it contains ${listed}${names.length > 6 ? ', …' : ''}).` : ': it is empty.') +
        ` ${SUPPORTED}`,
    };
  }

  const text = head.text.trimStart();
  if (text === '') return { parser: null, problem: `"${file.name}" contains only white space.` };

  if (looksLikeLedger(head.text)) return { parser: 'claude-code-ledger', recognisedAs: 'Claude Code usage ledger written by the collector script' };

  if (text[0] === '[') {
    const first = firstJsonValue(text, 1);
    if (looksLikeConversation(first) || /"chat_messages"\s*:/.test(text)) {
      return { parser: 'claude-export', recognisedAs: 'conversations.json from a claude.ai data export' };
    }
    if (first === undefined && /^\[\s*\]/.test(text)) return { parser: null, problem: `"${file.name}" is an empty JSON list: there is nothing in it to import.` };
    const kind = first === undefined ? null : await fromValue([first], 'JSON file');
    if (kind) return kind;
    // The first entry does not end inside the part that was read: a page of a report with many rows is larger
    // than that. Its beginning still shows what it is.
    if (first === undefined && /"data"\s*:\s*\[/.test(text) && /"starting_at"\s*:/.test(text)) {
      const byMarks = reportByMarks(text) ?? (await scanForReportKind(file.blob, head.encoding));
      if (byMarks !== null) return { parser: byMarks, recognisedAs: `JSON file with an Anthropic API ${byMarks === 'api-cost' ? 'cost' : 'usage'} report` };
      return { parser: 'api-usage', recognisedAs: 'JSON file with an Anthropic API report that has no figures in it', undecided: true };
    }
    if (isObject(first) && typeof first.uuid === 'string' && ('email_address' in first || 'full_name' in first)) {
      return { parser: null, problem: `"${file.name}" is the account file of a claude.ai export. Choose conversations.json (or the whole ZIP) instead.` };
    }
    return { parser: null, problem: `"${file.name}" is a JSON list, but its entries are neither conversations nor usage records. ${SUPPORTED}` };
  }

  if (text[0] === '{') {
    const transcriptPath = transcriptPathInfo(file.path ?? file.name).isTranscript;
    // What the name promises: one JSON value per line.
    const linesByName = transcriptPath || /\.(jsonl|ndjson)$/.test(name);
    const byName: Kind | null = transcriptPath ? { parser: 'claude-code', recognisedAs: 'Claude Code session transcript' } : null;
    const firstLineEnd = text.indexOf('\n');
    // The head can end inside the first line: a session that begins with a pasted image has a first row of megabytes.
    const cutLine = firstLineEnd === -1 && file.size > head.bytes.length;
    let firstLine: string | null = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
    if (cutLine && linesByName) firstLine = head.utf8 ? await readFirstLine(file.blob, head.bytes, PARSE_WHOLE_BYTES) : null;
    let lineValue: unknown;
    try {
      lineValue = firstLine === null ? undefined : JSON.parse(firstLine);
    } catch {
      lineValue = undefined;
    }
    // JSON Lines: the first line is a complete value of its own.
    if (lineValue !== undefined && (firstLineEnd !== -1 || linesByName)) {
      if (isTranscriptRow(lineValue)) return { parser: 'claude-code', recognisedAs: 'Claude Code session transcript', fromJson: true };
      const kind = await fromValue(lineValue, 'JSON Lines file');
      if (kind) return kind;
      if (byName) return byName;
    }
    // A file with one value per line is never parsed as a single document: that stops at
    // its second line, and the message would call a sound transcript incomplete.
    const longFirstLine = cutLine && linesByName;
    if (longFirstLine ? lineValue !== undefined : file.size <= PARSE_WHOLE_BYTES) {
      // A first line that is a value of its own is either the whole document, or the file
      // is not one document at all. Both ways there is nothing more to learn from parsing all of it.
      let value = lineValue;
      if (value === undefined) {
        try {
          value = JSON.parse(file.size <= head.bytes.length ? head.text : await file.blob.text());
        } catch (error) {
          // Not one document. It can still be one value per line under a name that does not say so, with a first
          // line longer than the part that was read: pages of a report saved one per line, for example.
          const line = cutLine && head.utf8 ? await readFirstLine(file.blob, head.bytes, PARSE_WHOLE_BYTES) : null;
          let first: unknown;
          try {
            first = line === null ? undefined : JSON.parse(line);
          } catch {
            first = undefined;
          }
          if (first !== undefined) {
            if (isTranscriptRow(first)) return { parser: 'claude-code', recognisedAs: 'Claude Code session transcript', fromJson: true };
            const kind = await fromValue(first, 'JSON Lines file');
            if (kind) return kind;
          }
          return {
            parser: null,
            problem: `"${file.name}" starts like a JSON document but cannot be parsed (${error instanceof Error ? error.message : 'invalid JSON'}). The file may be incomplete.`,
          };
        }
      }
      const apiError = apiErrorMessage(value);
      if (apiError !== null) {
        return {
          parser: null,
          problem: `"${file.name}" is an error response from the Anthropic API, not a report: ${apiError}. Run the request again and save a successful response.`,
        };
      }
      const kind = await fromValue(value, 'JSON file');
      if (kind) return kind;
      if (isObject(value) && Array.isArray(value.conversations) && value.conversations.some(looksLikeConversation)) {
        return { parser: null, problem: `"${file.name}" wraps its conversations in an object. Claude Lifetime reads the conversations.json of the official export, which is a plain list.` };
      }
    } else if (/"data"\s*:\s*\[/.test(text) && /"starting_at"\s*:/.test(text)) {
      // Too large to parse whole. The marks in its beginning say which report it is; a beginning of empty time
      // buckets has none, and then the rest of the file is looked through.
      const byMarks = reportByMarks(text) ?? (await scanForReportKind(file.blob, head.encoding));
      if (byMarks === null) return { parser: 'api-usage', recognisedAs: 'JSON file with an Anthropic API report that has no figures in it', undecided: true };
      return { parser: byMarks, recognisedAs: `JSON file with an Anthropic API ${byMarks === 'api-cost' ? 'cost' : 'usage'} report` };
    } else if (longFirstLine) {
      // The first line is longer than what is read, or it is not valid JSON. The Claude Code parser reads on past such a line.
      return byName ?? { parser: null, problem: `The first line of "${file.name}" could not be read as JSON, so the app cannot tell what the file holds. ${SUPPORTED}` };
    }
    return { parser: null, problem: `"${file.name}" is a JSON document, but not one of the formats this app reads. ${SUPPORTED}` };
  }

  // Anything else is treated as delimited text when its first line has separators.
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (/\.(csv|tsv|txt)$/.test(name) || /[,;\t]/.test(firstLine)) {
    const csv = await previewCsv(file.blob);
    const format = detectCsvFormat(csv.header);
    if (format === 'anthropic/console-usage-csv') return { parser: 'console-csv', recognisedAs: 'usage export from the Claude Console' };
    if (format === 'anthropic/console-cost-csv') return { parser: 'console-csv', recognisedAs: 'cost export from the Claude Console' };
    if (csv.header.length >= 2) {
      return {
        parser: 'generic-csv',
        recognisedAs: format === 'generic/csv' ? 'CSV file with recognisable usage columns' : 'CSV file whose columns need to be matched by you',
        csv,
      };
    }
  }
  return { parser: null, problem: `"${file.name}" is not a format this app can read. ${SUPPORTED}` };
}

/** `count` entries of a list, spread evenly over it. */
function spread<T>(list: T[], count: number): T[] {
  if (list.length <= count) return list;
  if (count <= 1) return list.slice(0, count);
  return Array.from({ length: count }, (_, k) => list[Math.round((k * (list.length - 1)) / (count - 1))]);
}

/**
 * Which of the .jsonl files are opened to see what a selection holds: all of them when
 * they are few, otherwise a sample spread over the whole list, so that one unusual
 * folder does not decide for all the others. Most of the sample comes from below a
 * "projects" folder, where Claude Code keeps its transcripts, so that a Claude Code
 * folder is recognised whatever else lies around it.
 */
function sampleOf(files: ImportFile[], jsonl: number[]): number[] {
  const filled = jsonl.filter((i) => files[i].size > 0);
  if (filled.length <= SAMPLE_FILES) return filled;
  const inProjects: number[] = [];
  const elsewhere: number[] = [];
  for (const i of filled) (/(^|\/)projects\//.test((files[i].path ?? '').replace(/\\/g, '/')) ? inProjects : elsewhere).push(i);
  const fromElsewhere = Math.min(elsewhere.length, Math.max(SAMPLE_FILES - inProjects.length, SAMPLE_FILES / 4));
  return [...spread(inProjects, SAMPLE_FILES - fromElsewhere), ...spread(elsewhere, fromElsewhere)];
}

/** What the files of each kind are called when too many were selected, and what the person can do instead. */
const TOO_MANY: Record<ParserKey, { found: string; advice: string }> = {
  'claude-code': {
    found: 'Claude Code transcripts',
    advice: 'Choose the folder that contains them instead of the individual files: in a folder, transcripts are found by their .jsonl names.',
  },
  'api-usage': {
    found: 'pages of an Anthropic API usage report',
    advice: 'Put the pages into one file (a JSON list of the pages, or one page per line) and import that file.',
  },
  'api-cost': {
    found: 'pages of an Anthropic API cost report',
    advice: 'Put the pages into one file (a JSON list of the pages, or one page per line) and import that file.',
  },
  'console-csv': {
    found: 'exports from the Claude Console',
    advice: `Import them in groups of up to ${MAX_SEPARATE_FILES}, one period after the other: an import replaces what is already stored for the days it covers.`,
  },
  'generic-json': {
    found: 'usage files in the Claude Lifetime format',
    advice: `Import them in groups of up to ${MAX_SEPARATE_FILES}: records that are already stored are not added again.`,
  },
  'generic-csv': { found: 'CSV files', advice: 'Import CSV files one at a time: each has its own columns to match.' },
  'claude-export': {
    found: 'claude.ai data exports',
    advice: `Import them in groups of up to ${MAX_SEPARATE_FILES}: messages that are already stored are not added again.`,
  },
  'claude-code-ledger': {
    found: 'Claude Code usage ledgers',
    advice: `Import them in groups of up to ${MAX_SEPARATE_FILES}: usage that is already counted is not added again.`,
  },
};

function tooManyFiles(count: number, parser: ParserKey): ImportError {
  const { found, advice } = TOO_MANY[parser];
  return new ImportError(
    `This selection has ${count.toLocaleString('en-US')} files. Each file is opened to see what it is, and that is done for at most ${MAX_SEPARATE_FILES} files per import. ` +
      `They look like ${found}. ${advice}`,
    'too_many_files',
  );
}

export async function detectImport(files: ImportFile[]): Promise<Detected> {
  if (files.length === 0) throw new ImportError('No file was selected.', 'no_files');

  const done = (parser: ParserKey, fileIndexes: number[], recognisedAs: string, csv?: CsvPreview): Detected => ({
    parser,
    fileIndexes,
    totalBytes: fileIndexes.reduce((sum, i) => sum + files[i].size, 0),
    recognisedAs,
    ignoredFiles: files.length - fileIndexes.length,
    csv,
  });

  /** What is already known about single files, so that no file is opened twice. */
  const known = new Map<number, Kind>();

  // A folder (or many files): what it holds is first looked for by name, to avoid reading thousands of files.
  if (files.length > 1) {
    const jsonl: number[] = [];
    const conversations: number[] = [];
    files.forEach((f, i) => {
      const path = f.path ?? f.name;
      const base = path.split('/').pop() ?? path;
      if (transcriptPathInfo(path).isTranscript) jsonl.push(i);
      else if (/^conversations(?:[-_.]\d+)?\.json$/i.test(base)) conversations.push(i);
    });

    if (jsonl.length > 0) {
      // A name is not proof: usage records and report pages are kept in .jsonl files too. A few are opened to see.
      let transcripts = 0;
      const somethingElse = new Set<number>();
      for (const i of sampleOf(files, jsonl)) {
        // A file that cannot be read says nothing about the others.
        const kind = await classify(files[i]).catch(() => null);
        // Only what the parsed JSON showed counts here. A guess from the name or from a pattern in the
        // text must not keep a transcript from being read, or turn a Claude Code folder into something else.
        if (kind === null || kind.parser === null || !kind.fromJson) continue;
        if (kind.parser === 'claude-code') transcripts++;
        else {
          somethingElse.add(i);
          known.set(i, kind);
        }
      }
      // Transcripts were found, or nothing that could be recognised (the names are then all there is to go by):
      // a Claude Code folder. When only other formats were found, the files are looked at one by one below.
      if (transcripts > 0 || somethingElse.size === 0) {
        if (conversations.length > 0) {
          throw new ImportError(
            'This selection contains both Claude Code transcripts and a claude.ai export. Import them one after the other, so each can be previewed on its own.',
            'mixed_selection',
          );
        }
        // The Claude Code parser reads the .jsonl files and nothing else. Whatever else was selected is reported as ignored.
        const read = jsonl.filter((i) => !somethingElse.has(i));
        const count = `${read.length.toLocaleString('en-US')} Claude Code transcript ${read.length === 1 ? 'file' : 'files'}`;
        // Files from a ZIP archive have the archive's name in their path; the archive is named separately (see selection.ts).
        const fromFolder = read.some((i) => files[i].archive === undefined && (files[i].path ?? '').includes('/'));
        return done('claude-code', read, fromFolder ? `folder with ${count}` : count);
      }
    } else if (conversations.length > 0) {
      return done('claude-export', conversations, 'unpacked claude.ai data export');
    }
  }

  // Otherwise every file must be the same kind of thing.
  const kinds: Kind[] = [];
  for (let i = 0; i < files.length && i < MAX_SEPARATE_FILES; i++) kinds.push(known.get(i) ?? (await classify(files[i])));
  const problems = kinds.filter((k): k is Extract<Kind, { parser: null }> => k.parser === null);
  const good = kinds.map((k, i) => ({ k, i })).filter((e): e is { k: Extract<Kind, { parser: ParserKey }>; i: number } => e.k.parser !== null);

  if (good.length === 0) {
    throw new ImportError(problems[0]?.problem ?? `These files are not in a format this app can read. ${SUPPORTED}`, 'unknown_format');
  }
  // A page of nothing but empty time buckets belongs to the report the other pages are from: a cost report
  // that starts before the first spend has such a page, and so has a usage report with a quiet week.
  const settled = new Set(good.filter((e) => !e.k.undecided).map((e) => e.k.parser));
  if (settled.size === 1 && settled.has('api-cost')) {
    for (const e of good) if (e.k.undecided) e.k = { ...e.k, parser: 'api-cost' };
  }
  const parsers = new Set(good.map((e) => e.k.parser));
  if (parsers.size > 1) {
    throw new ImportError(
      'The selected files are of different kinds. Import one kind at a time, so each import can be previewed and undone on its own.',
      'mixed_selection',
    );
  }
  const parser = good[0].k.parser;
  if (parser === 'generic-csv' && good.length > 1) {
    throw new ImportError('Import CSV files one at a time: each has its own columns to match.', 'mixed_selection');
  }
  if (files.length > MAX_SEPARATE_FILES) throw tooManyFiles(files.length, parser);
  // Named after a file that shows what the selection is, not after a page that happens to be empty.
  const lead = (good.find((e) => !e.k.undecided) ?? good[0]).k;
  const recognisedAs = good.length > 1 ? `${good.length} files: ${lead.recognisedAs}` : lead.recognisedAs;
  return done(parser, good.map((e) => e.i), recognisedAs, good[0].k.csv);
}
