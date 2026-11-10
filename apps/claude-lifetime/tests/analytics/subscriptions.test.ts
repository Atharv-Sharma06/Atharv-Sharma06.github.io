import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { listConversations } from '@/analytics/conversations';
import { getTimeSeries } from '@/analytics/overview';
import {
  buildSegments, deletePeriod, getBeforeAfter, getSegmentStats, listPeriods, planLabel, savePeriod, SubscriptionError, type SubscriptionPeriod,
} from '@/analytics/subscriptions';
import { getActualSpend } from '@/analytics/value';
import { createTestDb, type TestDb } from '../helpers/db';
import { loadDataset } from '../helpers/dataset';

const TZ = 'America/New_York';
let t: TestDb;
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: TZ, basis: 'processed', ...over });
const NOW = new Date('2025-04-01T00:00:00Z');
const save = (input: Parameters<typeof savePeriod>[3]) => savePeriod(t.db, t.userId, TZ, input);

beforeAll(async () => {
  t = await createTestDb(TZ);
  await loadDataset(t);
});
afterAll(() => t.close());

describe('before any subscription is entered', () => {
  it('assumes nothing: no segments, no before/after split', async () => {
    expect(await getSegmentStats(t.db, filter(), {}, NOW)).toEqual([]);
    expect(await getBeforeAfter(t.db, filter())).toEqual({ split: null, before: null, after: null });
    const byPlan = await getTimeSeries(t.db, filter(), 'year', 'plan');
    expect(byPlan.map((p) => [p.group, p.tokens])).toEqual([['none', 14_914_125]]);
  });

  it('a Free period alone is not a subscription to compare against', async () => {
    const free = await save({ planKey: 'free', startDate: '2025-01-01', lastDate: '2025-01-31' });
    expect(free).toMatchObject({ planKey: 'free', startDate: '2025-01-01', lastDate: '2025-01-31', startedAt: '2025-01-01T05:00:00.000Z', endedAt: '2025-02-01T05:00:00.000Z' });
    expect((await getBeforeAfter(t.db, filter())).split).toBeNull();
  });
});

