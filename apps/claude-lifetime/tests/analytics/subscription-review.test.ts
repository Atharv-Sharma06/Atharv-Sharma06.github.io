import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getCoverage } from '@/analytics/coverage';
import { getOverview } from '@/analytics/overview';
import { addManualUsage } from '@/analytics/settings';
import { getRecordedHistory, getSegmentStats, listPeriods, periodDateProblem, savePeriod, SubscriptionError } from '@/analytics/subscriptions';
import { getActualSpend } from '@/analytics/value';
import type { StagedCost } from '@/core/types';
import { createTestDb, type TestDb } from '../helpers/db';
import { importRecords } from '../helpers/staged';

/**
 * Regression tests for the review of the Subscription History page: what the analytics
 * behind it must do so that the page can tell the truth.
 */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb('UTC');
});
afterAll(() => t.close());

const NOW = new Date('2026-11-10T12:00:00Z');
const filterIn = (timezone: string): AnalyticsFilter => ({ userId: t.userId, timezone, basis: 'processed' });
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as SubscriptionError;
  }
  throw new Error('expected the save to be refused');
};

describe('a demo period ended to make room for a new plan stays demo data', () => {
  const demoPeriod = async () => {
    await t.reset();
    const { rows } = await t.db.query<{ id: number }>(
      `INSERT INTO subscription_periods (user_id, plan_key, start_date, monthly_price, notes, is_synthetic)
       VALUES ($1, 'max_5x', '2025-12-11', 100, 'Synthetic demo period', true) RETURNING id`,
      [t.userId],
    );
    return (await listPeriods(t.db, t.userId, 'UTC')).find((p) => p.id === rows[0].id)!;
  };

  it('keeps its demo flag when only its end is set for the new period, so removing the demo data removes it', async () => {
    const demo = await demoPeriod();
    const ended = await savePeriod(t.db, t.userId, 'UTC', { ...demo, lastDate: '2026-09-30' }, { keepSynthetic: true, now: NOW });
    expect(ended).toMatchObject({ lastDate: '2026-09-30', isSynthetic: true });
    // The new plan is the user's own.
    const own = await savePeriod(t.db, t.userId, 'UTC', { planKey: 'max_20x', startDate: '2026-10-01', monthlyPrice: '200' }, { now: NOW });
    expect(own.isSynthetic).toBe(false);
    // What removing the demo data deletes.
    await t.db.query(`DELETE FROM subscription_periods WHERE user_id = $1 AND is_synthetic`, [t.userId]);
    expect((await listPeriods(t.db, t.userId, 'UTC')).map((p) => p.planKey)).toEqual(['max_20x']);
  });

  it('becomes the user’s own when it is edited itself', async () => {
    const demo = await demoPeriod();
    expect((await savePeriod(t.db, t.userId, 'UTC', { ...demo, notes: 'mine now' }, { now: NOW })).isSynthetic).toBe(false);
    // and an explicit edit with the option set never turns a period of the user's into demo data
    const own = await savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2021-03-01', lastDate: '2021-03-31' }, { now: NOW });
    expect((await savePeriod(t.db, t.userId, 'UTC', { ...own, lastDate: '2021-04-30' }, { keepSynthetic: true, now: NOW })).isSynthetic).toBe(false);
  });
});

