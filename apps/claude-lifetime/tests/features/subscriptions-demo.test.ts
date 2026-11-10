import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter, TokenBasis } from '@/analytics/base';
import {
  getBeforeAfter, getBeforeAfterConversationUsage, getSegmentStats, listPeriods, type BeforeAfter, type ConversationUsage, type SegmentStats, type SubscriptionPeriod,
} from '@/analytics/subscriptions';
import { getApiValue } from '@/analytics/value';
import {
  assessComparability, averagePerDay, boundaryX, DAY_MS, DAYS_PER_MONTH, DAYS_PER_WEEK, defaultMode, elapsedDays, layoutTimeline, leadingUsd, lengthDays, pricedShare,
  rateRatio, segmentDates, segmentSpans, sideFigure, timelineTicks, timelineX, valueLevel,
} from '@/features/subscriptions/logic';
import { loadDemoDataset } from '@/import/demo/load';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * The figures the Subscription History page derives, checked on the synthetic demo
 * dataset against queries written here from scratch. Nothing below hard-codes a number
 * of the dataset: every expectation is recomputed from the usage_facts view, so the test
 * keeps its meaning when the demo generator changes.
 */
const NOW = new Date('2026-11-10T12:00:00Z');
const TZ = 'UTC';
const TOKENS: Record<TokenBasis, string> = {
  processed: '(input_tokens + output_tokens + cache_write_5m_tokens + cache_write_1h_tokens + cache_read_tokens + replay_tokens)',
  new: '(input_tokens + output_tokens + cache_write_5m_tokens + cache_write_1h_tokens)',
};

let t: TestDb;
let periods: SubscriptionPeriod[];
let segments: SegmentStats[];
let sides: BeforeAfter;
let inConversations: { before: ConversationUsage; after: ConversationUsage };
const filter = (basis: TokenBasis = 'processed'): AnalyticsFilter => ({ userId: t.userId, timezone: TZ, basis });

interface Direct {
  tokens: number;
  exact: number;
  estimated: number;
  first: number | null;
  last: number | null;
}

/** Sums straight from the view, for facts in [from, to). */
async function direct(from: string | null, to: string | null, basis: TokenBasis = 'processed', extra = ''): Promise<Direct> {
  const tok = TOKENS[basis];
  const { rows } = await t.db.query<Record<string, unknown>>(
    `SELECT COALESCE(sum(${tok}), 0)::text AS tokens,
            COALESCE(sum(${tok}) FILTER (WHERE confidence = 'exact'), 0)::text AS exact,
            COALESCE(sum(${tok}) FILTER (WHERE confidence = 'estimated'), 0)::text AS estimated,
            min(occurred_at) AS first_at, max(occurred_at) AS last_at
       FROM usage_facts f
      WHERE user_id = $1 AND ($2::timestamptz IS NULL OR occurred_at >= $2::timestamptz) AND ($3::timestamptz IS NULL OR occurred_at < $3::timestamptz) ${extra}`,
    [t.userId, from, to],
  );
  const r = rows[0];
  const time = (v: unknown) => (v instanceof Date ? v.getTime() : null);
  return { tokens: Number(r.tokens), exact: Number(r.exact), estimated: Number(r.estimated), first: time(r.first_at), last: time(r.last_at) };
}

/** Tokens and number of chats and Claude Code sessions with usage in [from, to), straight from the tables. */
async function directConversations(from: string | null, to: string | null) {
  const { rows } = await t.db.query<{ tokens: string; conversations: number }>(
    `SELECT COALESCE(sum(${TOKENS.processed}), 0)::text AS tokens, count(DISTINCT f.conversation_id)::int AS conversations
       FROM usage_facts f JOIN conversations c ON c.id = f.conversation_id
      WHERE f.user_id = $1 AND c.kind IN ('chat', 'code_session')
        AND ($2::timestamptz IS NULL OR f.occurred_at >= $2::timestamptz) AND ($3::timestamptz IS NULL OR f.occurred_at < $3::timestamptz)`,
    [t.userId, from, to],
  );
  return { tokens: Number(rows[0].tokens), conversations: rows[0].conversations };
}

