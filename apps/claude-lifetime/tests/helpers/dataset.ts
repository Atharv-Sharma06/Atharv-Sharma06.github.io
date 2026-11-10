import type { TestDb } from './db';
import { conv, importRecords, msg, usage } from './staged';

/**
 * A small dataset with hand-computable totals, used by the analytics tests.
 *
 * Estimated (claude.ai export, factor 1.25 for these 2025 dates):
 *   conversation a, 10 Jan 2025: user 100 base -> 125; reply 200 base -> 250, re-read 80 -> 100 (40 -> 50 cacheable)
 *   conversation b,  9 Mar 2025 03:30 UTC (= 8 Mar 22:30 in New York): user 40 -> 50; reply 80 -> 100
 * Exact (Claude Code session s1):
 *   u1 Sonnet 4.5,  1 Feb 10:00 UTC: in 1,000,000 out 200,000 cache read 10,000,000 write5m 2,000,000 write1h 500,000, 5 web searches
 *   u2 Haiku 5.5 (long context), 1 Feb 10:15 UTC: in 1,000,000 out 100,000
 *   u3 "claude-opus-9" (not in the catalog), 2 Feb: in 1,000 out 500
 *   u4 no model, 2 Feb: in 2,000
 * Exact (API usage report, one-day bucket for 9 Mar 2025 UTC): Opus 4.5 in 100,000 out 10,000
 */
export const EXPECTED = {
  processed: { estimated: 625, exact: 14_913_500, total: 14_914_125 },
  fresh: { estimated: 525, exact: 4_913_500, total: 4_914_025 },
};

export async function loadDataset(t: TestDb) {
  const at = (iso: string) => ({ createdAt: iso, occurredAt: iso });
  const chat = await importRecords(
    t.db,
    t.userId,
    {
      conversations: [
        conv('a', { createdAt: '2025-01-10T15:00:00.000Z', updatedAt: '2025-01-10T15:01:00.000Z' }),
        conv('b', { title: 'Late night question', createdAt: '2025-03-09T03:30:00.000Z', updatedAt: '2025-03-09T03:31:00.000Z' }),
      ],
      messages: [
        msg('a', 0, { ...at('2025-01-10T15:00:00.000Z'), inputBase: 100, outputBase: 0, replayBase: 0, requestCount: 0 }),
        msg('a', 1, { ...at('2025-01-10T15:01:00.000Z'), inputBase: 0, outputBase: 200, replayBase: 80, replayCachedBase: 40, requestCount: 1, limitationFlags: 3 | 4 }),
        msg('b', 0, { ...at('2025-03-09T03:30:00.000Z'), inputBase: 40, outputBase: 0, replayBase: 0, requestCount: 0 }),
        msg('b', 1, { ...at('2025-03-09T03:31:00.000Z'), inputBase: 0, outputBase: 80, replayBase: 0, requestCount: 1 }),
      ],
    },
    { contentHash: 'chat' },
  );

  const zero = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requestCount: 0, userMessageCount: 0, assistantMessageCount: 0 };
  const code = await importRecords(
    t.db,
    t.userId,
    {
      models: [{ key: 'claude-opus-9', displayName: 'claude-opus-9', family: 'opus', tokenizerFamily: 'unknown' }],
      conversations: [conv('s1', { dedupKey: 'claude_code:s1', kind: 'code_session', title: 'Refactor importer', projectLabel: '/home/alex/demo', modelKey: 'claude-sonnet-4-5', createdAt: '2025-02-01T10:00:00.000Z', updatedAt: '2025-02-02T11:00:00.000Z' })],
      usage: [
        usage('cc:u1', { conversationKey: 'claude_code:s1', modelKey: 'claude-sonnet-4-5', occurredAt: '2025-02-01T10:00:00.000Z', inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 10_000_000, cacheWrite5mTokens: 2_000_000, cacheWrite1hTokens: 500_000, requestCount: 10, userMessageCount: 2, assistantMessageCount: 3, webSearchRequests: 5 }),
        usage('cc:u2', { ...zero, conversationKey: 'claude_code:s1', modelKey: 'claude-haiku-5-5', priceTier: 'long_context', occurredAt: '2025-02-01T10:15:00.000Z', inputTokens: 1_000_000, outputTokens: 100_000, requestCount: 2 }),
        usage('cc:u3', { ...zero, conversationKey: 'claude_code:s1', modelKey: 'claude-opus-9', occurredAt: '2025-02-02T10:00:00.000Z', inputTokens: 1000, outputTokens: 500, requestCount: 1 }),
        usage('cc:u4', { ...zero, conversationKey: 'claude_code:s1', modelKey: null, occurredAt: '2025-02-02T11:00:00.000Z', inputTokens: 2000, outputTokens: 0, requestCount: 1 }),
      ],
    },
    { source: { kind: 'claude_code', label: 'Claude Code (this computer)', externalRef: 'local' }, contentHash: 'code' },
  );

  const api = await importRecords(
    t.db,
    t.userId,
    { usage: [usage('api:d1', { ...zero, modelKey: 'claude-opus-4-5', occurredAt: '2025-03-09T00:00:00.000Z', bucketSeconds: 86_400, inputTokens: 100_000, outputTokens: 10_000 })] },
    { source: { kind: 'api_usage_report', label: 'Anthropic API usage report', externalRef: '' }, contentHash: 'api' },
  );

  return { chat, code, api };
}