describe('dates a period cannot have', () => {
  it('refuses a year before 2021, such as a two-digit year read as the year 26', async () => {
    await t.reset();
    const error = await rejection(savePeriod(t.db, t.userId, 'America/New_York', { planKey: 'pro', startDate: '0026-01-10', monthlyPrice: '20' }, { now: NOW }));
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error.code).toBe('invalid');
    expect(error.message).toBe('Enter a start date in 2021 or later. There was no Claude usage before then, so check the year.');
    const end = await rejection(savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2021-01-01', lastDate: '2020-12-31' }, { now: NOW }));
    expect(end.message).toBe('The end date is before the start date.');
    // Each field is named with its article: "an end date", not "a end date".
    expect(periodDateProblem('end', '2020-02-01', '2026-11-10')).toBe('Enter an end date in 2021 or later. There was no Claude usage before then, so check the year.');
    expect(periodDateProblem('start', '2020-01-01', '2026-11-10')).toBe('Enter a start date in 2021 or later. There was no Claude usage before then, so check the year.');
    // 1 January 2021 itself is fine
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'free', startDate: '2021-01-01', lastDate: '2021-01-31' }, { now: NOW });
  });

  it('refuses dates more than ten years ahead, such as 31 December 9999 for "no end", so the page can always be read', async () => {
    await t.reset();
    const running = await savePeriod(t.db, t.userId, 'UTC', { planKey: 'max_5x', startDate: '2025-12-11' }, { now: NOW });
    const error = await rejection(savePeriod(t.db, t.userId, 'UTC', { ...running, lastDate: '9999-12-31' }, { now: NOW }));
    expect(error.message).toBe('The end date is more than 10 years from today. Check the year, or leave the end date empty while the plan is active.');
    const start = await rejection(savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2036-11-11' }, { now: NOW }));
    expect(start.message).toBe('The start date is more than 10 years from today. Check the year.');
    // exactly ten years ahead is still accepted
    await savePeriod(t.db, t.userId, 'UTC', { ...running, lastDate: '2036-11-10' }, { now: NOW });
    // nothing out of range was stored, and the figures can be read
    expect((await getSegmentStats(t.db, filterIn('UTC'), {}, NOW)).map((s) => [s.startDate, s.endDate])).toEqual([['2025-12-11', '2036-11-11']]);
  });
});

describe('the overlap message', () => {
  it('describes a period without an end date by its start, not as a range that ends today', async () => {
    await t.reset();
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'max_5x', startDate: '2026-12-10' }, { now: NOW });
    const ahead = await rejection(savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2027-01-01', lastDate: '2027-01-31' }, { now: NOW }));
    expect(ahead.message).toMatch(/^These dates overlap your Max 5x period \(from Dec 10, 2026, no end date\)\./);
    await t.reset();
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'max_5x', startDate: '2026-02-01' }, { now: NOW });
    const running = await rejection(savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2026-03-01', lastDate: '2026-03-31' }, { now: NOW }));
    expect(running.message).toMatch(/^These dates overlap your Max 5x period \(since Feb 1, 2026, no end date\)\./);
  });
});

describe('records dated after the last period', () => {
  it('get a stretch of their own, so the rows add up to the total, also when the period ends today', async () => {
    await t.reset();
    // 18:00 on 9 November in Los Angeles is already 10 November in UTC.
    const now = new Date('2026-11-10T02:00:00Z');
    const tz = 'America/Los_Angeles';
    await savePeriod(t.db, t.userId, tz, { planKey: 'pro', startDate: '2026-11-01', lastDate: '2026-11-09' }, { now });
    await addManualUsage(t.db, t.userId, { date: '2026-11-05', inputTokens: 1000, confidence: 'exact' }, now);
    // a manual entry is filed under its date, which is tomorrow for this user
    await addManualUsage(t.db, t.userId, { date: '2026-11-10', inputTokens: 5000, confidence: 'exact' }, new Date('2026-11-10T12:00:00Z'));
    const segments = await getSegmentStats(t.db, filterIn(tz), {}, now);
    expect(segments.map((s) => [s.kind, s.startDate, s.endDate, s.tokens])).toEqual([
      ['period', '2026-11-01', '2026-11-10', 1000],
      ['gap', '2026-11-10', '2026-11-11', 5000],
    ]);
    const overview = await getOverview(t.db, filterIn(tz));
    expect(segments.reduce((sum, s) => sum + s.tokens, 0)).toBe(overview.tokens.total);
    expect(await getRecordedHistory(t.db, filterIn(tz))).toEqual({ first: '2026-11-05', last: '2026-11-10' });
    // The stretch begins tomorrow for this user and holds records all the same: its day counts as passed,
    // so the table does not call a row with 5,000 tokens "Not started".
    expect(segments.map((s) => [s.kind, s.days, s.elapsedDays])).toEqual([
      ['period', 9, 9],
      ['gap', 1, 1],
    ]);
  });

  it('still counts no day of a plan that begins after today and after the last record', async () => {
    await t.reset();
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2026-11-01', lastDate: '2026-11-15' }, { now: NOW });
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'max_5x', startDate: '2026-11-16' }, { now: NOW });
    await addManualUsage(t.db, t.userId, { date: '2026-11-05', inputTokens: 1000, confidence: 'exact' }, NOW);
    const segments = await getSegmentStats(t.db, filterIn('UTC'), {}, NOW);
    expect(segments.map((s) => [s.planKey, s.elapsedDays])).toEqual([
      ['pro', 10],
      ['max_5x', 0],
    ]);
  });

  it('adds no stretch while nothing is recorded after a period that ends today or later', async () => {
    await t.reset();
    await savePeriod(t.db, t.userId, 'UTC', { planKey: 'pro', startDate: '2026-11-01', lastDate: '2026-11-30' }, { now: NOW });
    await addManualUsage(t.db, t.userId, { date: '2026-11-05', inputTokens: 1000, confidence: 'exact' }, NOW);
    const segments = await getSegmentStats(t.db, filterIn('UTC'), {}, NOW);
    expect(segments.map((s) => [s.kind, s.elapsedDays, s.days])).toEqual([['period', 10, 30]]);
  });
});