beforeAll(async () => {
  t = await createTestDb(TZ);
  await loadDemoDataset(t.db, t.userId, TZ, NOW);
  periods = await listPeriods(t.db, t.userId, TZ);
  segments = await getSegmentStats(t.db, filter(), {}, NOW);
  sides = await getBeforeAfter(t.db, filter(), {});
  inConversations = (await getBeforeAfterConversationUsage(t.db, filter()))!;
});
afterAll(() => t.close());

describe('timeline of the demo history', () => {
  it('has one block per period, each as wide as its share of the time', () => {
    expect(segments.map((s) => [s.kind, s.planKey])).toEqual([['period', 'free'], ['period', 'pro'], ['period', 'max_5x']]);
    const spans = segmentSpans(segments, NOW.getTime());
    expect(spans[2].endMs).toBe(NOW.getTime());

    const gap = 2;
    const layout = layoutTimeline(spans, 1100, { minBlock: 12, gap });
    const total = spans.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
    const room = 1100 - 2 * gap;
    layout.blocks.forEach((block, i) => {
      expect(Math.abs(block.width - ((spans[i].endMs - spans[i].startMs) / total) * room)).toBeLessThanOrEqual(1);
      if (i > 0) expect(block.x - (layout.blocks[i - 1].x + layout.blocks[i - 1].width)).toBe(gap);
    });
    expect(layout.blocks[0].x).toBe(0);
    expect(layout.blocks[2].x + layout.blocks[2].width).toBe(1100);

    // the marker of the first paid plan stands in the gap in front of the Pro block, where the comparison splits
    expect(sides.split!.at).toBe(segments[1].start);
    expect(boundaryX(layout, 1, gap)).toBe(layout.blocks[1].x - 1);
    expect(timelineX(layout, Date.parse(sides.split!.at))).toBe(layout.blocks[1].x);
    expect(timelineX(layout, NOW.getTime())).toBe(1100);
  });

  it('puts the year ticks where the years begin', () => {
    const spans = segmentSpans(segments, NOW.getTime());
    const layout = layoutTimeline(spans, 1100, { minBlock: 12, gap: 2 });
    const ticks = timelineTicks(spans[0].startMs, NOW.getTime(), TZ, 3);
    expect(ticks.map((tick) => [tick.label, new Date(tick.ms).toISOString()])).toEqual([
      ['2025', '2025-01-01T00:00:00.000Z'],
      ['2026', '2026-01-01T00:00:00.000Z'],
    ]);
    // 1 January 2025 falls in the Free period, shortly before Pro starts
    const free = layout.blocks[0];
    const x = timelineX(layout, ticks[0].ms);
    expect(x).toBe(Math.round(free.x + ((ticks[0].ms - free.startMs) / (free.endMs - free.startMs)) * free.width));
    expect(x).toBeLessThan(layout.blocks[1].x);
  });

  it('reads the dates of each block back from its instants', () => {
    expect(segments.map((s) => segmentDates(s, TZ))).toEqual(periods.map((p) => ({ startDate: p.startDate, lastDate: p.lastDate })));
  });
});

