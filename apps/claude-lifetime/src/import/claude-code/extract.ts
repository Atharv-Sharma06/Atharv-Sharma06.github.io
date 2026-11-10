import { readLines } from '@/import/util/lines';

/**
 * Reads Claude Code's session transcripts (JSONL under `<config>/projects/`) and
 * reduces them to one record per API response and one per human prompt.
 *
 * This file is shared by the in-browser importer and by the collector CLI, so it
 * depends on nothing but the line reader: no database, no model catalog, no Node APIs.
 *
 * Why it is not a plain "sum the usage fields" loop (see docs: research §5):
 *  - one API response is written as one line per content block, and every line
 *    repeats the response's usage, so summing lines counts a response 2-3 times;
 *  - old versions wrote growing streaming snapshots instead, where only the last
 *    line (sometimes no line) carries the final output count;
 *  - branched, forked, resumed and set-aside sessions copy rows into other files;
 *  - subagent ("sidechain") responses live in their own files and are real usage.
 * So rows are grouped by a key that identifies the response across all files, and the
 * most complete line of each group is kept. Lines of one group are never added up.
 *
 * Message text is never copied: only ids, timestamps, model names and counters leave
 * this module (plus the session title, working directory and git branch).
 */

/** A response whose last line is younger than this may still be streaming. */
export const IN_PROGRESS_WINDOW_MS = 10 * 60 * 1000;

/** Bit flags of a ResponseRecord. Stored as-is in the collector's ledger, so values never change. */
export const ResponseFlag = {
  /** Subagent response (isSidechain, or read from a subagent file). */
  SIDECHAIN: 1,
  /** The best line still has `stop_reason: null`: a streaming snapshot, output may be undercounted. */
  PARTIAL: 2,
  /** The response calls a client tool (a `tool_use` block, or `stop_reason: "tool_use"`), so it does not end a turn. */
  TOOL_USE: 4,
  /** `usage.speed` is "fast". */
  FAST: 8,
  /** `usage.speed` is present (old preliminary lines lack it; used to rank lines). */
  HAS_SPEED: 16,
  /** Cache-write tokens without a 5-minute / 1-hour breakdown; they are held in the 5-minute column. */
  CACHE_TTL_UNKNOWN: 32,
  /** No row of the response carries a `requestId` (usual behind gateways, and for rows Claude Code copied into another transcript). */
  NO_REQUEST_ID: 64,
  /** The response has no `message.id`; its lines were recognised by standing together in the file. */
  NO_MESSAGE_ID: 128,
  /** The row had no usable timestamp; the nearest one in the same file was used. */
  TIMESTAMP_INFERRED: 256,
  /** Claude Code marked the row `isUnmetered` (meaning unverified; counted and reported). */
  UNMETERED: 512,
  /** Claude Code marked the row `isVirtual` (meaning unverified; counted and reported). */
  VIRTUAL: 1024,
  /** The same message id was seen with another request id on the main thread; it is one response and counted once. */
  MESSAGE_ID_REUSED: 2048,
} as const;

/** Flags that describe the whole response rather than the line that was kept. */
const GROUP_FLAGS =
  ResponseFlag.TOOL_USE | ResponseFlag.TIMESTAMP_INFERRED | ResponseFlag.UNMETERED | ResponseFlag.VIRTUAL | ResponseFlag.MESSAGE_ID_REUSED;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * One entry of `usage.iterations` other than the returned message itself: an extra,
 * separately billed attempt that the top-level counters do not include.
 */
export interface IterationRecord extends TokenCounts {
  /** Position in `usage.iterations`; part of the record's key. */
  index: number;
  /** `advisor_message`, `fallback_message`, `compaction`, ... exactly as written. */
  type: string;
  model: string | null;
  cacheTtlUnknown: boolean;
}

/** One API response, de-duplicated across lines and files. */
export interface ResponseRecord extends TokenCounts {
  /**
   * Identity of the response across files and imports. `m:<message.id>` for an id issued
   * by Anthropic, which names one response wherever and however often it is written. For
   * any other id, or none, `u:<uuid of the response's first row>` (see GatewayRun), with
   * `mst:<session>:<message.id>:<time of the first row>` and `line:<file>:<line>` as fallbacks.
   */
  key: string;
  /** Session the response is attributed to (the original session for copied rows). */
  sessionId: string;
  /** Model identifier exactly as Claude Code wrote it, or null. */
  model: string | null;
  /** Epoch ms of the first line of the response. Copies keep it, so the day never depends on which copy survives. */
  ts: number;
  /** Epoch ms of the last line seen; tells whether the response may still be streaming. */
  lastTs: number;
  /** Share of `output` spent on thinking, when reported (informational). */
  thinking: number;
  webSearch: number;
  /** Bitmask of ResponseFlag. */
  flags: number;
  /** `usage.service_tier` as written ("standard", "batch", "priority", ...). */
  serviceTier: string | null;
  /** `usage.inference_geo` as written. */
  geo: string | null;
  extras: IterationRecord[] | null;
}

export const PromptKind = { TYPED: 0, COMMAND: 1, SHELL: 2 } as const;
export type PromptKindCode = (typeof PromptKind)[keyof typeof PromptKind];

/** A prompt the person submitted. Carries no text. */
export interface PromptRecord {
  /** `p:<row uuid>`. */
  key: string;
  sessionId: string;
  ts: number;
  kind: PromptKindCode;
}

export type TitleKind = 'custom' | 'ai' | 'summary';

export interface SessionInfo {
  id: string;
  /** Session title from a `custom-title`, `ai-title` or `summary` row (a title, not message content). */
  title: string | null;
  titleKind: TitleKind | null;
  /** Working directory of the session's first main-thread row. */
  cwd: string | null;
  gitBranch: string | null;
  /** Claude Code version that last wrote to the session. */
  version: string | null;
  hasSubagents: boolean;
}

export interface TranscriptSource {
  name: string;
  /** Path relative to the directory that was picked or scanned. */
  path?: string;
  size: number;
  lastModified?: number;
  /** A browser `File`, a Node `Blob`, or anything else that can be read as a byte stream. */
  blob: { stream(): ReadableStream<Uint8Array> };
}