describe('the range of the imported cost reports', () => {
  const cost = (key: string, occurredAt: string, bucketSeconds: number): StagedCost => ({
    modelKey: 'claude-sonnet-4-5',
    occurredAt,
    bucketSeconds,
    costType: 'tokens',
    tokenType: 'output_tokens',
    description: null,
    amountUsd: '10.00',
    dedupKey: key,
  });

  it('ends on the last day the last row covers, not on the day it starts', async () => {
    await t.reset();
    // one row for all of September, as a monthly cost report gives it
    await importRecords(
      t.db,
      t.userId,
      { costs: [cost('sep', '2026-09-01T00:00:00.000Z', 30 * 86_400)] },
      { source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' }, contentHash: 'monthly', replaceRanges: [{ start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' }] },
    );
    expect((await getActualSpend(t.db, t.userId, 'UTC', NOW)).reportedRange).toEqual({ first: '2026-09-01', last: '2026-09-30' });
    // daily rows end on their own day
    await importRecords(
      t.db,
      t.userId,
      { costs: [cost('d1', '2026-10-01T00:00:00.000Z', 86_400), cost('d2', '2026-10-02T00:00:00.000Z', 86_400)] },
      { source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' }, contentHash: 'daily', replaceRanges: [{ start: '2026-10-01T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z' }] },
    );
    expect((await getActualSpend(t.db, t.userId, 'UTC', NOW)).reportedRange).toEqual({ first: '2026-09-01', last: '2026-10-02' });
  });

  it('names the days of hourly rows as the import preview does: in the person’s timezone', async () => {
    await t.reset();
    // Two hours of 3 November in UTC, which is still 2 November in Los Angeles. Daily rows stay UTC days everywhere.
    await importRecords(
      t.db,
      t.userId,
      { costs: [cost('h1', '2026-11-03T02:00:00.000Z', 3600), cost('h2', '2026-11-03T03:00:00.000Z', 3600)] },
      { source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' }, contentHash: 'hourly', replaceRanges: [{ start: '2026-11-03T02:00:00.000Z', end: '2026-11-03T04:00:00.000Z' }] },
    );
    expect((await getActualSpend(t.db, t.userId, 'America/Los_Angeles', NOW)).reportedRange).toEqual({ first: '2026-11-02', last: '2026-11-02' });
    expect((await getActualSpend(t.db, t.userId, 'UTC', NOW)).reportedRange).toEqual({ first: '2026-11-03', last: '2026-11-03' });
    const source = (await getCoverage(t.db, t.userId, 'America/Los_Angeles')).sources[0];
    expect([source.firstDay, source.lastDay]).toEqual(['2026-11-02', '2026-11-02']);

    await importRecords(
      t.db,
      t.userId,
      { costs: [cost('d1', '2026-11-05T00:00:00.000Z', 86_400)] },
      { source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' }, contentHash: 'daily', replaceRanges: [{ start: '2026-11-05T00:00:00.000Z', end: '2026-11-06T00:00:00.000Z' }] },
    );
    expect((await getActualSpend(t.db, t.userId, 'America/Los_Angeles', NOW)).reportedRange).toEqual({ first: '2026-11-02', last: '2026-11-05' });
  });
});
