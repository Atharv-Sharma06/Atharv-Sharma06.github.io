import type { Granularity } from '@/analytics/base';
import type { SeriesPoint } from '@/analytics/overview';
import { addDays, addMonths, daysBetween, formatDay, formatDayRange } from './format';

/**
 * Shaping of time series for charts. The analytics queries only return buckets that
 * have data; a time axis needs every bucket, so the empty ones are filled in here —
 * a three-week pause must look like a pause, not disappear.
 */
export type ChartRow = { bucket: string } & Record<string, number | string>;

export function bucketStart(day: string, granularity: Granularity): string {
  if (granularity === 'day') return day;
  if (granularity === 'month') return `${day.slice(0, 7)}-01`;
  if (granularity === 'year') return `${day.slice(0, 4)}-01-01`;
  // ISO week: Monday
  const d = new Date(`${day}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  return addDays(day, -shift);
}

export function nextBucket(bucket: string, granularity: Granularity): string {
  switch (granularity) {
    case 'day':
      return addDays(bucket, 1);
    case 'week':
      return addDays(bucket, 7);
    case 'month':
      return addMonths(bucket, 1);
    case 'year':
      // Padded: buckets are compared as text, and "227-01-01" would sort after "2025-01-01".
      return `${String(Number(bucket.slice(0, 4)) + 1).padStart(4, '0')}-01-01`;
  }
}

/** A granularity that keeps the number of buckets readable for a span of days. */
export function autoGranularity(spanDays: number): Granularity {
  if (spanDays <= 45) return 'day';
  if (spanDays <= 270) return 'week';
  if (spanDays <= 366 * 6) return 'month';
  return 'year';
}

export function spanOf(first: string | null | undefined, last: string | null | undefined): number {
  if (!first || !last) return 0;
  return daysBetween(first.slice(0, 10), last.slice(0, 10));
}

/**
 * The edges at which a selected date range cuts into recorded usage, or null where it
 * does not. A week, month or year that reaches across such an edge is shown with only
 * the days inside the range, so it must not be named as if it were whole.
 */
export interface RangeCut {
  from: string | null;
  to: string | null;
}

/** The days of a bucket that lie inside the range, and whether that is less than the whole bucket. */
export function bucketPart(bucket: string, granularity: Granularity, cut?: RangeCut | null): { from: string; to: string; partial: boolean } {
  const end = addDays(nextBucket(bucket, granularity), -1);
  const from = cut?.from && cut.from > bucket && cut.from <= end ? cut.from : bucket;
  const to = cut?.to && cut.to < end && cut.to >= bucket ? cut.to : end;
  return { from, to, partial: from !== bucket || to !== end };
}

/**
 * The name of a bucket. With `cut`, a bucket of which only a part lies inside the
 * selected range is named by the days it holds: "Feb 11 – Feb 15, 2026, part of the week
 * of Feb 9, 2026", never "Week of Feb 9", which would promise the Monday it leaves out.
 */
export function bucketLabel(bucket: string, granularity: Granularity, cut?: RangeCut | null): string {
  const whole = wholeBucketLabel(bucket, granularity);
  if (granularity === 'day') return whole;
  const part = bucketPart(bucket, granularity, cut);
  if (!part.partial) return whole;
  return `${formatDayRange(part.from, part.to)}, part of ${granularity === 'week' ? `the week of ${formatDay(bucket)}` : whole}`;
}

function wholeBucketLabel(bucket: string, granularity: Granularity): string {
  switch (granularity) {
    case 'day':
      return formatDay(bucket, 'weekday');
    case 'week':
      return `Week of ${formatDay(bucket)}`;
    case 'month':
      return new Date(`${bucket}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    case 'year':
      return bucket.slice(0, 4);
  }
}

/**
 * Axis label of a bucket. When the axis spans more than one calendar year every label
 * carries its year, because a narrow chart may show only a few of them.
 */