export interface ExtractOptions {
  /** Files an earlier import read completely; skipped while size and modification time are unchanged. */
  knownFiles?: ReadonlyMap<string, { size: number; lastModified: number }>;
  /** Called about once per megabyte and after every file. Throw from it to cancel. */
  onProgress?: (progress: { bytesRead: number; totalBytes: number; usageRows: number }) => void;
}

export interface ExtractedFile {
  /** Path as given (`path ?? name`). */
  path: string;
  name: string;
  size: number;
  lastModified: number | undefined;
  /** `unchanged`: skipped because of `knownFiles`; `unreadable`: reading stopped with an error. */
  status: 'read' | 'unchanged' | 'unreadable';
  /** Why reading stopped, for an unreadable file. */
  error?: string;
  /** The code of the error that stopped the reading, when it has one (an ImportError's, for a file in a ZIP archive). */
  errorCode?: string;
  subagent: boolean;
}

export interface ExtractCounters {
  filesGiven: number;
  /** Not transcripts (other extensions, tool-results/, mcp-tasks/). */
  filesIgnored: number;
  transcriptFiles: number;
  filesRead: number;
  filesSkippedUnchanged: number;
  /** Unchanged main transcripts read anyway because new subagent rows of their session arrived. */
  filesUnreadable: number;
  subagentFiles: number;
  bytesRead: number;
  lines: number;
  malformedLines: number;
  /** `assistant` rows (and legacy `progress` wrappers) that carry a usage object. */
  usageRows: number;
  progressRows: number;
  syntheticRows: number;
  /** Usage objects with neither `input_tokens` nor `output_tokens`. */
  usageRowsWithoutCounts: number;
  /** Rows dropped because no timestamp could be found for them. */
  rowsWithoutTimestamp: number;
  /** Usage rows that repeated a response already seen (further lines and copies). */
  duplicateLines: number;
  /** Responses that a sidechain file repeated under a new request id (counted once). */
  sidechainReplaysDropped: number;
  /** Responses written under more than one request id on the main thread (counted once). */
  messageIdsReused: number;
  userRows: number;
  /** `user` rows that are not human prompts, by reason. */
  notPromptSidechain: number;
  notPromptMeta: number;
  notPromptCompactSummary: number;
  notPromptToolResult: number;
  notPromptEmpty: number;
  notPromptOrigin: number;
  notPromptInjected: number;
  /** Prompt rows that repeated a prompt already seen (copies). */
  duplicatePromptRows: number;
  /** `summary` rows whose `leafUuid` matches no row that was read. */
  summariesUnresolved: number;
}

