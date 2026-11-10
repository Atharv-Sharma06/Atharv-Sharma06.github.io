import * as fs from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { deferInProgress, extractTranscripts, IN_PROGRESS_WINDOW_MS, ResponseFlag, transcriptPathInfo, type TranscriptSource } from './extract';
import { emptyLedger, LedgerError, mergeIntoLedger, parseLedger, serialiseLedger, type Ledger } from './ledger';

const { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } = fs;
/**
 * `fs.openAsBlob` exists from Node.js 19.8. It is read from the module object at run time: a named
 * import of something a Node version does not have stops the whole file from loading, before the
 * tool can say which version it needs.
 */
const openAsBlob: typeof fs.openAsBlob | undefined = fs.openAsBlob;

/**
 * The collector: reads Claude Code's transcripts on this computer and keeps a ledger
 * of their usage (see ledger.ts). Node only; this is the body of the CLI that is
 * bundled into public/tools/claude-lifetime-collect.mjs. It uses the same extraction
 * code as the in-browser importer and nothing but Node's built-in modules.
 *
 * It only ever reads below the config directories it is given, writes the ledger,
 * a list of the files it has read next to it (and the optional copy), and talks to no
 * network.
 *
 * A run reads the transcripts that are new or have changed since the last one, and saves
 * as it goes: about every half gigabyte the ledger and the list are written, so a run that
 * is cut short (a hook's time limit, a closed laptop) has still made progress and the
 * next one continues from there.
 */
export const COLLECTOR_VERSION = '1.0.0';

export type CollectErrorCode = 'nothing_found' | 'ledger_unreadable' | 'bad_arguments';

export class CollectError extends Error {
  constructor(
    message: string,
    readonly code: CollectErrorCode,
  ) {
    super(message);
    this.name = 'CollectError';
  }
}

export interface CollectOptions {
  /** Claude Code config directories to read (each holds `projects/`). Default: discovered, see findProjectsDirs. */
  dirs?: string[];
  /** Ledger to update. Default: ~/.claude-lifetime/claude-code-ledger.json */
  ledgerPath?: string;
  /** Also write a copy of the updated ledger here. */
  outPath?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** Epoch ms to treat as the current time. */
  now?: number;
  machine?: string;
  onProgress?: (progress: { bytesRead: number; totalBytes: number }) => void;
  /** Bytes of transcripts to read between two saves. */
  checkpointBytes?: number;
}

export interface Unreadable {
  path: string;
  /** The system's reason, for example "EACCES: permission denied". */
  reason: string;
}

export interface CollectResult {
  /** The `projects` directories that were scanned. */
  roots: string[];
  /** Transcripts that exist now. */
  transcriptFiles: number;
  /** Of those, the ones read in this run; the others have not changed since a run that read them. */
  filesRead: number;
  filesUnchanged: number;
  /** Folders that could not be opened, so whatever they hold was not collected. */
  foldersUnreadable: Unreadable[];
  /** Transcripts that could not be read to the end. What was read of them is in the ledger. */
  filesUnreadable: Unreadable[];
  bytesRead: number;
  malformedLines: number;
  /** Complete responses and prompts in the transcripts read in this run. */
  responsesFound: number;
  promptsFound: number;
  /** Still being written; left for the next run. */
  deferredInProgress: number;
  responsesAdded: number;
  responsesImproved: number;
  promptsAdded: number;
  /** Added responses whose final output count was never written (streaming snapshots). */
  partialAdded: number;
  /** Totals of the ledger after this run. */
  responses: number;
  prompts: number;
  sessions: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  ledgerPath: string;
  ledgerBytes: number;
  /** False when the ledger already held everything and was left as it was. */
  written: boolean;
  outPath: string | null;
}

