import type { ConversationUsage, PeriodInput, SegmentStats, SideStats, SubscriptionPeriod } from '@/analytics/subscriptions';
import type { ValueFigures } from '@/analytics/value';
import type { ConfidenceLevel } from '@/components/data/confidence';
import { addDays, dayInZone, formatDay, formatDayRange, formatDecimal, formatMonth } from '@/lib/format';

/**
 * Calculations behind the Subscription History page, kept free of React so they can be
 * tested on their own: where the blocks of the timeline go, how the two sides of the
 * before/after comparison are normalised, and when comparing them is not meaningful.
 */
export const DAY_MS = 86_400_000;
export const DAYS_PER_WEEK = 7;
/** Average length of a month (365.25 days / 12), the value `formatSpan()` uses as well. */
export const DAYS_PER_MONTH = 30.4375;

// ── Calendar days in the user's timezone ────────────────────────────────────────

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function zoneOffsetMs(instantMs: number, timezone: string): number {
  let format = offsetFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    offsetFormats.set(timezone, format);
  }
  const part: Record<string, number> = {};
  for (const p of format.formatToParts(instantMs)) part[p.type] = Number(p.value);
  const wall = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  return wall - Math.floor(instantMs / 1000) * 1000;
}

/** The instant (ms since the epoch) at which a local calendar day `YYYY-MM-DD` begins in a timezone. */
export function dayStartInZone(day: string, timezone: string): number {
  const wall = Date.parse(`${day}T00:00:00Z`);
  try {
    const guess = wall - zoneOffsetMs(wall, timezone);
    // The second pass settles days around a change of the UTC offset (daylight saving time).
    return wall - zoneOffsetMs(guess, timezone);
  } catch {
    // An unknown timezone falls back to UTC, as dayInZone() does.
    return wall;
  }
}

/**
 * First and last calendar day of a segment in the user's timezone. A segment's end is
 * exclusive, so its last day is the day before; a running segment has no last day.
 */
export function segmentDates(segment: { start: string; end: string | null }, timezone: string): { startDate: string; lastDate: string | null } {
  return {
    startDate: dayInZone(segment.start, timezone),
    lastDate: segment.end ? dayInZone(new Date(Date.parse(segment.end) - 1), timezone) : null,
  };
}

/** "Jan 10 – Dec 10, 2025" for a finished stretch, "Since Dec 11, 2025" for a running one. */
export function describeDates(dates: { startDate: string; lastDate: string | null }, today: string): string {
  if (dates.lastDate) return formatDayRange(dates.startDate, dates.lastDate);
  return `${dates.startDate > today ? 'From' : 'Since'} ${formatDay(dates.startDate)}`;
}

// ── Timeline geometry ───────────────────────────────────────────────────────────

export interface TimeSpan {
  startMs: number;
  endMs: number;
}

/** The stretch of time each segment covers on the timeline. A running segment ends now. */
export function segmentSpans(segments: Array<{ start: string; end: string | null }>, nowMs: number): TimeSpan[] {
  return segments.map((segment) => {
    const startMs = Date.parse(segment.start);
    const endMs = segment.end ? Date.parse(segment.end) : nowMs;
    return { startMs, endMs: Math.max(startMs, endMs) };
  });
}

export interface PlacedBlock extends TimeSpan {
  x: number;
  width: number;
}

export interface TimelineLayout {
  /** Width of the band in px. Wider than the frame only when the blocks cannot fit at their minimum width. */
  width: number;
  blocks: PlacedBlock[];
}

/** Positions are whole pixels, so block edges, gaps and hairlines stay crisp. */
const px = (value: number) => Math.round(value);

/**
 * Places the blocks of the timeline side by side, each as wide as its share of the
 * time. A block that would be narrower than `minBlock` is given that width and the
 * others share what is left, so a two-day period stays visible next to a two-year one.
 */
