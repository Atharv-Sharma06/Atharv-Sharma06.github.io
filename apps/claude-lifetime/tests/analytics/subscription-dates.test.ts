import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getOverview, getTimeSeries } from '@/analytics/overview';
import { addManualUsage, updateSettings } from '@/analytics/settings';
import { getBeforeAfter, getSegmentStats, listPeriods, savePeriod } from '@/analytics/subscriptions';
import { getActualSpend } from '@/analytics/value';
import { createTestDb, type TestDb } from '../helpers/db';
import { importRecords, usage } from '../helpers/staged';

/**
 * A subscription period is a range of calendar days. These tests pin what follows from
 * that: the days read back as entered in every timezone, usage is matched to a plan by
 * the day it is charted on, and monthly payments are counted on the calendar.
 */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb('UTC');
});
afterAll(() => t.close());

const zero = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requestCount: 0, userMessageCount: 0, assistantMessageCount: 0 };
const filterIn = (timezone: string, over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone, basis: 'processed', ...over });

describe('monthly payments are counted on the calendar, in every timezone', () => {
  async function cycles(tz: string, startDate: string, lastDate: string | null, now?: Date) {
    await t.reset();
    await savePeriod(t.db, t.userId, tz, { planKey: 'pro', startDate, lastDate, monthlyPrice: '20' });
    return (await getActualSpend(t.db, t.userId, tz, now)).subscriptions;
  }
  const once = [{ currency: 'USD', amount: '20.00', cycles: 1 }];

  it('one calendar month is one payment east and west of UTC, with and without daylight saving', async () => {
    expect(await cycles('UTC', '2025-05-01', '2025-05-31')).toEqual(once);
    expect(await cycles('Europe/Berlin', '2025-05-01', '2025-05-31')).toEqual(once);
    expect(await cycles('Asia/Kolkata', '2025-07-01', '2025-07-31')).toEqual(once);
    expect(await cycles('Asia/Tokyo', '2025-07-01', '2025-07-31')).toEqual(once);
    // clocks go back in New York on 2 November 2025
    expect(await cycles('America/New_York', '2025-11-01', '2025-11-30')).toEqual(once);
    expect(await cycles('Pacific/Auckland', '2025-09-01', '2025-09-30')).toEqual(once);
  });

  it('every month of a year is one payment, and six months are six', async () => {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const last = new Date(Date.UTC(2025, m, 0)).getUTCDate();
      expect(await cycles('Europe/Berlin', `2025-${mm}-01`, `2025-${mm}-${last}`), `2025-${mm}`).toEqual(once);
    }
    expect(await cycles('America/New_York', '2025-06-01', '2025-11-30')).toEqual([{ currency: 'USD', amount: '120.00', cycles: 6 }]);
  });

  it('a year entered as twelve monthly periods adds up to twelve payments', async () => {
    await t.reset();
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const last = new Date(Date.UTC(2025, m, 0)).getUTCDate();
      await savePeriod(t.db, t.userId, 'Europe/Berlin', { planKey: 'pro', startDate: `2025-${mm}-01`, lastDate: `2025-${mm}-${last}`, monthlyPrice: '20' });
    }
    expect((await getActualSpend(t.db, t.userId, 'Europe/Berlin')).subscriptions).toEqual([{ currency: 'USD', amount: '240.00', cycles: 12 }]);
  });

  it('a cycle counts from the day it starts: a day more than a month is two payments, a single day is one', async () => {
    expect(await cycles('Europe/Berlin', '2025-05-01', '2025-06-01')).toEqual([{ currency: 'USD', amount: '40.00', cycles: 2 }]);
    expect(await cycles('Europe/Berlin', '2025-05-01', '2025-05-01')).toEqual(once);
    // a plan started on the 31st renews on the last day of shorter months
    expect(await cycles('UTC', '2025-01-31', '2025-02-27')).toEqual(once);
    expect(await cycles('UTC', '2025-01-31', '2025-02-28')).toEqual([{ currency: 'USD', amount: '40.00', cycles: 2 }]);
  });

  it('a running plan gains a payment on the day its next cycle starts in the user’s timezone, not a day early', async () => {
    const on = async (iso: string) => (await cycles('Europe/Berlin', '2025-05-01', null, new Date(iso)))![0].cycles;
    expect(await on('2025-10-30T11:00:00Z')).toBe(6);
    expect(await on('2025-10-31T11:00:00Z')).toBe(6);
    // 31 October 23:30 UTC is already 1 November in Berlin
    expect(await on('2025-10-31T23:30:00Z')).toBe(7);
    expect(await on('2025-11-01T11:00:00Z')).toBe(7);
    // a plan that starts tomorrow has not been paid for yet
    expect(await cycles('Europe/Berlin', '2025-05-01', null, new Date('2025-04-30T12:00:00Z'))).toBeNull();
  });
});