export function defaultLedgerPath(home = homedir()): string {
  return join(home, '.claude-lifetime', 'claude-code-ledger.json');
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Where to look for transcripts.
 *  - `dirs` given: exactly those. Each is a config directory (its `projects/` is read)
 *    or, when it has no `projects/`, a folder of transcripts itself (a backup, say).
 *  - else every entry of $CLAUDE_CONFIG_DIR (comma-separated, a convention of usage
 *    tools; Claude Code itself documents a single directory) that contains `projects/`;
 *  - else ~/.claude and ($XDG_CONFIG_HOME or ~/.config)/claude, whichever contain `projects/`.
 * The same directory reached twice (symlinks) is read once.
 */
export function findProjectsDirs(dirs: string[] | undefined, env: Record<string, string | undefined>, home: string): string[] {
  const candidates: string[] = [];
  let tried: string[];
  if (dirs !== undefined && dirs.length > 0) {
    tried = dirs.map((d) => resolve(d));
    for (const dir of tried) {
      if (!isDirectory(dir)) throw new CollectError(`"${dir}" is not a directory.`, 'nothing_found');
      const projects = join(dir, 'projects');
      candidates.push(isDirectory(projects) ? projects : dir);
    }
  } else {
    const configured = (env.CLAUDE_CONFIG_DIR ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    tried = configured.length > 0 ? configured.map((d) => resolve(d)) : [join(home, '.claude'), join(env.XDG_CONFIG_HOME || join(home, '.config'), 'claude')];
    for (const dir of tried) {
      const projects = join(dir, 'projects');
      if (isDirectory(projects)) candidates.push(projects);
    }
  }
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const dir of candidates) {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // keep the path as given
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push(dir);
  }
  if (roots.length === 0) {
    throw new CollectError(
      `No Claude Code data found. Looked for a "projects" folder in: ${tried.join(', ')}.\n` +
        'If Claude Code keeps its files elsewhere, pass that folder with --dir.',
      'nothing_found',
    );
  }
  return roots;
}

interface FoundFile {
  abs: string;
  /** Path below the scanned `projects` directory, with forward slashes. */
  rel: string;
  size: number;
  mtimeMs: number;
}

/** Tool output kept next to transcripts; never transcripts, sometimes large. */
const SKIP_DIRS = new Set(['tool-results', 'mcp-tasks']);

/** "EACCES: permission denied" from Node's "EACCES: permission denied, scandir '/path'". */
function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/, \w+ '.*'$/, '');
}

const isMissing = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ENOENT';

