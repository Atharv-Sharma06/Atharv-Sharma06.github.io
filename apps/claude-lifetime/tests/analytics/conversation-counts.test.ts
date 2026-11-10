import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getModelBreakdown } from '@/analytics/models';
import { getOverview, getTimeSeries } from '@/analytics/overview';
import { getBeforeAfter } from '@/analytics/subscriptions';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg, usage } from '../helpers/staged';

/**
 * Rows of API reports and generic imports can hang off a container (kind usage_bucket)
 * that groups them. A container is not a conversation, and no figure may count it as one.
 */
describe('conversation counts', () => {
  let t: TestDb;
  const filter = () => ({ userId: t.userId, timezone: 'UTC', basis: 'processed' as const });

  beforeAll(async () => {
    t = await createTestDb('UTC');
    await importRecords(t.db, t.userId, {
      conversations: [conv('chat-1', { createdAt: '2025-06-01T09:00:00.000Z', updatedAt: '2025-06-01T09:05:00.000Z' })],
      messages: [
        msg('chat-1', 0, { createdAt: '2025-06-01T09:00:00.000Z', occurredAt: '2025-06-01T09:00:00.000Z' }),
        msg('chat-1', 1, { createdAt: '2025-06-01T09:01:00.000Z', occurredAt: '2025-06-01T09:01:00.000Z' }),
      ],
    });
    await importRecords(
      t.db,
      t.userId,
      {
        conversations: [
          conv('bucket-1', { dedupKey: 'generic:proxy:bucket-1', kind: 'usage_bucket', title: 'Proxy logs', createdAt: '2025-06-01T10:00:00.000Z', updatedAt: '2025-06-01T10:00:00.000Z' }),
          conv('session-1', { dedupKey: 'claude_code:session-1', kind: 'code_session', createdAt: '2025-06-01T11:00:00.000Z', updatedAt: '2025-06-01T11:00:00.000Z' }),
        ],
        usage: [
          usage('g:1', { conversationKey: 'generic:proxy:bucket-1', occurredAt: '2025-06-01T10:00:00.000Z' }),
          usage('cc:1', { conversationKey: 'claude_code:session-1', occurredAt: '2025-06-01T11:00:00.000Z' }),
          usage('api:1', { conversationKey: null, occurredAt: '2025-06-01T00:00:00.000Z', bucketSeconds: 86_400 }),
        ],
      },
      { source: { kind: 'generic_csv', label: 'Mixed', externalRef: 'proxy' }, contentHash: 'mixed' },
    );
    await t.db.query(`INSERT INTO subscription_periods (user_id, plan_key, start_date) VALUES ($1, 'pro', '2025-05-01')`, [t.userId]);
  });
  afterAll(() => t.close());

  it('the overview counts the chat and the session, and so does its busiest day', async () => {
    const o = await getOverview(t.db, filter());
    expect(o.conversations).toEqual({ total: 2, chats: 1, codeSessions: 1 });
    expect(o.mostActiveDay).toMatchObject({ day: '2025-06-01', conversationsActive: 2 });
  });

  it('time series, the model breakdown and the subscription comparison agree with it', async () => {
    const series = await getTimeSeries(t.db, filter(), 'day');
    expect(series.map((p) => p.conversations)).toEqual([2]);

    const models = await getModelBreakdown(t.db, filter());
    // the session runs on the helper's default model; the chat has no model
    expect(models.find((m) => m.modelKey === 'claude-sonnet-4-5')!.conversations).toBe(1);
    expect(models.find((m) => m.modelKey === null)!.conversations).toBe(1);

    const ba = await getBeforeAfter(t.db, filter());
    expect(ba.after!.conversations).toBe(2);
    // every token is still counted, including those of the container and of the report
    expect(ba.after!.tokens).toBe((await getOverview(t.db, filter())).tokens.total);
  });
});
