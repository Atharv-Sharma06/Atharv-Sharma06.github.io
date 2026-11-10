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

/** What a plain backup file turned out to be. */
export type BackupFileKind =
  /** A complete dump of a database. */
  | 'backup'
  /** The beginning of one: the file ends before the backup does, or is damaged. Typically a download or a copy that was cut off. */
  | 'cut_short'
  /** Anything else. */
  | 'other';

/** A file of a PostgreSQL data directory, by its path in the archive: the catalogs, the tables, the write-ahead log. */
const DATA_DIRECTORY_FILE = /^(?:base|global|pg_[a-z_]+)\//;

/**
 * Reads the names of the files in a gzip-compressed tar archive and says what the
 * archive is: a dump of a database has a PG_VERSION entry at its root, which every
 * PostgreSQL data directory has.
 *
 * With `whole`, the archive is read to its end, which also checks it: a file that was
 * cut off or damaged fails there (gzip ends with a checksum), and is called 'cut_short'
 * when what could be read are the files of a data directory. Without `whole`, reading
 * stops at PG_VERSION, and a file that is cut off after it passes as a backup.
 */
async function readArchive(file: Blob, whole: boolean): Promise<BackupFileKind> {
  if (!(await looksLikeGzip(file))) return 'other';
  // Never turns away a file it cannot look into: where the browser has no gzip decoder, restoring decides.
  if (typeof DecompressionStream === 'undefined') return 'backup';
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const latin1 = new TextDecoder('latin1');
  const field = (block: Uint8Array, start: number, length: number) => latin1.decode(block.subarray(start, start + length)).split('\0')[0];
  let pending: Uint8Array = new Uint8Array(0);
  // Bytes of the current entry's content (padded to whole 512-byte blocks) that are still to be passed over.
  let skip = 0;
  let hasVersion = false;
  let hasDataFiles = false;
  /** True once the archive's end, or something that is no tar header, was reached: the rest is only read through. */
  let parsed = false;
  let isTar = true;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return hasVersion && isTar ? 'backup' : 'other';
      if (parsed) continue;
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
        const size = field(header, 124, 12).trim();
        const ended = header.every((byte) => byte === 0);
        if (ended || !/^[0-7]*$/.test(size)) {
          if (!ended) isTar = false;
          if (!whole || !isTar) return hasVersion && isTar ? 'backup' : 'other';
          parsed = true;
          break;
        }
        const path = field(header, 0, 100).replace(/^\.?\//, '');
        if (path === 'PG_VERSION') {
          if (!whole) return 'backup';
          hasVersion = true;
        } else if (DATA_DIRECTORY_FILE.test(path)) {
          hasDataFiles = true;
        }
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
    // Not a complete gzip stream. What could be read of it says whether it was on its way to being a backup.
    return isTar && (hasVersion || hasDataFiles) ? 'cut_short' : 'other';
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * Whether a plain backup really is a dump of a database: a gzip-compressed tar archive
 * with a PG_VERSION entry at its root.
 *
 * Picking some other .tar.gz by mistake is easy, and the database engine does not
 * fail cleanly on one, so such a file is turned away before the user is asked to
 * confirm. The check only reads the archive's file names, and stops at PG_VERSION.
 */
export async function looksLikeDatabaseDump(file: Blob): Promise<boolean> {
  return (await readArchive(file, false)) === 'backup';
}

/**
 * What a file chosen for a restore is, read to its end: a complete backup, a backup
 * that was cut short or damaged, or something else. This is what tells a download that
 * broke off from a file that never was a backup, before the user is asked to confirm.
 */
export function inspectBackupFile(file: Blob): Promise<BackupFileKind> {
  return readArchive(file, true);
}
