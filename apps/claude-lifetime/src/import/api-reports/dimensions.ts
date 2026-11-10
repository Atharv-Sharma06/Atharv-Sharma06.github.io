import { sha256Hex } from '@/core/sha256';
import { INT32_MAX, isObject, parseTimestamp, type Json } from '../generic/values';

/**
 * What the usage and cost importers share about the rows of a report: which price
 * tier a row belongs to, how its deduplication key is built from its dimensions,
 * and the time range a report restates.
 */
export const API_REPORTS_PARSER_VERSION = 'api-reports-1';

// ── Price tier ────────────────────────────────────────────────────────────────

/**
 * Models that charged a premium for requests over 200,000 input tokens (the 1M
 * context window beta of Claude Sonnet 4 and 4.5). A report row with
 * `context_window: "200k-1M"` on one of them is that premium usage.
 *
 * Newer models bill the whole context window at the standard rate, so the context
 * window does not change their tier. The one exception cannot be handled: Claude
 * Haiku 5.5 is priced higher for prompts over 100,000 tokens, but reports only
 * separate prompts at 200,000 tokens, so its 100,000-200,000 token requests sit in
 * the "0-200k" bucket together with cheaper ones. Haiku 5.5 usage is therefore
 * always imported as `standard`, which can understate its equivalent API value.
 */
const LONG_CONTEXT_PREMIUM_MODELS = new Set(['claude-sonnet-4', 'claude-sonnet-4-5']);

export function hasLongContextPremium(modelKey: string | null): boolean {
  return modelKey !== null && LONG_CONTEXT_PREMIUM_MODELS.has(modelKey);
}

/**
 * The API spells the two context windows "0-200k" and "200k-1M"; the Console's CSV
 * export spells them "≤ 200k" and "200k - 1M".
 */
export function normaliseContextWindow(raw: unknown): '0-200k' | '200k-1M' | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, '').toLowerCase();
  if (text === '0-200k' || text === '≤200k' || text === '<=200k') return '0-200k';
  if (text === '200k-1m') return '200k-1M';
  return null;
}

const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Service tiers the API reference lists for usage reports. */
export const SERVICE_TIERS = new Set(['standard', 'batch', 'priority', 'priority_on_demand', 'flex', 'flex_discount']);

export interface TierDimensions {
  /** Catalog key of the row's model, null when the row names none. */
  modelKey: string | null;
  serviceTier: unknown;
  speed: unknown;
  contextWindow: unknown;
}

/**
 * The tier a row is priced under. Fast mode comes first because its price applies
 * whatever else is true of the request; then the service tier; and only standard
 * usage can be long-context usage. A dimension the report is not grouped by is
 * null and reads as "standard".
 */
export function priceTierFor(d: TierDimensions): string {
  if (lower(d.speed) === 'fast') return 'fast';
  const tier = lower(d.serviceTier);
  if (tier === 'batch') return 'batch';
  if (tier.startsWith('priority')) return 'priority';
  if (tier.startsWith('flex')) return 'flex';
  if (hasLongContextPremium(d.modelKey) && normaliseContextWindow(d.contextWindow) === '200k-1M') return 'long_context';
  return 'standard';
}

// ── Dimensions and deduplication keys ─────────────────────────────────────────

export interface Dimensions {
  /** Name and value of every dimension the row has a value for, sorted by name. */
  pairs: Array<[string, string]>;
  /** A value was an object (the Analytics API's `actor`). Such values never appear in a key as text. */
  structured: boolean;
}

/** Object keys in a fixed order, so the same dimension value always yields the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Collects the dimensions of a row without a fixed list of names, so a dimension
 * Anthropic adds later still tells rows apart.
 *
 *  - `group` of an Analytics API row holds nothing but dimensions: every non-null
 *    entry counts.
 *  - A legacy result holds dimensions and measurements side by side. Dimensions are
 *    its text values; numbers and nested objects are measurements. `exclude` names
 *    the text values that are measurements all the same (a cost amount, a currency).
 */
export function dimensionsOf(source: Json, kind: 'group' | 'result', exclude: ReadonlySet<string> = new Set()): Dimensions {
  const pairs: Array<[string, string]> = [];
  let structured = false;
  for (const name of Object.keys(source).sort()) {
    if (exclude.has(name)) continue;
    const value = source[name];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') pairs.push([name, value]);
    else if (typeof value === 'boolean') pairs.push([name, String(value)]);
    else if (kind === 'group') {
      if (typeof value === 'object') structured = true;
      pairs.push([name, canonical(value)]);
    }
  }
  return { pairs, structured };
}

/** Longer keys are replaced by their hash: they are compared, never read. */
const MAX_READABLE_KEY = 120;

