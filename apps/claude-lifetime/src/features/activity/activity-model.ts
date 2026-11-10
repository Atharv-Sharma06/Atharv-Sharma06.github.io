import type { SeriesPoint } from '@/analytics/overview';
import { addDays, daysBetween, formatInt, formatTokens } from '@/lib/format';

/**
 * Everything the Activity Heatmap computes from the daily series of the whole history:
 * the calendar layout of a year, the colour scale, streaks, weekday averages and the
 * monthly table. Kept free of React so the arithmetic can be tested on its own.
 *
 * Days are local calendar days as `YYYY-MM-DD`, exactly as the queries return them.
 */
export type Metric = 'tokens' | 'messages' | 'conversations';

export const METRIC_OPTIONS: Array<{ value: Metric; label: string }> = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'messages', label: 'Messages' },
  { value: 'conversations', label: 'Conversations' },
];

export const METRIC_NOUN: Record<Metric, { one: string; many: string }> = {
  tokens: { one: 'token', many: 'tokens' },
  messages: { one: 'message', many: 'messages' },
  conversations: { one: 'conversation', many: 'conversations' },
};

export function valueOf(point: SeriesPoint | undefined, metric: Metric): number {
  return point ? point[metric] : 0;
}

/**
 * Whether a day's records say anything about the metric. Sources such as API usage
 * reports hold tokens and no message or conversation counts: a day that has usage and no
 * count is a day whose count is not recorded, which is not the same as zero. Such a day is
 * neither drawn nor averaged as a day without messages.
 */
export function metricRecorded(point: SeriesPoint | undefined, metric: Metric): boolean {
  if (!point || metric === 'tokens') return true;
  return point[metric] > 0 || point.tokens === 0;
}

/** "64.1M tokens", "1 message". */
export function quantity(value: number, metric: Metric): string {
  return `${formatTokens(value)} ${value === 1 ? METRIC_NOUN[metric].one : METRIC_NOUN[metric].many}`;
}

// ── The recorded history ────────────────────────────────────────────────────────

export interface DaySpan {
  from: string;
  to: string;
  days: number;
}

export interface History {
  /** The record of every day that has one. A day without records is absent. */
  days: Map<string, SeriesPoint>;
  /** First day with a record. Nothing is known about earlier days. */
  first: string;
  /**
   * Last day with a record. Nothing is known about later days: usage after it may simply
   * not be imported yet, so those days are outside the history, as on Lifetime Usage.
   */
  last: string;
  /** Every calendar year from the first to the last one with records. */
  years: number[];
}

export function buildHistory(points: SeriesPoint[]): History | null {
  if (points.length === 0) return null;
  const days = new Map<string, SeriesPoint>();
  let first = points[0].bucket;
  let lastRecorded = points[0].bucket;
  for (const p of points) {
    days.set(p.bucket, p);
    if (p.bucket < first) first = p.bucket;
    if (p.bucket > lastRecorded) lastRecorded = p.bucket;
  }
  const years: number[] = [];
  for (let y = yearOf(first); y <= yearOf(lastRecorded); y++) years.push(y);
  return { days, first, last: lastRecorded, years };
}

const yearOf = (day: string) => Number(day.slice(0, 4));

/** Whether a day lies between the first and the last record. Only those days can be called "no recorded activity". */
export function isInside(history: History, day: string): boolean {
  return day >= history.first && day <= history.last;
}

/** The days of a calendar year that lie inside the recorded history. */
export function yearSpan(history: History, year: number): DaySpan | null {
  const from = history.first > `${year}-01-01` ? history.first : `${year}-01-01`;
  const to = history.last < `${year}-12-31` ? history.last : `${year}-12-31`;
  return from > to ? null : { from, to, days: daysBetween(from, to) };
}

// ── Calendar layout ─────────────────────────────────────────────────────────────

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export interface CalendarDay {
  day: string;
  /** Column: weeks since the week that holds 1 January. */
  week: number;
  /** Row: 0 = Monday … 6 = Sunday. */
  weekday: number;
}

export interface Calendar {
  year: number;
  weeks: number;
  days: CalendarDay[];
  /** Where each month starts: the column that holds its first day. */
  months: Array<{ label: string; week: number }>;
}