function scan(dir: string, rel: string, out: FoundFile[], visited: Set<string>, unreadable: Unreadable[]): void {
  let real: string;
  let entries;
  try {
    real = realpathSync(dir);
    // Guards against symlink loops.
    if (visited.has(real)) return;
    visited.add(real);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A folder that is not there any more holds nothing; any other failure hides what it holds.
    if (!isMissing(err)) unreadable.push({ path: dir, reason: reasonOf(err) });
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    let stat;
    try {
      stat = statSync(abs);
    } catch (err) {
      // Deleted since the folder was listed, or a link to nothing.
      if (!isMissing(err)) unreadable.push({ path: abs, reason: reasonOf(err) });
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scan(abs, childRel, out, visited, unreadable);
    } else if (stat.isFile() && transcriptPathInfo(childRel).isTranscript) {
      out.push({ abs, rel: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
}

const MAX_REOPENS = 100;

/**
 * A byte source for a transcript that may be growing while it is read.
 *
 * `fs.openAsBlob` gives a Blob that refuses to be read once its file has changed, and
 * the transcript of a running session changes all the time. Transcripts are
 * append-only, so when a read is refused the file is reopened and reading continues
 * at the byte already reached. Reading stops at the size the file had when it was
 * found, which keeps the snapshot consistent and guarantees an end.
 */
export function appendTolerantSource(path: string, size: number): TranscriptSource['blob'] {
  return {
    stream(): ReadableStream<Uint8Array> {
      let offset = 0;
      let reopens = 0;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          for (;;) {
            if (offset >= size) return controller.close();
            try {
              if (reader === null) {
                const blob = await openAsBlob!(path);
                reader = (blob.slice(offset, size).stream() as unknown as ReadableStream<Uint8Array>).getReader();
              }
              const { done, value } = await reader.read();
              if (done) return controller.close();
              offset += value.length;
              return controller.enqueue(value);
            } catch (err) {
              reader = null;
              const refused = err instanceof Error && err.name === 'NotReadableError';
              if (!refused || ++reopens > MAX_REOPENS) throw err;
              // A Blob only says that it "could not be read". When the file cannot be opened at all
              // (no permission, deleted), opening it gives the real reason and there is nothing to retry.
              closeSync(openSync(path, 'r'));
            }
          }
        },
        async cancel() {
          await reader?.cancel().catch(() => undefined);
        },
      });
    },
  };
}

/** Writes to a temporary file in the same directory and renames it over the target, so a crash never leaves half a ledger. */
function writeAtomic(target: string, chunks: Iterable<string>): number {
  const dir = dirname(target);
  // The ledger names projects and session titles: keep a newly created folder private.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  let bytes = 0;
  const fd = openSync(temp, 'w', 0o600);
  try {
    for (const chunk of chunks) bytes += writeSync(fd, chunk);
    fsyncSync(fd);
    closeSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    rmSync(temp, { force: true });
    throw err;
  }
  renameSync(temp, target);
  return bytes;
}

function copyAtomic(from: string, to: string): void {
  const dir = dirname(to);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(to)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    copyFileSync(from, temp);
    renameSync(temp, to);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

function loadLedger(path: string): Ledger | null {
  if (!existsSync(path)) return null;
  try {
    return parseLedger(readFileSync(path, 'utf8'));
  } catch (err) {
    // Never start a fresh ledger over one that cannot be read: it may hold years of history.
    const why = err instanceof LedgerError || err instanceof Error ? err.message : String(err);
    throw new CollectError(
      `The existing ledger at ${path} could not be read: ${why}\n` +
        'It was left untouched. Move it out of the way (or pass another file with --ledger) and run again.',
      'ledger_unreadable',
    );
  }
}

// ── What has been read ────────────────────────────────────────────────────────

const FILES_FORMAT = 'claude-lifetime/collector-files';
const FILES_VERSION = 1;

/** Size and modification time of a transcript when it was read completely. */
type ReadFiles = Map<string, { size: number; mtimeMs: number }>;

/** The list of read transcripts lives next to the ledger: `claude-code-ledger.files.json`. */
export function readFilesPath(ledgerPath: string): string {
  return `${ledgerPath.replace(/\.json$/i, '')}.files.json`;
}

/**
 * The transcripts an earlier run has read into this ledger. The list only counts when it was written
 * for the ledger as it is now and by this version of the tool: a ledger that was deleted, replaced by
 * a backup or written by another version makes every transcript be read again, which is always safe.
 */
function loadReadFiles(path: string, ledger: Ledger | null): ReadFiles {
  const known: ReadFiles = new Map();
  if (ledger === null || ledger.generatedAt === null) return known;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (doc.format !== FILES_FORMAT || doc.version !== FILES_VERSION) return known;
    if (doc.collector !== COLLECTOR_VERSION || doc.ledgerGeneratedAt !== ledger.generatedAt) return known;
    const files = doc.files;
    if (typeof files !== 'object' || files === null) return known;
    for (const [file, value] of Object.entries(files)) {
      if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') known.set(file, { size: value[0], mtimeMs: value[1] });
    }
  } catch {
    known.clear();
  }
  return known;
}

function* serialiseReadFiles(known: ReadFiles, ledgerGeneratedAt: string): Generator<string> {
  yield `{\n"format": ${JSON.stringify(FILES_FORMAT)},\n"version": ${FILES_VERSION},\n"collector": ${JSON.stringify(COLLECTOR_VERSION)},\n` +
    `"ledgerGeneratedAt": ${JSON.stringify(ledgerGeneratedAt)},\n"files": {\n`;
  let i = 0;
  for (const [file, { size, mtimeMs }] of known) yield `${i++ > 0 ? ',\n' : ''}${JSON.stringify(file)}: [${size}, ${mtimeMs}]`;
  yield '\n}\n}\n';
}

/** Temporary files of a run that was stopped while it was saving. A run that is saving right now is left alone. */
function removeStaleTemporaryFiles(targets: string[], now: number): void {
  for (const target of targets) {
    const dir = dirname(target);
    const prefix = `.${basename(target)}.`;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      try {
        const file = join(dir, name);
        if (now - statSync(file).mtimeMs > IN_PROGRESS_WINDOW_MS) rmSync(file, { force: true });
      } catch {
        // gone already, or not ours to remove
      }
    }
  }
}