export function layoutTimeline(spans: TimeSpan[], frameWidth: number, options: { minBlock: number; gap: number }): TimelineLayout {
  const { minBlock, gap } = options;
  const count = spans.length;
  if (count === 0 || frameWidth <= 0) return { width: Math.max(0, frameWidth), blocks: [] };

  const gaps = gap * (count - 1);
  const width = Math.max(frameWidth, count * minBlock + gaps);
  const room = width - gaps;
  const durations = spans.map((span) => Math.max(0, span.endMs - span.startMs));

  const pinned = durations.map(() => false);
  let scale = 0;
  for (;;) {
    const pinnedCount = pinned.filter(Boolean).length;
    const free = durations.reduce((sum, d, i) => (pinned[i] ? sum : sum + d), 0);
    scale = free > 0 ? (room - pinnedCount * minBlock) / free : 0;
    let changed = false;
    durations.forEach((d, i) => {
      if (!pinned[i] && d * scale < minBlock) {
        pinned[i] = true;
        changed = true;
      }
    });
    if (!changed) break;
  }
  // Only when every block sits at the minimum can room be left over; it is shared equally.
  const each = pinned.every(Boolean) ? room / count : minBlock;

  let x = 0;
  const blocks = spans.map((span, i) => {
    const blockWidth = pinned[i] ? each : durations[i] * scale;
    // Both edges are snapped, so neighbours keep exactly `gap` between them.
    const block = { ...span, x: px(x), width: px(x + blockWidth) - px(x) };
    x += blockWidth + gap;
    return block;
  });
  return { width: px(width), blocks };
}

/** Horizontal position of an instant on the laid-out timeline. Linear within a block. */
export function timelineX(layout: TimelineLayout, ms: number): number {
  const { blocks } = layout;
  if (blocks.length === 0) return 0;
  for (const block of blocks) {
    if (ms <= block.startMs) return block.x;
    if (ms < block.endMs) return px(block.x + ((ms - block.startMs) / (block.endMs - block.startMs)) * block.width);
  }
  const last = blocks[blocks.length - 1];
  return px(last.x + last.width);
}

/** Where a marker for the start of block `index` goes: in the middle of the gap in front of it. */
export function boundaryX(layout: TimelineLayout, index: number, gap: number): number {
  const block = layout.blocks[index];
  if (!block) return 0;
  return index === 0 ? 0 : px(block.x - gap / 2);
}

export interface TimelineTick {
  ms: number;
  label: string;
  /** The start of a year. */
  major: boolean;
}

const MONTH_STEPS = [1, 2, 3, 6, 12, 24, 60, 120];
const monthName = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

/**
 * Ticks of the time axis: the start of every month when the span is short, of every
 * few months or of every year when it is longer, so that at most `maxTicks` are drawn.
 */
export function timelineTicks(startMs: number, endMs: number, timezone: string, maxTicks: number): TimelineTick[] {
  if (!(endMs > startMs)) return [];
  const monthIndex = (ms: number) => {
    const day = dayInZone(new Date(ms), timezone);
    return Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
  };
  const first = monthIndex(startMs);
  const last = monthIndex(endMs);
  const limit = Math.max(1, maxTicks);
  const step = MONTH_STEPS.find((s) => Math.floor(last / s) - Math.floor(first / s) <= limit) ?? MONTH_STEPS[MONTH_STEPS.length - 1];

  const ticks: TimelineTick[] = [];
  for (let m = (Math.floor(first / step) + 1) * step; m <= last; m += step) {
    const year = Math.floor(m / 12);
    const month = m % 12;
    const day = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const ms = dayStartInZone(day, timezone);
    if (ms <= startMs || ms >= endMs) continue;
    const label = step >= 12 ? String(year) : month === 0 || ticks.length === 0 ? formatMonth(day) : monthName(day);
    ticks.push({ ms, label, major: month === 0 });
  }
  return ticks;
}

export interface AxisLabel {
  x: number;
  text: string;
  /** Which part of the text sits at `x`. */
  anchor: 'start' | 'middle' | 'end';
  major: boolean;
}