export function buildCalendar(year: number): Calendar {
  const offset = weekdayOf(`${year}-01-01`);
  const length = daysBetween(`${year}-01-01`, `${year}-12-31`);
  const days: CalendarDay[] = [];
  const months: Calendar['months'] = [];
  for (let i = 0; i < length; i++) {
    const day = addDays(`${year}-01-01`, i);
    const week = Math.floor((offset + i) / 7);
    days.push({ day, week, weekday: (offset + i) % 7 });
    if (day.endsWith('-01')) months.push({ label: MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3), week });
  }
  return { year, weeks: days[days.length - 1].week + 1, days, months };
}

// ── Colour scale ────────────────────────────────────────────────────────────────

/** The sequential ramp has five steps above "no activity". */
export const MAX_LEVELS = 5;

export interface Scale {
  /** Largest value of every level except the top one, ascending. */
  thresholds: number[];
  min: number;
  max: number;
  /** How many active days of the whole history fall in each level. */
  counts: number[];
}

/**
 * Splits the active days of the whole history into up to five levels holding about
 * the same number of days each (quintiles), so a colour means the same amount in
 * every year. Days with equal values always share a level; when many days are tied,
 * the cut points move to the nearest values that keep every level in use, and a
 * metric with fewer than five distinct values gets one level per value.
 */
export function buildScale(values: number[]): Scale | null {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const distinct = [...new Set(sorted)];
  const cuts = Math.min(MAX_LEVELS - 1, distinct.length - 1);
  // Index into `distinct` of the last value of each level but the top one.
  const at: number[] = [];
  for (let i = 0; i < cuts; i++) {
    const quantile = sorted[Math.ceil(((i + 1) / (cuts + 1)) * sorted.length) - 1];
    const ideal = distinct.indexOf(quantile);
    at.push(Math.max(ideal, i === 0 ? 0 : at[i - 1] + 1));
  }
  // Leave at least one distinct value for every level above a cut.
  for (let i = cuts - 1; i >= 0; i--) at[i] = Math.min(at[i], distinct.length - 2 - (cuts - 1 - i));
  const thresholds = at.map((index) => distinct[index]);
  const counts = new Array<number>(cuts + 1).fill(0);
  for (const v of sorted) counts[levelAbove(v, thresholds) - 1]++;
  return { thresholds, min: sorted[0], max: sorted[sorted.length - 1], counts };
}

const levelAbove = (value: number, thresholds: number[]) => 1 + thresholds.filter((t) => value > t).length;

/** 0 for no activity, otherwise 1 (least) up to the number of levels of the scale. */
export function levelOf(value: number, scale: Scale | null): number {
  if (value <= 0 || !scale) return 0;
  return levelAbove(value, scale.thresholds);
}

/**
 * Which of the five ramp steps a level is drawn with. A scale with fewer levels spreads
 * them over the whole ramp, so its busiest days are still the brightest squares.
 */
export function rampStep(level: number, levels: number): number {
  if (level <= 0) return 0;
  if (levels <= 1) return MAX_LEVELS - 1;
  return Math.round(1 + ((level - 1) * (MAX_LEVELS - 1)) / (levels - 1));
}

/** The values a level covers, in words: "Up to 210K tokens", "2 to 3 messages", "12.1M tokens or more". */
export function bandLabel(scale: Scale, level: number, metric: Metric): string {
  const levels = scale.thresholds.length + 1;
  const lower = level === 1 ? scale.min : scale.thresholds[level - 2] + 1;
  const upper = level === levels ? scale.max : scale.thresholds[level - 1];
  const noun = METRIC_NOUN[metric];
  if (lower === upper) return `${formatTokens(lower)} ${lower === 1 ? noun.one : noun.many}`;
  if (level === levels) return `${formatTokens(lower)} ${noun.many} or more`;
  if (level === 1) return `Up to ${formatTokens(upper)} ${noun.many}`;
  return `${formatTokens(lower)} to ${formatTokens(upper)} ${noun.many}`;
}

// ── Figures for one year ────────────────────────────────────────────────────────