const DEFAULT_CHECKPOINT_BYTES = 512 * 1024 * 1024;

/** Files of one session (its transcript and its subagents' files) sort next to each other and are read together. */
function sessionOf(rel: string): string {
  const info = transcriptPathInfo(rel);
  const project = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
  return `${project}/${info.sessionId ?? info.stem}`;
}

export async function collect(options: CollectOptions = {}): Promise<CollectResult> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const now = options.now ?? Date.now();
  const ledgerPath = resolve(options.ledgerPath ?? defaultLedgerPath(home));
  const filesPath = readFilesPath(ledgerPath);
  const outPath = options.outPath !== undefined ? resolve(options.outPath) : null;
  if (outPath !== null && (outPath === ledgerPath || outPath === filesPath)) {
    throw new CollectError('--out must name a different file than the ledger.', 'bad_arguments');
  }
  const checkpointBytes = options.checkpointBytes ?? DEFAULT_CHECKPOINT_BYTES;

  const roots = findProjectsDirs(options.dirs, env, home);
  const found: FoundFile[] = [];
  const foldersUnreadable: Unreadable[] = [];
  const visited = new Set<string>();
  for (const root of roots) scan(root, '', found, visited, foldersUnreadable);
  if (found.length === 0) {
    const blocked = foldersUnreadable.length > 0 ? `\nCould not open: ${foldersUnreadable.map((u) => `${u.path} (${u.reason})`).join(', ')}.` : '';
    throw new CollectError(
      `No transcripts (.jsonl files) found under ${roots.join(', ')}.${blocked}\n` +
        'Claude Code deletes transcripts after 30 days by default; an existing ledger is left as it is.',
      'nothing_found',
    );
  }

  // Read the ledger first: if it is damaged there is no point in reading gigabytes of transcripts.
  const existing = loadLedger(ledgerPath);
  const ledger = existing ?? emptyLedger();
  const before = { responses: ledger.responses.size, prompts: ledger.prompts.size };
  const readFiles = loadReadFiles(filesPath, existing);
  removeStaleTemporaryFiles([ledgerPath, filesPath], now);

  // The same relative path can exist under two config directories, so files are known by their full path.
  const unchanged = (f: FoundFile): boolean => {
    const known = readFiles.get(f.abs);
    return known !== undefined && known.size === f.size && known.mtimeMs === f.mtimeMs;
  };
  const toRead = found.filter((f) => !unchanged(f)).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  // A file that is gone needs no entry; one that changed gets its entry back when it has been read.
  const present = new Set(found.map((f) => f.abs));
  let listChanged = false;
  for (const file of [...readFiles.keys()]) if (!present.has(file) && readFiles.delete(file)) listChanged = true;
  for (const f of toRead) if (readFiles.delete(f.abs)) listChanged = true;
  const totalBytes = toRead.reduce((sum, f) => sum + f.size, 0);

  const header = { generatedAt: new Date(now).toISOString(), machine: options.machine ?? hostname(), collector: COLLECTOR_VERSION };
  let ledgerGeneratedAt = existing?.generatedAt ?? null;
  /** The ledger the list on disk was written for. A list that did not count (see loadReadFiles) is written anew. */
  let listFor = readFiles.size > 0 ? ledgerGeneratedAt : null;
  let ledgerChanged = existing === null;
  let written = false;
  let ledgerBytes = 0;
  const save = (): void => {
    if (ledgerChanged) {
      ledgerBytes = writeAtomic(ledgerPath, serialiseLedger(ledger, header));
      ledgerGeneratedAt = header.generatedAt;
      ledgerChanged = false;
      written = true;
    }
    // Only ever written after the ledger it describes, and for that ledger.
    if (ledgerGeneratedAt !== null && (listChanged || listFor !== ledgerGeneratedAt)) {
      writeAtomic(filesPath, serialiseReadFiles(readFiles, ledgerGeneratedAt));
      listChanged = false;
      listFor = ledgerGeneratedAt;
    }
  };

  const filesUnreadable: Unreadable[] = [];
  const responsesFound = new Set<string>();
  const promptsFound = new Set<string>();
  const totals = { bytesRead: 0, malformedLines: 0, deferred: 0, responsesAdded: 0, responsesImproved: 0, promptsAdded: 0, partialAdded: 0 };

  const readBatch = async (batch: FoundFile[]): Promise<void> => {
    const bytesBefore = totals.bytesRead;
    const extraction = await extractTranscripts(
      batch.map((f) => ({ name: basename(f.abs), path: f.rel, size: f.size, lastModified: f.mtimeMs, blob: appendTolerantSource(f.abs, f.size) })),
      { onProgress: options.onProgress ? (p) => options.onProgress?.({ bytesRead: bytesBefore + p.bytesRead, totalBytes }) : undefined },
    );
    // What is still being written is not put in the ledger; the next run picks it up complete.
    const deferral = deferInProgress(extraction, now);
    for (const r of deferral.responses) {
      responsesFound.add(r.key);
      if ((r.flags & ResponseFlag.PARTIAL) !== 0 && !ledger.responses.has(r.key)) totals.partialAdded++;
    }
    for (const p of deferral.prompts) promptsFound.add(p.key);
    const merged = mergeIntoLedger(ledger, { responses: deferral.responses, prompts: deferral.prompts, sessions: extraction.sessions });
    if (ledger.responses.size < before.responses || ledger.prompts.size < before.prompts) {
      throw new Error('Internal error: the updated ledger would hold fewer records than before. Nothing was written.');
    }
    if (merged.changed) ledgerChanged = true;
    totals.bytesRead += extraction.counters.bytesRead;
    totals.malformedLines += extraction.counters.malformedLines;
    totals.deferred += deferral.deferredResponses;
    totals.responsesAdded += merged.responsesAdded;
    totals.responsesImproved += merged.responsesImproved;
    totals.promptsAdded += merged.promptsAdded;
    // Files are read in the order of their relative paths, which is the order of the batch. Two config
    // directories can hold the same relative path, so a file is matched by its place, not by its name.
    if (extraction.files.length !== batch.length || extraction.files.some((file, i) => file.path !== batch[i].rel)) {
      throw new Error('Internal error: the transcripts were not read in the expected order. Nothing was written.');
    }
    extraction.files.forEach((file, i) => {
      const f = batch[i];
      if (file.status === 'unreadable') filesUnreadable.push({ path: f.abs, reason: reasonOf(file.error ?? 'could not be read') });
      // Remembered only when nothing in it can still change: read to the end, quiet for a while,
      // and nothing read from it was set aside for later.
      else if (file.status === 'read' && now - f.mtimeMs >= IN_PROGRESS_WINDOW_MS && !deferral.hotFiles.has(i)) {
        readFiles.set(f.abs, { size: f.size, mtimeMs: f.mtimeMs });
        listChanged = true;
      }
    });
  };

  let batch: FoundFile[] = [];
  let batchBytes = 0;
  for (let i = 0; i < toRead.length; i++) {
    batch.push(toRead[i]);
    batchBytes += toRead[i].size;
    const last = i === toRead.length - 1;
    if (last || (batchBytes >= checkpointBytes && sessionOf(toRead[i + 1].rel) !== sessionOf(toRead[i].rel))) {
      await readBatch(batch);
      batch = [];
      batchBytes = 0;
      // An empty first ledger is never written: there may simply be nothing to collect.
      if (!last && ledger.responses.size + ledger.prompts.size > 0) save();
    }
  }

  if (existing === null && ledger.responses.size === 0 && ledger.prompts.size === 0) {
    const blocked = filesUnreadable.length > 0 ? ` ${things(filesUnreadable.length, 'file')} could not be read: ${filesUnreadable[0].path} (${filesUnreadable[0].reason}).` : '';
    throw new CollectError(
      `No Claude Code usage found in the ${found.length} transcript file(s) under ${roots.join(', ')}.${blocked}`,
      'nothing_found',
    );
  }
  save();
  if (!written) ledgerBytes = statSync(ledgerPath).size;
  if (outPath !== null) copyAtomic(ledgerPath, outPath);

  let first = Infinity;
  let last = -Infinity;
  const sessions = new Set<string>();
  for (const r of ledger.responses.values()) {
    if (r.ts < first) first = r.ts;
    if (r.ts > last) last = r.ts;
    sessions.add(r.sessionId);
  }
  for (const p of ledger.prompts.values()) {
    if (p.ts < first) first = p.ts;
    if (p.ts > last) last = p.ts;
    sessions.add(p.sessionId);
  }

  return {
    roots,
    transcriptFiles: found.length,
    filesRead: toRead.length,
    filesUnchanged: found.length - toRead.length,
    foldersUnreadable,
    filesUnreadable,
    bytesRead: totals.bytesRead,
    malformedLines: totals.malformedLines,
    responsesFound: responsesFound.size,
    promptsFound: promptsFound.size,
    deferredInProgress: totals.deferred,
    responsesAdded: totals.responsesAdded,
    responsesImproved: totals.responsesImproved,
    promptsAdded: totals.promptsAdded,
    partialAdded: totals.partialAdded,
    responses: ledger.responses.size,
    prompts: ledger.prompts.size,
    sessions: sessions.size,
    firstTimestamp: Number.isFinite(first) ? new Date(first).toISOString() : null,
    lastTimestamp: Number.isFinite(last) ? new Date(last).toISOString() : null,
    ledgerPath,
    ledgerBytes,
    written,
    outPath,
  };
}

