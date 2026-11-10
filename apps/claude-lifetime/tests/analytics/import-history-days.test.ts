import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCoverage, listImports } from '@/analytics/coverage';
import { getOverview, getTimeSeries } from '@/analytics/overview';
import { addManualUsage } from '@/analytics/settings';
import type { StagedCost } from '@/core/types';
import { recordedHistory } from '@/features/usage/usage-model';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg, usage } from '../helpers/staged';

/**
 * The days an import "covers" in the import history. They are calendar days by the
 * rule of every chart: a record that only knows its day (a daily report row, a dated
 * table row, a manual entry) is that day in every timezone, and a record with a time
 * of day falls on the day it has in the person's timezone. Printing the stored
 * instants in the person's timezone instead showed a manual entry for 1 June as
 * "May 31" in New York, while the overview filed it under 1 June.
 */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb('UTC');
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const NEW_YORK = 'America/New_York';
const KOLKATA = 'Asia/Kolkata';
const daysOf = async (timezone: string) => (await listImports(t.db, t.userId, timezone)).map((i) => [i.fileName, i.coveredDays]);
const daily = (key: string, day: string) => usage(key, { occurredAt: `${day}T00:00:00.000Z`, bucketSeconds: 86_400 });
const API = { kind: 'api_usage_report' as const, label: 'Anthropic API usage report', externalRef: '' };

describe('the days an import covers', () => {
  it('are the entered day for a manual entry, in every timezone, as on the overview', async () => {
    await addManualUsage(t.db, t.userId, { date: '2026-06-01', inputTokens: 1000, confidence: 'exact' });
    for (const timezone of [NEW_YORK, KOLKATA, 'UTC']) {
      const [[, days]] = await daysOf(timezone);
      expect(days, timezone).toEqual({ first: '2026-06-01', last: '2026-06-01' });
      const overview = await getOverview(t.db, { userId: t.userId, timezone, basis: 'processed' });
      expect([overview.firstDay, overview.lastDay], timezone).toEqual(['2026-06-01', '2026-06-01']);
    }
  });

  it('are the report’s own days for a daily report, not a day early in the west or a day late in the east', async () => {
    await importRecords(
      t.db,
      t.userId,
      { usage: [daily('d1', '2026-03-01'), daily('d2', '2026-03-02'), daily('d3', '2026-03-03')] },
      { source: API, contentHash: 'daily', fileName: 'usage-report.json', replaceRanges: [{ start: '2026-03-01T00:00:00.000Z', end: '2026-03-04T00:00:00.000Z' }] },
    );
    for (const timezone of [NEW_YORK, KOLKATA, 'UTC']) {
      expect(await daysOf(timezone), timezone).toEqual([['usage-report.json', { first: '2026-03-01', last: '2026-03-03' }]]);
    }
  });

  it('run to the last day a row that adds up a longer period covers', async () => {
    // One row for all of September, as a monthly table has it.
    await importRecords(
      t.db,
      t.userId,
      { usage: [usage('sep', { occurredAt: '2026-09-01T00:00:00.000Z', bucketSeconds: 30 * 86_400, confidence: 'estimated' })] },
      { source: { kind: 'generic_csv', label: 'My table', externalRef: 'my-table' }, contentHash: 'monthly', fileName: 'months.csv' },
    );
    expect(await daysOf(NEW_YORK)).toEqual([['months.csv', { first: '2026-09-01', last: '2026-09-30' }]]);
  });

  it('are local days for records with a time of day', async () => {
    // 03:00 UTC on 2 March is the evening of 1 March in New York and the morning of 2 March in Kolkata.
    await importRecords(
      t.db,
      t.userId,
      { usage: [usage('cc:1', { occurredAt: '2026-03-02T03:00:00.000Z', bucketSeconds: 900 }), usage('cc:2', { occurredAt: '2026-03-02T22:00:00.000Z', bucketSeconds: 900 })] },
      { source: { kind: 'claude_code', label: 'Claude Code (this computer)', externalRef: 'local' }, contentHash: 'cc', fileName: 'Claude Code folder' },
    );
    expect(await daysOf(NEW_YORK)).toEqual([['Claude Code folder', { first: '2026-03-01', last: '2026-03-02' }]]);
    expect(await daysOf(KOLKATA)).toEqual([['Claude Code folder', { first: '2026-03-02', last: '2026-03-03' }]]);

    // The same for the messages of a chat export, which carry their own time.
    await t.reset();
    await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] }, { contentHash: 'chat' });
    // The fixture's messages are from 10:00 UTC on 1 January 2025.
    expect((await daysOf(NEW_YORK))[0][1]).toEqual({ first: '2025-01-01', last: '2025-01-01' });
  });

  it('are the days of a cost report’s rows, which hold no token usage', async () => {
    const cost = (key: string, day: string): StagedCost => ({
      modelKey: 'claude-sonnet-4-5',
      occurredAt: `${day}T00:00:00.000Z`,
      bucketSeconds: 86_400,
      costType: 'tokens',
      tokenType: 'output_tokens',
      description: null,
      amountUsd: '1.50',
      dedupKey: key,
    });
    await importRecords(
      t.db,
      t.userId,
      { costs: [cost('c1', '2026-07-05'), cost('c2', '2026-07-08')] },
      {
        source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' },
        contentHash: 'cost',
        fileName: 'cost-report.json',
        replaceRanges: [{ start: '2026-07-05T00:00:00.000Z', end: '2026-07-09T00:00:00.000Z' }],
      },
    );
    expect(await daysOf(NEW_YORK)).toEqual([['cost-report.json', { first: '2026-07-05', last: '2026-07-08' }]]);
  });

  it('are not given for an import that holds no dated record', async () => {
    // The app removes an import once nothing of it is left, so this only arises for data written by other means.
    const first = await importRecords(t.db, t.userId, { usage: [daily('d1', '2026-03-01')] }, { source: API, contentHash: 'one', fileName: 'report.json' });
    await t.db.query(`DELETE FROM usage_records WHERE batch_id = $1`, [first.result.batchId]);
    expect(await daysOf('UTC')).toEqual([['report.json', null]]);
  });

  it('follow the rows an import still has after a later report replaced some of them', async () => {
    const report = (hash: string, fileName: string, days: string[], range: [string, string], tokens: number) =>
      importRecords(
        t.db,
        t.userId,
        { usage: days.map((day) => ({ ...daily(`d:${day}`, day), inputTokens: tokens })) },
        { source: API, contentHash: hash, fileName, replaceRanges: [{ start: `${range[0]}T00:00:00.000Z`, end: `${range[1]}T00:00:00.000Z` }] },
      );
    await report('first', 'first.json', ['2026-03-01', '2026-03-02', '2026-03-03'], ['2026-03-01', '2026-03-04'], 1000);
    // 3 March restated with another figure: that row of the first import is replaced.
    await report('second', 'second.json', ['2026-03-03'], ['2026-03-03', '2026-03-04'], 2000);
    expect(await daysOf(NEW_YORK)).toEqual([
      ['second.json', { first: '2026-03-03', last: '2026-03-03' }],
      ['first.json', { first: '2026-03-01', last: '2026-03-02' }],
    ]);
  });
});

