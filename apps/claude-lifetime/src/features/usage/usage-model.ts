import { NO_PLAN, UNKNOWN_MODEL_LABEL, type Granularity, type TokenBasis } from '@/analytics/base';
import type { SeriesGroup, SeriesPoint } from '@/analytics/overview';
import { PLANS, planLabel, type SubscriptionPeriod } from '@/analytics/subscriptions';
import { NEUTRAL_SERIES_COLOR, SERIES_COLORS, type ChartSeries } from '@/components/charts/series-chart';
import { addDays, daysBetween, formatDayRange } from '@/lib/format';
import { FAMILY_ORDER, familyColor, familyLabel, NEUTRAL, planColor } from '@/lib/palette';
import { autoGranularity, bucketStart, cumulative, nextBucket, pivot, type ChartRow } from '@/lib/series';

/**
 * Everything the Lifetime Usage page computes from the query results: which days the
 * chart covers, how fine its buckets are, and the rows and series of each view.
 * Kept free of React so the arithmetic can be tested on its own.
 */
export type UsageView = 'tokens' | 'cumulative' | 'categories' | 'models' | 'plans';
export type ModelGrouping = 'family' | 'model';
export type GranularityChoice = 'auto' | Granularity;

export const VIEW_OPTIONS: Array<{ value: UsageView; label: string }> = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cumulative', label: 'Cumulative' },
  { value: 'categories', label: 'Input vs output' },
  { value: 'models', label: 'By model' },
  { value: 'plans', label: 'By plan' },
];

export const GRANULARITY_OPTIONS: Array<{ value: GranularityChoice; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
];

export const UNIT: Record<Granularity, { one: string; many: string }> = {
  day: { one: 'day', many: 'days' },
  week: { one: 'week', many: 'weeks' },
  month: { one: 'month', many: 'months' },
  year: { one: 'year', many: 'years' },
};

// ── Which days are covered ──────────────────────────────────────────────────────

/** A run of whole local days, both ends included. */
export interface DaySpan {
  from: string;
  to: string;
  days: number;
}

export interface RecordedHistory {
  first: string;
  last: string;
}

/** First and last local day with any record, read from the daily series of the whole history. */
export function recordedHistory(days: SeriesPoint[]): RecordedHistory | null {
  if (days.length === 0) return null;
  let first = days[0].bucket;
  let last = days[0].bucket;
  for (const d of days) {
    if (d.bucket < first) first = d.bucket;
    if (d.bucket > last) last = d.bucket;
  }
  return { first, last };
}

/**
 * The part of the selected range that lies inside the recorded history. Days before the
 * first record or after the last one say nothing about usage, so the chart does not draw
 * them as empty and the daily averages do not divide by them.
 */
export function recordedSpan(range: { from: string | null; to: string | null }, history: RecordedHistory): DaySpan | null {
  const from = range.from && range.from > history.first ? range.from : history.first;
  const to = range.to && range.to < history.last ? range.to : history.last;
  if (from > to) return null;
  return { from, to, days: daysBetween(from, to) };
}

// ── How fine the buckets are ────────────────────────────────────────────────────

/** More bars than this cannot be told apart on any screen and slow the chart down. */
export const MAX_BUCKETS = 1500;

const COARSER: Record<Granularity, Granularity | null> = { day: 'week', week: 'month', month: 'year', year: null };

