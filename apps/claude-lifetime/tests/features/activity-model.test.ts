import { describe, expect, it } from 'vitest';
import type { SeriesPoint } from '@/analytics/overview';
import {
  bandLabel,
  buildCalendar,
  buildHistory,
  buildScale,
  isInside,
  levelOf,
  monthRows,
  quantity,
  rampStep,
  recordedCount,
  summariseYear,
  valueOf,
  weekdayAverages,
  weekdayOf,
  yearSpan,
} from '@/features/activity/activity-model';

const day = (bucket: string, tokens: number, over: Partial<SeriesPoint> = {}): SeriesPoint => ({
  bucket,
  group: '',
  tokens,
  exact: tokens,
  estimated: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  replay: 0,
  messages: 0,
  conversations: 0,
  requests: 0,
  ...over,
});

describe('the recorded history', () => {
  const points = [day('2024-11-30', 5), day('2025-01-02', 7), day('2026-03-04', 9)];

  it('runs from the first record to today and lists every year in between', () => {
    const history = buildHistory(points, '2026-11-10');
    expect(history).toMatchObject({ first: '2024-11-30', last: '2026-11-10', years: [2024, 2025, 2026] });
    expect(history?.days.get('2025-01-02')?.tokens).toBe(7);
    expect(buildHistory([], '2026-11-10')).toBeNull();
  });

  it('ends at the last year with records even when today is in a later year', () => {
    expect(buildHistory(points, '2027-02-01')).toMatchObject({ last: '2027-02-01', years: [2024, 2025, 2026] });
  });

  it('never treats a recorded day as outside the history', () => {
    // A daily report is dated in UTC and can be a day ahead of the local "today".
    const history = buildHistory(points, '2026-03-03');
    expect(history?.last).toBe('2026-03-04');
    expect(history && isInside(history, '2026-03-04')).toBe(true);
  });

  it('knows which days it can speak for', () => {
    const history = buildHistory(points, '2026-11-10')!;
    expect(isInside(history, '2024-11-29')).toBe(false);
    expect(isInside(history, '2024-11-30')).toBe(true);
    expect(isInside(history, '2025-06-01')).toBe(true);
    expect(isInside(history, '2026-11-10')).toBe(true);
    expect(isInside(history, '2026-11-11')).toBe(false);
    expect(yearSpan(history, 2024)).toEqual({ from: '2024-11-30', to: '2024-12-31', days: 32 });
    expect(yearSpan(history, 2025)).toEqual({ from: '2025-01-01', to: '2025-12-31', days: 365 });
    expect(yearSpan(history, 2026)).toEqual({ from: '2026-01-01', to: '2026-11-10', days: 314 });
    expect(yearSpan(history, 2023)).toBeNull();
    expect(yearSpan(history, 2027)).toBeNull();
  });
});

