/**
 * Reads a byte stream line by line without holding the whole input in memory.
 * Handles \n and \r\n, a missing final newline, and multi-byte characters split
 * across chunks. `onBytes` reports raw chunks (for progress and hashing).
 *
 * A line can be far longer than a chunk (a transcript row that carries an image is
 * megabytes of base64). Each chunk is searched for a line feed on its own and the
 * unfinished line is kept as a list of pieces that is joined once, when the line
 * ends: appending to one growing string and searching it again from the start for
 * every chunk takes time that grows with the square of the line's length.
 */
export async function* readLines(
  stream: ReadableStream<Uint8Array>,
  onBytes?: (chunk: Uint8Array) => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let pieces: string[] = [];
  const line = (last: string): string => {
    let text = last;
    if (pieces.length > 0) {
      pieces.push(last);
      text = pieces.join('');
      pieces = [];
    }
    return text.endsWith('\r') ? text.slice(0, -1) : text;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes?.(value);
      const text = decoder.decode(value, { stream: true });
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl === -1) break;
        yield line(text.slice(start, nl));
        start = nl + 1;
      }
      if (start < text.length) pieces.push(start === 0 ? text : text.slice(start));
    }
    const tail = decoder.decode();
    if (tail.length > 0) pieces.push(tail);
    if (pieces.length > 0) {
      const rest = line('');
      if (rest.length > 0) yield rest;
    }
  } finally {
    reader.releaseLock();
  }
}