/**
 * Keeps the axis labels that fit. Candidates are given in order of importance; a label
 * is dropped when it would leave the axis or come closer than `spacing` to one already
 * placed. Widths are estimated from the number of characters, generously.
 */
export function placeAxisLabels(width: number, candidates: AxisLabel[], options: { charWidth?: number; spacing?: number } = {}): AxisLabel[] {
  const charWidth = options.charWidth ?? 7;
  const spacing = options.spacing ?? 10;
  const taken: Array<[number, number]> = [];
  const placed: AxisLabel[] = [];
  for (const label of candidates) {
    const size = label.text.length * charWidth;
    const from = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - size : label.x - size / 2;
    const to = from + size;
    if (from < 0 || to > width) continue;
    if (taken.some(([a, b]) => from - spacing < b && to + spacing > a)) continue;
    taken.push([from, to]);
    placed.push(label);
  }
  return placed;
}

export type BlockLabel = 'full' | 'name' | 'none';

/**
 * How much of its label a timeline block can show without clipping it: the plan name
 * and the dates, the name alone, or nothing (the tooltip and the table carry it then).
 * Widths are measured text widths; `undefined` means not measured yet.
 */
export function blockLabelFit(blockWidth: number, nameWidth: number | undefined, datesWidth: number | undefined, padding: number): BlockLabel {
  const room = blockWidth - 2 * padding;
  if (nameWidth === undefined || nameWidth > room) return 'none';
  if (datesWidth === undefined || datesWidth > room) return 'name';
  return 'full';
}

// ── Segments (periods and the gaps between them) ────────────────────────────────

/** A segment with at least one imported record. Without one, its figures are unavailable rather than zero. */
export function hasRecords(segment: Pick<SegmentStats, 'activeDays'>): boolean {
  return segment.activeDays > 0;
}

/**
 * Days of a segment that have already passed. Equal to its length, except for a period
 * entered with dates in the future: usage can only have accrued up to today.
 */
export function elapsedDays(segment: Pick<SegmentStats, 'start' | 'end' | 'days'>, nowMs: number): number {
  const startMs = Date.parse(segment.start);
  if (startMs >= nowMs) return 0;
  if (!segment.end || Date.parse(segment.end) <= nowMs) return segment.days;
  return Math.max(1, Math.round((nowMs - startMs) / DAY_MS));
}

/** Length of a segment in days, or null for a running period that has not started: it has no length yet. */
export function lengthDays(segment: Pick<SegmentStats, 'start' | 'end' | 'days'>, nowMs: number): number | null {
  return !segment.end && Date.parse(segment.start) >= nowMs ? null : segment.days;
}

/** Tokens per day over the days of the segment that have passed, or null when there is nothing to average. */
export function averagePerDay(segment: Pick<SegmentStats, 'start' | 'end' | 'days' | 'tokens' | 'activeDays'>, nowMs: number): number | null {
  if (!hasRecords(segment)) return null;
  const days = elapsedDays(segment, nowMs);
  return days > 0 ? segment.tokens / days : null;
}

// ── Equivalent API value ────────────────────────────────────────────────────────

export type CostScenario = 'standard' | 'cached';

export function leadingUsd(value: ValueFigures, scenario: CostScenario): string {
  return scenario === 'cached' ? value.totalCachedUsd : value.totalStandardUsd;
}

export function otherUsd(value: ValueFigures, scenario: CostScenario): string {
  return scenario === 'cached' ? value.totalStandardUsd : value.totalCachedUsd;
}

/** Unavailable when nothing could be priced; estimated when estimated tokens or an assumed model are part of it. */
export function valueLevel(value: ValueFigures): ConfidenceLevel {
  if (value.pricedTokens === 0) return 'unavailable';
  return Number(value.estimatedStandardUsd) > 0 || Number(value.estimatedCachedUsd) > 0 || value.assumedTokens > 0 ? 'estimated' : 'exact';
}