// ── Command line ──────────────────────────────────────────────────────────────

export const USAGE = `Claude Lifetime collector ${COLLECTOR_VERSION}

Reads Claude Code's session transcripts on this computer and adds their token usage
to a ledger file that you can import into Claude Lifetime. Claude Code deletes
transcripts after 30 days by default; the ledger keeps what it has already seen, so
run this regularly.

Nothing leaves this computer, and no message text is stored: the ledger holds ids,
timestamps, model names and token counts, plus each session's title, folder and
git branch. Next to the ledger the tool keeps a list of the transcripts it has read
(their paths, sizes and dates), so that a later run only reads what is new. The first
run reads everything, which can take minutes when there are gigabytes of transcripts;
it saves as it goes, so a run that is stopped early is continued by the next one.

Usage:
  node claude-lifetime-collect.mjs [options]

Options:
  --dir <config dir>  Claude Code config directory to read. May be given several times.
                      Default: each entry of $CLAUDE_CONFIG_DIR (comma-separated) if set,
                      else ~/.claude and ~/.config/claude.
  --ledger <file>     Ledger to update. Default: ~/.claude-lifetime/claude-code-ledger.json
  --out <file>        Also write a copy of the updated ledger to this file.
  --quiet             Print nothing unless something goes wrong.
  --help              Show this help.
  --version           Show the version.

Exit status: 0 when the ledger is up to date; 1 when nothing was found or on an error;
3 when the ledger was updated but a folder or a transcript could not be read.
`;