export interface Extraction {
  /** Sorted by time, then key. */
  responses: ResponseRecord[];
  prompts: PromptRecord[];
  /** Sessions that have at least one response or prompt. */
  sessions: Map<string, SessionInfo>;
  /** Every transcript file given, in the order it was considered. */
  files: ExtractedFile[];
  /** Index into `files` of the first file each response / prompt was read from. */
  responseFile: number[];
  promptFile: number[];
  /** Further files for records that were found in more than one (copies), by record index. */
  responseMoreFiles: Map<number, number[]>;
  promptMoreFiles: Map<number, number[]>;
  counters: ExtractCounters;
  /** Identifiers for warning messages (file names and ids, never text). */
  samples: { malformedLine?: string; unreadableFile?: string };
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A non-empty string, or null: empty ids count as missing. */
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** A counter: finite and non-negative, fractions dropped. Anything else counts as missing. */
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;

// Claude Code did not exist before 2025; anything outside this window is a corrupt value.
const MIN_TIME = Date.UTC(2020, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);

function timeOf(v: unknown): number {
  if (typeof v !== 'string' || v === '') return NaN;
  const ms = Date.parse(v);
  return ms >= MIN_TIME && ms <= MAX_TIME ? ms : NaN;
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

/**
 * Copies the token counts of a usage object (the top level, or one iteration) into
 * `into`. Returns true when cache writes come without a time-to-live breakdown.
 *
 * `cache_creation_input_tokens` is the total over all TTLs; `cache_creation` splits it.
 * Whatever part of the total the split does not explain (all of it on old rows, which
 * have no split) goes to the 5-minute column, the cheaper of the two.
 */
function readTokens(u: Json, into: TokenCounts): boolean {
  into.input = count(u.input_tokens) ?? 0;
  into.output = count(u.output_tokens) ?? 0;
  into.cacheRead = count(u.cache_read_input_tokens) ?? 0;
  const written = count(u.cache_creation_input_tokens) ?? 0;
  const split = u.cache_creation;
  let w5 = 0;
  let w1 = 0;
  if (isObject(split)) {
    w5 = count(split.ephemeral_5m_input_tokens) ?? 0;
    w1 = count(split.ephemeral_1h_input_tokens) ?? 0;
  }
  const unexplained = written - w5 - w1;
  into.cacheWrite5m = unexplained > 0 ? w5 + unexplained : w5;
  into.cacheWrite1h = w1;
  return unexplained > 0;
}

function readIterations(v: unknown): IterationRecord[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const all: IterationRecord[] = [];
  let messages = 0;
  for (let i = 0; i < v.length; i++) {
    const it: unknown = v[i];
    if (!isObject(it)) continue;
    const type = text(it.type) ?? 'unknown';
    if (type === 'message') messages++;
    const rec: IterationRecord = {
      index: i, type, model: text(it.model),
      input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheTtlUnknown: false,
    };
    rec.cacheTtlUnknown = readTokens(it, rec);
    all.push(rec);
  }
  // A single `message` iteration is the returned message, which the top-level counters
  // already cover. With several, it is not known which one that is, so all are kept
  // (and reported as not counted) rather than guessing.
  const extras = messages === 1 ? all.filter((r) => r.type !== 'message') : all;
  return extras.length > 0 ? extras : null;
}

/**
 * True when `a` is a more complete record of a response than `b` (research §5.6):
 * the parent's copy beats a sidechain copy, a finished line beats a streaming
 * snapshot, then the larger counts, then the line that has `speed` (old final lines
 * had it, preliminary ones did not). Equal ranks return false.
 */
export function outranks(a: TokenCounts & { flags: number }, b: TokenCounts & { flags: number }): boolean {
  const aMain = (a.flags & ResponseFlag.SIDECHAIN) === 0;
  const bMain = (b.flags & ResponseFlag.SIDECHAIN) === 0;
  if (aMain !== bMain) return aMain;
  const aDone = (a.flags & ResponseFlag.PARTIAL) === 0;
  const bDone = (b.flags & ResponseFlag.PARTIAL) === 0;
  if (aDone !== bDone) return aDone;
  const aTotal = totalTokens(a);
  const bTotal = totalTokens(b);
  if (aTotal !== bTotal) return aTotal > bTotal;
  if (a.output !== b.output) return a.output > b.output;
  const aSpeed = (a.flags & ResponseFlag.HAS_SPEED) !== 0;
  const bSpeed = (b.flags & ResponseFlag.HAS_SPEED) !== 0;
  return aSpeed && !bSpeed;
}

/**
 * Ids issued by the Anthropic API are unique per response. Gateways and proxies may
 * put one placeholder id on every response, so rules that rely on "same id = same
 * message" are only applied to ids of this shape.
 */
export function isAnthropicMessageId(id: string): boolean {
  return id.startsWith('msg_') || id.startsWith('resp_');
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export interface TranscriptPathInfo {
  /** The path with forward slashes. */
  path: string;
  base: string;
  /** A `.jsonl` transcript (including set-aside `*.jsonl.superseded-*` and `*.orphaned-*.jsonl` copies). */
  isTranscript: boolean;
  /** Under `subagents/`, or a legacy flat `agent-*.jsonl` file. */
  isSubagent: boolean;
  /** Session id implied by the location, when the location implies one. */
  sessionId: string | null;
  /** File name without the transcript extension; the last-resort session id. */
  stem: string;
}

/** Directories next to transcripts that hold tool output, not transcripts. */
const NOT_TRANSCRIPT_DIRS = new Set(['tool-results', 'mcp-tasks']);

export function transcriptPathInfo(rawPath: string): TranscriptPathInfo {
  const path = rawPath.replace(/\\/g, '/');
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  const base = segments.length > 0 ? segments[segments.length - 1] : '';
  const dirs = segments.slice(0, -1);
  const superseded = /\.jsonl\.superseded-[^/]*$/i.exec(base);
  const isJsonl = superseded !== null || /\.jsonl$/i.test(base);
  const isTranscript = isJsonl && !dirs.some((d) => NOT_TRANSCRIPT_DIRS.has(d));
  let stem = superseded ? base.slice(0, superseded.index) : base.replace(/\.jsonl$/i, '');
  const orphaned = /\.orphaned-.*$/i.exec(stem);
  if (orphaned) stem = stem.slice(0, orphaned.index);
  const subagentsAt = dirs.lastIndexOf('subagents');
  const isSubagent = subagentsAt !== -1 || /^agent-/i.test(base);
  let sessionId: string | null = null;
  // <project>/<sessionId>/subagents/**/agent-<agentId>.jsonl: the session is the directory above.
  if (subagentsAt > 0) sessionId = dirs[subagentsAt - 1];
  // A legacy flat <project>/agent-<id>.jsonl names an agent, not a session.
  else if (!isSubagent && stem !== '') sessionId = stem;
  return { path, base, isTranscript, isSubagent, sessionId, stem };
}

/**
 * True when a parsed JSON Lines value looks like a row of a Claude Code transcript:
 * every row has a string `type` and names its session. Two row types do not:
 * `summary` names the last row it summarises, `file-history-snapshot` the message it
 * belongs to. Used to tell a transcript from other JSON Lines files by its first line.
 */
export function isTranscriptRow(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== 'string') return false;
  if (typeof value.sessionId === 'string') return true;
  if (value.type === 'summary') return typeof value.leafUuid === 'string';
  return value.type === 'file-history-snapshot' && typeof value.messageId === 'string';
}

// ── Human prompts ─────────────────────────────────────────────────────────────

/**
 * `user` rows that begin with one of these were written by Claude Code, not typed:
 * command output, notifications, reminders, interrupt markers and the summary that
 * opens a compacted session (research §3.6). `<local-command-caveat>` is not in the
 * research list; such rows are also flagged `isMeta`, the prefix is a second net.
 */
const INJECTED_PREFIXES = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
  '<system-reminder>',
  '<user-memory-input>',
  '<teammate-message',
  '[Request interrupted by user',
  'This session is being continued from a previous conversation',
];

export type PromptExclusion = 'sidechain' | 'meta' | 'compact_summary' | 'tool_result' | 'empty' | 'origin' | 'injected';
export type UserRowClass = { prompt: PromptKindCode; excluded?: undefined } | { prompt?: undefined; excluded: PromptExclusion };

/** Kind of a text block the person submitted, or null when Claude Code injected it or it is empty. */
function humanTextKind(value: unknown): PromptKindCode | null | 'injected' {
  if (typeof value !== 'string') return null;
  const t = value.trimStart();
  if (t === '') return null;
  for (const prefix of INJECTED_PREFIXES) if (t.startsWith(prefix)) return 'injected';
  // Slash commands are written as <command-name>/x</command-name> (some versions put
  // <command-message> first); `!` shell commands as <bash-input>...</bash-input>.
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) return PromptKind.COMMAND;
  if (t.startsWith('<bash-input>')) return PromptKind.SHELL;
  return PromptKind.TYPED;
}

/**
 * Decides whether a `type: "user"` row is something the person submitted: a typed
 * prompt, a slash command or a `!` shell command. Everything else on `user` rows is
 * machinery (tool results, injected context, subagent prompts written by the model).
 */
