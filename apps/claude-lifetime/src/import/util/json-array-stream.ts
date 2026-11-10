import { ImportError } from '@/core/types';

/**
 * Yields the elements of a top-level JSON array one at a time from a byte stream.
 *
 * A claude.ai export is a single-line `conversations.json` that can reach a
 * gigabyte, far beyond what JSON.parse (or a JavaScript string) can hold. This
 * scanner only tracks string/escape state and nesting depth at byte level to find
 * where each element ends, then parses that element on its own, so memory use is
 * bounded by the largest single element. UTF-8 safe: structural characters are
 * ASCII and never occur inside a multi-byte sequence.
 */
export interface JsonArrayStreamOptions {
  /** Called with every raw chunk (progress, hashing). */
  onBytes?: (chunk: Uint8Array) => void;
  /** Called once at the end; `truncated` is true when the input stopped before the closing bracket. */
  onEnd?: (info: { truncated: boolean; elements: number }) => void;
  /** Upper bound for a single element, in bytes. */
  maxElementBytes?: number;
}

const WS = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

export async function* iterateJsonArray(
  stream: ReadableStream<Uint8Array>,
  options: JsonArrayStreamOptions = {},
): AsyncGenerator<unknown> {
  const maxElementBytes = options.maxElementBytes ?? 768 * 1024 * 1024;
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();

  let opened = false; // saw the opening '['
  let closed = false; // saw the matching ']'
  let elements = 0;

  // state of the element being captured
  let capturing = false;
  let kind: 'nested' | 'string' | 'scalar' = 'nested';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pieces: Uint8Array[] = [];
  let pieceBytes = 0;

  const finish = (): unknown => {
    let buf: Uint8Array;
    if (pieces.length === 1) buf = pieces[0];
    else {
      buf = new Uint8Array(pieceBytes);
      let o = 0;
      for (const p of pieces) {
        buf.set(p, o);
        o += p.length;
      }
    }
    pieces = [];
    pieceBytes = 0;
    capturing = false;
    elements++;
    try {
      return JSON.parse(decoder.decode(buf));
    } catch (err) {
      throw new ImportError(
        `Record ${elements} of the JSON file could not be read (${err instanceof Error ? err.message : 'invalid JSON'}).`,
        'invalid_json',
      );
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      options.onBytes?.(value);
      const n = value.length;
      let i = 0;
      let start = 0; // start of the current element inside this chunk

      while (i < n) {
        if (closed) {
          i = n; // ignore anything after the array
          break;
        }
        if (!opened) {
          const c = value[i++];
          // whitespace or a UTF-8 byte order mark (EF BB BF, possibly split across chunks)
          if (WS(c) || c === 0xef || c === 0xbb || c === 0xbf) continue;
          if (c !== 0x5b) {
            throw new ImportError(
              'This JSON file does not contain a list of records at the top level, so it is not a conversations export.',
              'not_a_json_array',
            );
          }
          opened = true;
          continue;
        }
        if (!capturing) {
          const c = value[i];
          if (WS(c) || c === 0x2c) {
            i++;
            continue;
          }
          if (c === 0x5d) {
            closed = true;
            i++;
            continue;
          }
          capturing = true;
          start = i;
          depth = 0;
          inString = false;
          escaped = false;
          kind = c === 0x7b || c === 0x5b ? 'nested' : c === 0x22 ? 'string' : 'scalar';
          if (kind === 'string') {
            inString = true;
            i++;
          }
          continue;
        }

        // inside an element
        let ended = false;
        if (kind === 'scalar') {
          while (i < n) {
            const c = value[i];
            if (c === 0x2c || c === 0x5d || WS(c)) {
              ended = true;
              break;
            }
            i++;
          }
        } else {
          while (i < n) {
            const c = value[i];
            if (inString) {
              if (escaped) escaped = false;
              else if (c === 0x5c) escaped = true;
              else if (c === 0x22) {
                inString = false;
                if (kind === 'string') {
                  i++;
                  ended = true;
                  break;
                }
              }
              i++;
              continue;
            }
            if (c === 0x22) inString = true;
            else if (c === 0x7b || c === 0x5b) depth++;
            else if (c === 0x7d || c === 0x5d) {
              depth--;
              if (depth === 0) {
                i++;
                ended = true;
                break;
              }
            }
            i++;
          }
        }

        if (ended) {
          pieces.push(value.subarray(start, i));
          pieceBytes += i - start;
          yield finish();
        }
      }

      if (capturing && start < n) {
        // element continues in the next chunk
        pieces.push(value.subarray(start, n));
        pieceBytes += n - start;
        if (pieceBytes > maxElementBytes) {
          throw new ImportError('A single record in this file is too large to process in the browser.', 'element_too_large');
        }
      }
    }

    if (!opened) {
      throw new ImportError('The file is empty.', 'empty_file');
    }
    // A scalar that ran to the end of input without a delimiter still counts.
    if (capturing && kind === 'scalar' && pieceBytes > 0) yield finish();
    options.onEnd?.({ truncated: !closed || capturing, elements });
  } finally {
    reader.releaseLock();
  }
}