describe('periods table of the demo history', () => {
  it('shows per period the tokens that fall between its dates, split by confidence', async () => {
    for (const segment of segments) {
      const d = await direct(segment.start, segment.end);
      expect([segment.tokens, segment.exact, segment.estimated]).toEqual([d.tokens, d.exact, d.estimated]);
      expect(segment.exact + segment.estimated).toBe(segment.tokens);
    }
    expect(segments.reduce((sum, s) => sum + s.tokens, 0)).toBe((await direct(null, null)).tokens);
  });

  it('averages the tokens of a period over its days inside the recorded history', async () => {
    // The recorded history, straight from the view: the first and the last day with a record (UTC here).
    const all = await direct(null, null);
    const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
    const [historyFirst, historyLast] = [dayOf(all.first!), dayOf(all.last!)];
    for (const segment of segments) {
      const d = await direct(segment.start, segment.end);
      const first = dayOf(Date.parse(segment.start));
      // the last day of the segment: the day before its exclusive end, or today while it runs
      const last = segment.end ? dayOf(Date.parse(segment.end)) - 1 : dayOf(NOW.getTime());
      const days = last - first + 1;
      expect(lengthDays(segment, NOW.getTime())).toBe(days);
      expect(segment.elapsedDays).toBe(days);
      expect(Math.abs(elapsedDays(segment, NOW.getTime()) - days)).toBeLessThanOrEqual(1);
      const recorded = Math.min(last, historyLast) - Math.max(first, historyFirst) + 1;
      expect(recorded).toBeGreaterThan(0);
      expect(segment.recordedDays).toBe(recorded);
      expect(averagePerDay(segment)).toBeCloseTo(d.tokens / recorded, 6);
      expect(averagePerDay(segment)).toBe(segment.averageDailyTokens);
    }
  });

  it('prices nothing in the Free period, whose chats name no model, and says how much of the others is priced', async () => {
    const [free, pro, max] = segments;
    expect(valueLevel(free.value)).toBe('unavailable');
    expect(pricedShare(free.value)).toBe(0);
    for (const segment of [pro, max]) {
      expect(valueLevel(segment.value)).toBe('exact');
      // only metered usage names a model in the demo, so the priced share is the metered share of the processed tokens
      expect(pricedShare(segment.value)).toBeCloseTo(segment.exact / segment.tokens, 9);
    }
    const whole = await getApiValue(t.db, filter(), {});
    const sum = segments.reduce((total, s) => total + Number(leadingUsd(s.value, 'standard')), 0);
    expect(sum).toBeCloseTo(Number(leadingUsd(whole, 'standard')), 4);
    expect(leadingUsd(whole, 'cached')).toBe(whole.totalCachedUsd);
  });
});