export function classifyUserRow(row: Json, inSubagentFile = false): UserRowClass {
  if (row.isSidechain === true || inSubagentFile) return { excluded: 'sidechain' };
  if (row.isMeta === true) return { excluded: 'meta' };
  if (row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return { excluded: 'compact_summary' };
  if (row.toolUseResult !== undefined && row.toolUseResult !== null) return { excluded: 'tool_result' };
  const content = isObject(row.message) ? row.message.content : undefined;
  let kind: PromptKindCode | null = null;
  let injected = false;
  if (typeof content === 'string') {
    const k = humanTextKind(content);
    if (k === 'injected') injected = true;
    else kind = k;
  } else if (Array.isArray(content)) {
    for (const block of content as unknown[]) {
      if (!isObject(block)) continue;
      if (block.type === 'tool_result') return { excluded: 'tool_result' };
      if (block.type === 'text') {
        const k = humanTextKind(block.text);
        if (k === 'injected') injected = true;
        else if (k !== null && kind === null) kind = k;
      } else if (block.type === 'image' && kind === null) {
        kind = PromptKind.TYPED;
      }
    }
  }
  if (kind === null) return { excluded: injected ? 'injected' : 'empty' };
  // Newer versions say who sent the row; task notifications, auto-continuations and
  // plugin or channel messages are not the person.
  const origin = row.origin;
  if (origin !== undefined && origin !== null && !(isObject(origin) && origin.kind === 'human')) return { excluded: 'origin' };
  return { prompt: kind };
}

// ── Reader ────────────────────────────────────────────────────────────────────

interface FileState {
  index: number;
  base: string;
  subagent: boolean;
  /** Session for rows that name none. */
  session: string;
  lastModified: number | undefined;
  /** Raw timestamp of the latest row that had one (parsed only when needed). */
  lastRawTime: unknown;
  /** Rows waiting for the first usable timestamp in the file. */
  waiting: Array<(ts: number) => void>;
  /** The gateway response whose lines are being read, if the last usage row was one. */
  gatewayRun: GatewayRun | null;
  /**
   * The same for responses that old versions wrapped into the parent's file as progress rows, one
   * open run per session and message id. Subagents that ran side by side had their wrappers written
   * interleaved (A, B, A, B), so the lines of one response do not stand next to each other there.
   */
  wrappedRuns: Map<string, GatewayRun>;
}

interface SessionState {
  id: string;
  cwd: string | null;
  cwdFromSidechain: boolean;
  gitBranch: string | null;
  gitBranchFromSidechain: boolean;
  version: string | null;
  versionFromSidechain: boolean;
  customTitle: string | null;
  aiTitle: string | null;
  summaryTitle: string | null;
  sidechainUsage: boolean;
}

interface Group {
  rec: ResponseRecord;
  /** Timestamp of the line that was kept; breaks ties between equally complete lines. */
  keptTs: number;
  file: number;
  moreFiles: number[] | null;
  /** The request id the response was first seen with, and the latest other one. Repeats under another id are replays. */
  requestId: string | null;
  replayId: string | null;
}

/**
 * Lines of one response whose message id was not issued by Anthropic: a gateway's own id,
 * which it may put on every response, or no id at all. Such an id does not name the
 * response, so the response is the run of lines that stand together in a file: same session,
 * same id and the same request id or, where rows carry no request id, the same usage (a
 * snapshot written while the response streamed may hold less), with no row of the person,
 * of a tool or of another response in between. The run is known again by the uuid of its
 * first row, which every kind of copy keeps. Rows inside progress wrappers are the exception
 * to "standing together": see FileState.wrappedRuns.
 */
interface GatewayRun {
  session: string;
  messageId: string | null;
  requestId: string | null;
  usage: TokenCounts;
  partial: boolean;
  /** Set when the first line has been placed in time. */
  key: string | null;
}

const countsOf = (t: TokenCounts): TokenCounts => ({
  input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite5m: t.cacheWrite5m, cacheWrite1h: t.cacheWrite1h,
});
const sameCounts = (a: TokenCounts, b: TokenCounts): boolean =>
  a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead &&
  a.cacheWrite5m === b.cacheWrite5m && a.cacheWrite1h === b.cacheWrite1h;

interface PromptState {
  rec: PromptRecord;
  file: number;
  moreFiles: number[] | null;
}

const REPORT_EVERY_BYTES = 1024 * 1024;
const TITLE_MAX_CHARS = 200;

const cleanTitle = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > TITLE_MAX_CHARS ? `${t.slice(0, TITLE_MAX_CHARS - 1)}…` : t;
};

function addFile(holder: { file: number; moreFiles: number[] | null }, index: number): void {
  if (holder.file === index) return;
  if (holder.moreFiles === null) holder.moreFiles = [index];
  else if (!holder.moreFiles.includes(index)) holder.moreFiles.push(index);
}

class TranscriptReader {
  readonly counters: ExtractCounters = {
    filesGiven: 0, filesIgnored: 0, transcriptFiles: 0, filesRead: 0, filesSkippedUnchanged: 0,
    filesUnreadable: 0, subagentFiles: 0, bytesRead: 0, lines: 0, malformedLines: 0,
    usageRows: 0, progressRows: 0, syntheticRows: 0, usageRowsWithoutCounts: 0, rowsWithoutTimestamp: 0,
    duplicateLines: 0, sidechainReplaysDropped: 0, messageIdsReused: 0, userRows: 0,
    notPromptSidechain: 0, notPromptMeta: 0, notPromptCompactSummary: 0, notPromptToolResult: 0,
    notPromptEmpty: 0, notPromptOrigin: 0, notPromptInjected: 0, duplicatePromptRows: 0, summariesUnresolved: 0,
  };
  readonly files: ExtractedFile[] = [];
  readonly samples: Extraction['samples'] = {};
  totalBytes = 0;

  private readonly groups = new Map<string, Group>();
  private readonly prompts = new Map<string, PromptState>();
  private readonly sessions = new Map<string, SessionState>();
  /** Main-thread row uuid -> session, to attach `summary` rows (which only name a leaf uuid). */
  private readonly uuidSession = new Map<string, string>();
  private readonly summaries: Array<{ leaf: string; title: string }> = [];
  private reportedAt = 0;
  private cancelled = false;

  constructor(private readonly options: ExtractOptions) {}

  skip(source: TranscriptSource, info: TranscriptPathInfo): void {
    this.files.push({
      path: source.path ?? source.name, name: source.name, size: source.size,
      lastModified: source.lastModified, status: 'unchanged', subagent: info.isSubagent,
    });
  }

