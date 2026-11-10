import { ImportError } from '@/core/types';

/**
 * Streaming CSV reader.
 *
 * Follows RFC 4180 (quoted fields, "" for a quote inside quotes, line breaks inside
 * quotes) and accepts what real files add to it: LF, CRLF or lone CR line ends, a
 * byte order mark, UTF-16 text (Excel's "Unicode Text"), a semicolon or tab instead
 * of the comma, Excel's leading `sep=;` line, blank lines and a missing final line
 * break.
 *
 * The input is consumed chunk by chunk and records are handed out as soon as they
 * are complete, so memory use is bounded by the largest chunk plus the longest
 * record (which is capped), not by the size of the file. Chunks may end anywhere:
 * inside a multi-byte character, between the CR and LF of a line end, or between
 * the two quotes of an escaped quote.
 */
export interface CsvRecord {
  /** Field values with quoting removed. Surrounding spaces are kept, as the RFC asks. */
  fields: string[];
  /** 1-based line of the input on which the record starts. */
  line: number;
}

export interface CsvOptions {
  /** Field delimiter. Detected from the first line when omitted. */
  delimiter?: string;
  /** Called with every raw chunk (progress, hashing). */
  onBytes?: (chunk: Uint8Array) => void;
  /** Called once with the delimiter in use, before the first record is produced. */
  onDelimiter?: (delimiter: string) => void;
  /** Longest record accepted, in characters. */
  maxRecordChars?: number;
}

/** A row of usage data is well under a kilobyte; this leaves room for free-text columns. */
export const DEFAULT_MAX_RECORD_CHARS = 4 * 1024 * 1024;

/** The first line is looked at before parsing starts; a longer one is judged by this much of it. */
const DETECT_CHARS = 64 * 1024;

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

// Parser states.
const FIELD_START = 0; // nothing of the current field has been read
const UNQUOTED = 1; // inside a field that did not start with a quote
const QUOTED = 2; // inside quotes
const QUOTE_SEEN = 3; // a quote inside quotes: either the end of the field or the first half of ""

function encodingOf(head: Uint8Array): string {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

/**
 * Decodes a byte stream to text. UTF-8 unless the input starts with a UTF-16 byte
 * order mark; the mark itself is dropped. `onBytes` sees every raw chunk.
 */
export async function* decodeText(
  stream: ReadableStream<Uint8Array>,
  onBytes?: (chunk: Uint8Array) => void,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  let decoder: TextDecoder | null = null;
  // A UTF-16 mark is two bytes; a first chunk of one byte is held back until the second arrives.
  let held: Uint8Array | null = null;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length === 0) continue;
      onBytes?.(value);
      let chunk = value;
      if (decoder === null) {
        if (held !== null) {
          const joined = new Uint8Array(held.length + value.length);
          joined.set(held);
          joined.set(value, held.length);
          chunk = joined;
          held = null;
        }
        if (chunk.length < 2) {
          held = chunk;
          continue;
        }
        decoder = new TextDecoder(encodingOf(chunk));
      }
      const text = decoder.decode(chunk, { stream: true });
      if (text.length > 0) yield text;
    }
    finished = true;
    const tail = decoder === null ? (held === null ? '' : new TextDecoder('utf-8').decode(held)) : decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    // A consumer that stops early (a preview of the first rows) should not keep the source open.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Index of the first line break that is not inside quotes, or -1. */
function firstLineBreak(text: string): number {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) quoted = !quoted;
    else if (!quoted && (c === LF || c === CR)) return i;
  }
  return -1;
}

/**
 * Chooses between comma, semicolon and tab: whichever splits the first line (the
 * header) into the most fields. Delimiters inside quotes do not count, and a tie
 * goes to the comma, then the semicolon.
 */
export function detectDelimiter(firstLine: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) counts[ch]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/** The state machine. Text goes in through `push`, complete records come out in `out`. */
class Tokenizer {
  private state = FIELD_START;
  private field = '';
  private fields: string[] = [];
  /** The record holds a quoted field, so it is not a blank line even if that field is empty. */
  private sawQuote = false;
  private recordChars = 0;
  private line = 1;
  private recordLine = 1;
  private quoteLine = 1;
  /** The previous character was a CR; an LF right after it belongs to the same line end. */
  private afterCR = false;

  constructor(
    private readonly delimiter: number,
    private readonly maxRecordChars: number,
  ) {}

  push(text: string, out: CsvRecord[]): void {
    const delimiter = this.delimiter;
    // Start of the part of the current field that has not been copied into `field` yet.
    let from = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);

      if (this.state === QUOTED) {
        if (c === QUOTE) {
          this.field += text.slice(from, i);
          this.state = QUOTE_SEEN;
          this.afterCR = false;
        } else if (c === CR) {
          this.line++;
          this.afterCR = true;
        } else if (c === LF) {
          if (this.afterCR) this.afterCR = false;
          else this.line++;
        } else {
          this.afterCR = false;
        }
        continue;
      }

      if (this.state === QUOTE_SEEN) {
        if (c === QUOTE) {
          this.field += '"';
          from = i + 1;
          this.state = QUOTED;
          continue;
        }
        // The quote closed the field. Anything before the next delimiter is kept as it
        // is rather than rejected: files written by hand do contain `"a" ,b`.
        this.state = UNQUOTED;
        from = i;
      }