describe('periods keep the days that were entered', () => {
  it('a change of the timezone setting moves no period', async () => {
    await t.reset();
    await savePeriod(t.db, t.userId, 'America/New_York', { planKey: 'free', startDate: '2025-01-01', lastDate: '2025-01-31' });
    await savePeriod(t.db, t.userId, 'America/New_York', { planKey: 'pro', startDate: '2025-02-01', lastDate: '2025-02-28', monthlyPrice: '20' });
    const days = async (tz: string) => (await listPeriods(t.db, t.userId, tz)).map((p) => [p.planKey, p.startDate, p.lastDate]);
    const entered = [
      ['free', '2025-01-01', '2025-01-31'],
      ['pro', '2025-02-01', '2025-02-28'],
    ];
    for (const tz of ['America/New_York', 'Europe/Berlin', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) expect(await days(tz), tz).toEqual(entered);

    // Saving a period again with the days it shows is always possible, and changes nothing.
    await updateSettings(t.db, t.userId, { timezone: 'Europe/Berlin' });
    const [free] = await listPeriods(t.db, t.userId, 'Europe/Berlin');
    await savePeriod(t.db, t.userId, 'Europe/Berlin', { id: free.id, planKey: 'free', startDate: free.startDate, lastDate: free.lastDate, notes: 'a note' });
    expect(await days('Europe/Berlin')).toEqual(entered);
    expect((await getActualSpend(t.db, t.userId, 'Europe/Berlin')).subscriptions).toEqual([{ currency: 'USD', amount: '20.00', cycles: 1 }]);

    // The instants follow the timezone in use; they are derived, not stored.
    expect((await listPeriods(t.db, t.userId, 'Europe/Berlin'))[1]).toMatchObject({ startedAt: '2025-01-31T23:00:00.000Z', endedAt: '2025-02-28T23:00:00.000Z' });
    expect((await listPeriods(t.db, t.userId, 'America/New_York'))[1]).toMatchObject({ startedAt: '2025-02-01T05:00:00.000Z', endedAt: '2025-03-01T05:00:00.000Z' });
    await updateSettings(t.db, t.userId, { timezone: 'UTC' });
  });

  it('usage of one day is never split between two plans after a timezone change', async () => {
    await t.reset();
    await savePeriod(t.db, t.userId, 'America/New_York', { planKey: 'free', startDate: '2025-01-01', lastDate: '2025-01-31' });
    await savePeriod(t.db, t.userId, 'America/New_York', { planKey: 'pro', startDate: '2025-02-01', lastDate: '2025-02-28' });
    await importRecords(
      t.db,
      t.userId,
      {
        usage: [
          // 1 February in Berlin: 00:30 and 12:00 local time
          usage('a', { ...zero, conversationKey: null, occurredAt: '2025-01-31T23:30:00.000Z', inputTokens: 100, outputTokens: 0 }),
          usage('b', { ...zero, conversationKey: null, occurredAt: '2025-02-01T11:00:00.000Z', inputTokens: 200, outputTokens: 0 }),
        ],
      },
      { source: { kind: 'claude_code', label: 'cc', externalRef: 'local' }, contentHash: 'tz' },
    );
    const byPlan = await getTimeSeries(t.db, filterIn('Europe/Berlin'), 'day', 'plan');
    expect(byPlan.map((p) => [p.bucket, p.group, p.tokens])).toEqual([['2025-02-01', 'pro', 300]]);
  });

  it('a last day on the eve of a daylight-saving change at midnight reads back as entered', async () => {
    // In these zones the clocks jump from 00:00 to 01:00, so the midnight after the last day does not exist.
    const cases: Array<[string, string]> = [
      ['America/Santiago', '2025-09-06'],
      ['America/Havana', '2025-03-08'],
      ['Africa/Cairo', '2025-04-24'],
      ['Asia/Beirut', '2025-03-29'],
      ['Atlantic/Azores', '2025-03-29'],
    ];
    for (const [tz, lastDate] of cases) {
      await t.reset();
      const saved = await savePeriod(t.db, t.userId, tz, { planKey: 'pro', startDate: '2025-01-01', lastDate });
      expect(saved.lastDate, tz).toBe(lastDate);
      // The plan that follows can start on the next day, and the first one can be saved again unchanged.
      const next = new Date(`${lastDate}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      await savePeriod(t.db, t.userId, tz, { planKey: 'max', startDate: next.toISOString().slice(0, 10) });
      const again = await savePeriod(t.db, t.userId, tz, { id: saved.id, planKey: 'pro', startDate: '2025-01-01', lastDate });
      expect([again.startDate, again.lastDate], tz).toEqual(['2025-01-01', lastDate]);
      // The derived end is the first instant of the following day, so it is later than the start of the last day.
      expect(Date.parse(again.endedAt!) - Date.parse(`${lastDate}T00:00:00Z`), tz).toBeGreaterThan(0);
    }
  });
});

describe('usage is matched to a plan by the day it is charted on', () => {
  const TZ = 'America/New_York';
  const NOW = new Date('2025-06-01T00:00:00Z');

  it('a record that only knows its date belongs to the plan that started on that date', async () => {
    await t.reset();
    await savePeriod(t.db, t.userId, TZ, { planKey: 'pro', startDate: '2025-02-01', lastDate: '2025-02-28' });
    // "Add usage by hand" takes a calendar day.
    await addManualUsage(t.db, t.userId, { date: '2025-02-01', model: 'claude-sonnet-4-5', inputTokens: 1_000_000, confidence: 'exact' });

    expect((await getTimeSeries(t.db, filterIn(TZ), 'day')).map((p) => [p.bucket, p.tokens])).toEqual([['2025-02-01', 1_000_000]]);
    expect((await getOverview(t.db, filterIn(TZ, { from: '2025-02-01', to: '2025-02-28' }))).firstDay).toBe('2025-02-01');
    expect((await getTimeSeries(t.db, filterIn(TZ), 'day', 'plan')).map((p) => [p.bucket, p.group, p.tokens])).toEqual([['2025-02-01', 'pro', 1_000_000]]);

    const sides = await getBeforeAfter(t.db, filterIn(TZ));
    expect(sides.split!.date).toBe('2025-02-01');
    expect(sides.before!.tokens).toBe(0);
    expect(sides.after).toMatchObject({ tokens: 1_000_000, firstDay: '2025-02-01', lastDay: '2025-02-01' });
    // No "No subscription recorded" stretch is invented in front of the plan.
    expect((await getSegmentStats(t.db, filterIn(TZ), {}, NOW)).map((s) => [s.kind, s.planKey, s.tokens])).toEqual([
      ['period', 'pro', 1_000_000],
      ['gap', 'none', 0],
    ]);
  });

  it('a daily report bucket of the day after a plan ended is outside the plan', async () => {
    await t.reset();
    await savePeriod(t.db, t.userId, TZ, { planKey: 'pro', startDate: '2025-02-01', lastDate: '2025-02-28' });
    await importRecords(
      t.db,
      t.userId,
      {
        usage: [
          usage('api:feb28', { ...zero, occurredAt: '2025-02-28T00:00:00.000Z', bucketSeconds: 86_400, inputTokens: 100, outputTokens: 0 }),
          usage('api:mar01', { ...zero, occurredAt: '2025-03-01T00:00:00.000Z', bucketSeconds: 86_400, inputTokens: 7_000, outputTokens: 0 }),
        ],
      },
      { source: { kind: 'api_usage_report', label: 'Anthropic API usage report', externalRef: '' }, contentHash: 'api' },
    );
    expect((await getTimeSeries(t.db, filterIn(TZ), 'day', 'plan')).map((p) => [p.bucket, p.group, p.tokens])).toEqual([
      ['2025-02-28', 'pro', 100],
      ['2025-03-01', 'none', 7_000],
    ]);
    expect((await getSegmentStats(t.db, filterIn(TZ), {}, NOW)).map((s) => [s.kind, s.planKey, s.tokens])).toEqual([
      ['period', 'pro', 100],
      ['gap', 'none', 7_000],
    ]);
  });

  it('the same holds east of UTC', async () => {
    await t.reset();
    const tz = 'Asia/Tokyo';
    await savePeriod(t.db, t.userId, tz, { planKey: 'pro', startDate: '2025-02-01', lastDate: '2025-02-28' });
    await addManualUsage(t.db, t.userId, { date: '2025-02-01', model: 'claude-sonnet-4-5', inputTokens: 1_000_000, confidence: 'exact' });
    await addManualUsage(t.db, t.userId, { date: '2025-02-28', model: 'claude-sonnet-4-5', inputTokens: 7, confidence: 'exact' });
    await addManualUsage(t.db, t.userId, { date: '2025-03-01', model: 'claude-sonnet-4-5', inputTokens: 5, confidence: 'exact' });
    expect((await getTimeSeries(t.db, filterIn(tz), 'day', 'plan')).map((p) => [p.bucket, p.group, p.tokens])).toEqual([
      ['2025-02-01', 'pro', 1_000_000],
      ['2025-02-28', 'pro', 7],
      ['2025-03-01', 'none', 5],
    ]);
  });
});

describe('averages only count days the imported records cover', () => {
  // Exactly 1,000 tokens on every day from 1 January to 30 June 2025: the true rate is 1,000 a day, whatever is selected.
  const loadDaily = async () => {
    await t.reset();
    const rows = [];
    for (let d = 0; d < 181; d++) {
      const at = new Date(Date.UTC(2025, 0, 1 + d, 12, 0)).toISOString();
      rows.push(usage(`d${d}`, { ...zero, requestCount: 1, conversationKey: null, occurredAt: at, inputTokens: 1_000, outputTokens: 0 }));
    }
    await importRecords(t.db, t.userId, { usage: rows }, { source: { kind: 'claude_code', label: 'cc', externalRef: 'local' }, contentHash: 'daily' });
  };
  const perDay = (side: { tokens: number; spanDays: number }) => side.tokens / side.spanDays;

  it('a plan that began long before the first record is averaged from the first record on', async () => {
    await loadDaily();
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2024-01-01' });
    const all = await getBeforeAfter(t.db, filterIn('UTC'));
    expect(all.before).toMatchObject({ tokens: 0, spanDays: 0, spanFrom: null, spanTo: null });
    expect(all.after).toMatchObject({ tokens: 181_000, spanFrom: '2025-01-01', spanTo: '2025-06-30', spanDays: 181 });
    expect(perDay(all.after!)).toBe(1_000);

    // The plan's own row says the same: 181 recorded days, not the 547 that have passed.
    const [pro] = await getSegmentStats(t.db, filterIn('UTC'), {}, new Date('2025-07-01T00:00:00Z'));
    expect(pro).toMatchObject({ planKey: 'pro', tokens: 181_000, recordedDays: 181, elapsedDays: 548, averageDailyTokens: 1_000 });
  });

  it('a selected date range limits the days as well as the tokens', async () => {
    await loadDaily();
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2024-01-01' });
    const june = await getBeforeAfter(t.db, filterIn('UTC', { from: '2025-06-01', to: '2025-06-30' }));
    expect(june.after).toMatchObject({ tokens: 30_000, firstDay: '2025-06-01', lastDay: '2025-06-30', spanFrom: '2025-06-01', spanTo: '2025-06-30', spanDays: 30 });
    expect(perDay(june.after!)).toBe(1_000);
    // A range wider than the records does not stretch the span either.
    const wide = await getBeforeAfter(t.db, filterIn('UTC', { from: '2020-01-01', to: '2030-12-31' }));
    expect(wide.after).toMatchObject({ spanFrom: '2025-01-01', spanTo: '2025-06-30', spanDays: 181 });
  });

  it('each side ends where the split, the range and the records end', async () => {
    await loadDaily();
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2025-06-01' });
    const january = await getBeforeAfter(t.db, filterIn('UTC', { from: '2025-01-01', to: '2025-01-31' }));
    expect(january.before).toMatchObject({ tokens: 31_000, spanFrom: '2025-01-01', spanTo: '2025-01-31', spanDays: 31 });
    expect(january.after).toMatchObject({ tokens: 0, spanDays: 0 });

    const all = await getBeforeAfter(t.db, filterIn('UTC'));
    expect(all.before).toMatchObject({ tokens: 151_000, spanFrom: '2025-01-01', spanTo: '2025-05-31', spanDays: 151 });
    expect(all.after).toMatchObject({ tokens: 30_000, spanFrom: '2025-06-01', spanTo: '2025-06-30', spanDays: 30 });
    expect([perDay(all.before!), perDay(all.after!)]).toEqual([1_000, 1_000]);

    // A period that reaches beyond the records is averaged over the days it shares with them.
    const segments = await getSegmentStats(t.db, filterIn('UTC'), {}, new Date('2025-09-01T00:00:00Z'));
    expect(segments.map((s) => [s.kind, s.planKey, s.tokens, s.recordedDays, s.averageDailyTokens])).toEqual([
      ['gap', 'none', 151_000, 151, 1_000],
      ['period', 'pro', 30_000, 30, 1_000],
    ]);
  });
});