export interface CliArgs {
  dirs: string[];
  ledger?: string;
  out?: string;
  quiet: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { dirs: [], quiet: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const value = (): string => {
      const v = eq === -1 ? argv[++i] : raw.slice(eq + 1);
      if (v === undefined || v === '') throw new CollectError(`${name} needs a value.`, 'bad_arguments');
      return v;
    };
    if (name === '--dir') args.dirs.push(value());
    else if (name === '--ledger') args.ledger = value();
    else if (name === '--out') args.out = value();
    else if (name === '--quiet' || name === '-q') args.quiet = true;
    else if (name === '--help' || name === '-h') args.help = true;
    else if (name === '--version') args.version = true;
    else throw new CollectError(`Unknown option: ${raw}`, 'bad_arguments');
  }
  return args;
}

const num = (n: number) => n.toLocaleString('en-US');

function megabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "1 response", "2 responses". */
const things = (n: number, one: string) => `${num(n)} ${one}${n === 1 ? '' : 's'}`;

/** Status when the ledger was updated but something could not be read. Not 2, which Claude Code hooks treat as a blocking error. */
export const EXIT_INCOMPLETE = 3;

const LISTED = 5;

/** What could not be read, one line each, for the summary and (with --quiet) for the error output. */
export function formatProblems(r: Pick<CollectResult, 'foldersUnreadable' | 'filesUnreadable'>): string[] {
  const lines: string[] = [];
  const list = (items: Unreadable[], what: string) => {
    if (items.length === 0) return;
    lines.push(what);
    for (const u of items.slice(0, LISTED)) lines.push(`  ${u.path}: ${u.reason}`);
    if (items.length > LISTED) lines.push(`  and ${num(items.length - LISTED)} more`);
  };
  list(
    r.foldersUnreadable,
    `${things(r.foldersUnreadable.length, 'folder')} could not be opened, so the usage in ${r.foldersUnreadable.length === 1 ? 'it' : 'them'} was not collected:`,
  );
  list(
    r.filesUnreadable,
    `${things(r.filesUnreadable.length, 'transcript')} could not be read to the end; what was read is in the ledger, the rest is tried again by the next run:`,
  );
  return lines;
}

