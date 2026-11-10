/**
 * Reads a byte stream line by line without holding the whole input in memory.
 * Handles \n and \r\n, a missing final newline, and multi-byte characters split
 * across chunks. `onBytes` reports raw chunks (for progress and hashing).
 */
export async function* readLines(
  stream: ReadableStream<Uint8Array>,
  onBytes?: (chunk: Uint8Array) => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes?.(value);
      pending += decoder.decode(value, { stream: true });
      let start = 0;
      for (;;) {
        const nl = pending.indexOf('\n', start);
        if (nl === -1) break;
        const end = nl > start && pending.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
        yield pending.slice(start, end);
        start = nl + 1;
      }
      if (start > 0) pending = pending.slice(start);
    }
    pending += decoder.decode();
    if (pending.length > 0) yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
  } finally {
    reader.releaseLock();
  }
}
