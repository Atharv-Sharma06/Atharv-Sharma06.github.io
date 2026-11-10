import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listConversations } from '@/analytics/conversations';
import { ensureStatistics } from '@/db/maintenance';
import { deleteAllData, deleteBatch } from '@/import/delete';
import { loadDemoDataset } from '@/import/demo/load';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg } from '../helpers/staged';

/**
 * The browser database has no autovacuum, so the app has to keep the planner's
 * statistics current itself. Without them the conversation list on the demo data took
 * seconds instead of milliseconds.
 */
describe('planner statistics', () => {
  let t: TestDb;
  const estimate = async (table: string) =>
    (await t.db.query<{ n: number }>(`SELECT reltuples::float8 AS n FROM pg_class WHERE oid = $1::regclass`, [table])).rows[0].n;
  const count = async (table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

  beforeAll(async () => {
    t = await createTestDb('UTC');
  });
  afterAll(() => t.close());

  it('are refreshed by an import, so the planner knows the tables right away', async () => {
    await loadDemoDataset(t.db, t.userId, 'UTC', new Date('2026-11-10T12:00:00Z'));
    for (const table of ['conversations', 'messages', 'usage_records', 'estimate_buckets']) {
      expect(await estimate(table), table).toBe(await count(table));
    }
  });

  it('keep the conversation list fast on the demo data', async () => {
    const started = performance.now();
    const page = await listConversations(t.db, { userId: t.userId, timezone: 'UTC', basis: 'processed' });
    expect(page.rows).toHaveLength(50);
    // about 15 ms with statistics, about 3,000 ms without; the bound leaves room for a slow machine
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('are refreshed by deletions', async () => {
    await deleteAllData(t.db, t.userId);
    expect(await estimate('conversations')).toBe(0);
    const first = await importRecords(t.db, t.userId, { conversations: [conv('a'), conv('b')], messages: [msg('a', 0), msg('b', 0)] });
    expect(await estimate('conversations')).toBe(2);
    await deleteBatch(t.db, t.userId, first.result.batchId!);
    expect(await estimate('conversations')).toBe(0);
  });

  it('are rebuilt when a database arrives without them, and left alone when they are current', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `c${i}`);
    await importRecords(t.db, t.userId, { conversations: ids.map((id) => conv(id)), messages: ids.map((id) => msg(id, 0)) }, { contentHash: 'many' });
    expect(await ensureStatistics(t.db)).toBe(false);
    // what a database restored from an old backup looks like to the planner
    await t.db.query(`UPDATE pg_class SET reltuples = -1 WHERE oid = 'conversations'::regclass`);
    expect(await ensureStatistics(t.db)).toBe(true);
    expect(await estimate('conversations')).toBe(120);
    expect(await ensureStatistics(t.db)).toBe(false);
  });
});
