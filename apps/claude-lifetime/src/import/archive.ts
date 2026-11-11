import { ImportError, type ImportFile } from '@/core/types';
import { entryData, looksLikeZip, openZipEntry, readZipDirectory, type ZipEntry } from './util/zip';

/**
 * ZIP archives in a selection, opened up: every file the app can read inside one takes the
 * archive's place, as if the archive had been unpacked and its files chosen. Runs inside the
 * import worker, the same way before detection and before parsing, so the positions detection
 * returns name the same files when the page asks for them to be read.
 *
 * Nothing is unpacked here. An entry's bytes are inflated when a reader asks for them: a Claude
 * Code transcript is streamed once from start to end, the beginning of a file is inflated only as
 * far as it is looked at, and a file that is read at random places is inflated once and kept. An
 * archive inside an archive is read in place when it is stored, and inflated whole otherwise.
 *
 * A claude.ai export stays a ZIP: its reader already streams conversations.json out of it, and its
 * import is named after the archive.
 */

/** The files a dropped folder keeps; anything else in an archive is left out as well. */
const USEFUL = /\.(jsonl|json|csv|tsv|zip)$|\.jsonl\.superseded-/i;
/** Folders of no use to any reader, as for a dropped folder, and the copies macOS adds to archives it makes. */
const SKIP_DIRECTORIES = new Set(['tool-results', 'mcp-tasks', 'node_modules', '.git', '__macosx']);
/** At most this many files are taken from one selection's archives, as from a dropped folder. */
export const MAX_ARCHIVE_FILES = 200_000;
/** Archives inside archives are opened up to this depth (an export's parts inside the download, for example). */
const MAX_DEPTH = 2;
/** In a selection of up to this many files, each is checked for a ZIP signature whatever its name. */
const SNIFF_ALL_UP_TO = 200;

const EXPORT_FILE = /^conversations(?:[-_.]\d+)?\.json$/i;
/**
 * The other files of a claude.ai export: users.json, projects.json and memories.json of the single-ZIP
 * export, and the parts a manifest lists besides the conversations (users.json and login_history.json,
 * projects/<uuid>.json, memories/<account>.json, reflections/<account>.json). A part of an export that
 * holds only these is not opened (see isExportPart).
 */
const EXPORT_SIDE_FILE = /^(?:users|projects|memories|login_history)(?:[-_.]\d+)?\.json$/i;
const EXPORT_SIDE_FOLDER = /^(?:[^/]+\/)?(?:projects|memories|reflections)\/[^/]+\.json$/i;

/**
 * An entry's name as a path: forward slashes, no drive letter or leading slash, and no "." or ".."
 * steps, so that a name can neither climb out of the archive nor be written two ways.
 */
export function entryPath(name: string): string {
  return name
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}

/** Whether an entry (by its path, see entryPath) holds a file a reader may want. */
export function isReadableEntry(path: string): boolean {
  const segments = path.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (base === '' || base.startsWith('._') || !USEFUL.test(base)) return false;
  return !segments.slice(0, -1).some((s) => SKIP_DIRECTORIES.has(s.toLowerCase()));
}

/**
 * Whether the readable files of an archive (by their paths) are only the side files of a claude.ai
 * export: a part of an export that arrived in several, without its conversations. It is left a ZIP,
 * so that detection can say to choose the part with the conversations, and so that a projects part
 * with hundreds of files does not count as hundreds of files.
 */
export function isExportPart(readable: readonly string[]): boolean {
  return readable.length > 0 && readable.every((path) => EXPORT_SIDE_FILE.test(path.split('/').pop() ?? '') || EXPORT_SIDE_FOLDER.test(path));
}

