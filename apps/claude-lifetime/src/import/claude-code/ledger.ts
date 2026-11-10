import {
  outranks,
  ResponseFlag,
  type IterationRecord,
  type PromptKindCode,
  type PromptRecord,
  type ResponseRecord,
  type SessionInfo,
  type TitleKind,
} from './extract';

/**
 * The collector's ledger: a compact record of Claude Code usage that outlives the
 * transcripts it was read from (Claude Code deletes those after 30 days by default).
 *
 * It holds one row per API response and one per human prompt, already de-duplicated,
 * and never any message text: ids, timestamps, model names and counters, plus each
 * session's title, working directory and git branch.
 *
 * The file is JSON, written with one row per line so it can be inspected and diffed:
 *
 *   {
 *     "format": "claude-lifetime/claude-code-ledger",
 *     "version": 1,
 *     "generatedAt": "2026-11-10T12:00:00.000Z",      when the file was last written
 *     "machine": "alex-laptop",                       host name of the computer it was collected on
 *     "collector": "1.0.0",                           version of the tool that wrote it
 *     "columns": { "responses": [...], "extras": [...], "prompts": [...] },   names of the row positions
 *     "flags": { "SIDECHAIN": 1, "PARTIAL": 2, ... }, meaning of the bits in a response's `flags`
 *     "models": ["claude-sonnet-4-5-20250929"],       model ids exactly as Claude Code wrote them
 *     "serviceTiers": ["standard"],                   usage.service_tier values
 *     "geos": ["global"],                             usage.inference_geo values
 *     "sessions": {
 *       "<sessionId>": { "i": 0, "title": "...", "titleKind": "ai", "cwd": "/home/alex/demo",
 *                        "gitBranch": "main", "version": "2.1.321", "subagents": true }
 *     },
 *     "responses": [
 *       [key, session, model, ts, input, output, cacheRead, cacheWrite5m, cacheWrite1h,
 *        thinking, webSearch, flags, serviceTier, geo, extras?]
 *     ],
 *     "prompts": [
 *       [key, session, ts, kind]
 *     ]
 *   }
 *
 * Response row: `key` identifies the response (`m:<message.id>` for an id issued by
 * Anthropic, and the fallbacks of extract.ts); `session` is the `i` of an entry in `sessions`; `model`,
 * `serviceTier` and `geo` are indexes into the tables above (-1: not stated); `ts` is
 * epoch milliseconds (UTC) of the response's first line; the counters are tokens
 * (`thinking` is a share of `output`); `flags` is a bitmask of ResponseFlag. Raw facts
 * are stored rather than derived ones (speed and service tier, not a price tier), so
 * that pricing rules can change without the ledger going stale.
 * `extras`, present only when the API reported further attempts under usage.iterations,
 * lists them as [iterationIndex, type, model, input, output, cacheRead, cacheWrite5m,
 * cacheWrite1h, cacheTtlUnknown (0|1)].
 * Prompt row: `key` is `p:<row uuid>`; `kind` is 0 typed, 1 slash command, 2 shell command.
 * Optional session fields are omitted when unknown.
 */
export const LEDGER_FORMAT = 'claude-lifetime/claude-code-ledger';
export const LEDGER_VERSION = 1;

const RESPONSE_COLUMNS = [
  'key', 'session', 'model', 'ts', 'input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h',
  'thinking', 'webSearch', 'flags', 'serviceTier', 'geo', 'extras?',
];
const EXTRA_COLUMNS = ['iterationIndex', 'type', 'model', 'input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheTtlUnknown'];
const PROMPT_COLUMNS = ['key', 'session', 'ts', 'kind'];

export type LedgerErrorCode = 'not_a_ledger' | 'unsupported_version' | 'corrupt';

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: LedgerErrorCode,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** A ledger in memory, keyed for merging. */
export interface Ledger {
  generatedAt: string | null;
  machine: string;
  collector: string | null;
  responses: Map<string, ResponseRecord>;
  prompts: Map<string, PromptRecord>;
  sessions: Map<string, SessionInfo>;
}