export function bucketTick(bucket: string, granularity: Granularity, multiYear = false): string {
  const d = new Date(`${bucket}T00:00:00Z`);
  const year = `’${bucket.slice(2, 4)}`;
  switch (granularity) {
    case 'day':
    case 'week':
      return multiYear
        ? `${d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })} ${year}`
        : d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    case 'month': {
      const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
      return multiYear ? `${month} ${year}` : month;
    }
    case 'year':
      return bucket.slice(0, 4);
  }
}

export interface Pivoted {
  rows: ChartRow[];
  /** Group keys in order of total, largest first. */
  groups: string[];
  totals: Record<string, number>;
}

/**
 * Turns grouped points into one row per bucket with one column per group, filling
 * empty buckets with zeros between `from` and `to` (default: first and last point).
 */
export function pivot(
  points: SeriesPoint[],
  granularity: Granularity,
  value: (p: SeriesPoint) => number,
  options: { from?: string | null; to?: string | null; groups?: string[] } = {},
): Pivoted {
  const totals: Record<string, number> = {};
  const byBucket = new Map<string, Record<string, number>>();
  for (const p of points) {
    const v = value(p);
    totals[p.group] = (totals[p.group] ?? 0) + v;
    let row = byBucket.get(p.bucket);
    if (!row) byBucket.set(p.bucket, (row = {}));
    row[p.group] = (row[p.group] ?? 0) + v;
  }
  const groups = options.groups ?? Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  for (const g of groups) totals[g] ??= 0;

  const buckets = [...byBucket.keys()].sort();
  if (buckets.length === 0) return { rows: [], groups, totals };
  let first = buckets[0];
  let last = buckets[buckets.length - 1];
  if (options.from) first = minDay(first, bucketStart(options.from, granularity));
  if (options.to) last = maxDay(last, bucketStart(options.to, granularity));

  const rows: ChartRow[] = [];
  // Guard against a pathological range: never build more than a few thousand buckets.
  for (let b = first, n = 0; b <= last && n < 5000; b = nextBucket(b, granularity), n++) {
    const src = byBucket.get(b);
    const row: ChartRow = { bucket: b };
    for (const g of groups) row[g] = src?.[g] ?? 0;
    rows.push(row);
  }
  return { rows, groups, totals };
}

const minDay = (a: string, b: string) => (a < b ? a : b);
const maxDay = (a: string, b: string) => (a > b ? a : b);

/** Running totals of every numeric column. */
export function cumulative(rows: ChartRow[], keys: string[]): ChartRow[] {
  const acc: Record<string, number> = {};
  return rows.map((row) => {
    const out: ChartRow = { bucket: row.bucket };
    for (const k of keys) {
      acc[k] = (acc[k] ?? 0) + (Number(row[k]) || 0);
      out[k] = acc[k];
    }
    return out;
  });
}

/**
 * Keeps the `limit` largest groups and folds the rest into "Other", so a chart never
 * needs more colours than the palette has. Colour follows the entity: callers assign
 * colours from a stable order, not from this ranking.
 */
export function foldGroups(pivoted: Pivoted, limit: number, otherKey = 'Other'): Pivoted {
  if (pivoted.groups.length <= limit) return pivoted;
  const keep = pivoted.groups.slice(0, limit - 1);
  const fold = pivoted.groups.slice(limit - 1);
  const rows = pivoted.rows.map((row) => {
    const out: ChartRow = { bucket: row.bucket };
    for (const g of keep) out[g] = row[g];
    out[otherKey] = fold.reduce((s, g) => s + (Number(row[g]) || 0), 0);
    return out;
  });
  const totals: Record<string, number> = {};
  for (const g of keep) totals[g] = pivoted.totals[g];
  totals[otherKey] = fold.reduce((s, g) => s + pivoted.totals[g], 0);
  return { rows, groups: [...keep, otherKey], totals };
}