/**
 * Deduplication key of one row: `<prefix>:<bucket start>:<bucket seconds>:<dimensions>`.
 * Two rows share a key only when they describe the same time bucket and the same
 * value of every dimension, i.e. when one restates the other.
 */
export function bucketKey(prefix: string, startIso: string, bucketSeconds: number, dims: Dimensions): string {
  const head = `${prefix}:${startIso}:${bucketSeconds}:`;
  if (dims.pairs.length === 0) return `${head}*`;
  const text = dims.pairs.map(([name, value]) => `${name}=${value}`).join('|');
  return !dims.structured && head.length + text.length <= MAX_READABLE_KEY ? head + text : `${head}#${sha256Hex(text)}`;
}

// ── Time ──────────────────────────────────────────────────────────────────────

/** `starting_at` / `ending_at`: RFC 3339 text. Null for anything else. */
export function reportTime(value: unknown): number | null {
  return typeof value === 'string' ? (parseTimestamp(value)?.ms ?? null) : null;
}

/** Width of a bucket in seconds; 0 when it cannot be derived. */
export function bucketSecondsBetween(startMs: number, endMs: number | null): number {
  if (endMs === null || endMs <= startMs) return 0;
  const seconds = Math.round((endMs - startMs) / 1000);
  return seconds <= INT32_MAX ? seconds : 0;
}

/** The widths both APIs offer: a minute, an hour, a day. */
export const isTimeBucket = (seconds: number): boolean => seconds === 60 || seconds === 3600 || seconds === 86400;

/**
 * The half-open UTC range a report covers: from its earliest bucket start to its
 * latest bucket end. Existing rows of the same source inside it are replaced by the
 * import (ParsedImport.replaceRange), which is how a report that restates a period
 * with revised figures is kept from being counted on top of the earlier one.
 */
export class RangeTracker {
  private start = Infinity;
  private end = -Infinity;

  add(startMs: number, endMs: number | null): void {
    if (startMs < this.start) this.start = startMs;
    // Without a usable end the row still has to fall inside the range it is replaced in.
    const until = endMs !== null && endMs > startMs ? endMs : startMs + 1;
    if (until > this.end) this.end = until;
  }

  get(): { start: string; end: string } | undefined {
    if (this.start === Infinity) return undefined;
    return { start: new Date(this.start).toISOString(), end: new Date(this.end).toISOString() };
  }
}

const DAY_MS = 86_400_000;

/**
 * Notices when one import states the same day at two granularities — a daily and
 * an hourly report of one period, or a whole-range total next to its daily rows.
 * Such rows have different keys (the bucket width is part of the key), so nothing
 * would stop them from being added up. Imported one after the other they are handled
 * by the commit: the later import replaces the earlier rows that lie wholly inside its
 * range, and is refused when its range cuts through a stored row (see commit.ts).
 */
export class GranularityGuard {
  /**
   * UTC day number -> the kind of bucket seen on that day. Minute, hour and day
   * buckets are aligned to the clock, so their width identifies them; a row that
   * covers an arbitrary range is identified by its start as well, which makes two
   * overlapping ranges of equal length clash too.
   */
  private readonly bucketOfDay = new Map<number, string>();
  private clash: { day: number; widths: [number, number] } | null = null;

  add(startMs: number, bucketSeconds: number): void {
    if (this.clash !== null) return;
    const bucket = bucketSeconds === 0 || isTimeBucket(bucketSeconds) ? String(bucketSeconds) : `${bucketSeconds}@${startMs}`;
    const first = Math.floor(startMs / DAY_MS);
    const last = bucketSeconds > 0 ? Math.floor((startMs + bucketSeconds * 1000 - 1) / DAY_MS) : first;
    // A row can span a month; anything much longer is cut off rather than walked day by day.
    for (let day = first; day <= last && day - first < 400; day++) {
      const known = this.bucketOfDay.get(day);
      if (known === undefined) this.bucketOfDay.set(day, bucket);
      else if (known !== bucket) {
        this.clash = { day, widths: [parseInt(known, 10), bucketSeconds] };
        return;
      }
    }
  }

  /** The first day found at two granularities, as YYYY-MM-DD, with the two widths in seconds. */
  conflict(): { day: string; widths: [number, number] } | null {
    if (this.clash === null) return null;
    return { day: new Date(this.clash.day * DAY_MS).toISOString().slice(0, 10), widths: this.clash.widths };
  }
}

/** "daily", "hourly", ... for a bucket width, for messages. */
export function describeBucket(seconds: number): string {
  if (seconds === 86400) return 'daily';
  if (seconds === 3600) return 'hourly';
  if (seconds === 60) return 'per-minute';
  if (seconds === 0) return 'unbucketed';
  return seconds % 86400 === 0 ? `${seconds / 86400}-day` : 'whole-range';
}
