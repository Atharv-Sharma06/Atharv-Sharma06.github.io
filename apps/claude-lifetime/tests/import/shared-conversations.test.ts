import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { listConversationModels, listConversations } from '@/analytics/conversations';
import { getCoverage } from '@/analytics/coverage';
import { getOverview } from '@/analytics/overview';
import { setSourceIncluded } from '@/analytics/settings';
import { loadKnownRequestKeys } from '@/import/commit';
import { deleteBatch, deleteSource } from '@/import/delete';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, usage } from '../helpers/staged';

/**
 * One conversation, two sources. The same Claude Code session is read once before the
 * computer was given a name and once after, so its requests arrive under two sources
 * while the session itself is one row, owned by the source that brought it first.
 * Deleting either source or import must remove exactly what that one added.
 */
const TZ = 'UTC';
let t: TestDb;
const filter = (): AnalyticsFilter => ({ userId: t.userId, timezone: TZ, basis: 'processed' });
const zero = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requestCount: 1, userMessageCount: 1, assistantMessageCount: 1 };
const session = conv('s1', {
  dedupKey: 'claude_code:s1', kind: 'code_session', title: 'Long-running session', modelKey: 'claude-sonnet-4-5',
  createdAt: '2025-06-01T10:00:00.000Z', updatedAt: '2025-06-01T10:00:00.000Z',
});

async function importTwice() {
  await t.reset();
  const first = await importRecords(
    t.db, t.userId,
    { conversations: [session], usage: [usage('cc:s1:a', { ...zero, conversationKey: 'claude_code:s1', occurredAt: '2025-06-01T10:00:00.000Z', inputTokens: 1_000, outputTokens: 0 })] },
    { source: { kind: 'claude_code', label: 'Claude Code', externalRef: 'local' }, contentHash: 'h1', requestKeys: [1n] },
  );
  const second = await importRecords(
    t.db, t.userId,
    {
      conversations: [{ ...session, updatedAt: '2025-06-02T10:00:00.000Z' }],
      usage: [usage('cc:s1:b', { ...zero, conversationKey: 'claude_code:s1', occurredAt: '2025-06-02T10:00:00.000Z', inputTokens: 2_000, outputTokens: 0 })],
    },
    { source: { kind: 'claude_code', label: 'Claude Code (work laptop)', externalRef: 'work-laptop' }, contentHash: 'h2', requestKeys: [2n] },
  );
  return { first: first.result, second: second.result };
}

const sources = async () => (await getCoverage(t.db, t.userId, TZ)).sources.map((s) => [s.label, s.imports, s.exactTokens, s.conversations]);
const sessionRow = async () =>
  (await t.db.query<{ source_id: number; message_count: number }>(`SELECT source_id, message_count FROM conversations WHERE dedup_key = 'claude_code:s1'`)).rows[0];

beforeAll(async () => {
  t = await createTestDb(TZ);
});
afterAll(() => t.close());

