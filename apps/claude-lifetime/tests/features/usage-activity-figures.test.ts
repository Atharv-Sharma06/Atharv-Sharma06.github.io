import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter, Granularity, TokenBasis } from '@/analytics/base';
import { getOverview, getTimeSeries, type SeriesPoint } from '@/analytics/overview';
import { listPeriods, type SubscriptionPeriod } from '@/analytics/subscriptions';
import { toNumber } from '@/db/driver';
import { buildHistory, buildScale, monthRows, summariseYear, valueOf, weekdayAverages, type History } from '@/features/activity/activity-model';
import {
  categoryChart,
  confidenceChart,
  cumulativeChart,
  familyChart,
  modelChart,
  planChart,
  rankBuckets,
  rankModels,
  recordedHistory,
  recordedSpan,
  type ChartModel,
} from '@/features/usage/usage-model';
import { loadDemoDataset } from '@/import/demo/load';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * The figures the Lifetime Usage and Activity Heatmap pages put on screen, recomputed
 * with plain SQL over the usage facts. The pages go through the analytics queries and
 * then through their own shaping (gap filling, folding, streaks, averages); these
 * statements go through neither.
 */
const NOW = new Date('2026-11-10T12:00:00Z');
/** The last day the demo dataset has a record for. */
const LAST_RECORD = '2026-11-09';
const FACTS = `usage_facts f JOIN data_sources s ON s.id = f.source_id`;
const MINE = `f.user_id = $1 AND s.include_in_totals`;
const NEW = `(f.input_tokens + f.output_tokens + f.cache_write_5m_tokens + f.cache_write_1h_tokens)`;
const PROCESSED = `(${NEW} + f.cache_read_tokens + f.replay_tokens)`;
// The test database runs in UTC, so a fact's local day is its UTC day.
const DAY = `(f.occurred_at AT TIME ZONE 'UTC')::date`;
const MESSAGES = `(f.user_message_count + f.assistant_message_count)`;

let t: TestDb;
let lifetime: AnalyticsFilter;
let daily: SeriesPoint[];
let history: History;
let periods: SubscriptionPeriod[];

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, [t.userId, ...params])).rows;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
const stacked = (chart: ChartModel) => chart.rows.reduce((sum, row) => sum + chart.series.reduce((s, def) => s + Number(row[def.key]), 0), 0);

beforeAll(async () => {
  t = await createTestDb('UTC');
  await loadDemoDataset(t.db, t.userId, 'UTC', NOW);
  lifetime = { userId: t.userId, timezone: 'UTC', basis: 'processed' };
  daily = await getTimeSeries(t.db, lifetime, 'day', 'none');
  history = buildHistory(daily)!;
  periods = await listPeriods(t.db, t.userId, 'UTC');
});
afterAll(() => t.close());