/** Share of the processed tokens that a price could be applied to, or null when there are none. */
export function pricedShare(value: Pick<ValueFigures, 'pricedTokens' | 'unpricedTokens'>): number | null {
  const all = value.pricedTokens + value.unpricedTokens;
  return all > 0 ? value.pricedTokens / all : null;
}

// ── Before vs. after the first paid plan ────────────────────────────────────────

export type CompareMode = 'total' | 'day' | 'week' | 'month' | 'conversation';

/** `short` is the label where space is tight, `heading` names the figure itself, `unit` completes a sentence. */
export const COMPARE_MODES: Array<{ value: CompareMode; label: string; short: string; heading: string; unit: string }> = [
  { value: 'total', label: 'Total usage', short: 'Total', heading: 'Total tokens', unit: 'tokens' },
  { value: 'day', label: 'Average per day', short: 'Per day', heading: 'Average tokens per day', unit: 'tokens per day' },
  { value: 'week', label: 'Average per week', short: 'Per week', heading: 'Average tokens per week', unit: 'tokens per week' },
  { value: 'month', label: 'Average per month', short: 'Per month', heading: 'Average tokens per month', unit: 'tokens per month' },
  { value: 'conversation', label: 'Per conversation', short: 'Per conversation', heading: 'Average tokens per conversation', unit: 'tokens per conversation' },
];

const MODE_DAYS: Partial<Record<CompareMode, number>> = { day: 1, week: DAYS_PER_WEEK, month: DAYS_PER_MONTH };

/** Tokens per `unitDays` days over a span of calendar days; null when the span is empty. */
export function ratePer(tokens: number, spanDays: number, unitDays: number): number | null {
  return spanDays > 0 ? (tokens / spanDays) * unitDays : null;
}

/** Tokens per conversation; null when there are no conversations to divide by. */
export function perConversation(tokens: number, conversations: number): number | null {
  return conversations > 0 ? tokens / conversations : null;
}

export interface Figure {
  value: number;
  /** Parts of `value` that are metered and reconstructed from text. They add up to it. */
  exact: number;
  estimated: number;
}

/**
 * One side of the comparison under a mode, or null when it cannot be computed: the side
 * has no imported records, or (per conversation) no conversations.
 *
 * Time-based modes divide by the calendar span the side covers. "Per conversation" uses
 * only the tokens that belong to conversations, so usage imported without conversations
 * (API usage reports) does not inflate the size of the conversations there are.
 */
export function sideFigure(mode: CompareMode, side: SideStats | null, inConversations: ConversationUsage | null): Figure | null {
  if (!side || side.spanDays <= 0) return null;
  if (mode === 'total') return { value: side.tokens, exact: side.exact, estimated: side.estimated };

  const parts = mode === 'conversation' ? inConversations : side;
  if (!parts) return null;
  const share = (tokens: number) =>
    mode === 'conversation' ? perConversation(tokens, inConversations?.conversations ?? 0) : ratePer(tokens, side.spanDays, MODE_DAYS[mode] ?? 1);
  const value = share(parts.tokens);
  return value === null ? null : { value, exact: share(parts.exact) ?? 0, estimated: share(parts.estimated) ?? 0 };
}

/** One side is at least this many times as long as the other: their totals are not comparable. */
const LENGTH_FACTOR = 2;
/** A side shorter than this is too short for a steady average, and no ratio is shown. */
const MIN_RATE_DAYS = 14;
/** "Mostly metered": more than this share of a side's tokens come from sources that count them. */
const MOSTLY_METERED = 0.5;

export type Side = 'before' | 'after';

export interface Comparability {
  /** The two sides cover very different lengths of time. */
  lengths: { beforeDays: number; afterDays: number } | null;
  /** One side is entirely estimated from text while the other is mostly metered. */
  measurement: { estimatedSide: Side; meteredShare: number } | null;
  /**
   * The earlier side begins with the first imported record. `unrecordedDays` counts the
   * days between the start of the entered history and that record (0 when there are none).
   */
  firstRecord: { day: string; unrecordedDays: number } | null;
  /** Sides with records that span fewer than MIN_RATE_DAYS days. */
  short: Array<{ side: Side; days: number }>;
}

