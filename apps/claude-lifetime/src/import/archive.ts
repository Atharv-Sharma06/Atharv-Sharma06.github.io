import { ImportError, type ImportFile } from '@/core/types';
import { looksLikeZip, openZipEntry, readZipDirectory, unsupportedMethod, type ZipEntry } from './util/zip';

/**
 * ZIP archives in a selection, opened up: every file the app can read inside one takes the
 * archive's place, as if the archive had been unpacked and its files chosen. Runs inside the
 * import worker, the same way before detection and before parsing, so the positions detection
 * returns name the same files when the page asks for them to be read.
 *
 * Nothing is unpacked here. An entry's bytes are inflated when a reader asks for them: a Claude
 * Code transcript is streamed once from start to end, the beginning of a file is inflated only as
 * far as it is looked at, and a file that is read at random places is inflated once and kept.
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

/** One entry's bytes, inflated on demand and kept once a reader needed them at random places. */
class EntryBytes {
  private whole: Promise<Blob> | null = null;

  constructor(
    private readonly archive: Blob,
    readonly entry: ZipEntry,
  ) {}

  get unpacked(): boolean {
    return this.whole !== null;
  }

  stream(): ReadableStream<Uint8Array> {
    const whole = this.whole;
    return whole ? opening(async () => (await whole).stream() as ReadableStream<Uint8Array>) : opening(() => openZipEntry(this.archive, this.entry));
  }

  blob(): Promise<Blob> {
    this.whole ??= new Response(opening(() => openZipEntry(this.archive, this.entry))).blob();
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
    if (this.start === 0 && this.end === this.bytes.entry.uncompressedSize) return this.bytes.stream();
    return opening(async () => (await this.bytes.blob()).slice(this.start, this.end).stream() as ReadableStream<Uint8Array>);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    // The beginning of an entry is inflated only as far as it is read, unless the whole entry is at hand already.
    if (this.start === 0 && !this.bytes.unpacked) return prefix(this.bytes.stream(), this.size);
    return (await this.bytes.blob()).slice(this.start, this.end).arrayBuffer();
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
  if (useful.length === 0) {
    // Detection names what the archive holds.
    out.push(file);
    return;
  }
  const archive = file.archive ?? file.name;
  const within = file.path ?? file.name;
  for (const { entry, path } of useful) {
    if (entry.encrypted) {
      throw new ImportError(`"${entry.name}" in "${file.name}" is password-protected. Remove the password from the archive and try again.`, 'zip_encrypted');
    }
    if (entry.method !== 0 && entry.method !== 8) throw unsupportedMethod(entry);
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
    if (/\.zip$/i.test(name)) {
      // An archive inside the archive needs to be read at random places: it is inflated whole and opened in turn.
      const inner = await bytes.blob();
      await expandOne({ ...unpacked, blob: inner, size: inner.size }, depth + 1, true, out);
    } else out.push(unpacked);
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
