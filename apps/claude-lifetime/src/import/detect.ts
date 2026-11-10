import { ImportError, type ImportFile } from '@/core/types';
import { apiErrorMessage } from './api-reports/detect';
import { isTranscriptRow, transcriptPathInfo } from './claude-code/extract';
import { looksLikeLedger } from './claude-code/ledger';
import { previewCsv, type CsvPreview } from './generic/csv';
import { detectCsvFormat, detectJsonFormat } from './generic/detect';
import type { ParserKey } from './formats';
import { looksLikeZip, readZipDirectory } from './util/zip';

/**
 * Works out what the selected files are, by looking at their contents rather than
 * trusting their names. Only the beginning of each file is read, except for small
 * JSON documents, which are parsed whole.
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
}

const HEAD_BYTES = 256 * 1024;
/** JSON documents up to this size are parsed whole to be identified. */
const PARSE_WHOLE_BYTES = 96 * 1024 * 1024;

const SUPPORTED =
  'Claude Lifetime reads: the claude.ai data export (ZIP or conversations.json), Claude Code transcripts (.jsonl files or the whole .claude folder), ' +
  'Anthropic API usage and cost reports (JSON), Claude Console CSV exports, and usage tables as CSV or JSON.';

async function readHead(blob: Blob, bytes = HEAD_BYTES): Promise<{ bytes: Uint8Array; text: string }> {
  const buffer = new Uint8Array(await blob.slice(0, bytes).arrayBuffer());
  let text: string;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buffer);
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) text = new TextDecoder('utf-16be').decode(buffer);
  else text = new TextDecoder('utf-8').decode(buffer);
  return { bytes: buffer, text: text.replace(/^﻿/, '') };
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
  | { parser: ParserKey; recognisedAs: string; csv?: CsvPreview }
  | { parser: null; problem: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function looksLikeConversation(value: unknown): boolean {
  return isObject(value) && (Array.isArray(value.chat_messages) || (typeof value.uuid === 'string' && 'name' in value && 'created_at' in value));
}

function fromJsonFormat(format: ReturnType<typeof detectJsonFormat>, what: string): Kind | null {
  switch (format) {
    case 'anthropic/usage-report':
    case 'anthropic/analytics-usage':
      return { parser: 'api-usage', recognisedAs: `${what} with an Anthropic API usage report` };
    case 'anthropic/cost-report':
    case 'anthropic/analytics-cost':
      return { parser: 'api-cost', recognisedAs: `${what} with an Anthropic API cost report` };
    case 'claude-lifetime/usage':
      return { parser: 'generic-json', recognisedAs: `${what} with usage records in the Claude Lifetime format` };
    default:
      return null;
  }
}

async function classify(file: ImportFile): Promise<Kind> {
  if (file.size === 0) return { parser: null, problem: `"${file.name}" is empty.` };
  const head = await readHead(file.blob);
  const name = file.name.toLowerCase();

  if (looksLikeZip(head.bytes)) {
    const entries = await readZipDirectory(file.blob);
    const names = entries.filter((e) => !e.isDirectory).map((e) => e.name);
    const base = (n: string) => n.split('/').pop() ?? n;
    if (names.some((n) => /^conversations(?:[-_.]\d+)?\.(json|zip)$/i.test(base(n)))) {
      return { parser: 'claude-export', recognisedAs: 'ZIP archive of a claude.ai data export' };
    }
    if (names.some((n) => /\.jsonl$/i.test(n) && /(^|\/)projects\//.test(n))) {
      return {
        parser: null,
        problem: `"${file.name}" is a ZIP archive of Claude Code files. Unpack it and choose the unpacked folder, so the transcripts can be read one by one.`,
      };
    }
    const listed = names.slice(0, 6).join(', ');
    return {
      parser: null,
      problem:
        `"${file.name}" is a ZIP archive, but not a claude.ai data export: it has no conversations.json` +
        (listed ? ` (it contains ${listed}${names.length > 6 ? ', …' : ''}).` : '.') +
        ' If your export arrived in several parts, choose the part that contains conversations.json.',
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
    const kind = fromJsonFormat(detectJsonFormat(first === undefined ? undefined : [first]), 'JSON file');
    if (kind) return kind;
    if (isObject(first) && typeof first.uuid === 'string' && ('email_address' in first || 'full_name' in first)) {
      return { parser: null, problem: `"${file.name}" is the account file of a claude.ai export. Choose conversations.json (or the whole ZIP) instead.` };
    }
    return { parser: null, problem: `"${file.name}" is a JSON list, but its entries are neither conversations nor usage records. ${SUPPORTED}` };
  }

  if (text[0] === '{') {
    const firstLineEnd = text.indexOf('\n');
    const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
    let lineValue: unknown;
    try {
      lineValue = JSON.parse(firstLine);
    } catch {
      lineValue = undefined;
    }
    // JSON Lines: the first line is a complete value of its own.
    if (lineValue !== undefined && (firstLineEnd !== -1 || /\.(jsonl|ndjson)$/.test(name))) {
      if (isTranscriptRow(lineValue)) return { parser: 'claude-code', recognisedAs: 'Claude Code session transcript' };
      const kind = fromJsonFormat(detectJsonFormat(lineValue), 'JSON Lines file');
      if (kind) return kind;
      if (transcriptPathInfo(file.path ?? file.name).isTranscript) return { parser: 'claude-code', recognisedAs: 'Claude Code session transcript' };
    }
    if (file.size <= PARSE_WHOLE_BYTES) {
      let value: unknown;
      try {
        value = JSON.parse(file.size <= head.bytes.length ? head.text : await file.blob.text());
      } catch (error) {
        if (lineValue === undefined) {
          return {
            parser: null,
            problem: `"${file.name}" starts like a JSON document but cannot be parsed (${error instanceof Error ? error.message : 'invalid JSON'}). The file may be incomplete.`,
          };
        }
        value = lineValue;
      }
      const apiError = apiErrorMessage(value);
      if (apiError !== null) {
        return {
          parser: null,
          problem: `"${file.name}" is an error response from the Anthropic API, not a report: ${apiError}. Run the request again and save a successful response.`,
        };
      }
      const kind = fromJsonFormat(detectJsonFormat(value), 'JSON file');
      if (kind) return kind;
      if (isObject(value) && Array.isArray(value.conversations) && value.conversations.some(looksLikeConversation)) {
        return { parser: null, problem: `"${file.name}" wraps its conversations in an object. Claude Lifetime reads the conversations.json of the official export, which is a plain list.` };
      }
    } else if (/"data"\s*:\s*\[/.test(text) && /"starting_at"\s*:/.test(text)) {
      return { parser: /"amount"\s*:/.test(text) && !/"uncached_input_tokens"\s*:/.test(text) ? 'api-cost' : 'api-usage', recognisedAs: 'JSON file with an Anthropic API report' };
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

  // A folder (or many files): look for what it holds by name first, to avoid reading thousands of files.
  if (files.length > 1) {
    const transcripts: number[] = [];
    const conversations: number[] = [];
    files.forEach((f, i) => {
      const path = f.path ?? f.name;
      const base = path.split('/').pop() ?? path;
      if (transcriptPathInfo(path).isTranscript) transcripts.push(i);
      else if (/^conversations(?:[-_.]\d+)?\.json$/i.test(base)) conversations.push(i);
    });
    if (transcripts.length > 0 && conversations.length === 0) {
      // The parser itself decides which of the .jsonl files are transcripts; it gets all files so paths stay intact.
      return done('claude-code', files.map((_, i) => i), `folder with ${transcripts.length.toLocaleString('en-US')} Claude Code transcript files`);
    }
    if (conversations.length > 0 && transcripts.length === 0) {
      return done('claude-export', conversations, 'unpacked claude.ai data export');
    }
    if (transcripts.length > 0 && conversations.length > 0) {
      throw new ImportError(
        'This selection contains both Claude Code transcripts and a claude.ai export. Import them one after the other, so each can be previewed on its own.',
        'mixed_selection',
      );
    }
  }

  // Otherwise every file must be the same kind of thing.
  const kinds: Kind[] = [];
  for (const file of files.slice(0, 200)) kinds.push(await classify(file));
  const problems = kinds.filter((k): k is Extract<Kind, { parser: null }> => k.parser === null);
  const good = kinds.map((k, i) => ({ k, i })).filter((e): e is { k: Extract<Kind, { parser: ParserKey }>; i: number } => e.k.parser !== null);

  if (good.length === 0) {
    throw new ImportError(problems[0]?.problem ?? `These files are not in a format this app can read. ${SUPPORTED}`, 'unknown_format');
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
  if (files.length > 200) {
    throw new ImportError(
      'Too many separate files were selected. To import Claude Code transcripts, choose the folder that contains them instead of the individual files.',
      'too_many_files',
    );
  }
  const recognisedAs = good.length > 1 ? `${good.length} files: ${good[0].k.recognisedAs}` : good[0].k.recognisedAs;
  return done(parser, good.map((e) => e.i), recognisedAs, good[0].k.csv);
}
