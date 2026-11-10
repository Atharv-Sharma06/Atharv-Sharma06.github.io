import { afterAll, beforeAll, describe, it } from 'vitest';
import { listConversations, getConversationDetail } from '@/analytics/conversations';
import { getModelBreakdown } from '@/analytics/models';
import { getOverview, getTimeSeries } from '@/analytics/overview';
import { listPeriods } from '@/analytics/subscriptions';
import { getApiValue } from '@/analytics/value';
import { loadDemoDataset } from '@/import/demo/load';
import { createTestDb, type TestDb } from '../helpers/db';

import { writeFileSync } from 'node:fs';
const OUT: string[] = [];
const NOW = new Date('2026-11-10T12:00:00Z');
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb('UTC');
  const t0 = Date.now();
  await loadDemoDataset(t.db, t.userId, 'UTC', NOW);
  OUT.push(['load ms', Date.now() - t0].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
});
afterAll(async () => { writeFileSync('/tmp/claude-0/-home-user/bb0dfdd4-dd86-5a48-a206-6d561655db66/scratchpad/conv-work/explore.txt', OUT.join('\n')); await t.close(); });

describe('explore', () => {
  it('prints', async () => {
    const filter = { userId: t.userId, timezone: 'UTC', basis: 'processed' as const };
    const models = await getModelBreakdown(t.db, filter);
    OUT.push([JSON.stringify(models, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const value = await getApiValue(t.db, filter);
    OUT.push([JSON.stringify(value, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const page = await listConversations(t.db, filter, { limit: 5 });
    OUT.push([page.total, JSON.stringify(page.rows, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const chats = await listConversations(t.db, filter, { limit: 3, sourceKind: 'claude_export' });
    OUT.push([chats.total, JSON.stringify(chats.rows, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const d = await getConversationDetail(t.db, filter, chats.rows[0].id);
    OUT.push([JSON.stringify({ ...d, messages: d!.messages.slice(0, 8) }, null, 1), d!.messages.length].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const o = await getOverview(t.db, { ...filter, conversationId: chats.rows[0].id });
    OUT.push([JSON.stringify(o, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const v = await getApiValue(t.db, { ...filter, conversationId: chats.rows[0].id });
    OUT.push([JSON.stringify(v, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const cd = await getConversationDetail(t.db, filter, page.rows[0].id);
    OUT.push([JSON.stringify(cd, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const co = await getOverview(t.db, { ...filter, conversationId: page.rows[0].id });
    OUT.push([JSON.stringify(co, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const cv = await getApiValue(t.db, { ...filter, conversationId: page.rows[0].id });
    OUT.push([JSON.stringify(cv, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const ts = await getTimeSeries(t.db, { ...filter, conversationId: page.rows[0].id }, 'day');
    OUT.push([JSON.stringify(ts, null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    OUT.push([JSON.stringify(await listPeriods(t.db, t.userId, 'UTC'), null, 1)].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  });
});