describe('a session that two sources added to', () => {
  it('is one conversation, owned by the source that imported it first', async () => {
    const { first, second } = await importTwice();
    expect(first.sourceId).not.toBe(second.sourceId);
    expect(await sessionRow()).toEqual({ source_id: first.sourceId, message_count: 4 });
    expect((await getOverview(t.db, filter())).tokens.total).toBe(3_000);
  });

  it('keeps what the second import added when the first import is deleted', async () => {
    const { first, second } = await importTwice();
    await deleteBatch(t.db, t.userId, first.batchId!);
    expect((await getOverview(t.db, filter())).tokens.total).toBe(2_000);
    // The session now belongs to the source that still has records in it, and counts only those.
    expect(await sessionRow()).toEqual({ source_id: second.sourceId, message_count: 2 });
    expect(await sources()).toEqual([['Claude Code (work laptop)', 1, 2_000, 1]]);
    // What is still stored is still known, and what was deleted can be read in again.
    const known = await loadKnownRequestKeys(t.db, t.userId);
    expect([known.has(1n), known.has(2n)]).toEqual([false, true]);
  });

  it('keeps it as well when the first source is removed in Settings', async () => {
    const { first, second } = await importTwice();
    expect(await deleteSource(t.db, t.userId, first.sourceId!)).toMatchObject({ deleted: true });
    expect((await getOverview(t.db, filter())).tokens.total).toBe(2_000);
    expect(await sessionRow()).toEqual({ source_id: second.sourceId, message_count: 2 });
    expect(await sources()).toEqual([['Claude Code (work laptop)', 1, 2_000, 1]]);
  });

  it('removes only the second source’s records when that one is deleted', async () => {
    const { first, second } = await importTwice();
    await deleteSource(t.db, t.userId, second.sourceId!);
    expect((await getOverview(t.db, filter())).tokens.total).toBe(1_000);
    expect(await sessionRow()).toEqual({ source_id: first.sourceId, message_count: 2 });
    expect(await sources()).toEqual([['Claude Code', 1, 1_000, 1]]);
  });

  it('removes the session once neither source has anything left in it', async () => {
    const { first, second } = await importTwice();
    await deleteBatch(t.db, t.userId, first.batchId!);
    await deleteBatch(t.db, t.userId, second.batchId!);
    expect(await sessionRow()).toBeUndefined();
    expect(await sources()).toEqual([]);
    expect((await getOverview(t.db, filter())).tokens.total).toBe(0);
  });

  it('leaves a source out of the conversation explorer’s token figures when it is left out of the totals', async () => {
    const { second } = await importTwice();
    await setSourceIncluded(t.db, t.userId, second.sourceId!, false, 'counted elsewhere');
    expect((await getOverview(t.db, filter())).tokens.total).toBe(1_000);
    const page = await listConversations(t.db, filter());
    expect(page.rows.map((r) => [r.title, r.tokens, r.exact])).toEqual([['Long-running session', 1_000, 1_000]]);
  });

  it('still lists the session when the source it belongs to is left out and the other one counts', async () => {
    const { first, second } = await importTwice();
    await setSourceIncluded(t.db, t.userId, first.sourceId!, false, 'counted elsewhere');
    // the second source's tokens are in the totals, so the session they belong to is in the list, with those tokens
    const overview = await getOverview(t.db, filter());
    expect(overview.tokens.total).toBe(2_000);
    expect(overview.mostActiveDay).toMatchObject({ day: '2025-06-02', conversationsActive: 1 });
    expect((await listConversations(t.db, filter())).rows.map((r) => [r.title, r.tokens])).toEqual([['Long-running session', 2_000]]);
    expect((await listConversationModels(t.db, t.userId)).map((m) => [m.modelKey, m.conversations])).toEqual([['claude-sonnet-4-5', 1]]);
    // with both left out there is nothing to list
    await setSourceIncluded(t.db, t.userId, second.sourceId!, false, 'counted elsewhere');
    expect((await listConversations(t.db, filter())).rows).toEqual([]);
    expect(await listConversationModels(t.db, t.userId)).toEqual([]);
  });

  it('hands the session to the other source when the first source keeps other imports but has nothing left in the session', async () => {
    const { first, second } = await importTwice();
    // the first source has a second import, of another session
    const other = conv('s2', { dedupKey: 'claude_code:s2', kind: 'code_session', title: 'Another session', createdAt: '2025-06-03T10:00:00.000Z', updatedAt: '2025-06-03T10:00:00.000Z' });
    await importRecords(
      t.db, t.userId,
      { conversations: [other], usage: [usage('cc:s2:a', { ...zero, conversationKey: 'claude_code:s2', occurredAt: '2025-06-03T10:00:00.000Z', inputTokens: 400, outputTokens: 0 })] },
      { source: { kind: 'claude_code', label: 'Claude Code', externalRef: 'local' }, contentHash: 'h3', requestKeys: [3n] },
    );
    await deleteBatch(t.db, t.userId, first.batchId!);
    // each source is listed with the sessions it holds records of
    expect(await sessionRow()).toEqual({ source_id: second.sourceId, message_count: 2 });
    expect(await sources()).toEqual([
      ['Claude Code', 1, 400, 1],
      ['Claude Code (work laptop)', 1, 2_000, 1],
    ]);
  });
});