export function assessComparability(
  before: SideStats | null,
  after: SideStats | null,
  context: { timezone: string; historyStart: string | null },
): Comparability {
  const b = before && before.spanDays > 0 ? before : null;
  const a = after && after.spanDays > 0 ? after : null;

  let lengths: Comparability['lengths'] = null;
  if (a && b && Math.max(a.spanDays, b.spanDays) >= LENGTH_FACTOR * Math.min(a.spanDays, b.spanDays)) {
    lengths = { beforeDays: b.spanDays, afterDays: a.spanDays };
  }

  let measurement: Comparability['measurement'] = null;
  if (a && b && a.tokens > 0 && b.tokens > 0) {
    const meteredShare = (side: SideStats) => side.exact / side.tokens;
    if (b.exact === 0 && meteredShare(a) > MOSTLY_METERED) measurement = { estimatedSide: 'before', meteredShare: meteredShare(a) };
    else if (a.exact === 0 && meteredShare(b) > MOSTLY_METERED) measurement = { estimatedSide: 'after', meteredShare: meteredShare(b) };
  }

  let firstRecord: Comparability['firstRecord'] = null;
  if (b?.firstAt) {
    const lead = context.historyStart ? Date.parse(b.firstAt) - Date.parse(context.historyStart) : 0;
    firstRecord = { day: dayInZone(b.firstAt, context.timezone), unrecordedDays: lead > 0 ? Math.floor(lead / DAY_MS) : 0 };
  }

  const short: Comparability['short'] = [];
  if (b && b.spanDays < MIN_RATE_DAYS) short.push({ side: 'before', days: b.spanDays });
  if (a && a.spanDays < MIN_RATE_DAYS) short.push({ side: 'after', days: a.spanDays });

  return { lengths, measurement, firstRecord, short };
}

/** Totals mislead when the sides differ in length, so the comparison then opens on a daily average. */
export function defaultMode(comparability: Comparability): CompareMode {
  return comparability.lengths ? 'day' : 'total';
}

export interface RateRatio {
  /** `more`: the later side is higher. `fewer`: the earlier side is higher. */
  direction: 'more' | 'fewer' | 'same';
  /** How many times as high the higher side is, rounded for reading; 1 when they are about the same. */
  factor: number;
}

function roundFactor(factor: number): number {
  if (factor < 2) return Math.round(factor * 10) / 10;
  if (factor < 10) return Math.round(factor * 2) / 2;
  if (factor < 100) return Math.round(factor);
  return Number(factor.toPrecision(2));
}

/**
 * The plain ratio between the two sides of a normalised rate, or null when it should not
 * be stated: for totals (never a growth figure between spans of different length), when
 * a side is missing, empty or shorter than MIN_RATE_DAYS, and when the two sides are
 * measured differently, because the ratio would then mostly reflect the method.
 */
export function rateRatio(
  mode: CompareMode,
  before: { figure: Figure | null; spanDays: number },
  after: { figure: Figure | null; spanDays: number },
  comparability: Pick<Comparability, 'measurement'>,
): RateRatio | null {
  if (mode === 'total' || comparability.measurement) return null;
  if (!before.figure || !after.figure || before.figure.value <= 0 || after.figure.value <= 0) return null;
  if (before.spanDays < MIN_RATE_DAYS || after.spanDays < MIN_RATE_DAYS) return null;
  const ratio = after.figure.value / before.figure.value;
  if (ratio >= 1.15) return { direction: 'more', factor: roundFactor(ratio) };
  if (ratio <= 1 / 1.15) return { direction: 'fewer', factor: roundFactor(1 / ratio) };
  return { direction: 'same', factor: 1 };
}

export function describeRatio(ratio: RateRatio, unit: string): string {
  const times = formatDecimal(ratio.factor, 1);
  if (ratio.direction === 'same') return `About the same number of ${unit} before and after your first paid plan.`;
  return ratio.direction === 'more'
    ? `About ${times} times as many ${unit} after your first paid plan as before.`
    : `About ${times} times as many ${unit} before your first paid plan as after.`;
}