describe('subscription transitions', () => {
  let pro: SubscriptionPeriod;
  let max: SubscriptionPeriod;

  it('stores periods in UTC and shows them in the user’s timezone, across a DST change', async () => {
    pro = await save({ planKey: 'pro', startDate: '2025-02-01', lastDate: '2025-02-28', monthlyPrice: '20' });
    max = await save({ planKey: 'max_5x', startDate: '2025-03-09', monthlyPrice: '100', notes: 'upgraded' });
    // 9 March 2025 is the day clocks change in New York; local midnight is still 05:00 UTC
    expect(max).toMatchObject({ startedAt: '2025-03-09T05:00:00.000Z', endedAt: null, startDate: '2025-03-09', lastDate: null, monthlyPrice: '100.00', notes: 'upgraded' });
    const all = await listPeriods(t.db, t.userId, TZ);
    expect(all.map((p) => [p.planKey, p.startDate, p.lastDate])).toEqual([
      ['free', '2025-01-01', '2025-01-31'],
      ['pro', '2025-02-01', '2025-02-28'],
      ['max_5x', '2025-03-09', null],
    ]);
  });

  it('builds the timeline FREE → PRO → (nothing recorded) → MAX with usage derived from timestamps', async () => {
    const segs = await getSegmentStats(t.db, filter(), {}, NOW);
    expect(segs.map((s) => [s.kind, s.planKey, s.label, s.days, s.tokens, s.conversations, s.messages])).toEqual([
      ['period', 'free', 'Free', 31, 475, 1, 2],
      ['period', 'pro', 'Pro', 28, 14_803_500, 1, 5],
      ['gap', 'none', 'No subscription recorded', 8, 110_150, 1, 2],
      ['period', 'max_5x', 'Max 5x', 23, 0, 0, 0],
    ]);
    expect(segs[0]).toMatchObject({ exact: 0, estimated: 475, activeDays: 1 });
    expect(segs[0].averageDailyTokens).toBeCloseTo(475 / 31, 6);
    expect(segs[1].averageDailyTokens).toBeCloseTo(14_803_500 / 28, 6);
    expect(segs[3].averageDailyTokens).toBeNull();
    expect(segs[3].end).toBeNull();
    // equivalent API value per segment
    expect(segs[1].value).toMatchObject({ exactUsd: '20.25', webSearchUsd: '0.05', totalStandardUsd: '20.3' });
    expect(segs[2].value.exactUsd).toBe('0.75');
    expect(segs[0].value).toMatchObject({ exactUsd: '0', unpricedTokens: 475 });
    expect(segs.reduce((s, x) => s + x.tokens, 0)).toBe(14_914_125);
  });

  it('classifies usage by plan at query time, so editing a period re-classifies it', async () => {
    const byPlan = async () => Object.fromEntries((await getTimeSeries(t.db, filter(), 'year', 'plan')).map((p) => [p.group, p.tokens]));
    expect(await byPlan()).toEqual({ free: 475, pro: 14_803_500, none: 110_150 });
    // nothing on usage rows stores a plan
    const cols = await t.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('usage_records', 'token_estimates', 'messages') AND column_name ILIKE '%plan%'`);
    expect(cols.rows).toEqual([]);
    await save({ id: pro.id, planKey: 'pro', startDate: '2025-02-02', lastDate: '2025-02-28', monthlyPrice: '20' });
    expect(await byPlan()).toEqual({ free: 475, pro: 3500, none: 14_800_000 + 110_150 });
    pro = await save({ id: pro.id, planKey: 'pro', startDate: '2025-02-01', lastDate: '2025-02-28', monthlyPrice: '20' });
    expect(await byPlan()).toEqual({ free: 475, pro: 14_803_500, none: 110_150 });
  });

  it('filters the conversation explorer by the plan in effect when a conversation started', async () => {
    const names = async (plan: string) => (await listConversations(t.db, filter(), { plan })).rows.map((r) => r.title);
    expect(await names('free')).toEqual(['Conversation a']);
    expect(await names('pro')).toEqual(['Refactor importer']);
    expect(await names('none')).toEqual(['Late night question']);
    expect(await names('max_5x')).toEqual([]);
    const all = await listConversations(t.db, filter());
    expect(all.rows.map((r) => r.planKey)).toEqual(['pro', 'free', 'none']);
  });

  it('compares usage before and after the first paid subscription', async () => {
    const ba = await getBeforeAfter(t.db, filter());
    expect(ba.split).toEqual({ at: '2025-02-01T05:00:00.000Z', date: '2025-02-01', planKey: 'pro', label: 'Pro' });
    expect(ba.before).toMatchObject({ tokens: 475, exact: 0, estimated: 475, conversations: 1, messages: 2, activeDays: 1, firstAt: '2025-01-10T15:00:00.000Z', spanDays: 22 });
    expect(ba.after).toMatchObject({ tokens: 14_913_650, exact: 14_913_500, estimated: 150, conversations: 2, messages: 7, lastAt: '2025-03-09T03:30:00.000Z', spanDays: 36 });
    expect(ba.after!.value.exactUsd).toBe('21');
    expect(ba.before!.value.exactUsd).toBe('0');
    expect(ba.before!.tokens + ba.after!.tokens).toBe(14_914_125);
  });

  it('rejects overlapping dates with a message that names the conflict, and changes nothing', async () => {
    const before = await listPeriods(t.db, t.userId, TZ);
    await expect(save({ planKey: 'max_20x', startDate: '2025-02-15', lastDate: '2025-03-05' })).rejects.toMatchObject({
      name: 'SubscriptionError', code: 'overlap', message: expect.stringContaining('Pro period (Feb 1, 2025 – Feb 28, 2025)'),
    });
    // an open-ended period overlaps everything after its start
    await expect(save({ planKey: 'pro', startDate: '2025-03-01' })).rejects.toMatchObject({ code: 'overlap', conflict: expect.objectContaining({ planKey: 'max_5x' }) });
    // editing an existing period into an overlap is rejected too
    await expect(save({ id: max.id, planKey: 'max_5x', startDate: '2025-02-20' })).rejects.toBeInstanceOf(SubscriptionError);
    expect(await listPeriods(t.db, t.userId, TZ)).toEqual(before);
  });

  it('the database itself refuses overlaps, whatever the application does', async () => {
    await expect(
      t.db.query(`INSERT INTO subscription_periods (user_id, plan_key, started_at, ended_at) VALUES ($1, 'pro', '2025-02-10Z', '2025-02-12Z')`, [t.userId]),
    ).rejects.toThrow(/subscription_periods_no_overlap/);
  });

  it('validates input', async () => {
    await expect(save({ planKey: '', startDate: '2025-05-01' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save({ planKey: 'pro', startDate: '2025-02-30' })).rejects.toThrow(/valid start date/);
    await expect(save({ planKey: 'pro', startDate: '2025-06-10', lastDate: '2025-06-01' })).rejects.toThrow(/before the start date/);
    await expect(save({ planKey: 'pro', startDate: '2025-06-10', monthlyPrice: 'twenty' })).rejects.toThrow(/monthly price/);
    await expect(save({ planKey: 'pro', startDate: '2025-06-10', currency: 'dollars' })).rejects.toThrow(/currency/);
    await expect(save({ id: 999_999, planKey: 'pro', startDate: '2024-01-01', lastDate: '2024-01-02' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('cancelling and subscribing again', () => {
  it('represents FREE → PRO → cancelled → PRO → MAX, each period on its own', async () => {
    // re-subscribed for exactly the days that had no plan: periods may touch but not overlap
    const again = await save({ planKey: 'pro', label: 'Pro (annual promo)', startDate: '2025-03-01', lastDate: '2025-03-08', monthlyPrice: '17' });
    const segs = await getSegmentStats(t.db, filter(), {}, NOW);
    expect(segs.map((s) => [s.kind, s.planKey, s.label, s.tokens])).toEqual([
      ['period', 'free', 'Free', 475],
      ['period', 'pro', 'Pro', 14_803_500],
      ['period', 'pro', 'Pro (annual promo)', 110_150],
      ['period', 'max_5x', 'Max 5x', 0],
    ]);
    // "after subscribing" still starts at the FIRST paid period
    expect((await getBeforeAfter(t.db, filter())).split?.date).toBe('2025-02-01');

    expect(await deletePeriod(t.db, t.userId, again.id)).toBe(true);
    expect(await deletePeriod(t.db, t.userId, again.id)).toBe(false);
    const back = await getSegmentStats(t.db, filter(), {}, NOW);
    expect(back.map((s) => s.kind)).toEqual(['period', 'period', 'gap', 'period']);
  });

  it('adds a trailing gap after the last plan was cancelled, and a leading one when usage predates the first plan', () => {
    const p = (id: number, planKey: string, startedAt: string, endedAt: string | null): SubscriptionPeriod => ({
      id, planKey, label: null, startedAt, endedAt, startDate: startedAt.slice(0, 10), lastDate: null, monthlyPrice: null, currency: 'USD', notes: null, isSynthetic: false,
    });
    const segs = buildSegments(
      [p(2, 'max', '2025-06-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z'), p(1, 'pro', '2025-03-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z')],
      '2025-01-15T00:00:00.000Z',
      '2025-09-01T00:00:00.000Z',
    );
    expect(segs.map((s) => [s.kind, s.planKey, s.start.slice(0, 10), s.end?.slice(0, 10) ?? null])).toEqual([
      ['gap', 'none', '2025-01-15', '2025-03-01'],
      ['period', 'pro', '2025-03-01', '2025-04-01'],
      ['gap', 'none', '2025-04-01', '2025-06-01'],
      ['period', 'max', '2025-06-01', '2025-07-01'],
      ['gap', 'none', '2025-07-01', null],
    ]);
    // no leading gap when usage starts after the first plan; no trailing gap while a plan is running
    expect(buildSegments([p(1, 'pro', '2025-03-01T00:00:00.000Z', null)], '2025-03-10T00:00:00.000Z', '2025-09-01T00:00:00.000Z').map((s) => s.kind)).toEqual(['period']);
    expect(buildSegments([], '2025-01-01T00:00:00.000Z', '2025-09-01T00:00:00.000Z')).toEqual([]);
    expect(planLabel('none')).toBe('No subscription recorded');
    expect(planLabel('pro', '  Student plan ')).toBe('Student plan');
    expect(planLabel('custom-key')).toBe('custom-key');
  });

  it('adds up what was actually paid from the prices entered, one payment per started monthly cycle', async () => {
    // make every period finite so the figure does not depend on today's date
    const periods = await listPeriods(t.db, t.userId, TZ);
    const max = periods.find((p) => p.planKey === 'max_5x')!;
    await save({ id: max.id, planKey: 'max_5x', startDate: '2025-03-09', lastDate: '2025-04-23', monthlyPrice: '100' });
    const spend = await getActualSpend(t.db, t.userId);
    // Pro: 1 Feb – 28 Feb = 1 cycle x $20.  Max 5x: 9 Mar – 23 Apr = 1 full month + a started second cycle = 2 x $100
    expect(spend.subscriptions).toEqual([{ currency: 'USD', amount: '220.00', cycles: 3 }]);
    expect(spend.reportedApiUsd).toBeNull();
  });
});
