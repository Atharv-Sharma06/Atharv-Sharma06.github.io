import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openAsBlob,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { deferInProgress, extractTranscripts, ResponseFlag, transcriptPathInfo, type TranscriptSource } from './extract';
import { emptyLedger, LedgerError, mergeIntoLedger, parseLedger, serialiseLedger, type Ledger } from './ledger';

/**
 * The collector: reads Claude Code's transcripts on this computer and keeps a ledger
 * of their usage (see ledger.ts). Node only; this is the body of the CLI that is
 * bundled into public/tools/claude-lifetime-collect.mjs. It uses the same extraction
 * code as the in-browser importer and nothing but Node's built-in modules.
 *
 * It only ever reads below the config directories it is given, writes the ledger
 * (and the optional copy), and talks to no network.
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
}

export interface CollectResult {
  /** The `projects` directories that were scanned. */
  roots: string[];
  transcriptFiles: number;
  filesUnreadable: number;
  bytesRead: number;
  malformedLines: number;
  /** Complete responses and prompts in the transcripts that exist now. */
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

function scan(dir: string, rel: string, out: FoundFile[], visited: Set<string>): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  // Guards against symlink loops.
  if (visited.has(real)) return;
  visited.add(real);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scan(abs, childRel, out, visited);
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
                const blob = await openAsBlob(path);
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

export async function collect(options: CollectOptions = {}): Promise<CollectResult> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const now = options.now ?? Date.now();
  const ledgerPath = resolve(options.ledgerPath ?? defaultLedgerPath(home));
  const outPath = options.outPath !== undefined ? resolve(options.outPath) : null;
  if (outPath !== null && outPath === ledgerPath) throw new CollectError('--out must name a different file than the ledger.', 'bad_arguments');

  const roots = findProjectsDirs(options.dirs, env, home);
  const found: FoundFile[] = [];
  const visited = new Set<string>();
  for (const root of roots) scan(root, '', found, visited);
  if (found.length === 0) {
    throw new CollectError(
      `No transcripts (.jsonl files) found under ${roots.join(', ')}.\n` +
        'Claude Code deletes transcripts after 30 days by default; an existing ledger is left as it is.',
      'nothing_found',
    );
  }

  // Read the ledger first: if it is damaged there is no point in reading gigabytes of transcripts.
  const existing = loadLedger(ledgerPath);
  const ledger = existing ?? emptyLedger();
  const before = { responses: ledger.responses.size, prompts: ledger.prompts.size };

  const sources: TranscriptSource[] = found.map((f) => ({
    name: basename(f.abs),
    path: f.rel,
    size: f.size,
    lastModified: f.mtimeMs,
    blob: appendTolerantSource(f.abs, f.size),
  }));
  const extraction = await extractTranscripts(sources, {
    onProgress: options.onProgress ? (p) => options.onProgress?.({ bytesRead: p.bytesRead, totalBytes: p.totalBytes }) : undefined,
  });
  // What is still being written is not put in the ledger; the next run picks it up complete.
  const deferral = deferInProgress(extraction, now);

  if (existing === null && deferral.responses.length === 0 && deferral.prompts.length === 0) {
    throw new CollectError(
      `No Claude Code usage found in the ${found.length} transcript file(s) under ${roots.join(', ')}.`,
      'nothing_found',
    );
  }

  let partialAdded = 0;
  for (const r of deferral.responses) {
    if ((r.flags & ResponseFlag.PARTIAL) !== 0 && !ledger.responses.has(r.key)) partialAdded++;
  }
  const merged = mergeIntoLedger(ledger, { responses: deferral.responses, prompts: deferral.prompts, sessions: extraction.sessions });
  if (ledger.responses.size < before.responses || ledger.prompts.size < before.prompts) {
    throw new Error('Internal error: the updated ledger would hold fewer records than before. Nothing was written.');
  }

  let ledgerBytes: number;
  const written = existing === null || merged.changed;
  if (written) {
    ledgerBytes = writeAtomic(
      ledgerPath,
      serialiseLedger(ledger, { generatedAt: new Date(now).toISOString(), machine: options.machine ?? hostname(), collector: COLLECTOR_VERSION }),
    );
  } else {
    ledgerBytes = statSync(ledgerPath).size;
  }
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
    filesUnreadable: extraction.counters.filesUnreadable,
    bytesRead: extraction.counters.bytesRead,
    malformedLines: extraction.counters.malformedLines,
    responsesFound: deferral.responses.length,
    promptsFound: deferral.prompts.length,
    deferredInProgress: deferral.deferredResponses,
    responsesAdded: merged.responsesAdded,
    responsesImproved: merged.responsesImproved,
    promptsAdded: merged.promptsAdded,
    partialAdded,
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
git branch.

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

Exit status: 0 when the ledger is up to date, 1 when nothing was found or on an error.
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

export function formatSummary(r: CollectResult): string {
  const lines = [
    `Read       ${things(r.transcriptFiles, 'transcript file')} (${megabytes(r.bytesRead)}) under ${r.roots.join(', ')}`,
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
  if (r.filesUnreadable > 0) notes.push(`${things(r.filesUnreadable, 'file')} could not be read to the end and will be read again next time`);
  for (const note of notes) lines.push(`Note       ${note}`);
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
    io.err('This tool needs Node.js 20 or newer.\n');
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
    return 0;
  } catch (err) {
    io.progress?.('');
    if (err instanceof CollectError) io.err(`${err.message}\n`);
    else io.err(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}