describe('calendar layout', () => {
  it('starts weeks on Monday', () => {
    expect(weekdayOf('2026-11-09')).toBe(0);
    expect(weekdayOf('2026-11-15')).toBe(6);
    expect(weekdayOf('2026-01-01')).toBe(3);
  });

  it('lays a year out in week columns and weekday rows', () => {
    const calendar = buildCalendar(2026);
    expect(calendar.days).toHaveLength(365);
    expect(calendar.weeks).toBe(53);
    // 1 January 2026 is a Thursday: first column, fourth row
    expect(calendar.days[0]).toEqual({ day: '2026-01-01', week: 0, weekday: 3 });
    expect(calendar.days.find((d) => d.day === '2026-01-05')).toEqual({ day: '2026-01-05', week: 1, weekday: 0 });
    expect(calendar.days[364]).toEqual({ day: '2026-12-31', week: 52, weekday: 3 });
    // every cell of the grid is used at most once
    expect(new Set(calendar.days.map((d) => `${d.week}:${d.weekday}`)).size).toBe(365);
  });

  it('puts each month label over the column of its first day', () => {
    const { months } = buildCalendar(2026);
    expect(months.map((m) => m.label)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    expect(months[0].week).toBe(0);
    // 1 February 2026 is a Sunday, the last day of the fifth column
    expect(months[1].week).toBe(4);
    // 1 March 2026 is a Sunday as well, four weeks on
    expect(months[2].week).toBe(8);
  });

  it('handles leap years and years that need 54 columns', () => {
    expect(buildCalendar(2024).days).toHaveLength(366);
    expect(buildCalendar(2024).weeks).toBe(53);
    // 2040 is a leap year that starts on a Sunday: one day in the first column, one in the last
    const calendar = buildCalendar(2040);
    expect(calendar.days[0]).toMatchObject({ week: 0, weekday: 6 });
    expect(calendar.weeks).toBe(54);
    expect(calendar.days[365]).toEqual({ day: '2040-12-31', week: 53, weekday: 0 });
  });
});

describe('colour scale', () => {
  it('cuts the active days of the whole history into five groups of equal size', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
    const scale = buildScale([...values, 0, 0, 0])!;
    expect(scale).toEqual({ thresholds: [200, 400, 600, 800], min: 10, max: 1000, counts: [20, 20, 20, 20, 20] });
    expect(levelOf(0, scale)).toBe(0);
    expect(levelOf(10, scale)).toBe(1);
    expect(levelOf(200, scale)).toBe(1);
    expect(levelOf(201, scale)).toBe(2);
    expect(levelOf(800, scale)).toBe(4);
    expect(levelOf(801, scale)).toBe(5);
    expect(levelOf(5000, scale)).toBe(5);
  });

  it('has no scale without active days', () => {
    expect(buildScale([])).toBeNull();
    expect(buildScale([0, 0])).toBeNull();
    expect(levelOf(12, null)).toBe(0);
  });

  it('keeps every level in use when many days share a value', () => {
    // conversations per day: mostly one or two
    const values = [...Array(40).fill(1), ...Array(30).fill(2), ...Array(15).fill(3), ...Array(10).fill(4), ...Array(3).fill(6), 7, 9];
    const scale = buildScale(values)!;
    expect(scale.thresholds).toEqual([1, 2, 3, 4]);
    expect(scale.counts).toEqual([40, 30, 15, 10, 5]);
    expect([1, 2, 3, 4, 6, 9].map((v) => levelOf(v, scale))).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it('still separates the rare quiet days when most days are equally busy', () => {
    const scale = buildScale([1, 2, 3, 4, 5, ...Array(45).fill(9)])!;
    expect(scale.thresholds).toEqual([2, 3, 4, 5]);
    expect(levelOf(9, scale)).toBe(5);
    expect(levelOf(1, scale)).toBe(1);
  });

  it('gives a metric with few distinct values one level per value', () => {
    const three = buildScale([1, 1, 1, 2, 2, 5])!;
    expect(three.thresholds).toEqual([1, 2]);
    expect(three.counts).toEqual([3, 2, 1]);
    const one = buildScale([4, 4, 4])!;
    expect(one.thresholds).toEqual([]);
    expect(levelOf(4, one)).toBe(1);
  });

  it('spreads fewer levels over the whole ramp, brightest for the busiest', () => {
    expect([1, 2, 3, 4, 5].map((level) => rampStep(level, 5))).toEqual([1, 2, 3, 4, 5]);
    expect([1, 2, 3, 4].map((level) => rampStep(level, 4))).toEqual([1, 2, 4, 5]);
    expect([1, 2, 3].map((level) => rampStep(level, 3))).toEqual([1, 3, 5]);
    expect([1, 2].map((level) => rampStep(level, 2))).toEqual([1, 5]);
    expect(rampStep(1, 1)).toBe(4);
    expect(rampStep(0, 5)).toBe(0);
  });

  it('describes the values of each level', () => {
    const tokens = buildScale(Array.from({ length: 100 }, (_, i) => (i + 1) * 10_000))!;
    expect([1, 2, 3, 4, 5].map((level) => bandLabel(tokens, level, 'tokens'))).toEqual([
      'Up to 200K tokens',
      '200K to 400K tokens',
      '400K to 600K tokens',
      '600K to 800K tokens',
      '800K tokens or more',
    ]);
    const conversations = buildScale([...Array(40).fill(1), ...Array(30).fill(2), ...Array(15).fill(3), ...Array(10).fill(4), 6, 9])!;
    expect([1, 2, 5].map((level) => bandLabel(conversations, level, 'conversations'))).toEqual(['1 conversation', '2 conversations', '5 conversations or more']);
    expect(bandLabel(buildScale([4, 4])!, 1, 'messages')).toBe('4 messages');
  });
});

describe('figures for one year', () => {
  const history = buildHistory(
    [
      day('2025-12-30', 10),
      day('2025-12-31', 10),
      day('2026-01-01', 30, { exact: 20, estimated: 10, messages: 4, conversations: 2 }),
      day('2026-01-02', 5, { messages: 0, conversations: 1 }),
      // a pause on 3 January
      day('2026-01-04', 50, { messages: 9, conversations: 1 }),
      day('2026-01-05', 50, { messages: 1, conversations: 3 }),
      day('2026-01-06', 1, { messages: 0, conversations: 0 }),
      day('2026-01-12', 0, { messages: 2, conversations: 1 }),
    ],
    '2026-01-14',
  )!;

  it('counts active days, the longest streak and the busiest day for the chosen metric', () => {
    const tokens = summariseYear(history, 2026, 'tokens');
    expect(tokens.span).toEqual({ from: '2026-01-01', to: '2026-01-14', days: 14 });
    expect(tokens.activeDays).toBe(5);
    expect(tokens.streak).toEqual({ from: '2026-01-04', to: '2026-01-06', days: 3 });
    // two days with 50 tokens: the later one
    expect(tokens.busiest?.bucket).toBe('2026-01-05');
    expect(tokens).toMatchObject({ tokens: 136, exact: 126, estimated: 10, messages: 16 });

    const messages = summariseYear(history, 2026, 'messages');
    expect(messages.activeDays).toBe(4);
    expect(messages.streak).toEqual({ from: '2026-01-04', to: '2026-01-05', days: 2 });
    expect(messages.busiest?.bucket).toBe('2026-01-04');

    const conversations = summariseYear(history, 2026, 'conversations');
    expect(conversations.activeDays).toBe(5);
    expect(conversations.busiest?.bucket).toBe('2026-01-05');
  });

  it('measures a streak inside the year only, and prefers the latest of equal streaks', () => {
    // 30 and 31 December belong to 2025: the run that continues into January is cut at the year's edge
    expect(summariseYear(history, 2025, 'tokens')).toMatchObject({ activeDays: 2, streak: { from: '2025-12-30', to: '2025-12-31', days: 2 } });
    expect(summariseYear(history, 2026, 'conversations').streak).toEqual({ from: '2026-01-04', to: '2026-01-05', days: 2 });
  });

  it('has nothing to say about a year outside the history', () => {
    expect(summariseYear(history, 2024, 'tokens')).toMatchObject({ span: null, activeDays: 0, streak: null, busiest: null, tokens: 0 });
  });

  it('averages each weekday over the days of the year inside the history only', () => {
    const rows = weekdayAverages(history, 2026, 'tokens');
    expect(rows.map((r) => r.label)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    // 1 to 14 January 2026: two of every weekday
    expect(rows.map((r) => r.days)).toEqual([2, 2, 2, 2, 2, 2, 2]);
    // Mondays 5 and 12 January: 50 and 0 tokens
    expect(rows[0]).toMatchObject({ total: 50, average: 25 });
    // Thursdays 1 and 8 January: 30 and nothing
    expect(rows[3]).toMatchObject({ total: 30, average: 15 });
    // 2025 only has 30 (Tuesday) and 31 December (Wednesday) inside the history
    const short = weekdayAverages(history, 2025, 'tokens');
    expect(short.map((r) => r.days)).toEqual([0, 1, 1, 0, 0, 0, 0]);
    expect(short[0].average).toBeNull();
    expect(short[1].average).toBe(10);
  });

  it('builds the monthly table, with months outside the history marked as such', () => {
    const monthly = [day('2025-12-01', 20, { messages: 0, conversations: 0 }), day('2026-01-01', 136, { messages: 16, conversations: 5 })];
    const rows2026 = monthRows(history, monthly, 2026);
    expect(rows2026[0]).toEqual({ month: 1, label: 'January', state: 'inside', tokens: 136, messages: 16, conversations: 5, activeDays: 6 });
    expect(rows2026[1]).toMatchObject({ label: 'February', state: 'after', tokens: 0, activeDays: 0 });
    const rows2025 = monthRows(history, monthly, 2025);
    expect(rows2025[10]).toMatchObject({ label: 'November', state: 'before' });
    expect(rows2025[11]).toMatchObject({ label: 'December', state: 'inside', tokens: 20, activeDays: 2 });
  });

  it('reads a metric off a day and words quantities', () => {
    expect(valueOf(undefined, 'tokens')).toBe(0);
    expect(valueOf(history.days.get('2026-01-01'), 'conversations')).toBe(2);
    expect(quantity(1, 'messages')).toBe('1 message');
    expect(quantity(64_100_000, 'tokens')).toBe('64.1M tokens');
  });

  it('shows a dash for a count the sources do not record, and a zero when there is no usage at all', () => {
    expect(recordedCount(12, 500)).toBe('12');
    expect(recordedCount(0, 500)).toBe('–');
    expect(recordedCount(0, 0)).toBe('0');
  });
});
