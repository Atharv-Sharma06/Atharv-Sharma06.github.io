/**
 * What a plain (not passphrase-protected) backup file looks like. A backup is the
 * database's data directory as a gzip-compressed tar archive.
 */

/** A plain backup is a gzip stream; anything else is turned away before the user is asked to confirm a restore. */
export async function looksLikeGzip(file: Blob): Promise<boolean> {
  if (file.size < 18) return false;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * Whether a plain backup really is a dump of a database: a gzip-compressed tar archive
 * with a PG_VERSION entry at its root, which every PostgreSQL data directory has.
 *
 * Picking some other .tar.gz by mistake is easy, and the database engine does not
 * fail cleanly on one, so such a file is turned away before the user is asked to
 * confirm. The check only reads the archive's file names. It never turns away a file
 * it cannot look into: where the browser has no gzip decoder, restoring decides.
 */
export async function looksLikeDatabaseDump(file: Blob): Promise<boolean> {
  if (!(await looksLikeGzip(file))) return false;
  if (typeof DecompressionStream === 'undefined') return true;
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const latin1 = new TextDecoder('latin1');
  const field = (block: Uint8Array, start: number, length: number) => latin1.decode(block.subarray(start, start + length)).split('\0')[0];
  let pending: Uint8Array = new Uint8Array(0);
  // Bytes of the current entry's content (padded to whole 512-byte blocks) that are still to be passed over.
  let skip = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      if (skip >= value.length) {
        skip -= value.length;
        continue;
      }
      const chunk = value.subarray(skip);
      skip = 0;
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      pending = joined;
      while (pending.length >= 512) {
        const header = pending.subarray(0, 512);
        // Two empty blocks end an archive; a size that is not an octal number means this is no tar header.
        if (header.every((byte) => byte === 0)) return false;
        const size = field(header, 124, 12).trim();
        if (!/^[0-7]*$/.test(size)) return false;
        if (field(header, 0, 100).replace(/^\.?\//, '') === 'PG_VERSION') return true;
        const content = Math.ceil(parseInt(size || '0', 8) / 512) * 512;
        const rest = pending.subarray(512);
        if (content >= rest.length) {
          skip = content - rest.length;
          pending = new Uint8Array(0);
        } else {
          pending = rest.subarray(content);
        }
      }
    }
  } catch {
    // not a complete gzip stream
    return false;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