// ── Period form ─────────────────────────────────────────────────────────────────

export interface PeriodFormValues {
  planKey: string;
  label: string;
  startDate: string;
  lastDate: string;
  monthlyPrice: string;
  currency: string;
  notes: string;
}

export type PeriodFormField = 'planKey' | 'startDate' | 'lastDate' | 'monthlyPrice' | 'currency';

export function emptyPeriodForm(preset: { startDate?: string; lastDate?: string | null } = {}): PeriodFormValues {
  return { planKey: '', label: '', startDate: preset.startDate ?? '', lastDate: preset.lastDate ?? '', monthlyPrice: '', currency: 'USD', notes: '' };
}

export function periodToForm(period: SubscriptionPeriod): PeriodFormValues {
  return {
    planKey: period.planKey,
    label: period.label ?? '',
    startDate: period.startDate,
    lastDate: period.lastDate ?? '',
    monthlyPrice: period.monthlyPrice ? period.monthlyPrice.replace(/\.00$/, '') : '',
    currency: period.currency,
    notes: period.notes ?? '',
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Checks the form before it is sent, so that a problem is shown next to its field. The
 * rules and wording are those of `savePeriod`, which remains the authority and is the
 * only place that can detect an overlap with another period.
 */
export function validatePeriodForm(values: PeriodFormValues): Partial<Record<PeriodFormField, string>> {
  const errors: Partial<Record<PeriodFormField, string>> = {};
  if (values.planKey.trim() === '') errors.planKey = 'Choose a plan.';
  if (!isCalendarDay(values.startDate)) errors.startDate = 'Enter a valid start date.';
  const lastDate = values.lastDate.trim();
  if (lastDate !== '') {
    if (!isCalendarDay(lastDate)) errors.lastDate = 'Enter a valid end date, or leave it empty if the plan is still active.';
    else if (!errors.startDate && lastDate < values.startDate) errors.lastDate = 'The end date is before the start date.';
  }
  const price = values.monthlyPrice.trim();
  if (price !== '' && !/^\d{1,7}(\.\d{1,2})?$/.test(price)) errors.monthlyPrice = 'Enter the monthly price as a number, for example 20 or 19.99.';
  if (!/^[A-Za-z]{3}$/.test(values.currency.trim())) errors.currency = 'Use a three-letter currency code such as USD.';
  return errors;
}

export function formToInput(values: PeriodFormValues, id?: number): PeriodInput {
  return {
    ...(id === undefined ? {} : { id }),
    planKey: values.planKey.trim(),
    label: values.label.trim() || null,
    startDate: values.startDate,
    lastDate: values.lastDate.trim() || null,
    monthlyPrice: values.monthlyPrice.trim() || null,
    currency: values.currency.trim().toUpperCase(),
    notes: values.notes.trim() || null,
  };
}

/** The stored fields of a period as save input, for changing one of them and keeping the rest. */
export function periodToInput(period: SubscriptionPeriod): PeriodInput {
  return {
    id: period.id,
    planKey: period.planKey,
    label: period.label,
    startDate: period.startDate,
    lastDate: period.lastDate,
    monthlyPrice: period.monthlyPrice,
    currency: period.currency,
    notes: period.notes,
  };
}

/**
 * When a new period overlaps one that is still running, the usual cause is a change of
 * plan: the earlier plan simply has no end date yet. Returns the last day to give that
 * period so the new one fits after it, or null when ending it would not resolve the
 * overlap (it already has an end date, or it starts on or after the new period).
 */
export function endDateResolvingOverlap(conflict: Pick<SubscriptionPeriod, 'startDate' | 'lastDate'>, newStartDate: string): string | null {
  if (conflict.lastDate !== null || !isCalendarDay(newStartDate) || conflict.startDate >= newStartDate) return null;
  return addDays(newStartDate, -1);
}
