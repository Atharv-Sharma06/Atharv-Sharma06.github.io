/**
 * Reading single values (timestamps, counts, price tiers) from files people made
 * themselves. Everything here is strict on purpose: a value that could mean two
 * things is rejected and shown to the user rather than guessed.
 */

export type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Short single-line excerpt of a value for a warning's `sample`. */
export function clip(value: unknown, max = 60): string {
  const text = (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Excerpt of a cell for a warning. A value that was expected to be a timestamp, a
 * number or a model name is short; a long one is a column of free text mapped by
 * mistake, and its content does not belong in a warning that is stored.
 */
export function sampleOf(value: unknown, max = 40): string {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text === '') return '(empty)';
    return text.length <= max ? text : `text of ${text.length} characters`;
  }
  if (value === null || value === undefined) return '(empty)';
  return clip(value, max);
}

// ── Timestamps ────────────────────────────────────────────────────────────────

export interface ParsedTimestamp {
  /** Milliseconds since the Unix epoch, UTC. */
  ms: number;
  /** The value named a calendar day only (YYYY-MM-DD), so it stands for the whole UTC day. */
  dateOnly: boolean;
}

/**
 * ISO 8601 / RFC 3339 as people and tools actually write it: "T" or a space between
 * date and time, seconds and fractions optional, and an optional zone (Z, UTC, +02,
 * +02:00, +0200). Without a zone the time is taken as UTC — the app keeps all usage
 * in UTC, and reading zone-less values in the browser's local zone would make the
 * same file import differently on two computers.
 */
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?)?)?$/i;

const EPOCH = /^\d{1,16}(?:\.\d+)?$/;

/**
 * Numbers below this are read as seconds, larger ones as milliseconds. As seconds
 * it is the year 5138 and as milliseconds 1973, so no real timestamp is ambiguous.
 */
const EPOCH_MS_FROM = 1e11;

function fromEpoch(n: number): number | null {
  if (!Number.isFinite(n) || n < 0) return null;
  const ms = n < EPOCH_MS_FROM ? n * 1000 : n;
  return ms <= 8.64e15 ? Math.floor(ms) : null;
}

/**
 * Accepts ISO 8601 date-times, plain dates (UTC midnight), and Unix epoch seconds
 * or milliseconds (as a number or a string of digits). Returns null for anything
 * else, including day-first or month-first dates such as 03/04/2025, which cannot
 * be told apart.
 */
export function parseTimestamp(value: unknown): ParsedTimestamp | null {
  if (typeof value === 'number') {
    const ms = fromEpoch(value);
    return ms === null ? null : { ms, dateOnly: false };
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;

  if (EPOCH.test(text)) {
    const ms = fromEpoch(Number(text));
    return ms === null ? null : { ms, dateOnly: false };
  }

  const m = ISO.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dateOnly = m[4] === undefined;
  const hour = dateOnly ? 0 : Number(m[4]);
  const minute = dateOnly ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  // Date.UTC rolls an impossible day (30 February) over into the next month.
  if (new Date(utc).getUTCDate() !== day) return null;

  let offsetMinutes = 0;
  const zone = m[8];
  if (zone !== undefined && /^[+-]/.test(zone)) {
    const digits = zone.slice(1).replace(':', '');
    const zh = Number(digits.slice(0, 2));
    const zm = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (zh > 14 || zm > 59) return null;
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (zh * 60 + zm);
  }
  return { ms: utc - offsetMinutes * 60_000, dateOnly };
}

// ── Counts ────────────────────────────────────────────────────────────────────

export type CountResult =
  | { ok: true; value: number | null } // null: the cell is empty
  | { ok: false; reason: 'negative' | 'not_a_number' | 'too_large' };

/** Spellings of "no value" that exports use instead of an empty cell. */
const BLANK = new Set(['', '-', '--', 'null', 'none', 'nan', 'n/a', 'na', 'undefined']);

const PLAIN_INTEGER = /^[+-]?\d+$/;
/** 1,234,567 · 1 234 567 · 1'234'567 · 1_234_567 (also with no-break spaces). */
const GROUPED = /^[+-]?\d{1,3}(?:[,   '_]\d{3})+$/;
/** 1.234.567 — only with two or more groups; "1.234" alone could be a decimal. */
const DOT_GROUPED = /^[+-]?\d{1,3}(?:\.\d{3}){2,}$/;
/** 1234.0 or 1.5e6: whole numbers written as decimals (spreadsheets, pandas). */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Reads a token or request count: a whole number that is zero or more. An empty
 * cell is "no value" (the caller decides whether that means zero); a negative
 * number, a fraction or text is an error, because storing a guess as a token count
 * would be worse than skipping the row.
 */
export function parseCount(value: unknown, max = Number.MAX_SAFE_INTEGER): CountResult {
  let n: number;
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (BLANK.has(text.toLowerCase())) return { ok: true, value: null };
    if (PLAIN_INTEGER.test(text)) n = Number(text);
    else if (GROUPED.test(text) || DOT_GROUPED.test(text)) n = Number(text.replace(/[^\d+-]/g, ''));
    else if (DECIMAL.test(text)) n = Number(text);
    else return { ok: false, reason: 'not_a_number' };
  } else {
    return { ok: false, reason: 'not_a_number' };
  }
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: 'not_a_number' };
  if (n < 0) return { ok: false, reason: 'negative' };
  if (n > max) return { ok: false, reason: 'too_large' };
  // "-0" is a whole number too; store it as plain zero.
  return { ok: true, value: n === 0 ? 0 : n };
}

/** Largest value of PostgreSQL's INTEGER, the type of request counts and bucket widths. */
export const INT32_MAX = 2_147_483_647;

// ── Price tiers ───────────────────────────────────────────────────────────────

/** Tiers the app knows how to name. Only some have published prices (see core/catalog.ts). */
export const KNOWN_PRICE_TIERS = new Set(['standard', 'batch', 'fast', 'long_context', 'priority', 'flex']);

/** Tier of rows that only carry a token total: nothing is priced under it, by design. */
export const UNCATEGORISED_TIER = 'uncategorised';

/**
 * Normalises a free-form tier label ("Batch", "long-context", "Priority Tier") to
 * the stored spelling. An empty value is the standard tier; a label that is not a
 * simple word is rejected (null).
 */
export function normalisePriceTier(value: unknown): string | null {
  if (value === null || value === undefined) return 'standard';
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (slug === '' || slug === 'default') return 'standard';
  if (slug === 'batch_api') return 'batch';
  if (slug === 'fast_mode') return 'fast';
  if (/^priority/.test(slug)) return 'priority';
  if (/^flex/.test(slug)) return 'flex';
  return /^[a-z0-9_]{1,40}$/.test(slug) ? slug : null;
}