describe('a report row that adds up a whole month', () => {
  // An Analytics API report asked for without daily buckets: one row for September, exact.
  const september = () =>
    importRecords(
      t.db,
      t.userId,
      { usage: [usage('sep', { occurredAt: '2026-09-01T00:00:00.000Z', bucketSeconds: 30 * 86_400 })] },
      { source: API, contentHash: 'sep', fileName: 'analytics-usage.json', replaceRanges: [{ start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' }] },
    );

  it('reaches to the end of the month on the overview and in the coverage summary, as in the import history', async () => {
    await september();
    expect(await daysOf(NEW_YORK)).toEqual([['analytics-usage.json', { first: '2026-09-01', last: '2026-09-30' }]]);

    const overview = await getOverview(t.db, { userId: t.userId, timezone: NEW_YORK, basis: 'processed' });
    expect([overview.firstDay, overview.lastDay]).toEqual(['2026-09-01', '2026-09-30']);

    const coverage = await getCoverage(t.db, t.userId, NEW_YORK);
    expect([coverage.earliestDay, coverage.latestDay]).toEqual(['2026-09-01', '2026-09-30']);
    expect([coverage.sources[0].firstDay, coverage.sources[0].lastDay]).toEqual(['2026-09-01', '2026-09-30']);

    // The history of Lifetime Usage ends with the month as well, so its averages divide by thirty days.
    const daily = await getTimeSeries(t.db, { userId: t.userId, timezone: NEW_YORK, basis: 'processed' }, 'day');
    expect(daily.map((p) => [p.bucket, p.lastDay])).toEqual([['2026-09-01', '2026-09-30']]);
    expect(recordedHistory(daily)).toEqual({ first: '2026-09-01', last: '2026-09-30' });
  });

  it('never reaches beyond the selected range', async () => {
    await september();
    const overview = await getOverview(t.db, { userId: t.userId, timezone: 'UTC', basis: 'processed', from: '2026-09-01', to: '2026-09-10' });
    expect(overview.lastDay).toBe('2026-09-10');
  });

  it('is the same for a cost report with one row for the month', async () => {
    const cost: StagedCost = {
      modelKey: 'claude-sonnet-4-5',
      occurredAt: '2026-09-01T00:00:00.000Z',
      bucketSeconds: 30 * 86_400,
      costType: 'tokens',
      tokenType: 'output_tokens',
      description: null,
      amountUsd: '12.00',
      dedupKey: 'sep',
    };
    await importRecords(
      t.db,
      t.userId,
      { costs: [cost] },
      {
        source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' },
        contentHash: 'cost-sep',
        fileName: 'analytics-cost.json',
        replaceRanges: [{ start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' }],
      },
    );
    const source = (await getCoverage(t.db, t.userId, NEW_YORK)).sources[0];
    expect([source.firstDay, source.lastDay]).toEqual(['2026-09-01', '2026-09-30']);
  });
});