export function formatSummary(r: CollectResult): string {
  const lines = [
    `Read       ${things(r.filesRead, 'transcript file')} (${megabytes(r.bytesRead)}) under ${r.roots.join(', ')}` +
      (r.filesUnchanged > 0 ? `; ${num(r.filesUnchanged)} unchanged since an earlier run` : ''),
    `Found      ${things(r.responsesFound, 'response')} and ${things(r.promptsFound, 'prompt')} in them`,
    `New        ${things(r.responsesAdded, 'response')} and ${things(r.promptsAdded, 'prompt')} since the last run` +
      (r.responsesImproved > 0 ? ` (${things(r.responsesImproved, 'earlier record')} completed)` : ''),
    `Ledger     ${things(r.responses, 'response')}, ${things(r.prompts, 'prompt')}, ${things(r.sessions, 'session')}`,
    `Range      ${r.firstTimestamp === null || r.lastTimestamp === null ? 'no usage yet' : `${r.firstTimestamp.slice(0, 10)} to ${r.lastTimestamp.slice(0, 10)} (UTC)`}`,
    `Saved to   ${r.ledgerPath} (${megabytes(r.ledgerBytes)})${r.written ? '' : ', already up to date'}`,
  ];
  if (r.outPath !== null) lines.push(`Copy       ${r.outPath}`);
  const notes: string[] = [];
  if (r.deferredInProgress > 0) notes.push(`${things(r.deferredInProgress, 'response')} still being written: left for the next run`);
  if (r.partialAdded > 0) notes.push(`${things(r.partialAdded, 'response')} only recorded as a streaming snapshot: output tokens may be undercounted`);
  if (r.malformedLines > 0) notes.push(`${things(r.malformedLines, 'unreadable line')} skipped (a cut-off last line is normal while a session runs)`);
  for (const note of notes) lines.push(`Note       ${note}`);
  const problems = formatProblems(r);
  if (problems.length > 0) lines.push('', `Incomplete ${problems[0]}`, ...problems.slice(1));
  return `${lines.join('\n')}\n`;
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** Transient progress line; only given when the terminal can show one. */
  progress?(text: string): void;
}

/** Runs the command line and returns the exit status. */
export async function runCli(argv: readonly string[], io: CliIo, defaults: Pick<CollectOptions, 'env' | 'homeDir' | 'now' | 'machine'> = {}): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  if (args.version) {
    io.out(`${COLLECTOR_VERSION}\n`);
    return 0;
  }
  if (typeof openAsBlob !== 'function') {
    io.err(`This tool needs Node.js 20 or newer; this is Node.js ${process.versions.node}.\n`);
    return 1;
  }
  try {
    const progress = args.quiet ? undefined : io.progress;
    const result = await collect({
      ...defaults,
      dirs: args.dirs,
      ledgerPath: args.ledger,
      outPath: args.out,
      onProgress: progress
        ? (p) => progress(`Reading transcripts... ${megabytes(p.bytesRead)} of ${megabytes(p.totalBytes)}`)
        : undefined,
    });
    progress?.('');
    if (!args.quiet) io.out(formatSummary(result));
    const incomplete = result.foldersUnreadable.length + result.filesUnreadable.length > 0;
    // --quiet prints nothing unless something goes wrong, and this is something going wrong.
    if (incomplete && args.quiet) io.err(`${formatProblems(result).join('\n')}\n`);
    return incomplete ? EXIT_INCOMPLETE : 0;
  } catch (err) {
    io.progress?.('');
    if (err instanceof CollectError) io.err(`${err.message}\n`);
    else io.err(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}