export function countBuckets(span: DaySpan, granularity: Granularity): number {
  const first = bucketStart(span.from, granularity);
  const last = bucketStart(span.to, granularity);
  const years = Number(last.slice(0, 4)) - Number(first.slice(0, 4));
  switch (granularity) {
    case 'day':
      return daysBetween(first, last);
    case 'week':
      return (daysBetween(first, last) - 1) / 7 + 1;
    case 'month':
      return years * 12 + Number(last.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
    case 'year':
      return years + 1;
  }
}

export interface ResolvedGranularity {
  granularity: Granularity;
  /** Set when the granularity the user picked would draw too many buckets and a coarser one is used. */
  tooFine: { chosen: Granularity; buckets: number } | null;
}

export function resolveGranularity(choice: GranularityChoice, span: DaySpan): ResolvedGranularity {
  const chosen = choice === 'auto' ? autoGranularity(span.days) : choice;
  let granularity = chosen;
  for (let next = COARSER[granularity]; next && countBuckets(span, granularity) > MAX_BUCKETS; next = COARSER[granularity]) granularity = next;
  const fellBack = choice !== 'auto' && granularity !== chosen;
  return { granularity, tooFine: fellBack ? { chosen, buckets: countBuckets(span, chosen) } : null };
}

// ── Stat tiles and the busiest periods ──────────────────────────────────────────

/** The largest buckets first; equal buckets are ordered latest first, as the overview's most active day is. */
export function rankBuckets(points: SeriesPoint[], limit: number): SeriesPoint[] {
  return points
    .filter((p) => p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || (a.bucket < b.bucket ? 1 : a.bucket > b.bucket ? -1 : 0))
    .slice(0, limit);
}

/** The days of a bucket that lie inside the span the chart covers. */
export function bucketDays(bucket: string, granularity: Granularity, span: DaySpan): DaySpan {
  const from = bucket < span.from ? span.from : bucket;
  const end = addDays(nextBucket(bucket, granularity), -1);
  const to = end > span.to ? span.to : end;
  return { from, to, days: daysBetween(from, to) };
}

// ── Chart views ─────────────────────────────────────────────────────────────────

export function groupOf(view: UsageView, grouping: ModelGrouping): SeriesGroup {
  switch (view) {
    case 'tokens':
    case 'cumulative':
      return 'confidence';
    case 'categories':
      return 'none';
    case 'models':
      return grouping;
    case 'plans':
      return 'plan';
  }
}

export interface ChartFrame {
  granularity: Granularity;
  span: DaySpan;
}

export interface ChartModel {
  kind: 'bar' | 'area';
  rows: ChartRow[];
  series: ChartSeries[];
}

const CONFIDENCE: ChartSeries[] = [
  { key: 'exact', label: 'Exact', color: SERIES_COLORS[0] },
  { key: 'estimated', label: 'Estimated', color: SERIES_COLORS[0], estimated: true },
];

function fill(points: SeriesPoint[], frame: ChartFrame, groups: string[]) {
  return pivot(points, frame.granularity, (p) => p.tokens, { from: frame.span.from, to: frame.span.to, groups });
}

/** Stacked bars: metered tokens solid, tokens reconstructed from text hatched. */
export function confidenceChart(points: SeriesPoint[], frame: ChartFrame): ChartModel {
  const pivoted = fill(points, frame, ['exact', 'estimated']);
  return { kind: 'bar', rows: pivoted.rows, series: CONFIDENCE.filter((s) => pivoted.totals[s.key] > 0) };
}

/** The same two series as running totals. The total starts at zero at the beginning of the span. */
export function cumulativeChart(points: SeriesPoint[], frame: ChartFrame): ChartModel {
  const bars = confidenceChart(points, frame);
  return { kind: 'area', rows: cumulative(bars.rows, ['exact', 'estimated']), series: bars.series };
}

type CategoryField = 'input' | 'output' | 'unsplit' | 'cacheWrite' | 'cacheRead' | 'replay';

/**
 * Token categories in a fixed order, so each keeps its colour. Cache reads and re-read
 * context are what separates processed tokens from new tokens; under the "new" basis
 * they are not part of the total and are left out. Re-read context only exists as a
 * model of chat exports, hence estimated. A row that only states a total says nothing
 * about how much of it was input and how much output, so it has a band of its own, in
 * the neutral colour, and is never drawn as input.
 */
const CATEGORIES: Array<ChartSeries & { field: CategoryField; processedOnly?: boolean }> = [
  { key: 'input', label: 'Input', color: SERIES_COLORS[0], field: 'input' },
  { key: 'output', label: 'Output', color: SERIES_COLORS[1], field: 'output' },
  { key: 'unsplit', label: 'Not split into input and output', color: NEUTRAL_SERIES_COLOR, field: 'unsplit' },
  { key: 'cacheWrite', label: 'Cache writes', color: SERIES_COLORS[2], field: 'cacheWrite' },
  { key: 'cacheRead', label: 'Cache reads', color: SERIES_COLORS[3], field: 'cacheRead', processedOnly: true },
  { key: 'replay', label: 'Re-read context', color: SERIES_COLORS[4], field: 'replay', estimated: true, processedOnly: true },
];

export function categoryChart(points: SeriesPoint[], frame: ChartFrame, basis: TokenBasis): ChartModel {
  const categories = CATEGORIES.filter((c) => basis === 'processed' || !c.processedOnly);
  const long = points.flatMap((p) => categories.map((c) => ({ ...p, group: c.key, tokens: p[c.field] })));
  const pivoted = fill(long, frame, categories.map((c) => c.key));
  return {
    kind: 'bar',
    rows: pivoted.rows,
    series: categories.filter((c) => pivoted.totals[c.key] > 0).map(({ key, label, color, estimated }) => ({ key, label, color, estimated })),
  };
}

/**
 * One series per model family, in the palette's fixed family order. `unknown` is usage
 * whose source names no model: it keeps its own neutral band and is never added to a family.
 */
export function familyChart(points: SeriesPoint[], frame: ChartFrame): ChartModel {
  const known = new Set<string>(FAMILY_ORDER);
  // A family this app has no colour for is shown with the other unlisted models rather than as "unknown".
  const mapped = points.map((p) => (known.has(p.group) ? p : { ...p, group: 'other' }));
  const pivoted = fill(mapped, frame, [...FAMILY_ORDER]);
  return {
    kind: 'bar',
    rows: pivoted.rows,
    series: FAMILY_ORDER.filter((f) => pivoted.totals[f] > 0).map((f) => ({ key: f, label: familyLabel(f), color: familyColor(f) })),
  };
}

/** How many models keep a colour of their own before the rest are folded together. */
export const MODEL_SLOTS = 7;
export const OTHER_MODELS_LABEL = 'Other models';
const OTHER_MODELS_COLOR = '#8f8f9b';

/**
 * The models that get a colour of their own: those with the most usage over the whole
 * history, listed by name. A model's position in this list is its colour, so it keeps
 * that colour whatever range is selected, and also when another model overtakes it: the
 * amount of usage decides who is on the list, never the order. A colour only moves when
 * a model joins or leaves the list. Usage is processed tokens under either basis, so
 * switching the basis does not repaint anything either.
 */
export function rankModels(lifetime: SeriesPoint[], limit = MODEL_SLOTS): string[] {
  const totals = new Map<string, number>();
  for (const p of lifetime) {
    if (p.group === UNKNOWN_MODEL_LABEL) continue;
    totals.set(p.group, (totals.get(p.group) ?? 0) + p.input + p.unsplit + p.output + p.cacheWrite + p.cacheRead + p.replay);
  }
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
    .slice(0, limit)
    .map(([name]) => name)
    .sort(byName);
}

/** Names in a fixed order that does not depend on the browser's language: "Claude Opus 4.5" before "Claude Opus 4.10". */
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function modelChart(points: SeriesPoint[], frame: ChartFrame, ranked: string[]): ChartModel & { folded: number } {
  // Row keys are positions, not display names: a name may contain characters the chart library reads as a path.
  const keyOf = new Map(ranked.map((name, i) => [name, `model${i}`]));
  const folded = new Set<string>();
  const mapped = points.map((p) => {
    if (p.group === UNKNOWN_MODEL_LABEL) return { ...p, group: 'unknown' };
    const key = keyOf.get(p.group);
    if (key) return { ...p, group: key };
    if (p.tokens > 0) folded.add(p.group);
    return { ...p, group: 'other' };
  });
  const defs: ChartSeries[] = [
    ...ranked.map((name, i) => ({ key: `model${i}`, label: name, color: SERIES_COLORS[i] })),
    { key: 'other', label: OTHER_MODELS_LABEL, color: OTHER_MODELS_COLOR },
    { key: 'unknown', label: UNKNOWN_MODEL_LABEL, color: NEUTRAL },
  ];
  const pivoted = fill(mapped, frame, defs.map((s) => s.key));
  return { kind: 'bar', rows: pivoted.rows, series: defs.filter((s) => pivoted.totals[s.key] > 0), folded: folded.size };
}

/**
 * One series per plan, in the order plans are listed everywhere else. The plan of a
 * bucket's usage comes from the subscription periods the user entered; `none` is time
 * that no period covers.
 */
export function planChart(points: SeriesPoint[], frame: ChartFrame, periods: SubscriptionPeriod[]): ChartModel {
  const listed = PLANS.map((p) => p.key);
  const unlisted = [...new Set(points.map((p) => p.group))].filter((k) => k !== NO_PLAN && !listed.includes(k)).sort();
  const order = [...listed, ...unlisted, NO_PLAN];
  const pivoted = fill(points, frame, order);
  return {
    kind: 'bar',
    rows: pivoted.rows,
    series: order.filter((k) => pivoted.totals[k] > 0).map((k) => ({ key: k, label: planSeriesLabel(k, periods), color: planColor(k) })),
  };
}

/** A plan's own name, or the label the user gave it when every period on that plan carries the same one. */
function planSeriesLabel(planKey: string, periods: SubscriptionPeriod[]): string {
  const labels = new Set(periods.filter((p) => p.planKey === planKey).map((p) => p.label?.trim() ?? ''));
  const only = labels.size === 1 ? [...labels][0] : '';
  return planLabel(planKey, only);
}

// ── Zoom ────────────────────────────────────────────────────────────────────────

/**
 * The part of the selected range the chart is zoomed to, as whole days. Kept as dates
 * rather than row numbers so the window survives a change of view or bucket size.
 */
export interface ZoomWindow {
  from: string;
  to: string;
}

/** The rows a zoom window overlaps: index of the first, and one past the last. */
export function zoomSlice(rows: ChartRow[], granularity: Granularity, zoom: ZoomWindow | null): [number, number] {
  if (!zoom || rows.length === 0) return [0, rows.length];
  let start = rows.findIndex((row) => nextBucket(row.bucket, granularity) > zoom.from);
  if (start < 0) start = rows.length - 1;
  let end = start + 1;
  while (end < rows.length && rows[end].bucket <= zoom.to) end++;
  return [start, end];
}

/** The days covered by rows `start` up to, but not including, `end`; null when that is every row. */
export function zoomWindow(rows: ChartRow[], granularity: Granularity, start: number, end: number): ZoomWindow | null {
  if (start <= 0 && end >= rows.length) return null;
  return { from: rows[start].bucket, to: addDays(nextBucket(rows[end - 1].bucket, granularity), -1) };
}

// ── Words ───────────────────────────────────────────────────────────────────────

const BASIS_NOUN: Record<TokenBasis, string> = { processed: 'Processed tokens', new: 'New tokens' };

/** Title and description of the chart card: exactly what is plotted, on which basis, over which days. */
export function describeChart(
  view: UsageView,
  grouping: ModelGrouping,
  basis: TokenBasis,
  frame: ChartFrame,
): { title: string; description: string; ariaLabel: string } {
  const unit = UNIT[frame.granularity].one;
  const tokens = BASIS_NOUN[basis];
  const dates = formatDayRange(frame.span.from, frame.span.to);
  switch (view) {
    case 'tokens':
      return {
        title: `Tokens per ${unit}`,
        description: `${tokens} per ${unit}, ${dates}. Solid bars are metered; hatched bars are reconstructed from text.`,
        ariaLabel: `${tokens} per ${unit}, exact and estimated, ${dates}`,
      };
    case 'cumulative':
      return {
        title: 'Cumulative tokens',
        description: `Running total of ${tokens.toLowerCase()} within the selected range, ${dates}, starting from zero. The hatched band is the estimated part.`,
        ariaLabel: `Running total of ${tokens.toLowerCase()}, exact and estimated, ${dates}`,
      };
    case 'categories':
      return {
        title: `Input and output per ${unit}`,
        description:
          basis === 'new'
            ? `${tokens} per ${unit} by category, ${dates}. Cache reads and re-read context are not new tokens, so this view leaves them out.`
            : `${tokens} per ${unit} by category, ${dates}. Re-read context only exists as a model of chat exports, so it is hatched; input and output also include tokens estimated from chat text.`,
        ariaLabel: `${tokens} per ${unit} by token category, ${dates}`,
      };
    case 'models': {
      const by = grouping === 'family' ? 'model family' : 'model';
      return {
        title: `Tokens per ${unit} by ${by}`,
        description: `${tokens} per ${unit} by ${by}, ${dates}. Exact and estimated tokens are added together. Usage whose source names no model is shown as Unknown model and is never assigned to one.`,
        ariaLabel: `${tokens} per ${unit} by ${by}, ${dates}`,
      };
    }
    case 'plans':
      return {
        title: `Tokens per ${unit} by plan`,
        description: `${tokens} per ${unit}, ${dates}, split by the subscription period you entered that covers each date. Exact and estimated tokens are added together.`,
        ariaLabel: `${tokens} per ${unit} by subscription plan, ${dates}`,
      };
  }
}
