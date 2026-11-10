import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { listImports } from '@/analytics/coverage';
import { getOverview } from '@/analytics/overview';
import { addManualUsage } from '@/analytics/settings';
import { commitImport, importGeneration, previewImport } from '@/import/commit';
import { loadDemoDataset } from '@/import/demo/load';
import { acquireImportLock, asOnlyImport } from '@/import/lock';
import { resetStaging, StagingWriter, stagingToken } from '@/import/staging';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg, parsed, usage } from '../helpers/staged';

/**
 * All tabs share one database session, and with it the staging tables an import waits
 * in between its preview and its confirmation. Two things keep one import from
 * damaging another: a lock that admits a single import at a time, and a token by which
 * a commit proves that the records it is about to save are the ones it previewed.
 */
const TZ = 'UTC';
let t: TestDb;
const filter = (): AnalyticsFilter => ({ userId: t.userId, timezone: TZ, basis: 'processed' });
const zero = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requestCount: 0, userMessageCount: 0, assistantMessageCount: 0 };
const API = { kind: 'api_usage_report' as const, label: 'Anthropic API usage report', externalRef: '' };
const day = (d: string, input: number, key: string) =>
  usage(key, { ...zero, modelKey: 'claude-opus-4-5', occurredAt: `${d}T00:00:00.000Z`, bucketSeconds: 86_400, inputTokens: input, outputTokens: 0 });

beforeAll(async () => {
  t = await createTestDb(TZ);
});
afterAll(() => t.close());

describe('the import lock', () => {
  it('admits one import at a time and is free again afterwards', async () => {
    const release = await acquireImportLock();
    expect(release).toBeTypeOf('function');
    expect(await acquireImportLock()).toBeNull();
    await expect(asOnlyImport(async () => 1)).rejects.toMatchObject({ name: 'ImportError', code: 'import_in_progress' });
    release!();
    release!(); // releasing twice does not free a lock someone else took in between
    expect(await asOnlyImport(async () => 'done')).toBe('done');
    // also free after the work failed
    await expect(asOnlyImport(async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    const again = await acquireImportLock();
    expect(again).not.toBeNull();
    again!();
  });

  it('refuses a manual entry and the demo dataset while another import is prepared or waits at its preview', async () => {
    await t.reset();
    // An import session has staged its records and shows the preview: it holds the lock.
    const release = (await acquireImportLock())!;
    await resetStaging(t.db);
    const writer = new StagingWriter(t.db);
    await writer.addBatch({ conversations: [conv('s1', { dedupKey: 'claude_code:s1', kind: 'code_session', title: 'Session' })] });
    await writer.finish();

    await expect(addManualUsage(t.db, t.userId, { date: '2025-01-15', inputTokens: 1_000, confidence: 'estimated' })).rejects.toMatchObject({
      code: 'import_in_progress',
      message: expect.stringContaining('Save or cancel it first'),
    });
    await expect(loadDemoDataset(t.db, t.userId, TZ)).rejects.toMatchObject({ code: 'import_in_progress' });
    // Nothing was stored, and the staged records of the waiting import were not touched.
    expect((await listImports(t.db, t.userId)).length).toBe(0);
    expect((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM stg_conversations`)).rows[0].n).toBe(1);

    release();
    expect(await addManualUsage(t.db, t.userId, { date: '2025-01-15', inputTokens: 1_000, confidence: 'estimated' })).toBeGreaterThan(0);
    expect((await getOverview(t.db, filter())).tokens.total).toBe(1_000);
  });
});

describe('a commit saves the records it previewed, or nothing', () => {
  it('hands out a new token with every reset', async () => {
    const first = await resetStaging(t.db);
    expect(await stagingToken(t.db)).toBe(first);
    const second = await resetStaging(t.db);
    expect(second).not.toBe(first);
    expect(await stagingToken(t.db)).toBe(second);
  });

  it('refuses a restated report whose staged rows were replaced, instead of deleting the stored range and saving nothing', async () => {
    await t.reset();
    await importRecords(t.db, t.userId, { usage: [day('2025-03-01', 100_000, 'a1'), day('2025-03-02', 200_000, 'a2'), day('2025-03-03', 300_000, 'a3')] }, { source: API, contentHash: 'report-1' });
    expect((await getOverview(t.db, filter())).tokens.total).toBe(600_000);

    // A newer report restates the same three days; the user is shown the preview.
    const staging = await resetStaging(t.db);
    const writer = new StagingWriter(t.db);
    await writer.addBatch({ usage: [day('2025-03-01', 110_000, 'b1'), day('2025-03-02', 220_000, 'b2'), day('2025-03-03', 320_000, 'b3')] });
    await writer.finish();
    const restated = parsed({ source: API, contentHash: 'report-2', fileName: 'usage-march.json', replaceRanges: [{ start: '2025-03-01T00:00:00.000Z', end: '2025-03-04T00:00:00.000Z' }] });
    const generation = await importGeneration(t.db, t.userId);
    const preview = await previewImport(t.db, t.userId, restated);
    expect(preview.replaced).toEqual({ usageRows: 3, costRows: 0, tokens: 600_000 });

    // Something else went through the staging tables in the meantime (here the lock does not stop it,
    // as between two pages of a browser without Web Locks).
    await addManualUsage(t.db, t.userId, { date: '2025-01-15', model: 'claude-sonnet-4-5', inputTokens: 1_000, confidence: 'estimated' });

    await expect(commitImport(t.db, t.userId, restated, { generation, staging })).rejects.toMatchObject({
      code: 'stale_preview',
      message: expect.stringContaining('Nothing was saved'),
    });
    // The stored March rows are all still there, next to the manual entry.
    expect((await getOverview(t.db, filter())).tokens.total).toBe(601_000);
    expect((await listImports(t.db, t.userId)).map((i) => i.fileName)).not.toContain('usage-march.json');
  });

  it('refuses a chat export whose staged rows were replaced, instead of reporting that it held nothing new', async () => {
    await t.reset();
    const staging = await resetStaging(t.db);
    const writer = new StagingWriter(t.db);
    await writer.addBatch({ conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] });
    await writer.finish();
    const exportFile = parsed();
    expect((await previewImport(t.db, t.userId, exportFile)).messages.new).toBe(2);

    await addManualUsage(t.db, t.userId, { date: '2025-01-15', inputTokens: 1_000, confidence: 'estimated' });
    await expect(commitImport(t.db, t.userId, exportFile, { staging })).rejects.toMatchObject({ code: 'stale_preview' });
    expect((await getOverview(t.db, filter())).conversations.total).toBe(0);
  });

  it('saves normally when nothing came in between', async () => {
    await t.reset();
    const staging = await resetStaging(t.db);
    const writer = new StagingWriter(t.db);
    await writer.addBatch({ conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] });
    await writer.finish();
    const result = await commitImport(t.db, t.userId, parsed(), { staging });
    expect(result.inserted).toMatchObject({ conversations: 1, messages: 2 });
  });

  it('a manual entry leaves no staged rows behind for the next import to pick up', async () => {
    await t.reset();
    await addManualUsage(t.db, t.userId, { date: '2025-01-15', inputTokens: 1_000, confidence: 'estimated' });
    expect((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM stg_usage`)).rows[0].n).toBe(0);
  });
});