/** A stream that is opened on its first read. */
function opening(open: () => Promise<ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= (await open()).getReader();
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

/** The first `length` bytes of a stream; the rest is not read. */
async function prefix(stream: ReadableStream<Uint8Array>, length: number): Promise<ArrayBuffer> {
  const out = new Uint8Array(length);
  let filled = 0;
  const reader = stream.getReader();
  try {
    while (filled < length) {
      const next = await reader.read();
      if (next.done) break;
      const take = Math.min(next.value.length, length - filled);
      out.set(next.value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.buffer.slice(0, filled);
}

/** The bytes of a stream from `start` to `end`. Those before `start` are read and dropped; the rest is not read. */
function window(source: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let at = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (at >= end) {
          controller.close();
          await reader.cancel().catch(() => undefined);
          return;
        }
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        const from = at;
        at += next.value.length;
        if (at <= start) continue;
        controller.enqueue(next.value.subarray(Math.max(0, start - from), Math.min(next.value.length, end - from)));
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * A stream collected into a Blob. Response.blob() does that without holding every chunk at once, but in
 * Chromium it rejects with "Failed to fetch" when the stream fails, so the stream's own error is kept and
 * thrown instead: it names the entry and says what is wrong with it.
 */
async function collect(open: () => Promise<ReadableStream<Uint8Array>>): Promise<Blob> {
  let failure: { error: unknown } | null = null;
  const source = opening(open);
  const reader = source.getReader();
  const watched = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        failure = { error };
        throw error;
      }
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  try {
    return await new Response(watched).blob();
  } catch (error) {
    throw failure === null ? error : (failure as { error: unknown }).error;
  }
}

/** Where the last forward read of an entry stopped: an open stream of the entry and the bytes of it not yet used. */
interface Cursor {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Position in the entry of the first byte of `rest`. */
  at: number;
  rest: Uint8Array;
}

/**
 * One entry's bytes, inflated on demand. A read from the start inflates only as far as it reaches. Reads
 * that move forward through the entry, as detection makes them along a long first line, continue one
 * stream. Only a read that goes back has the whole entry inflated, and that is then kept.
 */
class EntryBytes {
  private whole: Promise<Blob> | null = null;
  private cursor: Cursor | null = null;
  /** Reads take turns, so that two of them never move the cursor at once. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly archive: Blob,
    readonly entry: ZipEntry,
  ) {}

  get unpacked(): boolean {
    return this.whole !== null;
  }

  /** The bytes from `start` to `end` as a stream, which inflates only as far as it is read. */
  stream(start: number, end: number): ReadableStream<Uint8Array> {
    const whole = this.whole;
    if (whole) return opening(async () => (await whole).slice(start, end).stream() as ReadableStream<Uint8Array>);
    const open = () => openZipEntry(this.archive, this.entry);
    if (start === 0 && end >= this.entry.uncompressedSize) return opening(open);
    return opening(async () => window(await open(), start, end));
  }

  /** The bytes from `start` to `end`. */
  read(start: number, end: number): Promise<ArrayBuffer> {
    const result = this.turn.then(() => this.readNow(start, end));
    this.turn = result.catch(() => undefined);
    return result;
  }

  private async readNow(start: number, end: number): Promise<ArrayBuffer> {
    if (this.whole) return (await this.whole).slice(start, end).arrayBuffer();
    if (start === 0) return prefix(this.stream(0, end), end);
    if (this.cursor !== null && this.cursor.at > start) {
      // A read that goes back: the entry is wanted at random places.
      await this.cursor.reader.cancel().catch(() => undefined);
      this.cursor = null;
      return (await this.blob()).slice(start, end).arrayBuffer();
    }
    try {
      this.cursor ??= { reader: (await openZipEntry(this.archive, this.entry)).getReader(), at: 0, rest: new Uint8Array(0) };
      const c = this.cursor;
      const out = new Uint8Array(end - start);
      let filled = 0;
      while (filled < out.length) {
        if (c.rest.length === 0) {
          const next = await c.reader.read();
          if (next.done) break;
          c.rest = next.value;
        }
        const wanted = start + filled;
        const used = c.at < wanted ? Math.min(c.rest.length, wanted - c.at) : Math.min(c.rest.length, out.length - filled);
        if (c.at >= wanted) {
          out.set(c.rest.subarray(0, used), filled);
          filled += used;
        }
        c.rest = c.rest.subarray(used);
        c.at += used;
      }
      return out.buffer.slice(0, filled);
    } catch (error) {
      this.cursor = null;
      throw error;
    }
  }

  /** The whole entry, inflated once and kept. */
  blob(): Promise<Blob> {
    this.whole ??= collect(() => openZipEntry(this.archive, this.entry)).catch((error: unknown) => {
      this.whole = null;
      throw error;
    });
    return this.whole;
  }
}

/** Where a slice of `size` bytes starts and ends, by the rules of Blob.slice. */
function range(size: number, start = 0, end = size): [number, number] {
  const at = (v: number) => (v < 0 ? Math.max(size + v, 0) : Math.min(v, size));
  const from = at(start);
  return [from, Math.max(from, at(end))];
}

/**
 * The part of a Blob the readers use (size, slice, stream, text, arrayBuffer), over an entry in an
 * archive. It exists only inside the worker: unlike a real Blob it cannot be posted.
 */
class EntryBlob {
  readonly type = '';

  constructor(
    private readonly bytes: EntryBytes,
    private readonly start: number,
    private readonly end: number,
  ) {}

  get size(): number {
    return this.end - this.start;
  }

  slice(start?: number, end?: number): EntryBlob {
    const [from, to] = range(this.size, start, end);
    return new EntryBlob(this.bytes, this.start + from, this.start + to);
  }

  stream(): ReadableStream<Uint8Array> {
    return this.bytes.stream(this.start, this.end);
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.read(this.start, this.end);
  }

  async text(): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.arrayBuffer());
  }
}

/** Whether the file starts with a ZIP signature. Files too small to be an archive are not looked at. */
async function isZip(file: ImportFile, sniffAll: boolean): Promise<boolean> {
  if (file.size < 22 || !(sniffAll || /\.zip$/i.test(file.name))) return false;
  return looksLikeZip(new Uint8Array(await file.blob.slice(0, 4).arrayBuffer()));
}

/**
 * An archive inside the archive, as a Blob that can be read at random places. A stored one is a part of
 * the outer archive and is read in place; a compressed one is inflated whole. Null when it cannot be had:
 * it is then passed on unopened, and reading it says why.
 */
async function nestedArchive(outer: Blob, entry: ZipEntry, bytes: EntryBytes): Promise<Blob | null> {
  if (entry.encrypted || (entry.method !== 0 && entry.method !== 8)) return null;
  try {
    if (entry.method === 0 && entry.compressedSize === entry.uncompressedSize) return await entryData(outer, entry);
    return await bytes.blob();
  } catch {
    return null;
  }
}

async function expandOne(file: ImportFile, depth: number, sniffAll: boolean, out: ImportFile[]): Promise<void> {
  let entries: ZipEntry[];
  try {
    if (depth >= MAX_DEPTH || !(await isZip(file, sniffAll))) throw null;
    entries = await readZipDirectory(file.blob);
  } catch {
    // Not an archive, or one that cannot be listed: it is looked at as it is, and detection says what is wrong with it.
    out.push(file);
    return;
  }
  const files = entries.filter((e) => !e.isDirectory).map((entry) => ({ entry, path: entryPath(entry.name) }));
  if (files.some((f) => EXPORT_FILE.test(f.path.split('/').pop() ?? ''))) {
    out.push(file);
    return;
  }
  const useful = files.filter((f) => isReadableEntry(f.path));
  if (useful.length === 0 || isExportPart(useful.map((f) => f.path))) {
    // Detection names what the archive holds.
    out.push(file);
    return;
  }
  const archive = file.archive ?? file.name;
  const within = file.path ?? file.name;
  for (const { entry, path } of useful) {
    // An entry with a password or a compression method that cannot be unpacked is passed on all the same. Reading it
    // fails with a message that names it, which matters only when it is read: a stray archive in a folder is not.
    const name = path.split('/').pop() ?? path;
    const bytes = new EntryBytes(file.blob, entry);
    const unpacked: ImportFile = {
      name,
      path: `${within}/${path}`,
      size: entry.uncompressedSize,
      lastModified: entry.lastModified,
      blob: new EntryBlob(bytes, 0, entry.uncompressedSize) as unknown as Blob,
      archive,
    };
    const inner = /\.zip$/i.test(name) && depth + 1 < MAX_DEPTH ? await nestedArchive(file.blob, entry, bytes) : null;
    if (inner) await expandOne({ ...unpacked, blob: inner, size: inner.size }, depth + 1, true, out);
    else out.push(unpacked);
    if (out.length > MAX_ARCHIVE_FILES) {
      throw new ImportError(
        `"${file.name}" holds more than ${MAX_ARCHIVE_FILES.toLocaleString('en-US')} files. Unpack it and choose the folder you need instead.`,
        'too_many_files',
      );
    }
  }
}

/** The ZIP archive all of the files come from, or undefined when they do not all come from the same one. */
export function sameArchive(files: readonly Pick<ImportFile, 'archive'>[]): string | undefined {
  const archive = files[0]?.archive;
  return files.every((f) => f.archive === archive) ? archive : undefined;
}

/**
 * The name an import is listed under: the name of the file that was read, or how many files were
 * read. When the selection came from one ZIP archive, the archive's name comes first: it is what was chosen.
 */
export function importFileName(read: readonly { name: string }[], archive: string | undefined, kind = 'files'): string {
  const own = read.length === 1 ? read[0].name : `${read.length.toLocaleString('en-US')} ${kind}`;
  return archive === undefined ? own : `${archive} (${own})`;
}

/** The selection with every ZIP archive (other than a claude.ai export) replaced by the files in it. */
export async function expandArchives(files: ImportFile[]): Promise<ImportFile[]> {
  const out: ImportFile[] = [];
  const sniffAll = files.length <= SNIFF_ALL_UP_TO;
  for (const file of files) await expandOne(file, 0, sniffAll, out);
  return out;
}