export function emptyLedger(): Ledger {
  return { generatedAt: null, machine: '', collector: null, responses: new Map(), prompts: new Map(), sessions: new Map() };
}

/**
 * Cheap test on the beginning of a file: is this a ledger rather than something else?
 * The collector writes `format` as the first entry of the document, and only there does it
 * count. Anywhere else the same words can be data: a transcript of a session in which
 * Claude Code read a ledger holds them inside a tool result.
 */
export function looksLikeLedger(head: string): boolean {
  return /^\uFEFF?\s*\{\s*"format"\s*:\s*"claude-lifetime\/claude-code-ledger"/.test(head);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const optionalText = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const TITLE_KINDS: readonly unknown[] = ['custom', 'ai', 'summary'];

function stringTable(doc: Json, name: string): string[] {
  const v = doc[name];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new LedgerError(`The ledger's "${name}" table is damaged.`, 'corrupt');
  return v as string[];
}

/** Looks up an index written by serialiseLedger; -1 means "not stated". */
function lookup(table: string[], index: unknown, what: string, row: number): string | null {
  if (index === -1) return null;
  if (!isCount(index) || index >= table.length) throw new LedgerError(`Response row ${row} of the ledger refers to an unknown ${what}.`, 'corrupt');
  return table[index];
}

/**
 * Parses and validates a ledger. A file this function rejects is never half-used:
 * a damaged ledger must be noticed, not silently imported as less than it held.
 */
export function parseLedger(text: string): Ledger {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    if (!looksLikeLedger(text.slice(0, 4096))) throw new LedgerError('This file is not a Claude Lifetime ledger.', 'not_a_ledger');
    throw new LedgerError(`The ledger is not valid JSON (${err instanceof Error ? err.message : String(err)}).`, 'corrupt');
  }
  if (!isObject(doc) || doc.format !== LEDGER_FORMAT) throw new LedgerError('This file is not a Claude Lifetime ledger.', 'not_a_ledger');
  if (doc.version !== LEDGER_VERSION) {
    throw new LedgerError(
      `This ledger has format version ${String(doc.version)}, but this version of Claude Lifetime reads version ${LEDGER_VERSION}. ` +
        'It was probably written by a newer collector.',
      'unsupported_version',
    );
  }
  const models = stringTable(doc, 'models');
  const serviceTiers = stringTable(doc, 'serviceTiers');
  const geos = stringTable(doc, 'geos');

  const ledger = emptyLedger();
  ledger.generatedAt = optionalText(doc.generatedAt);
  ledger.machine = optionalText(doc.machine) ?? '';
  ledger.collector = optionalText(doc.collector);

  const sessionIds: string[] = [];
  if (!isObject(doc.sessions)) throw new LedgerError('The ledger has no "sessions" table.', 'corrupt');
  for (const [id, raw] of Object.entries(doc.sessions)) {
    if (!isObject(raw) || !isCount(raw.i) || sessionIds[raw.i] !== undefined || id === '') {
      throw new LedgerError(`Session "${id}" of the ledger is damaged.`, 'corrupt');
    }
    sessionIds[raw.i] = id;
    const titleKind = TITLE_KINDS.includes(raw.titleKind) ? (raw.titleKind as TitleKind) : null;
    const title = optionalText(raw.title);
    ledger.sessions.set(id, {
      id,
      title,
      titleKind: title === null ? null : (titleKind ?? 'summary'),
      cwd: optionalText(raw.cwd),
      gitBranch: optionalText(raw.gitBranch),
      version: optionalText(raw.version),
      hasSubagents: raw.subagents === true,
    });
  }
  const sessionAt = (index: unknown, kind: string, row: number): string => {
    const id = isCount(index) ? sessionIds[index] : undefined;
    if (id === undefined) throw new LedgerError(`${kind} row ${row} of the ledger refers to an unknown session.`, 'corrupt');
    return id;
  };

  if (!Array.isArray(doc.responses) || !Array.isArray(doc.prompts)) throw new LedgerError('The ledger has no "responses" or "prompts" list.', 'corrupt');
  (doc.responses as unknown[]).forEach((row, n) => {
    if (!Array.isArray(row) || row.length < 14 || typeof row[0] !== 'string' || row[0] === '') {
      throw new LedgerError(`Response row ${n} of the ledger is damaged.`, 'corrupt');
    }
    for (const at of [3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      if (!isCount(row[at])) throw new LedgerError(`Response row ${n} of the ledger is damaged.`, 'corrupt');
    }
    let extras: IterationRecord[] | null = null;
    if (row[14] !== undefined) {
      if (!Array.isArray(row[14])) throw new LedgerError(`Response row ${n} of the ledger is damaged.`, 'corrupt');
      extras = (row[14] as unknown[]).map((e) => {
        if (!Array.isArray(e) || e.length < 9 || !isCount(e[0]) || typeof e[1] !== 'string' || ![3, 4, 5, 6, 7].every((at) => isCount(e[at]))) {
          throw new LedgerError(`Response row ${n} of the ledger is damaged.`, 'corrupt');
        }
        return {
          index: e[0], type: e[1], model: lookup(models, e[2], 'model', n),
          input: e[3], output: e[4], cacheRead: e[5], cacheWrite5m: e[6], cacheWrite1h: e[7], cacheTtlUnknown: e[8] === 1,
        };
      });
      if (extras.length === 0) extras = null;
    }
    const rec: ResponseRecord = {
      key: row[0],
      sessionId: sessionAt(row[1], 'Response', n),
      model: lookup(models, row[2], 'model', n),
      ts: row[3],
      // The ledger keeps one timestamp; rows in it were complete when they were collected.
      lastTs: row[3],
      input: row[4], output: row[5], cacheRead: row[6], cacheWrite5m: row[7], cacheWrite1h: row[8],
      thinking: row[9], webSearch: row[10], flags: row[11],
      serviceTier: lookup(serviceTiers, row[12], 'service tier', n),
      geo: lookup(geos, row[13], 'region', n),
      extras,
    };
    const held = ledger.responses.get(rec.key);
    if (held === undefined || outranks(rec, held)) ledger.responses.set(rec.key, rec);
  });
  (doc.prompts as unknown[]).forEach((row, n) => {
    if (!Array.isArray(row) || row.length < 4 || typeof row[0] !== 'string' || row[0] === '' || !isCount(row[2]) || ![0, 1, 2].includes(row[3] as number)) {
      throw new LedgerError(`Prompt row ${n} of the ledger is damaged.`, 'corrupt');
    }
    const rec: PromptRecord = { key: row[0], sessionId: sessionAt(row[1], 'Prompt', n), ts: row[2], kind: row[3] as PromptKindCode };
    if (!ledger.prompts.has(rec.key)) ledger.prompts.set(rec.key, rec);
  });
  return ledger;
}

const byTimeThenKey = (a: { ts: number; key: string }, b: { ts: number; key: string }) =>
  a.ts - b.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The ledger's records in time order, as the aggregation step takes them. */
export function ledgerRecords(ledger: Ledger): { responses: ResponseRecord[]; prompts: PromptRecord[]; sessions: Map<string, SessionInfo> } {
  return {
    responses: [...ledger.responses.values()].sort(byTimeThenKey),
    prompts: [...ledger.prompts.values()].sort(byTimeThenKey),
    sessions: ledger.sessions,
  };
}

/** Interns strings in order of first use. */
class Table {
  readonly values: string[] = [];
  private readonly index = new Map<string, number>();
  of(value: string | null): number {
    if (value === null) return -1;
    let i = this.index.get(value);
    if (i === undefined) {
      i = this.values.length;
      this.values.push(value);
      this.index.set(value, i);
    }
    return i;
  }
}

const ROWS_PER_CHUNK = 2000;

/**
 * Writes the ledger as JSON text, in pieces, so a ledger of any size can be written
 * without building one giant string. The output is deterministic for the same records.
 */
export function* serialiseLedger(
  ledger: Ledger,
  header: { generatedAt: string; machine: string; collector: string },
): Generator<string> {
  const { responses, prompts } = ledgerRecords(ledger);
  const models = new Table();
  const serviceTiers = new Table();
  const geos = new Table();
  const sessions = new Table();

  // Tables come before the rows in the file, so the rows are encoded first.
  const responseRows = responses.map((r) => {
    const row: unknown[] = [
      r.key, sessions.of(r.sessionId), models.of(r.model), r.ts,
      r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h,
      r.thinking, r.webSearch, r.flags, serviceTiers.of(r.serviceTier), geos.of(r.geo),
    ];
    if (r.extras !== null && r.extras.length > 0) {
      row.push(r.extras.map((e) => [e.index, e.type, models.of(e.model), e.input, e.output, e.cacheRead, e.cacheWrite5m, e.cacheWrite1h, e.cacheTtlUnknown ? 1 : 0]));
    }
    return JSON.stringify(row);
  });
  const promptRows = prompts.map((p) => JSON.stringify([p.key, sessions.of(p.sessionId), p.ts, p.kind]));

  const head: Json = {
    format: LEDGER_FORMAT,
    version: LEDGER_VERSION,
    generatedAt: header.generatedAt,
    machine: header.machine,
    collector: header.collector,
    columns: { responses: RESPONSE_COLUMNS, extras: EXTRA_COLUMNS, prompts: PROMPT_COLUMNS },
    flags: ResponseFlag,
    models: models.values,
    serviceTiers: serviceTiers.values,
    geos: geos.values,
  };
  let out = '{\n';
  for (const [name, value] of Object.entries(head)) out += `${JSON.stringify(name)}: ${JSON.stringify(value)},\n`;
  out += '"sessions": {\n';
  sessions.values.forEach((id, i) => {
    const info = ledger.sessions.get(id);
    const entry: Json = { i };
    if (info?.title) {
      entry.title = info.title;
      entry.titleKind = info.titleKind ?? 'summary';
    }
    if (info?.cwd) entry.cwd = info.cwd;
    if (info?.gitBranch) entry.gitBranch = info.gitBranch;
    if (info?.version) entry.version = info.version;
    if (info?.hasSubagents) entry.subagents = true;
    out += `${JSON.stringify(id)}: ${JSON.stringify(entry)}${i < sessions.values.length - 1 ? ',' : ''}\n`;
  });
  out += '},\n"responses": [\n';
  yield out;
  for (let i = 0; i < responseRows.length; i += ROWS_PER_CHUNK) {
    const end = Math.min(i + ROWS_PER_CHUNK, responseRows.length);
    yield `${responseRows.slice(i, end).join(',\n')}${end < responseRows.length ? ',' : ''}\n`;
  }
  yield '],\n"prompts": [\n';
  for (let i = 0; i < promptRows.length; i += ROWS_PER_CHUNK) {
    const end = Math.min(i + ROWS_PER_CHUNK, promptRows.length);
    yield `${promptRows.slice(i, end).join(',\n')}${end < promptRows.length ? ',' : ''}\n`;
  }
  yield ']\n}\n';
}

export interface MergeReport {
  responsesAdded: number;
  /** Responses already in the ledger for which a more complete record was found. */
  responsesImproved: number;
  promptsAdded: number;
  sessionsChanged: number;
  /** False when the ledger already held everything. */
  changed: boolean;
}

/** A title the person chose beats a generated one; `summary` is the oldest mechanism. */
const TITLE_RANK: Record<TitleKind, number> = { summary: 1, ai: 2, custom: 3 };

function mergeSession(held: SessionInfo | undefined, seen: SessionInfo): SessionInfo {
  if (held === undefined) return { ...seen };
  // The newest reading wins among titles of the same kind (a session can be renamed).
  const takeTitle =
    seen.title !== null && (held.title === null || TITLE_RANK[seen.titleKind ?? 'summary'] >= TITLE_RANK[held.titleKind ?? 'summary']);
  return {
    id: held.id,
    title: takeTitle ? seen.title : held.title,
    titleKind: takeTitle ? seen.titleKind : held.titleKind,
    cwd: held.cwd ?? seen.cwd,
    gitBranch: seen.gitBranch ?? held.gitBranch,
    version: seen.version ?? held.version,
    hasSubagents: held.hasSubagents || seen.hasSubagents,
  };
}

const sameSession = (a: SessionInfo, b: SessionInfo) =>
  a.title === b.title && a.titleKind === b.titleKind && a.cwd === b.cwd && a.gitBranch === b.gitBranch &&
  a.version === b.version && a.hasSubagents === b.hasSubagents;

/** Flags that describe the whole response; they accumulate over everything seen of it. */
const STICKY_FLAGS = ResponseFlag.TOOL_USE | ResponseFlag.TIMESTAMP_INFERRED | ResponseFlag.UNMETERED | ResponseFlag.VIRTUAL | ResponseFlag.MESSAGE_ID_REUSED;

/**
 * Adds freshly read records to a ledger. Nothing is ever removed: a record stays even
 * when its transcript is gone, which is the point of the ledger. When a response is
 * seen again, the more complete record is kept (same rule as inside one read).
 */
export function mergeIntoLedger(
  ledger: Ledger,
  fresh: { responses: Iterable<ResponseRecord>; prompts: Iterable<PromptRecord>; sessions: ReadonlyMap<string, SessionInfo> },
): MergeReport {
  const report: MergeReport = { responsesAdded: 0, responsesImproved: 0, promptsAdded: 0, sessionsChanged: 0, changed: false };
  for (const r of fresh.responses) {
    const held = ledger.responses.get(r.key);
    if (held === undefined) {
      ledger.responses.set(r.key, r);
      report.responsesAdded++;
      continue;
    }
    const ts = Math.min(held.ts, r.ts);
    const sticky = (held.flags | r.flags) & STICKY_FLAGS;
    // A request id on any copy of the response is enough to know it.
    const noRequestId = held.flags & r.flags & ResponseFlag.NO_REQUEST_ID;
    const better = outranks(r, held);
    const kept = better ? r : held;
    const flags = (kept.flags & ~(STICKY_FLAGS | ResponseFlag.NO_REQUEST_ID)) | sticky | noRequestId;
    if (better) {
      ledger.responses.set(r.key, { ...r, ts, lastTs: Math.max(held.lastTs, r.lastTs), flags });
      report.responsesImproved++;
    } else if (ts !== held.ts || flags !== held.flags) {
      held.ts = ts;
      held.flags = flags;
      report.responsesImproved++;
    }
  }
  for (const p of fresh.prompts) {
    if (ledger.prompts.has(p.key)) continue;
    ledger.prompts.set(p.key, p);
    report.promptsAdded++;
  }
  // Session details are only kept for sessions that have rows.
  const referenced = new Set<string>();
  for (const r of ledger.responses.values()) referenced.add(r.sessionId);
  for (const p of ledger.prompts.values()) referenced.add(p.sessionId);
  for (const [id, seen] of fresh.sessions) {
    if (!referenced.has(id)) continue;
    const held = ledger.sessions.get(id);
    const merged = mergeSession(held, seen);
    if (held === undefined || !sameSession(held, merged)) {
      ledger.sessions.set(id, merged);
      report.sessionsChanged++;
    }
  }
  report.changed = report.responsesAdded + report.responsesImproved + report.promptsAdded + report.sessionsChanged > 0;
  return report;
}
