import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StagedCost } from '@/core/types';
import { getCoverage } from '@/analytics/coverage';
import { addManualUsage, updateSettings } from '@/analytics/settings';
import { DatabaseMovedError } from '@/db/driver';
import { commitImport, importGeneration, previewImport } from '@/import/commit';
import { deleteBatch } from '@/import/delete';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg, parsed, stage, usage } from '../helpers/staged';

/** Rules of the preview and the commit that every importer relies on. */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const CODE = { kind: 'claude_code' as const, label: 'Claude Code', externalRef: 'laptop' };
const zero = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requestCount: 1, userMessageCount: 0, assistantMessageCount: 1 };
const cost = (key: string, over: Partial<StagedCost> = {}): StagedCost => ({
  modelKey: 'claude-sonnet-4-5',
  occurredAt: '2026-04-01T00:00:00.000Z',
  bucketSeconds: 86_400,
  costType: 'tokens',
  tokenType: 'output_tokens',
  description: null,
  amountUsd: '1.50',
  dedupKey: key,
  ...over,
});

describe('a preview that has gone stale', () => {
  it('is noticed when an import was deleted in the meantime, not only when one was added', async () => {
    const first = await importRecords(t.db, t.userId, { usage: [usage('cc:a')] }, { source: CODE, contentHash: 'c1', requestKeys: [1n] });
    await importRecords(t.db, t.userId, { conversations: [conv('x')], messages: [msg('x', 0)] }, { contentHash: 'chat' });

    // A Claude Code import is prepared: its requests were compared with what is stored at this moment.
    const generation = await importGeneration(t.db, t.userId);
    await stage(t.db, { usage: [usage('cc:b')] });
    const pending = parsed({ source: CODE, contentHash: 'c2', requestKeys: [2n], duplicateRequests: 1 });

    // The first import, which is not the newest one, is deleted while that preview is open.
    await deleteBatch(t.db, t.userId, first.result.batchId!);
    expect(await importGeneration(t.db, t.userId)).not.toBe(generation);
    await expect(commitImport(t.db, t.userId, pending, { generation })).rejects.toMatchObject({ code: 'stale_preview' });
    expect((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM usage_records`)).rows[0].n).toBe(0);
  });

  it('changes with every save and every deletion, and is the same again only for the same set of imports', async () => {
    const empty = await importGeneration(t.db, t.userId);
    const a = await importRecords(t.db, t.userId, { usage: [usage('a')] }, { source: CODE, contentHash: 'a' });
    const one = await importGeneration(t.db, t.userId);
    const b = await importRecords(t.db, t.userId, { usage: [usage('b')] }, { source: CODE, contentHash: 'b' });
    const two = await importGeneration(t.db, t.userId);
    await deleteBatch(t.db, t.userId, a.result.batchId!);
    const onlySecond = await importGeneration(t.db, t.userId);
    expect(new Set([empty, one, two, onlySecond]).size).toBe(4);

    await deleteBatch(t.db, t.userId, b.result.batchId!);
    // nothing is stored, exactly as at the start
    expect(await importGeneration(t.db, t.userId)).toBe(empty);
    await importRecords(t.db, t.userId, { usage: [usage('c')] }, { source: CODE, contentHash: 'c' });
    // a new import never repeats an earlier value: import ids only grow
    expect([empty, one, two, onlySecond]).not.toContain(await importGeneration(t.db, t.userId));
  });
});

describe('what a conversation is called and filed under', () => {
  const title = async (id: string) =>
    (await t.db.query<{ title: string | null; project_label: string | null; n: number }>(`SELECT title, project_label, message_count AS n FROM conversations WHERE external_id = $1`, [id])).rows[0];

  it('follows the newer export, also when an older export is imported later', async () => {
    // the March export, in which the chat had been renamed
    await importRecords(
      t.db, t.userId,
      { conversations: [conv('c1', { title: 'Trip to Lisbon', projectLabel: 'Travel', updatedAt: '2025-03-01T10:00:00.000Z' })], messages: [msg('c1', 0), msg('c1', 1), msg('c1', 2), msg('c1', 3)] },
      { contentHash: 'march' },
    );
    // the January export, imported afterwards to recover another chat
    await importRecords(
      t.db, t.userId,
      { conversations: [conv('c1', { title: 'Untitled', projectLabel: 'Inbox', updatedAt: '2025-01-03T10:00:00.000Z' })], messages: [msg('c1', 0), msg('c1', 1)] },
      { contentHash: 'january' },
    );
    expect(await title('c1')).toEqual({ title: 'Trip to Lisbon', project_label: 'Travel', n: 4 });

    // a later export renames it again
    await importRecords(
      t.db, t.userId,
      { conversations: [conv('c1', { title: 'Lisbon in May', projectLabel: null, updatedAt: '2025-04-01T10:00:00.000Z' })], messages: [msg('c1', 4)] },
      { contentHash: 'april' },
    );
    expect(await title('c1')).toEqual({ title: 'Lisbon in May', project_label: 'Travel', n: 5 });

    // an export without a title never erases one
    await importRecords(
      t.db, t.userId,
      { conversations: [conv('c1', { title: null, updatedAt: '2025-05-01T10:00:00.000Z' })], messages: [msg('c1', 5)] },
      { contentHash: 'may' },
    );
    expect((await title('c1')).title).toBe('Lisbon in May');
  });

  it('files a Claude Code session under the model that handled most of its stored tokens', async () => {
    const session = (modelKey: string | null, updatedAt: string) => conv('s1', { dedupKey: 'claude_code:s1', kind: 'code_session', title: null, modelKey, updatedAt });
    const row = (key: string, modelKey: string, input: number, at: string) => usage(key, { ...zero, conversationKey: 'claude_code:s1', modelKey, occurredAt: at, inputTokens: input, outputTokens: 0 });
    const model = async () =>
      (await t.db.query<{ k: string | null }>(`SELECT m.model_key AS k FROM conversations c LEFT JOIN model_catalog m ON m.id = c.model_id WHERE c.dedup_key = 'claude_code:s1'`)).rows[0].k;

    // first read: the session has made one small request on Haiku
    await importRecords(t.db, t.userId, { conversations: [session('claude-haiku-4-5', '2026-01-01T10:00:00.000Z')], usage: [row('u1', 'claude-haiku-4-5', 100, '2026-01-01T10:00:00.000Z')] }, { source: CODE, contentHash: 'r1' });
    expect(await model()).toBe('claude-haiku-4-5');

    // second read: twenty times as much on Opus
    await importRecords(t.db, t.userId, { conversations: [session('claude-opus-4-5', '2026-01-02T10:00:00.000Z')], usage: [row('u2', 'claude-opus-4-5', 2_000, '2026-01-02T10:00:00.000Z')] }, { source: CODE, contentHash: 'r2' });
    expect(await model()).toBe('claude-opus-4-5');

    // a third read that only sees a small Haiku tail does not move the session back
    const third = await importRecords(t.db, t.userId, { conversations: [session('claude-haiku-4-5', '2026-01-03T10:00:00.000Z')], usage: [row('u3', 'claude-haiku-4-5', 50, '2026-01-03T10:00:00.000Z')] }, { source: CODE, contentHash: 'r3' });
    expect(await model()).toBe('claude-opus-4-5');

    // and when the Opus usage is deleted again, the session follows what is left
    await deleteBatch(t.db, t.userId, third.result.batchId!);
    expect(await model()).toBe('claude-opus-4-5');
    const second = (await t.db.query<{ id: number }>(`SELECT id FROM import_batches WHERE content_hash = 'r2'`)).rows[0].id;
    await deleteBatch(t.db, t.userId, second);
    expect(await model()).toBe('claude-haiku-4-5');
  });
});

describe('an import that adds nothing', () => {
  it('leaves no empty source behind, even when it read files', async () => {
    await importRecords(t.db, t.userId, { usage: [usage('cc:a')] }, { source: CODE, contentHash: 'c1', requestKeys: [1n] });
    // The same folder again under another computer name: every request is already counted.
    await stage(t.db, {});
    const again = parsed({
      source: { kind: 'claude_code', label: 'Claude Code (Laptop)', externalRef: 'laptop-2' },
      contentHash: 'c1b', requestKeys: [], duplicateRequests: 1,
      syncedFiles: [{ path: 'projects/p/a.jsonl', size: 10, lastModified: 1_700_000_000_000 }],
    });
    expect((await previewImport(t.db, t.userId, again)).nothingNew).toBe(true);
    const result = await commitImport(t.db, t.userId, again);
    expect(result).toMatchObject({ nothingNew: true, batchId: null, sourceId: null });
    expect((await getCoverage(t.db, t.userId, 'UTC')).sources.map((s) => s.label)).toEqual(['Claude Code']);

    // For a source that exists, the files that were read are still remembered.
    await stage(t.db, {});
    const same = parsed({ source: CODE, contentHash: 'c1c', requestKeys: [], duplicateRequests: 1, syncedFiles: [{ path: 'projects/p/a.jsonl', size: 10, lastModified: 1_700_000_000_000 }] });
    expect(await commitImport(t.db, t.userId, same)).toMatchObject({ nothingNew: true, batchId: null, sourceId: expect.any(Number) });
    expect((await t.db.query<{ path: string }>(`SELECT path FROM synced_files`)).rows).toEqual([{ path: 'projects/p/a.jsonl' }]);
  });

  it('into an empty workspace leaves the workspace empty', async () => {
    await stage(t.db, {});
    const nothing = parsed({ source: CODE, contentHash: 'empty', requestKeys: [], syncedFiles: [{ path: 'projects/p/a.jsonl', size: 10, lastModified: 1 }] });
    expect(await commitImport(t.db, t.userId, nothing)).toMatchObject({ nothingNew: true, sourceId: null });
    expect((await getCoverage(t.db, t.userId, 'UTC')).hasData).toBe(false);
  });
});

describe('an import whose records are stored but could not be written to the device', () => {
  it('is reported as saved with a problem, not as failed, so that nobody saves it a second time', async () => {
    // What the browser database does when the device's storage is full: the transaction commits, the copy to disk fails.
    const noRoom = Object.assign(Object.create(t.db) as typeof t.db, {
      flush: async () => {
        throw new Error('The change could not be saved to this device\'s storage. (QuotaExceededError: The quota has been exceeded.)');
      },
    });
    await stage(t.db, { usage: [usage('cc:a')] });
    const result = await commitImport(noRoom, t.userId, parsed({ source: CODE, contentHash: 'c1' }));
    expect(result).toMatchObject({ nothingNew: false, inserted: { usageRows: 1 } });
    expect(result.notOnDevice).toMatch(/QuotaExceededError/);
    // the records are there and count
    expect((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM usage_records`)).rows[0].n).toBe(1);

    // a manual entry says the same, with what it took away
    const entry = await addManualUsage(noRoom, t.userId, { date: '2025-01-15', inputTokens: 1_000, confidence: 'estimated' });
    expect(entry.batchId).toBeGreaterThan(0);
    expect(entry.notOnDevice).toMatch(/QuotaExceededError/);
    expect((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM usage_records`)).rows[0].n).toBe(2);

    // a healthy device reports nothing
    await stage(t.db, { usage: [usage('cc:b')] });
    expect((await commitImport(t.db, t.userId, parsed({ source: CODE, contentHash: 'c2' }))).notOnDevice).toBeUndefined();
  });
});

describe('an import that was saved by a tab’s worker which went away before it confirmed the copy to storage', () => {
  it('is not called "saved, but not on the device": whether it is stored is not known, and the error says to check', async () => {
    // The transaction commits. Then the tab that held the database is closed, and with it the only copy that is certain.
    const moved = Object.assign(Object.create(t.db) as typeof t.db, {
      flush: async () => {
        throw new DatabaseMovedError();
      },
    });
    await stage(t.db, { usage: [usage('cc:a')] });

    // Before the fix this resolved with notOnDevice, and the page said: "The import is saved … It is in the figures
    // now … Do not import the file a second time". After a move the figures come from what reached storage.
    await expect(commitImport(moved, t.userId, parsed({ source: CODE, contentHash: 'c1' }))).rejects.toThrow(
      'The tab that held the database was closed or reloaded at that moment, and another tab has taken over. Check whether this was saved, and do it again if it was not.',
    );
  });
});

describe('the days an import covers, as the preview states them', () => {
  const previewIn = async (timezone: string, records: Parameters<typeof stage>[1], meta: Parameters<typeof parsed>[0] = {}) => {
    await updateSettings(t.db, t.userId, { timezone });
    await stage(t.db, records);
    return (await previewImport(t.db, t.userId, parsed(meta))).coveredDays;
  };
  const daily = (key: string, day: string) => usage(key, { occurredAt: `${day}T00:00:00.000Z`, bucketSeconds: 86_400 });

  it('a record that only knows its day is that day in every timezone', async () => {
    // a manual entry, a dated table row or a daily report row: stored at 00:00 UTC of its day
    for (const timezone of ['America/New_York', 'UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      expect(await previewIn(timezone, { usage: [daily('d1', '2026-06-01')] }), timezone).toEqual({ first: '2026-06-01', last: '2026-06-01' });
    }
    // a daily report of 1 to 3 March speaks for exactly those days, east and west of UTC
    const report = { usage: [daily('r1', '2026-03-01'), daily('r2', '2026-03-03')] };
    const meta = { source: { kind: 'api_usage_report' as const, label: 'API', externalRef: '' }, replaceRanges: [{ start: '2026-03-01T00:00:00.000Z', end: '2026-03-04T00:00:00.000Z' }] };
    expect(await previewIn('America/New_York', report, meta)).toEqual({ first: '2026-03-01', last: '2026-03-03' });
    expect(await previewIn('Asia/Kolkata', report, meta)).toEqual({ first: '2026-03-01', last: '2026-03-03' });
    // a row that states a whole month ends on the month's last day
    expect(await previewIn('America/New_York', { usage: [usage('m', { occurredAt: '2026-02-01T00:00:00.000Z', bucketSeconds: 28 * 86_400 })] })).toEqual({
      first: '2026-02-01',
      last: '2026-02-28',
    });
  });

  it('a record with a time of day falls on the day it has in the user\'s timezone', async () => {
    // 03:30 UTC on 2 June is still 1 June in New York
    const late = { usage: [usage('h1', { occurredAt: '2026-06-02T03:30:00.000Z', bucketSeconds: 900 })] };
    expect(await previewIn('America/New_York', late)).toEqual({ first: '2026-06-01', last: '2026-06-01' });
    expect(await previewIn('Asia/Tokyo', late)).toEqual({ first: '2026-06-02', last: '2026-06-02' });
    // chat messages likewise
    const chat = { conversations: [conv('z')], messages: [msg('z', 0, { createdAt: '2026-06-02T03:30:00.000Z', occurredAt: '2026-06-02T03:30:00.000Z' })] };
    expect(await previewIn('America/New_York', chat)).toEqual({ first: '2026-06-01', last: '2026-06-01' });
    // an hourly report is placed by the hour
    const hourly = { usage: [usage('hr', { occurredAt: '2026-06-02T01:00:00.000Z', bucketSeconds: 3600 })] };
    const meta = { source: { kind: 'api_usage_report' as const, label: 'API', externalRef: '' }, replaceRanges: [{ start: '2026-06-02T01:00:00.000Z', end: '2026-06-02T02:00:00.000Z' }] };
    expect(await previewIn('America/New_York', hourly, meta)).toEqual({ first: '2026-06-01', last: '2026-06-01' });
  });

  it('is empty when nothing dated would be added', async () => {
    await importRecords(t.db, t.userId, { usage: [usage('same')] }, { source: CODE, contentHash: 'c' });
    expect(await previewIn('UTC', { usage: [usage('same')] }, { source: CODE, contentHash: 'c' })).toEqual({ first: null, last: null });
  });
});

describe('the preview says what kind of figures a file holds', () => {
  const API_COST = { kind: 'api_cost_report' as const, label: 'Anthropic API cost report', externalRef: '' };

  it('describes a cost report as money with models and dates, not as text to estimate from', async () => {
    await stage(t.db, { costs: [cost('c1'), cost('c2', { occurredAt: '2026-04-02T00:00:00.000Z' }), cost('c3', { occurredAt: '2026-04-03T00:00:00.000Z', modelKey: null, costType: 'web_search', tokenType: null })] });
    const preview = await previewImport(t.db, t.userId, parsed({ source: API_COST, contentHash: 'cost', replaceRanges: [{ start: '2026-04-01T00:00:00.000Z', end: '2026-04-04T00:00:00.000Z' }] }));
    expect(preview.figures).toEqual({ exactTokens: false, statedTokens: false, textEstimates: false, costs: true });
    expect(preview.costRows).toMatchObject({ total: 3, new: 3, duplicate: 0 });
    expect(preview.coverage.hasModel).toBe(true);
    expect(preview.coverage.modelShare).toBeCloseTo(2 / 3, 9);
    expect(preview.models).toEqual(['claude-sonnet-4-5']);
    // from the first day to the end of the last day the report speaks for
    expect(preview.dateRange).toEqual({ start: '2026-04-01T00:00:00.000Z', end: '2026-04-03T23:59:59.999Z' });
  });

  it('keeps apart token counts the source metered, counts a file states without that claim, and estimates from text', async () => {
    const table = { kind: 'generic_csv' as const, label: 'Usage table', externalRef: '' };
    await stage(t.db, { usage: [usage('t1', { confidence: 'estimated', inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0 })] });
    const stated = await previewImport(t.db, t.userId, parsed({ source: table, contentHash: 't' }));
    expect(stated.figures).toEqual({ exactTokens: false, statedTokens: true, textEstimates: false, costs: false });
    expect(stated.tokens).toEqual({ exact: 0, estimated: 2_500 });
    expect(stated.coverage.hasExactUsage).toBe(false);

    await stage(t.db, { usage: [usage('e1')] });
    expect((await previewImport(t.db, t.userId, parsed({ source: CODE, contentHash: 'e' }))).figures).toEqual({ exactTokens: true, statedTokens: false, textEstimates: false, costs: false });

    await stage(t.db, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] });
    expect((await previewImport(t.db, t.userId, parsed())).figures).toEqual({ exactTokens: false, statedTokens: false, textEstimates: true, costs: false });
  });

  it('names the source a file was imported under before, and whether that is the source it would go to now', async () => {
    const table = { kind: 'generic_csv' as const, label: 'Proxy logs', externalRef: 'proxy-logs' };
    await importRecords(t.db, t.userId, { usage: [usage('proxy-logs:1')] }, { source: table, contentHash: 'same-file' });
    await stage(t.db, { usage: [usage('proxy-logs:1')] });
    expect((await previewImport(t.db, t.userId, parsed({ source: table, contentHash: 'same-file' }))).previousImport).toMatchObject({ sourceLabel: 'Proxy logs', sameSource: true });
    // the same file once more, with the optional name left empty this time
    await stage(t.db, { usage: [usage(':1')] });
    const other = await previewImport(t.db, t.userId, parsed({ source: { kind: 'generic_csv', label: 'CSV usage table', externalRef: '' }, contentHash: 'same-file' }));
    expect(other.previousImport).toMatchObject({ sourceLabel: 'Proxy logs', sameSource: false });
    expect(other.usageRows.new).toBe(1);
  });
});