export interface YearSummary {
  /** The days of the year inside the recorded history; null when the whole year lies outside it. */
  span: DaySpan | null;
  /** Days on which the chosen metric is above zero. */
  activeDays: number;
  /** Days with usage whose source does not record the chosen metric: neither active nor quiet (see metricRecorded). */
  unrecordedDays: number;
  /** Longest run of consecutive active days inside the year; the latest one when several are equally long. */
  streak: DaySpan | null;
  /** The day with the highest value of the chosen metric; the latest one when several are equal. */
  busiest: SeriesPoint | null;
  /** Sums over the year. Conversations are absent on purpose: a conversation active on two days must not be counted twice. */
  tokens: number;
  exact: number;
  estimated: number;
  messages: number;
}

export function summariseYear(history: History, year: number, metric: Metric): YearSummary {
  const span = yearSpan(history, year);
  const out: YearSummary = { span, activeDays: 0, unrecordedDays: 0, streak: null, busiest: null, tokens: 0, exact: 0, estimated: 0, messages: 0 };
  if (!span) return out;
  let run = 0;
  for (let day = span.from; day <= span.to; day = addDays(day, 1)) {
    const point = history.days.get(day);
    const value = valueOf(point, metric);
    if (point) {
      out.tokens += point.tokens;
      out.exact += point.exact;
      out.estimated += point.estimated;
      out.messages += point.messages;
    }
    if (value <= 0) {
      // A day whose count is not recorded ends a run too: it cannot be said to continue one.
      if (!metricRecorded(point, metric)) out.unrecordedDays++;
      run = 0;
      continue;
    }
    out.activeDays++;
    run++;
    if (!out.streak || run >= out.streak.days) out.streak = { from: addDays(day, 1 - run), to: day, days: run };
    if (point && (!out.busiest || value >= valueOf(out.busiest, metric))) out.busiest = point;
  }
  return out;
}

export interface WeekdayAverage {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  label: string;
  /** How many days of this weekday the year has inside the recorded history, without those whose source does not record the metric. */
  days: number;
  total: number;
  /** Total divided by days; null when the history holds no such day in this year. */
  average: number | null;
}

export function weekdayAverages(history: History, year: number, metric: Metric): WeekdayAverage[] {
  const rows: WeekdayAverage[] = WEEKDAYS.map((label, weekday) => ({ weekday, label, days: 0, total: 0, average: null }));
  const span = yearSpan(history, year);
  if (!span) return rows;
  for (let day = span.from; day <= span.to; day = addDays(day, 1)) {
    const point = history.days.get(day);
    // Not recorded is not zero: such a day is left out instead of pulling the average down.
    if (!metricRecorded(point, metric)) continue;
    const row = rows[weekdayOf(day)];
    row.days++;
    row.total += valueOf(point, metric);
  }
  for (const row of rows) row.average = row.days > 0 ? row.total / row.days : null;
  return rows;
}

export interface MonthRow {
  /** 1 = January. */
  month: number;
  label: string;
  /** `before` and `after` months lie wholly outside the recorded history: nothing is known about them. */
  state: 'inside' | 'before' | 'after';
  tokens: number;
  messages: number;
  /** Conversations active in the month, each counted once. */
  conversations: number;
  /** Days of the month with at least one record. */
  activeDays: number;
}

/** `monthly` is the monthly series of the whole history; a month's bucket is its first day. */
export function monthRows(history: History, monthly: SeriesPoint[], year: number): MonthRow[] {
  const byMonth = new Map(monthly.map((p) => [p.bucket.slice(0, 7), p]));
  const activeDays = new Map<string, number>();
  for (const day of history.days.keys()) {
    if (yearOf(day) === year) activeDays.set(day.slice(0, 7), (activeDays.get(day.slice(0, 7)) ?? 0) + 1);
  }
  return MONTHS.map((label, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const point = byMonth.get(key);
    const state = key < history.first.slice(0, 7) ? 'before' : key > history.last.slice(0, 7) ? 'after' : 'inside';
    return {
      month: i + 1,
      label,
      state,
      tokens: point?.tokens ?? 0,
      messages: point?.messages ?? 0,
      conversations: point?.conversations ?? 0,
      activeDays: activeDays.get(key) ?? 0,
    };
  });
}

/** A count that only some sources record: a zero beside real token usage means "not recorded", which is shown as a dash. */
export function recordedCount(count: number, tokens: number): string {
  return count === 0 && tokens > 0 ? '–' : formatInt(count);
}