  async read(source: TranscriptSource, info: TranscriptPathInfo): Promise<void> {
    const report: ExtractedFile = {
      path: source.path ?? source.name, name: source.name, size: source.size,
      lastModified: source.lastModified, status: 'read', subagent: info.isSubagent,
    };
    const f: FileState = {
      index: this.files.length,
      base: info.base,
      subagent: info.isSubagent,
      session: info.sessionId ?? (info.stem !== '' ? info.stem : info.base),
      lastModified: source.lastModified,
      lastRawTime: undefined,
      waiting: [],
      gatewayRun: null,
      wrappedRuns: new Map(),
    };
    this.files.push(report);
    this.counters.filesRead++;
    if (info.isSubagent) this.counters.subagentFiles++;

    let lines: AsyncGenerator<string> | null = null;
    let lineNo = 0;
    try {
      for (;;) {
        let next: IteratorResult<string>;
        // Only failures of the read itself make a file "unreadable"; anything thrown
        // while handling a line is a bug and must surface.
        try {
          lines ??= readLines(source.blob.stream(), (chunk) => {
            this.counters.bytesRead += chunk.length;
          });
          next = await lines.next();
        } catch (err) {
          report.status = 'unreadable';
          report.error = err instanceof Error ? err.message : String(err);
          const code = (err as { code?: unknown } | null)?.code;
          if (typeof code === 'string') report.errorCode = code;
          this.counters.filesUnreadable++;
          this.samples.unreadableFile ??= `${info.base}: ${report.error}`;
          lines = null;
          break;
        }
        if (next.done) {
          lines = null;
          break;
        }
        lineNo++;
        this.line(next.value, lineNo, f);
        if (this.counters.bytesRead - this.reportedAt >= REPORT_EVERY_BYTES) this.report();
      }
    } finally {
      // Left early (cancelled): let go of the stream.
      if (lines !== null) await lines.return(undefined).catch(() => undefined);
    }
    // Rows still waiting for a timestamp: the file's modification time is the best
    // remaining bound; without one they cannot be placed in time at all.
    const fallback = f.lastModified !== undefined && f.lastModified >= MIN_TIME && f.lastModified <= MAX_TIME ? f.lastModified : NaN;
    for (const place of f.waiting) {
      if (Number.isNaN(fallback)) this.counters.rowsWithoutTimestamp++;
      else place(Math.trunc(fallback));
    }
  }

  /** Reports progress; `onProgress` may throw to cancel the extraction. */
  report(): void {
    this.reportedAt = this.counters.bytesRead;
    if (!this.options.onProgress || this.cancelled) return;
    try {
      this.options.onProgress({
        bytesRead: this.counters.bytesRead,
        totalBytes: Math.max(this.totalBytes, this.counters.bytesRead),
        usageRows: this.counters.usageRows,
      });
    } catch (err) {
      this.cancelled = true;
      throw err;
    }
  }

