import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getBeforeAfter, getBeforeAfterConversationUsage, savePeriod } from '@/analytics/subscriptions';
import { createTestDb, type TestDb } from '../helpers/db';
import { loadDataset } from '../helpers/dataset';
import { conv, importRecords, usage } from '../helpers/staged';

const TZ = 'America/New_York';
let t: TestDb;
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: TZ, basis: 'processed', ...over });

beforeAll(async () => {
  t = await createTestDb(TZ);
  // See tests/helpers/dataset.ts: chat "a" (10 Jan, 475 estimated), Claude Code session "s1"
  // (1–2 Feb, 14,803,500 exact), chat "b" (8 Mar New York time, 150 estimated) and an API
  // usage report for 9 Mar (110,000 exact) that belongs to no conversation.
  await loadDataset(t);
});
afterAll(() => t.close());

describe('usage that belongs to conversations, before vs. after the first paid period', () => {
  it('has nothing to split while no paid period is entered', async () => {
    expect(await getBeforeAfterConversationUsage(t.db, filter())).toBeNull();
    await savePeriod(t.db, t.userId, TZ, { planKey: 'free', startDate: '2025-01-01', lastDate: '2025-01-31' });
    expect(await getBeforeAfterConversationUsage(t.db, filter())).toBeNull();
  });

  it('counts chats and Claude Code sessions with their own tokens, and leaves out usage without a conversation', async () => {
    await savePeriod(t.db, t.userId, TZ, { planKey: 'pro', startDate: '2025-02-01' });
    const usageByConversation = await getBeforeAfterConversationUsage(t.db, filter());
    expect(usageByConversation).toEqual({
      before: { conversations: 1, tokens: 475, exact: 0, estimated: 475 },
      after: { conversations: 2, tokens: 14_803_500 + 150, exact: 14_803_500, estimated: 150 },
    });
    // The side totals also hold the API report, which no conversation accounts for.
    const sides = await getBeforeAfter(t.db, filter());
    expect(sides.after!.tokens - usageByConversation!.after.tokens).toBe(110_000);
    expect(sides.before!.tokens).toBe(usageByConversation!.before.tokens);
  });

  it('follows the token basis', async () => {
    expect(await getBeforeAfterConversationUsage(t.db, filter({ basis: 'new' }))).toEqual({
      before: { conversations: 1, tokens: 375, exact: 0, estimated: 375 },
      after: { conversations: 2, tokens: 4_803_500 + 150, exact: 4_803_500, estimated: 150 },
    });
  });

  it('follows the date range of the filter', async () => {
    // From 2 Feb only the last two rows of the session (1,500 + 2,000) and chat "b" remain.
    expect(await getBeforeAfterConversationUsage(t.db, filter({ from: '2025-02-02' }))).toEqual({
      before: { conversations: 0, tokens: 0, exact: 0, estimated: 0 },
      after: { conversations: 2, tokens: 3_500 + 150, exact: 3_500, estimated: 150 },
    });
  });

  it('does not take the container of a generic import for a conversation', async () => {
    await importRecords(
      t.db,
      t.userId,
      {
        conversations: [conv('bucket', { dedupKey: 'generic:sheet:bucket', kind: 'usage_bucket', title: 'Team usage', createdAt: '2025-03-01T12:00:00.000Z', updatedAt: '2025-03-01T12:00:00.000Z' })],
        usage: [usage('generic:1', { conversationKey: 'generic:sheet:bucket', occurredAt: '2025-03-01T12:00:00.000Z', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWrite5mTokens: 0 })],
      },
      { source: { kind: 'generic_csv', label: 'Spreadsheet', externalRef: 'sheet' }, contentHash: 'generic' },
    );
    const sides = await getBeforeAfter(t.db, filter());
    expect(sides.after!.tokens).toBe(14_913_650 + 1_500);
    const usageByConversation = await getBeforeAfterConversationUsage(t.db, filter());
    expect(usageByConversation!.after).toEqual({ conversations: 2, tokens: 14_803_650, exact: 14_803_500, estimated: 150 });
  });
});