describe('before vs. after the first paid plan, on the demo history', () => {
  it('normalises each side by the days it covers: per day, per week of 7 days, per month of 30.4375 days', async () => {
    const split = sides.split!.at;
    const before = await direct(null, split);
    const after = await direct(split, null);
    // the span of a side in calendar days: from the day of its first record to the day before the split, or from the
    // split day to the day of its last record
    const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
    const beforeDays = dayOf(Date.parse(split)) - dayOf(before.first!);
    const afterDays = dayOf(after.last!) - dayOf(Date.parse(split)) + 1;
    expect([sides.before!.spanDays, sides.after!.spanDays]).toEqual([beforeDays, afterDays]);
    expect([sides.before!.spanFrom, sides.before!.spanTo]).toEqual([new Date(before.first!).toISOString().slice(0, 10), new Date(Date.parse(split) - DAY_MS).toISOString().slice(0, 10)]);
    expect([sides.after!.spanFrom, sides.after!.spanTo]).toEqual([split.slice(0, 10), new Date(after.last!).toISOString().slice(0, 10)]);
    expect([sides.before!.tokens, sides.after!.tokens]).toEqual([before.tokens, after.tokens]);

    for (const [stats, d, days] of [[sides.before!, before, beforeDays], [sides.after!, after, afterDays]] as const) {
      expect(sideFigure('total', stats, null)).toEqual({ value: d.tokens, exact: d.exact, estimated: d.estimated });
      expect(sideFigure('day', stats, null)!.value).toBeCloseTo(d.tokens / days, 6);
      expect(sideFigure('week', stats, null)!.value).toBeCloseTo((d.tokens / days) * DAYS_PER_WEEK, 6);
      expect(sideFigure('month', stats, null)!.value).toBeCloseTo((d.tokens / days) * DAYS_PER_MONTH, 4);
      const perDay = sideFigure('day', stats, null)!;
      expect(perDay.exact).toBeCloseTo(d.exact / days, 6);
      expect(perDay.exact + perDay.estimated).toBeCloseTo(perDay.value, 6);
    }
  });

  it('follows the token basis', async () => {
    const split = sides.split!.at;
    const fresh = await getBeforeAfter(t.db, filter('new'), {});
    const before = await direct(null, split, 'new');
    const after = await direct(split, null, 'new');
    expect(sideFigure('day', fresh.before, null)!.value).toBeCloseTo(before.tokens / fresh.before!.spanDays, 6);
    expect(sideFigure('day', fresh.after, null)!.value).toBeCloseTo(after.tokens / fresh.after!.spanDays, 6);
    expect(fresh.after!.tokens).toBeLessThan(sides.after!.tokens);
  });

  it('sizes conversations by the tokens that belong to conversations', async () => {
    const split = sides.split!.at;
    const before = await directConversations(null, split);
    const after = await directConversations(split, null);
    expect(sideFigure('conversation', sides.before, inConversations.before)!.value).toBeCloseTo(before.tokens / before.conversations, 6);
    expect(sideFigure('conversation', sides.after, inConversations.after)!.value).toBeCloseTo(after.tokens / after.conversations, 6);
    expect(inConversations.after.conversations).toBe(after.conversations);

    // The API usage report of the demo belongs to no conversation. It counts towards the side's total, not towards conversation size.
    const withoutConversation = await direct(split, null, 'processed', 'AND conversation_id IS NULL');
    expect(withoutConversation.tokens).toBeGreaterThan(0);
    expect(sides.after!.tokens - inConversations.after.tokens).toBe(withoutConversation.tokens);
    expect(sideFigure('conversation', sides.after, inConversations.after)!.value).toBeLessThan(sides.after!.tokens / sides.after!.conversations);
  });

  it('raises the three guards the demo history calls for, and opens on the daily average', async () => {
    const comparability = assessComparability(sides.before, sides.after, { timezone: TZ, historyStart: periods[0].startedAt });

    // a) free for some months, paid for much longer
    expect(sides.after!.spanDays).toBeGreaterThanOrEqual(2 * sides.before!.spanDays);
    expect(comparability.lengths).toEqual({ beforeDays: sides.before!.spanDays, afterDays: sides.after!.spanDays });
    expect(defaultMode(comparability)).toBe('day');

    // b) chat text before, mostly metered Claude Code and API usage after
    expect(sides.before!.exact).toBe(0);
    expect(comparability.measurement).toEqual({ estimatedSide: 'before', meteredShare: sides.after!.exact / sides.after!.tokens });
    expect(comparability.measurement!.meteredShare).toBeGreaterThan(0.9);

    // c) the earlier side begins with the first imported record, a little after the first period starts
    const first = (await direct(null, null)).first!;
    expect(comparability.firstRecord).toEqual({
      day: new Date(first).toISOString().slice(0, 10),
      unrecordedDays: Math.floor((first - Date.parse(periods[0].startedAt)) / DAY_MS),
    });
    expect(comparability.firstRecord!.unrecordedDays).toBeLessThan(14);
    expect(comparability.short).toEqual([]);
  });

  it('states no ratio while the sides are measured differently, though both are long enough', () => {
    const comparability = assessComparability(sides.before, sides.after, { timezone: TZ, historyStart: periods[0].startedAt });
    const figure = (mode: 'day' | 'total') => ({
      before: { figure: sideFigure(mode, sides.before, null), spanDays: sides.before!.spanDays },
      after: { figure: sideFigure(mode, sides.after, null), spanDays: sides.after!.spanDays },
    });
    const perDay = figure('day');
    expect(rateRatio('day', perDay.before, perDay.after, comparability)).toBeNull();
    // with the same figures measured alike, a ratio would be stated for the rate, and never for the totals
    const alike = { measurement: null };
    expect(rateRatio('day', perDay.before, perDay.after, alike)).toMatchObject({ direction: 'more' });
    expect(rateRatio('day', perDay.before, perDay.after, alike)!.factor).toBeCloseTo(perDay.after.figure!.value / perDay.before.figure!.value, -2);
    expect(rateRatio('total', figure('total').before, figure('total').after, alike)).toBeNull();
  });
});