  private session(id: string): SessionState {
    let s = this.sessions.get(id);
    if (s === undefined) {
      s = {
        id, cwd: null, cwdFromSidechain: false, gitBranch: null, gitBranchFromSidechain: false,
        version: null, versionFromSidechain: false, customTitle: null, aiTitle: null, summaryTitle: null,
        sidechainUsage: false,
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  /**
   * Copied rows are attributed to the session they were copied from: `/branch` gives
   * the copy a new `sessionId` and records the original in `forkedFrom`.
   */
  private sessionOf(row: Json, outer: Json | null, f: FileState): SessionState {
    const forked = isObject(row.forkedFrom) ? text(row.forkedFrom.sessionId) : null;
    const outerForked = outer !== null && isObject(outer.forkedFrom) ? text(outer.forkedFrom.sessionId) : null;
    return this.session(forked ?? outerForked ?? text(row.sessionId) ?? (outer !== null ? text(outer.sessionId) : null) ?? f.session);
  }

  private line(line: string, lineNo: number, f: FileState): void {
    if (line.length === 0) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      row = undefined;
    }
    if (!isObject(row)) {
      if (line.trim() === '') return;
      // A torn last line is normal while a session is running; it is skipped and counted.
      this.counters.lines++;
      this.counters.malformedLines++;
      this.samples.malformedLine ??= `${f.base}:${lineNo}`;
      return;
    }
    this.counters.lines++;
    this.row(row, lineNo, f);
    // Remembered only after the row was handled, so a row never borrows its own bad timestamp.
    if (typeof row.timestamp === 'string' && row.timestamp.length >= 20) f.lastRawTime = row.timestamp;
  }

  private row(row: Json, lineNo: number, f: FileState): void {
    const type = row.type;
    if (type === 'summary') {
      const title = cleanTitle(row.summary);
      const leaf = text(row.leafUuid);
      const own = text(row.sessionId);
      if (title !== null) {
        if (own !== null) this.session(own).summaryTitle = title;
        else if (leaf !== null) this.summaries.push({ leaf, title });
      }
      return;
    }
    if (type === 'custom-title' || type === 'ai-title') {
      const title = cleanTitle(type === 'custom-title' ? row.customTitle : row.aiTitle);
      if (title !== null) {
        const s = this.session(text(row.sessionId) ?? f.session);
        if (type === 'custom-title') s.customTitle = title;
        else s.aiTitle = title;
      }
      return;
    }

    if (f.waiting.length > 0) {
      const ts = timeOf(row.timestamp);
      if (!Number.isNaN(ts)) {
        for (const place of f.waiting) place(ts);
        f.waiting.length = 0;
      }
    }

    const sidechain = row.isSidechain === true || f.subagent;
    let session: SessionState | null = null;
    if (typeof row.cwd === 'string' || typeof row.version === 'string' || typeof row.gitBranch === 'string') {
      session = this.sessionOf(row, null, f);
      this.noteEnvelope(session, row, sidechain);
    }

    if (type === 'assistant') {
      if (!sidechain) this.indexUuid(row, session ?? this.sessionOf(row, null, f));
      const message = row.message;
      if (isObject(message) && isObject(message.usage)) this.usageRow(row, null, message, sidechain, f, lineNo);
    } else if (type === 'user') {
      if (!sidechain) this.indexUuid(row, session ?? this.sessionOf(row, null, f));
      this.userRow(row, f);
    } else if (type === 'system') {
      if (!sidechain) this.indexUuid(row, session ?? this.sessionOf(row, null, f));
    } else if (type === 'progress') {
      // Old versions embedded each subagent message in the parent file as
      // { type: "progress", data: { message: { requestId, timestamp, message: { id, model, usage } } } }.
      // It has the same key as the row in the subagent file, so the two merge; when the
      // subagent file is gone, the wrapper is the only record of that usage.
      const inner = isObject(row.data) ? row.data.message : undefined;
      if (isObject(inner) && isObject(inner.message) && isObject(inner.message.usage)) {
        this.counters.progressRows++;
        this.usageRow(inner, row, inner.message, inner.isSidechain !== false, f, lineNo);
      }
    }
  }

  private noteEnvelope(s: SessionState, row: Json, sidechain: boolean): void {
    // A subagent can run in another directory (a worktree) or on another branch, so
    // main-thread rows decide; sidechain rows only fill what would otherwise be empty.
    const cwd = text(row.cwd);
    if (cwd !== null && (s.cwd === null || (s.cwdFromSidechain && !sidechain))) {
      s.cwd = cwd;
      s.cwdFromSidechain = sidechain;
    }
    const branch = text(row.gitBranch);
    if (branch !== null && (!sidechain || s.gitBranch === null || s.gitBranchFromSidechain)) {
      s.gitBranch = branch;
      s.gitBranchFromSidechain = sidechain;
    }
    const version = text(row.version);
    if (version !== null && (!sidechain || s.version === null || s.versionFromSidechain)) {
      s.version = version;
      s.versionFromSidechain = sidechain;
    }
  }

  private indexUuid(row: Json, session: SessionState): void {
    const uuid = text(row.uuid);
    if (uuid !== null) this.uuidSession.set(uuid, session.id);
  }

  /** Runs `place` with the row's timestamp, now or as soon as the file yields one. */
  private withTime(raw: unknown, f: FileState, place: (ts: number, inferred: boolean) => void): void {
    const own = timeOf(raw);
    if (!Number.isNaN(own)) return place(own, false);
    const previous = timeOf(f.lastRawTime);
    if (!Number.isNaN(previous)) return place(previous, true);
    f.waiting.push((ts) => place(ts, true));
  }

  private usageRow(env: Json, outer: Json | null, message: Json, sidechain: boolean, f: FileState, lineNo: number): void {
    this.counters.usageRows++;
    const model = text(message.model);
    // Locally generated messages (API errors and the like): no request was billed.
    if (model !== null && model.trim().toLowerCase() === '<synthetic>') {
      this.counters.syntheticRows++;
      return;
    }
    const usage = message.usage as Json;
    if (count(usage.input_tokens) === null && count(usage.output_tokens) === null) {
      this.counters.usageRowsWithoutCounts++;
      return;
    }

    let flags = sidechain ? ResponseFlag.SIDECHAIN : 0;
    const stop = message.stop_reason;
    if (stop === null || stop === undefined) flags |= ResponseFlag.PARTIAL;
    if (stop === 'tool_use') flags |= ResponseFlag.TOOL_USE;
    else if (Array.isArray(message.content)) {
      for (const block of message.content as unknown[]) {
        if (isObject(block) && block.type === 'tool_use') {
          flags |= ResponseFlag.TOOL_USE;
          break;
        }
      }
    }
    if (typeof usage.speed === 'string') {
      flags |= ResponseFlag.HAS_SPEED;
      if (usage.speed === 'fast') flags |= ResponseFlag.FAST;
    }
    if (env.isUnmetered === true) flags |= ResponseFlag.UNMETERED;
    if (env.isVirtual === true) flags |= ResponseFlag.VIRTUAL;

    const session = this.sessionOf(env, outer, f);
    const rec: ResponseRecord = {
      key: '',
      sessionId: session.id,
      model,
      ts: 0,
      lastTs: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
      thinking: isObject(usage.output_tokens_details) ? (count(usage.output_tokens_details.thinking_tokens) ?? 0) : 0,
      webSearch: isObject(usage.server_tool_use) ? (count(usage.server_tool_use.web_search_requests) ?? 0) : 0,
      flags,
      serviceTier: text(usage.service_tier),
      geo: text(usage.inference_geo),
      extras: readIterations(usage.iterations),
    };
    if (readTokens(usage, rec)) rec.flags |= ResponseFlag.CACHE_TTL_UNKNOWN;

    const messageId = text(message.id);
    const requestId = text(env.requestId);
    const ownUuid = text(env.uuid);
    const outerUuid = outer !== null ? text(outer.uuid) : null;

    // Only an id issued by Anthropic names a response; any other is recognised by its lines standing together.
    const named = messageId !== null && isAnthropicMessageId(messageId);
    let run: GatewayRun | null;
    if (outer === null) {
      run = named ? null : this.joinRun(f.gatewayRun, session.id, messageId, requestId, rec);
      // A usage row of any other response ends the run that was open.
      f.gatewayRun = run;
    } else if (named) {
      run = null;
    } else {
      // A wrapped row: the wrappers of subagents that ran side by side are interleaved, so the run is
      // looked up by session and id rather than taken from the line before. Rows without an id have
      // nothing to be looked up by and only continue the wrapped row directly before them.
      const key = `${session.id}\u0000${messageId ?? ''}`;
      const idless = `${session.id}\u0000`;
      if (key !== idless) f.wrappedRuns.delete(idless);
      run = this.joinRun(f.wrappedRuns.get(key) ?? null, session.id, messageId, requestId, rec);
      f.wrappedRuns.set(key, run);
    }

    // A wrapped message without its own timestamp was written when its wrapper was.
    const rawTime = outer !== null && Number.isNaN(timeOf(env.timestamp)) ? outer.timestamp : env.timestamp;
    this.withTime(rawTime, f, (ts, inferred) => {
      rec.ts = ts;
      rec.lastTs = ts;
      if (inferred) rec.flags |= ResponseFlag.TIMESTAMP_INFERRED;
      if (requestId === null) rec.flags |= ResponseFlag.NO_REQUEST_ID;
      if (messageId === null) rec.flags |= ResponseFlag.NO_MESSAGE_ID;
      if (run === null) {
        // In whatever file the response is repeated, and whether or not the row still carries its request
        // id: rows that Claude Code copies into the transcript of a session that moved to another folder
        // keep everything but the request id.
        rec.key = `m:${messageId}`;
      } else {
        // Fixed by the first line of the run. A copy keeps the row uuid and the timestamp; the position
        // in the file is the last resort and only survives reading that same file again.
        run.key ??=
          ownUuid !== null ? `u:${ownUuid}`
          : !inferred ? `mst:${session.id}:${messageId ?? ''}:${ts}`
          : outerUuid !== null ? `u:${outerUuid}`
          : `line:${f.base}:${lineNo}`;
        rec.key = run.key;
      }
      this.admit(rec, requestId, f.index);
      if ((rec.flags & ResponseFlag.SIDECHAIN) !== 0) session.sidechainUsage = true;
    });
  }

  /** The run of lines this usage row belongs to: the open one it continues, or a new one (see GatewayRun). */
  private joinRun(open: GatewayRun | null, session: string, messageId: string | null, requestId: string | null, rec: ResponseRecord): GatewayRun {
    const partial = (rec.flags & ResponseFlag.PARTIAL) !== 0;
    if (open !== null && open.session === session && open.messageId === messageId) {
      const sameResponse =
        open.requestId !== null && requestId !== null ? open.requestId === requestId : open.partial || partial || sameCounts(open.usage, rec);
      if (sameResponse) {
        open.requestId ??= requestId;
        if (!partial) {
          open.partial = false;
          open.usage = countsOf(rec);
        }
        return open;
      }
    }
    return { session, messageId, requestId, usage: countsOf(rec), partial, key: null };
  }

  private admit(rec: ResponseRecord, requestId: string | null, file: number): void {
    const g = this.groups.get(rec.key);
    if (g === undefined) {
      this.groups.set(rec.key, { rec, keptTs: rec.ts, file, moreFiles: null, requestId, replayId: null });
      return;
    }
    // Another line (or copy) of a response already seen: keep the more complete one, never add.
    this.counters.duplicateLines++;
    addFile(g, file);
    const kept = g.rec;
    // The same response under a second request id is a replay: a sidechain file repeating a message of its
    // parent (seen with `/btw` side questions). It was billed once. Reported, and counted once like any copy.
    if (requestId !== null) {
      if (g.requestId === null) g.requestId = requestId;
      else if (requestId !== g.requestId && requestId !== g.replayId) {
        g.replayId = requestId;
        if (((kept.flags | rec.flags) & ResponseFlag.SIDECHAIN) !== 0) this.counters.sidechainReplaysDropped++;
        else {
          this.counters.messageIdsReused++;
          kept.flags |= ResponseFlag.MESSAGE_ID_REUSED;
          rec.flags |= ResponseFlag.MESSAGE_ID_REUSED;
        }
      }
    }
    const ts = Math.min(kept.ts, rec.ts);
    const lastTs = Math.max(kept.lastTs, rec.lastTs);
    const groupFlags = (kept.flags | rec.flags) & GROUP_FLAGS;
    // A request id on any row of the response is enough to know it.
    const noRequestId = kept.flags & rec.flags & ResponseFlag.NO_REQUEST_ID;
    // Equally complete lines: the earliest wins, then the first file in sorted order (already held).
    if (outranks(rec, kept) || (!outranks(kept, rec) && rec.ts < g.keptTs)) {
      g.keptTs = rec.ts;
      rec.key = kept.key;
      g.rec = rec;
    }
    g.rec.ts = ts;
    g.rec.lastTs = lastTs;
    g.rec.flags = (g.rec.flags & ~(GROUP_FLAGS | ResponseFlag.NO_REQUEST_ID)) | groupFlags | noRequestId;
  }

  private userRow(row: Json, f: FileState): void {
    this.counters.userRows++;
    // Whatever the person or a tool sent back, the response before it is over.
    f.gatewayRun = null;
    const verdict = classifyUserRow(row, f.subagent);
    if (verdict.excluded !== undefined) {
      const c = this.counters;
      if (verdict.excluded === 'sidechain') c.notPromptSidechain++;
      else if (verdict.excluded === 'meta') c.notPromptMeta++;
      else if (verdict.excluded === 'compact_summary') c.notPromptCompactSummary++;
      else if (verdict.excluded === 'tool_result') c.notPromptToolResult++;
      else if (verdict.excluded === 'empty') c.notPromptEmpty++;
      else if (verdict.excluded === 'origin') c.notPromptOrigin++;
      else c.notPromptInjected++;
      return;
    }
    const kind = verdict.prompt;
    const session = this.sessionOf(row, null, f);
    const uuid = text(row.uuid);
    this.withTime(row.timestamp, f, (ts) => {
      const key = uuid !== null ? `p:${uuid}` : `p:${session.id}:${ts}`;
      const seen = this.prompts.get(key);
      if (seen !== undefined) {
        this.counters.duplicatePromptRows++;
        addFile(seen, f.index);
        if (ts < seen.rec.ts) seen.rec.ts = ts;
        return;
      }
      this.prompts.set(key, { rec: { key, sessionId: session.id, ts, kind }, file: f.index, moreFiles: null });
    });
  }

  finish(): Extraction {
    // `summary` rows name the last message they summarise, which is often in another
    // file (older versions wrote summaries of earlier sessions at the top of the next
    // one). A summary whose leaf was not read belongs to a session we do not have.
    for (const { leaf, title } of this.summaries) {
      const owner = this.uuidSession.get(leaf);
      if (owner === undefined) this.counters.summariesUnresolved++;
      else this.session(owner).summaryTitle = title;
    }
    const groups = [...this.groups.values()];
    groups.sort((a, b) => a.rec.ts - b.rec.ts || (a.rec.key < b.rec.key ? -1 : a.rec.key > b.rec.key ? 1 : 0));
    const prompts = [...this.prompts.values()];
    prompts.sort((a, b) => a.rec.ts - b.rec.ts || (a.rec.key < b.rec.key ? -1 : a.rec.key > b.rec.key ? 1 : 0));

    const sessions = new Map<string, SessionInfo>();
    const note = (id: string) => {
      if (sessions.has(id)) return;
      const s = this.session(id);
      const titleKind: TitleKind | null =
        s.customTitle !== null ? 'custom' : s.aiTitle !== null ? 'ai' : s.summaryTitle !== null ? 'summary' : null;
      sessions.set(id, {
        id,
        // A title the person chose beats a generated one; `summary` is the oldest mechanism.
        title: s.customTitle ?? s.aiTitle ?? s.summaryTitle,
        titleKind,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        version: s.version,
        hasSubagents: s.sidechainUsage,
      });
    };

    const responseMoreFiles = new Map<number, number[]>();
    const promptMoreFiles = new Map<number, number[]>();
    groups.forEach((g, i) => {
      note(g.rec.sessionId);
      if (g.moreFiles !== null) responseMoreFiles.set(i, g.moreFiles);
    });
    prompts.forEach((p, i) => {
      note(p.rec.sessionId);
      if (p.moreFiles !== null) promptMoreFiles.set(i, p.moreFiles);
    });

    return {
      responses: groups.map((g) => g.rec),
      prompts: prompts.map((p) => p.rec),
      sessions,
      files: this.files,
      responseFile: groups.map((g) => g.file),
      promptFile: prompts.map((p) => p.file),
      responseMoreFiles,
      promptMoreFiles,
      counters: this.counters,
      samples: this.samples,
    };
  }
}

const byPath = (a: { info: TranscriptPathInfo }, b: { info: TranscriptPathInfo }) =>
  a.info.path < b.info.path ? -1 : a.info.path > b.info.path ? 1 : 0;

/**
 * Reads every transcript among `files` and returns the de-duplicated responses and
 * prompts. Files are read one at a time, in path order, as streams.
 */
export async function extractTranscripts(files: readonly TranscriptSource[], options: ExtractOptions = {}): Promise<Extraction> {
  const reader = new TranscriptReader(options);
  const entries = files
    .map((source) => ({ source, info: transcriptPathInfo(source.path ?? source.name) }))
    .filter((e) => e.info.isTranscript)
    .sort(byPath);
  reader.counters.filesGiven = files.length;
  reader.counters.transcriptFiles = entries.length;
  reader.counters.filesIgnored = files.length - entries.length;

  const unchanged = (source: TranscriptSource): boolean => {
    const known = options.knownFiles?.get(source.path ?? source.name);
    return (
      known !== undefined &&
      source.lastModified !== undefined &&
      known.size === source.size &&
      // The database keeps milliseconds; file systems may report fractions of one.
      Math.abs(known.lastModified - source.lastModified) < 1
    );
  };
  const toRead = entries.filter((e) => !unchanged(e.source));
  const skipped = entries.filter((e) => unchanged(e.source));
  reader.totalBytes = toRead.reduce((sum, e) => sum + e.source.size, 0);
  for (const e of toRead) await reader.read(e.source, e.info);

  // An unchanged file never needs reading again, not even for context: a response keeps one key in
  // whatever file it is repeated, so a copy in a file read now is recognised against what earlier
  // imports counted.
  for (const e of skipped) {
    reader.counters.filesSkippedUnchanged++;
    reader.skip(e.source, e.info);
  }
  reader.report();
  return reader.finish();
}

export interface Deferral {
  responses: ResponseRecord[];
  prompts: PromptRecord[];
  deferredResponses: number;
  deferredPrompts: number;
  /** Indexes (into `Extraction.files`) of files that hold deferred records and must be read again. */
  hotFiles: Set<number>;
}

/**
 * Sets aside what may still be changing. A response that is still streaming has
 * `stop_reason: null` and a recent last line; counting it now would freeze a partial
 * output count, because a response is only ever counted once. It is left for the next
 * run instead. A just-submitted prompt whose answer is not there yet waits with it,
 * so that it can be attributed to the model that answers.
 */
export function deferInProgress(
  x: Pick<Extraction, 'responses' | 'prompts'> & Partial<Pick<Extraction, 'responseFile' | 'promptFile' | 'responseMoreFiles' | 'promptMoreFiles'>>,
  now: number,
  windowMs = IN_PROGRESS_WINDOW_MS,
): Deferral {
  const hotFiles = new Set<number>();
  const mark = (first: number[] | undefined, more: Map<number, number[]> | undefined, index: number) => {
    if (first !== undefined && first[index] !== undefined) hotFiles.add(first[index]);
    for (const file of more?.get(index) ?? []) hotFiles.add(file);
  };

  const responses: ResponseRecord[] = [];
  let deferredResponses = 0;
  x.responses.forEach((r, i) => {
    if ((r.flags & ResponseFlag.PARTIAL) !== 0 && now - r.lastTs < windowMs) {
      deferredResponses++;
      mark(x.responseFile, x.responseMoreFiles, i);
    } else responses.push(r);
  });

  let answeredUntil: Map<string, number> | null = null;
  const prompts: PromptRecord[] = [];
  let deferredPrompts = 0;
  x.prompts.forEach((p, i) => {
    if (now - p.ts >= windowMs) return void prompts.push(p);
    if (answeredUntil === null) {
      // Latest main-thread response that is being counted, per session.
      answeredUntil = new Map();
      for (const r of responses) {
        if ((r.flags & ResponseFlag.SIDECHAIN) !== 0) continue;
        if (r.ts > (answeredUntil.get(r.sessionId) ?? -Infinity)) answeredUntil.set(r.sessionId, r.ts);
      }
    }
    if ((answeredUntil.get(p.sessionId) ?? -Infinity) >= p.ts) prompts.push(p);
    else {
      deferredPrompts++;
      mark(x.promptFile, x.promptMoreFiles, i);
    }
  });
  return { responses, prompts, deferredResponses, deferredPrompts, hotFiles };
}
