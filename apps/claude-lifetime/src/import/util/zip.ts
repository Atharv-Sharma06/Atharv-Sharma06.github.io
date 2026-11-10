import { ImportError } from '@/core/types';

/**
 * Minimal ZIP reader for large archives.
 *
 * It never loads the archive into memory: the central directory is read from the
 * end of the Blob (random access), and an entry is streamed by slicing its byte
 * range and inflating it with the platform's DecompressionStream. ZIP64 is
 * supported (entries or archives over 4 GB, more than 65,535 entries). Works the
 * same on a browser File and a Node Blob.
 */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate */
  method: number;
  localHeaderOffset: number;
  encrypted: boolean;
  isDirectory: boolean;
  /** When the entry was last changed, epoch milliseconds, if the archive says. */
  lastModified?: number;
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function looksLikeZip(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06);
}

/**
 * The MS-DOS date and time of an entry (local time, to two seconds), or undefined when it is unset or not a date.
 */
function dosTime(date: number, time: number): number | undefined {
  if (date === 0) return undefined;
  const year = 1980 + (date >> 9);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  if (month < 1 || month > 12 || day < 1) return undefined;
  const at = new Date(year, month - 1, day, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();
  return Number.isFinite(at) ? at : undefined;
}

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

const u64 = (view: DataView, offset: number): number => {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ImportError('The ZIP archive is larger than this app can address.', 'zip_too_large');
  return Number(value);
};

export async function readZipDirectory(blob: Blob): Promise<ZipEntry[]> {
  const size = blob.size;
  if (size < 22) throw new ImportError('This file is too small to be a ZIP archive.', 'not_a_zip');
  const tailStart = Math.max(0, size - (22 + 0xffff));
  const tail = await bytes(blob, tailStart, size);

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ImportError(
      'This does not look like a complete ZIP archive (its directory is missing). The download may have been cut short; download the file again, or make the archive again.',
      'not_a_zip',
    );
  }

  let entryCount = tail.getUint16(eocd + 10, true);
  let directorySize = tail.getUint32(eocd + 12, true);
  let directoryOffset = tail.getUint32(eocd + 16, true);

  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorAt = tailStart + eocd - 20;
    if (locatorAt < 0) throw new ImportError('The ZIP64 directory of this archive is damaged.', 'zip_corrupt');
    const locator = await bytes(blob, locatorAt, locatorAt + 20);
    if (locator.getUint32(0, true) !== EOCD64_LOCATOR) throw new ImportError('The ZIP64 directory of this archive is damaged.', 'zip_corrupt');
    const recordAt = u64(locator, 8);
    const record = await bytes(blob, recordAt, recordAt + 56);
    if (record.getUint32(0, true) !== EOCD64) throw new ImportError('The ZIP64 directory of this archive is damaged.', 'zip_corrupt');
    entryCount = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
  }

  if (directoryOffset + directorySize > size) {
    throw new ImportError('The ZIP archive is incomplete: its directory points past the end of the file. Download the file again, or make the archive again.', 'zip_truncated');
  }

  const dir = await bytes(blob, directoryOffset, directoryOffset + directorySize);
  const utf8 = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < entryCount && p + 46 <= dir.byteLength; n++) {
    if (dir.getUint32(p, true) !== CENTRAL) throw new ImportError('The ZIP directory is damaged.', 'zip_corrupt');
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    let lastModified = dosTime(dir.getUint16(p + 14, true), dir.getUint16(p + 12, true));
    let compressedSize = dir.getUint32(p + 20, true);
    let uncompressedSize = dir.getUint32(p + 24, true);
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const commentLength = dir.getUint16(p + 32, true);
    let localHeaderOffset = dir.getUint32(p + 42, true);
    const name = utf8.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength));

    // ZIP64 extended information: present values replace the 0xFFFFFFFF placeholders, in this fixed order.
    let x = p + 46 + nameLength;
    const extraEnd = x + extraLength;
    while (x + 4 <= extraEnd) {
      const id = dir.getUint16(x, true);
      const len = dir.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(dir, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(dir, q); q += 8; }
        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = u64(dir, q); q += 8; }
      } else if (id === 0x5455 && len >= 5 && x + 9 <= extraEnd && (dir.getUint8(x + 4) & 1) !== 0) {
        // Extended timestamp: the modification time in UTC seconds, more exact than the MS-DOS one.
        lastModified = dir.getUint32(x + 5, true) * 1000;
      }
      x += 4 + len;
    }

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
      encrypted: (flags & 1) !== 0,
      isDirectory: name.endsWith('/'),
      lastModified,
    });
    p = extraEnd + commentLength;
  }
  return entries;
}

/** A stream of the entry's uncompressed bytes. */
export async function openZipEntry(blob: Blob, entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
  if (entry.encrypted) {
    throw new ImportError(`"${entry.name}" is password-protected. Remove the password from the archive and try again.`, 'zip_encrypted');
  }
  const header = await bytes(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL) {
    throw new ImportError(`The ZIP archive is damaged near "${entry.name}".`, 'zip_corrupt');
  }
  const dataStart = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > blob.size) {
    throw new ImportError(`The ZIP archive ends in the middle of "${entry.name}". Download the file again, or make the archive again.`, 'zip_truncated');
  }
  const raw = blob.slice(dataStart, dataEnd).stream() as ReadableStream<Uint8Array>;
  if (entry.method === 0) return checked(raw, entry);
  if (entry.method === 8) {
    return checked(raw.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), entry);
  }
  throw unsupportedMethod(entry);
}

/** Entries this reader cannot unpack, refused when they are opened. */
export function unsupportedMethod(entry: ZipEntry): ImportError {
  return new ImportError(
    `"${entry.name}" uses a ZIP compression method (${entry.method}) this app cannot read. Extract the archive and choose the extracted files instead.`,
    'zip_unsupported_compression',
  );
}

/**
 * The entry's bytes, held to the size the archive's directory gives for it. An entry that unpacks to more or to
 * less is damaged (or made to look small), and a stream the platform cannot inflate fails with a message that says
 * which entry it was, not with the platform's own error.
 */
function checked(source: ReadableStream<Uint8Array>, entry: ZipEntry): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  const damaged = (details: string) => new ImportError(`"${entry.name}" in the ZIP archive is damaged and could not be unpacked.`, 'zip_corrupt', details);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        throw error instanceof ImportError ? error : damaged(error instanceof Error ? error.message : String(error));
      }
      if (next.done) {
        if (seen !== entry.uncompressedSize) throw damaged(`${seen} bytes unpacked, the archive lists ${entry.uncompressedSize}`);
        controller.close();
        return;
      }
      seen += next.value.length;
      if (seen > entry.uncompressedSize) {
        await reader.cancel().catch(() => undefined);
        throw damaged(`more than the ${entry.uncompressedSize} bytes the archive lists`);
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