      if (c === delimiter) {
        this.endField(text, from, i);
        from = i + 1;
        this.afterCR = false;
      } else if (c === LF) {
        if (this.afterCR) {
          this.afterCR = false;
          from = i + 1;
        } else {
          this.endField(text, from, i);
          this.endRecord(out);
          from = i + 1;
        }
      } else if (c === CR) {
        this.endField(text, from, i);
        this.endRecord(out);
        from = i + 1;
        this.afterCR = true;
      } else {
        this.afterCR = false;
        if (c === QUOTE && this.state === FIELD_START) {
          this.state = QUOTED;
          this.sawQuote = true;
          this.quoteLine = this.line;
          from = i + 1;
        } else {
          // A quote in the middle of an unquoted field is taken literally.
          this.state = UNQUOTED;
        }
      }
    }

    // The chunk ended inside a field: keep what belongs to it.
    if (this.state === QUOTED || this.state === UNQUOTED) this.field += text.slice(from);
    if (this.recordChars + this.field.length > this.maxRecordChars) this.tooLong();
  }

  end(out: CsvRecord[]): void {
    if (this.state === QUOTED) {
      throw new ImportError(
        `A quoted value that starts on line ${this.quoteLine} is never closed, so the rest of the file cannot be split into rows. ` +
          'Check that line for a stray " character.',
        'csv_unclosed_quote',
      );
    }
    if (this.state !== FIELD_START || this.fields.length > 0 || this.sawQuote) {
      this.endField('', 0, 0);
      this.endRecord(out);
    }
  }

  private endField(text: string, from: number, to: number): void {
    if (to > from) this.field += text.slice(from, to);
    this.recordChars += this.field.length + 1;
    if (this.recordChars > this.maxRecordChars) this.tooLong();
    this.fields.push(this.field);
    this.field = '';
    this.state = FIELD_START;
  }

  private endRecord(out: CsvRecord[]): void {
    const fields = this.fields;
    const blankLine = fields.length === 1 && fields[0] === '' && !this.sawQuote;
    if (!blankLine) out.push({ fields, line: this.recordLine });
    this.fields = [];
    this.sawQuote = false;
    this.recordChars = 0;
    this.line++;
    this.recordLine = this.line;
  }

  private tooLong(): never {
    throw new ImportError(
      `The row that starts on line ${this.recordLine} is longer than ${this.maxRecordChars.toLocaleString('en-US')} characters. ` +
        'Either this is not a CSV file, or a quotation mark on that line is never closed.',
      'csv_record_too_long',
    );
  }
}

/**
 * Yields the records of a CSV file one at a time. Blank lines are skipped; the
 * header, if the file has one, is simply the first record.
 */
export async function* readCsv(stream: ReadableStream<Uint8Array>, options: CsvOptions = {}): AsyncGenerator<CsvRecord> {
  const maxRecordChars = options.maxRecordChars ?? DEFAULT_MAX_RECORD_CHARS;
  const out: CsvRecord[] = [];
  let pending = '';

  /**
   * Parsing can only start once the delimiter is known, which takes the whole first
   * line. Returns null while that line is still incomplete (never when `final`).
   */
  const begin = (final: boolean): Tokenizer | null => {
    if (pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1);
    const lineEnd = firstLineBreak(pending);
    if (lineEnd === -1 && !final && pending.length < DETECT_CHARS) return null;
    const firstLine = lineEnd === -1 ? pending : pending.slice(0, lineEnd);
    let delimiter = options.delimiter;
    let rest = pending;
    // Excel writes `sep=;` as the first line to announce the delimiter. It is not data:
    // the line break that follows it is left in place and read as a blank line.
    const hint = /^sep=(.)$/i.exec(firstLine);
    if (hint) {
      delimiter ??= hint[1];
      rest = lineEnd === -1 ? '' : pending.slice(lineEnd);
    }
    delimiter ??= detectDelimiter(firstLine);
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new ImportError('The CSV delimiter must be a single character other than a quote or a line break.', 'csv_invalid_delimiter');
    }
    options.onDelimiter?.(delimiter);
    const started = new Tokenizer(delimiter.charCodeAt(0), maxRecordChars);
    started.push(rest, out);
    pending = '';
    return started;
  };

  let tokenizer: Tokenizer | null = null;
  for await (const text of decodeText(stream, options.onBytes)) {
    if (tokenizer === null) {
      pending += text;
      tokenizer = begin(false);
    } else {
      tokenizer.push(text, out);
    }
    if (out.length > 0) {
      yield* out;
      out.length = 0;
    }
  }

  tokenizer ??= begin(true);
  tokenizer?.end(out);
  yield* out;
}

/**
 * Reads only the first records of a file (header and a few sample rows) and stops,
 * so a preview of a very large file costs one chunk.
 */
export async function readCsvHead(
  blob: Blob,
  maxRecords: number,
  options: Pick<CsvOptions, 'delimiter' | 'maxRecordChars'> = {},
): Promise<{ records: CsvRecord[]; delimiter: string }> {
  const records: CsvRecord[] = [];
  let delimiter = options.delimiter ?? ',';
  const stream = blob.stream() as ReadableStream<Uint8Array>;
  for await (const record of readCsv(stream, { ...options, onDelimiter: (d) => (delimiter = d) })) {
    records.push(record);
    if (records.length >= maxRecords) break;
  }
  return { records, delimiter };
}
