import { describe, expect, it } from 'vitest';
import { NO_PLAN, UNKNOWN_MODEL_LABEL } from '@/analytics/base';
import type { SeriesPoint } from '@/analytics/overview';
import type { SubscriptionPeriod } from '@/analytics/subscriptions';
import { SERIES_COLORS } from '@/components/charts/series-chart';
import { familyColor, NEUTRAL, planColor } from '@/lib/palette';
import type { ChartRow } from '@/lib/series';
import {
  bucketDays,
  categoryChart,
  confidenceChart,
  countBuckets,
  cumulativeChart,
  describeChart,
  familyChart,
  groupOf,
  MAX_BUCKETS,
  modelChart,
  planChart,
  rankBuckets,
  rankModels,
  recordedHistory,
  recordedSpan,
  resolveGranularity,
  zoomSlice,
  zoomWindow,
  type DaySpan,
} from '@/features/usage/usage-model';

const point = (bucket: string, group: string, over: Partial<SeriesPoint> = {}): SeriesPoint => ({
  bucket,
  group,
  tokens: 0,
  exact: 0,
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

const span = (from: string, to: string): DaySpan => ({ from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 });
const column = (rows: ChartRow[], key: string) => rows.map((r) => Number(r[key]));

describe('the days a range covers', () => {
  const history = { first: '2024-05-14', last: '2026-11-09' };

  it('reads the first and last recorded day from the daily series', () => {
    expect(recordedHistory([])).toBeNull();
    expect(recordedHistory([point('2025-03-02', ''), point('2024-05-14', ''), point('2026-11-09', '')])).toEqual(history);
  });

  it('uses the whole history for "all time"', () => {
    expect(recordedSpan({ from: null, to: null }, history)).toEqual({ from: '2024-05-14', to: '2026-11-09', days: 910 });
  });

  it('keeps a range that lies inside the history as it is', () => {
    expect(recordedSpan({ from: '2026-03-01', to: '2026-03-31' }, history)).toEqual({ from: '2026-03-01', to: '2026-03-31', days: 31 });
  });

  it('leaves out days before the first record and after the last one', () => {
    expect(recordedSpan({ from: '2024-01-01', to: '2024-06-30' }, history)).toEqual({ from: '2024-05-14', to: '2024-06-30', days: 48 });
    expect(recordedSpan({ from: '2026-10-12', to: '2026-11-10' }, history)).toEqual({ from: '2026-10-12', to: '2026-11-09', days: 29 });
    expect(recordedSpan({ from: '2026-11-01', to: null }, history)).toEqual({ from: '2026-11-01', to: '2026-11-09', days: 9 });
  });

  it('is empty for a range wholly outside the history', () => {
    expect(recordedSpan({ from: '2019-01-01', to: '2019-12-31' }, history)).toBeNull();
    expect(recordedSpan({ from: '2027-01-01', to: null }, history)).toBeNull();
  });
});

describe('bucket size', () => {
  it('counts the buckets a span touches', () => {
    const s = span('2024-05-14', '2026-11-09');
    expect(countBuckets(s, 'day')).toBe(910);
    // Monday 13 May 2024 up to Monday 9 November 2026
    expect(countBuckets(s, 'week')).toBe(131);
    expect(countBuckets(s, 'month')).toBe(31);
    expect(countBuckets(s, 'year')).toBe(3);
    expect(countBuckets(span('2026-03-04', '2026-03-04'), 'week')).toBe(1);
    expect(countBuckets(span('2025-12-31', '2026-01-01'), 'month')).toBe(2);
  });

  it('follows the automatic choice for the length of the span', () => {
    expect(resolveGranularity('auto', span('2026-10-12', '2026-11-09'))).toEqual({ granularity: 'day', tooFine: null });
    expect(resolveGranularity('auto', span('2026-06-01', '2026-11-09'))).toEqual({ granularity: 'week', tooFine: null });
    expect(resolveGranularity('auto', span('2024-05-14', '2026-11-09'))).toEqual({ granularity: 'month', tooFine: null });
    expect(resolveGranularity('auto', span('2010-01-01', '2026-11-09'))).toEqual({ granularity: 'year', tooFine: null });
  });

  it('keeps the bucket size the reader picked while it stays drawable', () => {
    expect(resolveGranularity('day', span('2024-05-14', '2026-11-09'))).toEqual({ granularity: 'day', tooFine: null });
    expect(resolveGranularity('year', span('2026-10-12', '2026-11-09'))).toEqual({ granularity: 'year', tooFine: null });
  });

  it('falls back to the next coarser size, and says so, when the pick would draw too many buckets', () => {
    const fiveYears = span('2021-01-01', '2025-12-31');
    expect(countBuckets(fiveYears, 'day')).toBeGreaterThan(MAX_BUCKETS);
    expect(resolveGranularity('day', fiveYears)).toEqual({ granularity: 'week', tooFine: { chosen: 'day', buckets: 1826 } });
    // forty years of weeks is too many as well: months it is
    const fortyYears = span('1986-01-01', '2025-12-31');
    expect(resolveGranularity('day', fortyYears).granularity).toBe('month');
    expect(resolveGranularity('week', fortyYears)).toMatchObject({ granularity: 'month', tooFine: { chosen: 'week' } });
  });
});

describe('busiest buckets', () => {
  it('ranks by tokens, latest first among equals, and leaves out empty buckets', () => {
    const ranked = rankBuckets(
      [point('2026-01-01', '', { tokens: 5 }), point('2026-02-01', '', { tokens: 9 }), point('2026-03-01', '', { tokens: 0 }), point('2026-04-01', '', { tokens: 9 }), point('2026-05-01', '', { tokens: 1 })],
      3,
    );
    expect(ranked.map((p) => p.bucket)).toEqual(['2026-04-01', '2026-02-01', '2026-01-01']);
  });

  it('gives the days of a bucket that lie inside the span', () => {
    const s = span('2024-05-14', '2026-11-09');
    expect(bucketDays('2024-05-01', 'month', s)).toEqual({ from: '2024-05-14', to: '2024-05-31', days: 18 });
    expect(bucketDays('2026-11-09', 'week', s)).toEqual({ from: '2026-11-09', to: '2026-11-09', days: 1 });
    expect(bucketDays('2025-02-01', 'month', s)).toEqual({ from: '2025-02-01', to: '2025-02-28', days: 28 });
  });
});

describe('chart views', () => {
  const frame = { granularity: 'month' as const, span: span('2026-01-10', '2026-04-20') };

  it('asks the database for the grouping each view needs', () => {
    expect(groupOf('tokens', 'family')).toBe('confidence');
    expect(groupOf('cumulative', 'model')).toBe('confidence');
    expect(groupOf('categories', 'family')).toBe('none');
    expect(groupOf('models', 'family')).toBe('family');
    expect(groupOf('models', 'model')).toBe('model');
    expect(groupOf('plans', 'family')).toBe('plan');
  });

  it('stacks exact and estimated tokens and fills months without records with zeros', () => {
    const chart = confidenceChart(
      [point('2026-01-01', 'exact', { tokens: 100 }), point('2026-01-01', 'estimated', { tokens: 10 }), point('2026-04-01', 'exact', { tokens: 40 })],
      frame,
    );
    expect(chart.kind).toBe('bar');
    expect(chart.rows.map((r) => r.bucket)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    expect(column(chart.rows, 'exact')).toEqual([100, 0, 0, 40]);
    expect(column(chart.rows, 'estimated')).toEqual([10, 0, 0, 0]);
    expect(chart.series).toEqual([
      { key: 'exact', label: 'Exact', color: SERIES_COLORS[0] },
      { key: 'estimated', label: 'Estimated', color: SERIES_COLORS[0], estimated: true },
    ]);
  });

  it('drops a series that is zero everywhere without changing the colour of the other', () => {
    const chart = confidenceChart([point('2026-02-01', 'estimated', { tokens: 7 })], frame);
    expect(chart.series).toEqual([{ key: 'estimated', label: 'Estimated', color: SERIES_COLORS[0], estimated: true }]);
  });

  it('turns the same series into running totals for the cumulative view', () => {
    const chart = cumulativeChart(
      [point('2026-01-01', 'exact', { tokens: 100 }), point('2026-01-01', 'estimated', { tokens: 10 }), point('2026-03-01', 'estimated', { tokens: 5 }), point('2026-04-01', 'exact', { tokens: 40 })],
      frame,
    );
    expect(chart.kind).toBe('area');
    expect(column(chart.rows, 'exact')).toEqual([100, 100, 100, 140]);
    expect(column(chart.rows, 'estimated')).toEqual([10, 10, 15, 15]);
  });

  const mixed = [
    point('2026-01-01', '', { tokens: 1500, input: 100, output: 200, cacheWrite: 300, cacheRead: 400, replay: 500 }),
    point('2026-03-01', '', { tokens: 30, input: 10, output: 20 }),
  ];

  it('splits processed tokens into all five categories, in the fixed order and colours', () => {
    const chart = categoryChart(mixed, frame, 'processed');
    expect(chart.series.map((s) => [s.label, s.color, s.estimated ?? false])).toEqual([
      ['Input', SERIES_COLORS[0], false],
      ['Output', SERIES_COLORS[1], false],
      ['Cache writes', SERIES_COLORS[2], false],
      ['Cache reads', SERIES_COLORS[3], false],
      ['Re-read context', SERIES_COLORS[4], true],
    ]);
    expect(chart.rows.map((r) => chart.series.reduce((sum, s) => sum + Number(r[s.key]), 0))).toEqual([1500, 0, 30, 0]);
  });

  it('leaves cache reads and re-read context out of the "new tokens" basis', () => {
    const chart = categoryChart(mixed, frame, 'new');
    expect(chart.series.map((s) => s.label)).toEqual(['Input', 'Output', 'Cache writes']);
    // 100 + 200 + 300: what the "new" total of that month is
    expect(chart.rows.map((r) => chart.series.reduce((sum, s) => sum + Number(r[s.key]), 0))).toEqual([600, 0, 30, 0]);
  });

  it('orders model families as the palette does and never merges usage without a model into one', () => {
    const chart = familyChart(
      [
        point('2026-01-01', 'unknown', { tokens: 50 }),
        point('2026-01-01', 'opus', { tokens: 20 }),
        point('2026-02-01', 'sonnet', { tokens: 30 }),
        point('2026-02-01', 'a-family-of-the-future', { tokens: 4 }),
      ],
      frame,
    );
    expect(chart.series).toEqual([
      { key: 'sonnet', label: 'Claude Sonnet', color: familyColor('sonnet') },
      { key: 'opus', label: 'Claude Opus', color: familyColor('opus') },
      { key: 'other', label: 'Other model', color: familyColor('other') },
      { key: 'unknown', label: 'Unknown model', color: NEUTRAL },
    ]);
    expect(column(chart.rows, 'unknown')).toEqual([50, 0, 0, 0]);
    expect(column(chart.rows, 'other')).toEqual([0, 4, 0, 0]);
  });

  it('ranks models by lifetime usage, whatever the basis, and leaves out usage without a model', () => {
    const lifetime = [
      point('2025-01-01', 'Model B', { tokens: 5, input: 5, cacheRead: 900 }),
      point('2026-01-01', 'Model B', { tokens: 5, input: 5 }),
      point('2025-01-01', 'Model A', { tokens: 800, input: 800 }),
      point('2025-01-01', 'Model C', { tokens: 800, output: 800 }),
      point('2025-01-01', UNKNOWN_MODEL_LABEL, { tokens: 99_999, input: 99_999 }),
      point('2025-01-01', 'Model D', { tokens: 0 }),
    ];
    // B: 910 processed, A and C: 800 each (ordered by name), D has no usage at all
    expect(rankModels(lifetime)).toEqual(['Model B', 'Model A', 'Model C']);
    expect(rankModels(lifetime, 2)).toEqual(['Model B', 'Model A']);
  });

  it('gives ranked models their colour by rank and folds the rest into "Other models"', () => {
    const chart = modelChart(
      [
        point('2026-01-01', 'Model A', { tokens: 10 }),
        point('2026-01-01', 'Model Z', { tokens: 3 }),
        point('2026-02-01', 'Model Y', { tokens: 2 }),
        point('2026-02-01', 'Model X', { tokens: 0 }),
        point('2026-02-01', UNKNOWN_MODEL_LABEL, { tokens: 7 }),
      ],
      frame,
      ['Model B', 'Model A'],
    );
    // Model B has no usage in this range: it has no series, and Model A keeps the second colour all the same.
    expect(chart.series).toEqual([
      { key: 'model1', label: 'Model A', color: SERIES_COLORS[1] },
      { key: 'other', label: 'Other models', color: '#8f8f9b' },
      { key: 'unknown', label: UNKNOWN_MODEL_LABEL, color: NEUTRAL },
    ]);
    expect(column(chart.rows, 'other')).toEqual([3, 2, 0, 0]);
    expect(column(chart.rows, 'unknown')).toEqual([0, 7, 0, 0]);
    expect(chart.folded).toBe(2);
  });

  const period = (planKey: string, label: string | null): SubscriptionPeriod => ({
    id: 1,
    planKey,
    label,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    startDate: '2026-01-01',
    lastDate: null,
    monthlyPrice: null,
    currency: 'USD',
    notes: null,
    isSynthetic: false,
  });

  it('orders plans as they are listed everywhere, with time no period covers last', () => {
    const chart = planChart(
      [point('2026-01-01', NO_PLAN, { tokens: 5 }), point('2026-02-01', 'max_5x', { tokens: 9 }), point('2026-02-01', 'free', { tokens: 1 }), point('2026-03-01', 'pro', { tokens: 4 })],
      frame,
      [period('free', null), period('pro', null), period('max_5x', null)],
    );
    expect(chart.series).toEqual([
      { key: 'free', label: 'Free', color: planColor('free') },
      { key: 'pro', label: 'Pro', color: planColor('pro') },
      { key: 'max_5x', label: 'Max 5x', color: planColor('max_5x') },
      { key: NO_PLAN, label: 'No subscription recorded', color: NEUTRAL },
    ]);
    expect(column(chart.rows, NO_PLAN)).toEqual([5, 0, 0, 0]);
  });

  it('uses the name the reader gave a plan only when every period on that plan carries it', () => {
    const points = [point('2026-01-01', 'other', { tokens: 5 }), point('2026-01-01', 'pro', { tokens: 5 })];
    const labels = (periods: SubscriptionPeriod[]) => planChart(points, frame, periods).series.map((s) => s.label);
    expect(labels([period('other', 'Student plan'), period('pro', null)])).toEqual(['Pro', 'Student plan']);
    expect(labels([period('other', 'Student plan'), period('other', 'Team trial'), period('pro', 'Pro (annual)'), period('pro', null)])).toEqual(['Pro', 'Other']);
  });

  it('says on which basis and over which days a view is plotted', () => {
    const tokens = describeChart('tokens', 'family', 'processed', frame);
    expect(tokens.title).toBe('Tokens per month');
    expect(tokens.description).toContain('Processed tokens per month, Jan 10 – Apr 20, 2026.');
    expect(describeChart('cumulative', 'family', 'new', frame).description).toContain('Running total of new tokens within the selected range');
    expect(describeChart('categories', 'family', 'new', frame).description).toContain('Cache reads and re-read context are not new tokens');
    expect(describeChart('categories', 'family', 'processed', frame).description).not.toContain('leaves them out');
    expect(describeChart('models', 'model', 'processed', { ...frame, granularity: 'week' }).title).toBe('Tokens per week by model');
    expect(describeChart('models', 'family', 'processed', frame).description).toContain('Unknown model');
  });
});

describe('zoom', () => {
  const months: ChartRow[] = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'].map((bucket) => ({ bucket }));

  it('shows every row while nothing is zoomed', () => {
    expect(zoomSlice(months, 'month', null)).toEqual([0, 6]);
    expect(zoomWindow(months, 'month', 0, 6)).toBeNull();
  });

  it('remembers a window as whole days and finds its rows again', () => {
    const window = zoomWindow(months, 'month', 1, 4);
    expect(window).toEqual({ from: '2026-02-01', to: '2026-04-30' });
    expect(zoomSlice(months, 'month', window)).toEqual([1, 4]);
  });

  it('keeps the same days in view when the bucket size changes', () => {
    const window = { from: '2026-02-01', to: '2026-04-30' };
    const weeks: ChartRow[] = [];
    for (let t = Date.parse('2025-12-29'); t <= Date.parse('2026-06-29'); t += 7 * 86_400_000) weeks.push({ bucket: new Date(t).toISOString().slice(0, 10) });
    const [start, end] = zoomSlice(weeks, 'week', window);
    // the week of Monday 26 January holds 1 February; the week of Monday 27 April holds 30 April
    expect(weeks[start].bucket).toBe('2026-01-26');
    expect(weeks[end - 1].bucket).toBe('2026-04-27');
    expect(zoomSlice([{ bucket: '2025-01-01' }, { bucket: '2026-01-01' }], 'year', window)).toEqual([1, 2]);
  });

  it('never returns an empty slice, even for a window outside the rows', () => {
    expect(zoomSlice(months, 'month', { from: '2027-01-01', to: '2027-02-01' })).toEqual([5, 6]);
    expect(zoomSlice(months, 'month', { from: '2020-01-01', to: '2020-02-01' })).toEqual([0, 1]);
  });
});