describe('Lifetime Usage', () => {
  it('spans the first to the last recorded day and averages the total over those days', async () => {
    const sql = await one(`SELECT min(${DAY})::text AS first, max(${DAY})::text AS last, (max(${DAY}) - min(${DAY}) + 1)::int AS days,
                                  sum(${PROCESSED})::bigint AS total, count(DISTINCT ${DAY})::int AS active
                             FROM ${FACTS} WHERE ${MINE}`);
    const recorded = recordedHistory(daily)!;
    expect(recorded).toEqual({ first: sql.first, last: sql.last });
    const span = recordedSpan({ from: null, to: null }, recorded)!;
    expect(span.days).toBe(sql.days);

    const overview = await getOverview(t.db, lifetime);
    expect(overview.tokens.total).toBe(toNumber(sql.total));
    expect(overview.activeDays).toBe(sql.active);
    // the two rates of the "Average per day" tile
    expect(overview.tokens.total / span.days).toBeCloseTo(toNumber(sql.total) / toNumber(sql.days), 6);
    expect(overview.tokens.total / overview.activeDays).toBeCloseTo(toNumber(sql.total) / toNumber(sql.active), 6);
  });

  it.each(['day', 'week', 'month', 'year'] as Granularity[])('lists the ten busiest %ss with their full figures', async (granularity) => {
    const bucket = granularity === 'day' ? DAY : `date_trunc('${granularity}', ${DAY}::timestamp)::date`;
    const sql = await rows(
      `SELECT ${bucket}::text AS bucket, sum(${PROCESSED})::bigint AS tokens,
              COALESCE(sum(${PROCESSED}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
              COALESCE(sum(${PROCESSED}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
              sum(${MESSAGES})::bigint AS messages, count(DISTINCT f.conversation_id)::int AS conversations
         FROM ${FACTS} WHERE ${MINE} GROUP BY 1 HAVING sum(${PROCESSED}) > 0 ORDER BY 2 DESC, 1 DESC LIMIT 10`,
    );
    const ranked = rankBuckets(await getTimeSeries(t.db, lifetime, granularity, 'none'), 10);
    expect(ranked.map((p) => [p.bucket, p.tokens, p.exact, p.estimated, p.messages, p.conversations])).toEqual(
      sql.map((r) => [r.bucket, toNumber(r.tokens), toNumber(r.exact), toNumber(r.estimated), toNumber(r.messages), toNumber(r.conversations)]),
    );
  });

  it.each(['processed', 'new'] as TokenBasis[])('draws every view so that its bars add up to the %s total', async (basis) => {
    const filter = { ...lifetime, basis };
    const total = (await getOverview(t.db, filter)).tokens.total;
    expect(total).toBe(toNumber((await one(`SELECT sum(${basis === 'new' ? NEW : PROCESSED})::bigint AS total FROM ${FACTS} WHERE ${MINE}`)).total));

    const span = recordedSpan({ from: null, to: null }, recordedHistory(daily)!)!;
    const frame = { granularity: 'month' as const, span };
    const series = (group: Parameters<typeof getTimeSeries>[3]) => getTimeSeries(t.db, filter, 'month', group);

    const confidence = confidenceChart(await series('confidence'), frame);
    expect(stacked(confidence)).toBe(total);
    expect(confidence.rows).toHaveLength(31);

    const running = cumulativeChart(await series('confidence'), frame);
    const end = running.rows[running.rows.length - 1];
    expect(Number(end.exact) + Number(end.estimated)).toBe(total);

    expect(stacked(categoryChart(await series('none'), frame, basis))).toBe(total);
    expect(stacked(familyChart(await series('family'), frame))).toBe(total);
    expect(stacked(planChart(await series('plan'), frame, periods))).toBe(total);

    const ranked = rankModels(await getTimeSeries(t.db, filter, 'year', 'model'));
    const models = modelChart(await series('model'), frame, ranked);
    expect(stacked(models)).toBe(total);
    expect(ranked).toHaveLength(7);
    expect(models.series.map((s) => s.label)).toEqual([...ranked, 'Other models', 'Unknown model']);
  });

  it('ranks models the same under both bases, so their colours do not move', async () => {
    const processed = rankModels(await getTimeSeries(t.db, lifetime, 'year', 'model'));
    const fresh = rankModels(await getTimeSeries(t.db, { ...lifetime, basis: 'new' }, 'year', 'model'));
    expect(fresh).toEqual(processed);
    const sql = await rows<{ name: string }>(
      `SELECT mc.display_name AS name FROM ${FACTS} JOIN model_catalog mc ON mc.id = f.model_id
        WHERE ${MINE} GROUP BY 1 ORDER BY sum(${PROCESSED}) DESC, 1 LIMIT 7`,
    );
    // The seven models with the most usage, listed by name: the amount decides who is listed, not in which colour.
    expect(processed).toEqual(sql.map((r) => r.name).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
  });

  it('keeps usage without a model, and time without a plan, in bands of their own', async () => {
    const span = recordedSpan({ from: null, to: null }, recordedHistory(daily)!)!;
    const frame = { granularity: 'year' as const, span };
    const unknown = toNumber((await one(`SELECT COALESCE(sum(${PROCESSED}), 0)::bigint AS n FROM ${FACTS} WHERE ${MINE} AND f.model_id IS NULL`)).n);
    expect(unknown).toBeGreaterThan(0);

    const families = familyChart(await getTimeSeries(t.db, lifetime, 'year', 'family'), frame);
    expect(families.rows.reduce((sum, r) => sum + Number(r.unknown), 0)).toBe(unknown);
    const opus = await one(
      `SELECT sum(${PROCESSED})::bigint AS n FROM ${FACTS} JOIN model_catalog mc ON mc.id = f.model_id
        WHERE ${MINE} AND mc.family = 'opus' AND ${DAY} BETWEEN '2026-01-01' AND '2026-12-31'`,
    );
    expect(Number(families.rows.find((r) => r.bucket === '2026-01-01')?.opus)).toBe(toNumber(opus.n));

    const models = modelChart(await getTimeSeries(t.db, lifetime, 'year', 'model'), frame, rankModels(await getTimeSeries(t.db, lifetime, 'year', 'model')));
    expect(models.rows.reduce((sum, r) => sum + Number(r.unknown), 0)).toBe(unknown);

    const plans = planChart(await getTimeSeries(t.db, lifetime, 'year', 'plan'), frame, periods);
    expect(plans.series.map((s) => s.label)).toEqual(['Free', 'Pro', 'Max 5x']);
    const pro = await one(
      `SELECT sum(${PROCESSED})::bigint AS n FROM ${FACTS}
         JOIN subscription_periods sp ON sp.user_id = f.user_id AND sp.plan_key = 'pro' AND ${DAY} BETWEEN sp.start_date AND sp.last_date
        WHERE ${MINE}`,
    );
    expect(plans.rows.reduce((sum, r) => sum + Number(r.pro), 0)).toBe(toNumber(pro.n));
  });

  it('follows a date range: one bar for every day of the range, adding up to the range total', async () => {
    const filter = { ...lifetime, from: '2026-03-01', to: '2026-03-31' };
    const span = recordedSpan(filter, recordedHistory(daily)!)!;
    expect(span).toEqual({ from: '2026-03-01', to: '2026-03-31', days: 31 });
    const chart = confidenceChart(await getTimeSeries(t.db, filter, 'day', 'confidence'), { granularity: 'day', span });
    const sql = await one(`SELECT sum(${PROCESSED})::bigint AS total FROM ${FACTS} WHERE ${MINE} AND ${DAY} BETWEEN '2026-03-01' AND '2026-03-31'`);
    expect(chart.rows).toHaveLength(31);
    expect(stacked(chart)).toBe(toNumber(sql.total));
    expect((await getOverview(t.db, filter)).tokens.total).toBe(toNumber(sql.total));
  });
});

describe('Activity Heatmap', () => {
  const perDay = `SELECT ${DAY}::text AS day, sum(${PROCESSED})::bigint AS tokens,
                         COALESCE(sum(${PROCESSED}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
                         COALESCE(sum(${PROCESSED}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
                         sum(${MESSAGES})::bigint AS messages, count(DISTINCT f.conversation_id)::int AS conversations
                    FROM ${FACTS} WHERE ${MINE} GROUP BY 1`;

  it('colours and describes each day with that day’s own figures', async () => {
    const sql = await rows(`${perDay} ORDER BY 1`);
    expect(history.days.size).toBe(sql.length);
    expect(history.first).toBe(sql[0].day);
    // The history ends with the last record, the day before "today" in the demo.
    expect(history.last).toBe(LAST_RECORD);
    for (const r of sql) {
      const point = history.days.get(String(r.day));
      expect([r.day, point?.tokens, point?.exact, point?.estimated, point?.messages, point?.conversations]).toEqual([
        r.day,
        toNumber(r.tokens),
        toNumber(r.exact),
        toNumber(r.estimated),
        toNumber(r.messages),
        toNumber(r.conversations),
      ]);
    }
  });

  it('summarises a year: total, active days, longest streak and busiest day', async () => {
    const summary = summariseYear(history, 2026, 'tokens');
    const total = await one(
      `SELECT sum(${PROCESSED})::bigint AS tokens, sum(${MESSAGES})::bigint AS messages, count(DISTINCT f.conversation_id)::int AS conversations
         FROM ${FACTS} WHERE ${MINE} AND ${DAY} BETWEEN '2026-01-01' AND '2026-12-31'`,
    );
    expect(summary.tokens).toBe(toNumber(total.tokens));
    expect(summary.messages).toBe(toNumber(total.messages));
    expect(summary.exact + summary.estimated).toBe(summary.tokens);
    expect(summary.span).toEqual({ from: '2026-01-01', to: LAST_RECORD, days: 313 });

    // the year's figures in the year switch and the first tile come from the yearly series
    const yearly = (await getTimeSeries(t.db, lifetime, 'year', 'none')).find((p) => p.bucket === '2026-01-01');
    expect([yearly?.tokens, yearly?.messages, yearly?.conversations]).toEqual([toNumber(total.tokens), toNumber(total.messages), total.conversations]);
    // a conversation active on several days is one conversation: the daily counts add up to more
    const conversationDays = [...history.days.values()].filter((p) => p.bucket.startsWith('2026-')).reduce((sum, p) => sum + p.conversations, 0);
    expect(conversationDays).toBeGreaterThan(toNumber(total.conversations));

    const active = `SELECT ${DAY} AS day, sum(${PROCESSED}) AS tokens FROM ${FACTS}
                     WHERE ${MINE} AND ${DAY} BETWEEN '2026-01-01' AND '2026-12-31' GROUP BY 1 HAVING sum(${PROCESSED}) > 0`;
    expect(summary.activeDays).toBe((await one(`SELECT count(*)::int AS n FROM (${active}) d`)).n);

    // consecutive days share the value of (day - row number)
    const streak = await one(
      `WITH d AS (${active}), g AS (SELECT day, day - (row_number() OVER (ORDER BY day))::int AS run FROM d)
       SELECT min(day)::text AS first, max(day)::text AS last, count(*)::int AS days FROM g GROUP BY run ORDER BY 3 DESC, 2 DESC LIMIT 1`,
    );
    expect(summary.streak).toEqual({ from: streak.first, to: streak.last, days: streak.days });

    const busiest = await one(`SELECT day::text AS day, tokens::bigint AS tokens FROM (${active}) d ORDER BY tokens DESC, day DESC LIMIT 1`);
    expect([summary.busiest?.bucket, summary.busiest?.tokens]).toEqual([busiest.day, toNumber(busiest.tokens)]);
  });

  it.each(['messages', 'conversations'] as const)('counts active days and streaks by %s when that metric is chosen', async (metric) => {
    const value = metric === 'messages' ? `sum(${MESSAGES})` : `count(DISTINCT f.conversation_id)`;
    const active = `SELECT ${DAY} AS day, ${value} AS value FROM ${FACTS}
                     WHERE ${MINE} AND ${DAY} BETWEEN '2025-01-01' AND '2025-12-31' GROUP BY 1 HAVING ${value} > 0`;
    const summary = summariseYear(history, 2025, metric);
    expect(summary.activeDays).toBe((await one(`SELECT count(*)::int AS n FROM (${active}) d`)).n);
    const streak = await one(
      `WITH d AS (${active}), g AS (SELECT day, day - (row_number() OVER (ORDER BY day))::int AS run FROM d)
       SELECT min(day)::text AS first, max(day)::text AS last, count(*)::int AS days FROM g GROUP BY run ORDER BY 3 DESC, 2 DESC LIMIT 1`,
    );
    expect(summary.streak).toEqual({ from: streak.first, to: streak.last, days: streak.days });
    const busiest = await one(`SELECT day::text AS day, value::bigint AS value FROM (${active}) d ORDER BY value DESC, day DESC LIMIT 1`);
    expect([summary.busiest?.bucket, valueOf(summary.busiest ?? undefined, metric)]).toEqual([busiest.day, toNumber(busiest.value)]);
  });

  it('averages each weekday over the days of the year up to the last record', async () => {
    const sums = await rows<{ dow: number; total: unknown }>(
      `SELECT extract(isodow FROM ${DAY})::int AS dow, sum(${PROCESSED})::bigint AS total
         FROM ${FACTS} WHERE ${MINE} AND ${DAY} BETWEEN '2026-01-01' AND '2026-12-31' GROUP BY 1`,
    );
    const counts = await t.db.query<{ dow: number; days: number }>(
      `SELECT extract(isodow FROM g)::int AS dow, count(*)::int AS days FROM generate_series('2026-01-01'::date, '${LAST_RECORD}'::date, interval '1 day') g GROUP BY 1`,
    );
    const averages = weekdayAverages(history, 2026, 'tokens');
    expect(averages.reduce((sum, r) => sum + r.days, 0)).toBe(313);
    for (const row of averages) {
      const total = toNumber(sums.find((s) => s.dow === row.weekday + 1)?.total);
      const days = counts.rows.find((c) => c.dow === row.weekday + 1)?.days ?? 0;
      expect([row.label, row.total, row.days]).toEqual([row.label, total, days]);
      expect(row.average).toBeCloseTo(total / days, 6);
    }
  });

  it('fills the monthly table from the months themselves, counting each conversation once per month', async () => {
    const monthly = await getTimeSeries(t.db, lifetime, 'month', 'none');
    const table = monthRows(history, monthly, 2026);
    const sql = await rows(
      `SELECT extract(month FROM ${DAY})::int AS month, sum(${PROCESSED})::bigint AS tokens, sum(${MESSAGES})::bigint AS messages,
              count(DISTINCT f.conversation_id)::int AS conversations, count(DISTINCT ${DAY})::int AS active
         FROM ${FACTS} WHERE ${MINE} AND ${DAY} BETWEEN '2026-01-01' AND '2026-12-31' GROUP BY 1 ORDER BY 1`,
    );
    expect(table.filter((r) => r.tokens > 0).map((r) => [r.month, r.tokens, r.messages, r.conversations, r.activeDays])).toEqual(
      sql.map((r) => [r.month, toNumber(r.tokens), toNumber(r.messages), r.conversations, r.active]),
    );
    expect(table.map((r) => r.state)).toEqual([...Array(11).fill('inside'), 'after']);
    // 2024: nothing is known before the first record in May
    expect(monthRows(history, monthly, 2024).map((r) => r.state)).toEqual([...Array(4).fill('before'), ...Array(8).fill('inside')]);
  });

  it('cuts the colour scale at the quintiles of every active day of the whole history', async () => {
    const scale = buildScale([...history.days.values()].map((p) => p.tokens))!;
    const sql = await one(
      `SELECT count(*)::int AS n, min(tokens)::bigint AS min, max(tokens)::bigint AS max,
              percentile_disc(ARRAY[0.2, 0.4, 0.6, 0.8]) WITHIN GROUP (ORDER BY tokens) AS cuts
         FROM (SELECT sum(${PROCESSED})::bigint AS tokens FROM ${FACTS} WHERE ${MINE} GROUP BY ${DAY} HAVING sum(${PROCESSED}) > 0) d`,
    );
    expect(scale.thresholds).toEqual((sql.cuts as unknown[]).map(toNumber));
    expect([scale.min, scale.max]).toEqual([toNumber(sql.min), toNumber(sql.max)]);
    expect(scale.counts.reduce((a, b) => a + b, 0)).toBe(sql.n);
    // five groups of the same size, give or take the day the division leaves over
    for (const count of scale.counts) expect(Math.abs(count - toNumber(sql.n) / 5)).toBeLessThan(1);
  });
});
