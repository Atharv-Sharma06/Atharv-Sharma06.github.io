import { ImportError } from '@/core/types';
import { decodeText } from '../util/csv';
import { iterateJsonArray } from '../util/json-array-stream';

/**
 * Reads the top-level values of a JSON file whatever way it was saved:
 *
 *  - one array            `[ {...}, {...} ]`    each element is a value
 *  - JSON Lines           one value per line
 *  - one document         `{ ... }`, compact or pretty-printed
 *
 * Arrays and JSON Lines are streamed, so only one value is in memory at a time. A
 * single document has to be held whole; that is fine for API responses, and large
 * record sets should be saved as an array or as JSON Lines.
 */
export interface JsonInputInfo {
  layout: 'array' | 'lines' | 'document' | null;
  /** The file ended before its top-level array was closed (a download that was cut off). */
  truncated: boolean;
}

export function newJsonInputInfo(): JsonInputInfo {
  return { layout: null, truncated: false };
}

const invalidJson = (what: string, err: unknown): ImportError => {
  const detail = err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 160) : 'invalid JSON';
  return new ImportError(
    `${what} is not valid JSON (${detail}). If the file was cut off while it was downloaded or copied, save it again.`,
    'invalid_json',
  );
};

/** True when the first character of the file opens an array (UTF-8 only). */
async function startsWithArray(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  // UTF-16 (a file written by Windows PowerShell's ">") goes through the text decoder instead.
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return false;
  for (const b of head) {
    // white space and the three bytes of a UTF-8 byte order mark
    if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0xef || b === 0xbb || b === 0xbf) continue;
    return b === 0x5b;
  }
  return false;
}

/** Lines of a text stream. Only the newly decoded text is searched, so one huge line stays linear. */
async function* textLines(stream: ReadableStream<Uint8Array>, onBytes: (chunk: Uint8Array) => void): AsyncGenerator<string> {
  let parts: string[] = [];
  for await (const text of decodeText(stream, onBytes)) {
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) break;
      parts.push(text.slice(start, nl));
      yield parts.length === 1 ? parts[0] : parts.join('');
      parts = [];
      start = nl + 1;
    }
    if (start < text.length) parts.push(text.slice(start));
  }
  if (parts.length > 0) yield parts.join('');
}

export async function* readJsonValues(
  blob: Blob,
  onBytes: (chunk: Uint8Array) => void,
  info: JsonInputInfo = newJsonInputInfo(),
): AsyncGenerator<unknown> {
  if (blob.size === 0) throw new ImportError('The file is empty.', 'empty_file');

  if (await startsWithArray(blob)) {
    info.layout = 'array';
    yield* iterateJsonArray(blob.stream() as ReadableStream<Uint8Array>, {
      onBytes,
      onEnd: (end) => {
        if (end.truncated) info.truncated = true;
      },
    });
    return;
  }

  // Either one value per line, or one document spread over many lines. The first
  // line decides: a pretty-printed document never has a complete value on line one.
  let mode: 'undecided' | 'lines' | 'document' = 'undecided';
  const document: string[] = [];
  let lineNumber = 0;
  let values = 0;
  for await (const line of textLines(blob.stream() as ReadableStream<Uint8Array>, onBytes)) {
    lineNumber++;
    if (mode === 'document') {
      document.push(line);
      continue;
    }
    const text = line.trim();
    if (text === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      if (mode === 'lines') throw invalidJson(`Line ${lineNumber} of the file`, err);
      mode = 'document';
      document.push(line);
      continue;
    }
    mode = 'lines';
    values++;
    yield value;
  }

  if (mode === 'undecided') throw new ImportError('The file is empty.', 'empty_file');
  if (mode === 'lines') {
    // A single line is also what a compact document looks like.
    info.layout = values === 1 ? 'document' : 'lines';
    return;
  }
  info.layout = 'document';
  let value: unknown;
  try {
    value = JSON.parse(document.join('\n'));
  } catch (err) {
    throw invalidJson('The file', err);
  }
  yield value;
}
