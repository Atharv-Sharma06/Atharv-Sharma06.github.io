import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCoverage } from '@/analytics/coverage';
import { getOverview } from '@/analytics/overview';
import { getBeforeAfter, listPeriods } from '@/analytics/subscriptions';
import { getApiValue } from '@/analytics/value';
import { importRecords, conv, msg } from '../helpers/staged';
import { createTestDb, type TestDb } from '../helpers/db';
import { deleteAllData } from '@/import/delete';
import { buildDemoDataset } from '@/import/demo/generate';
import { loadDemoDataset } from '@/import/demo/load';
import { collectingSink } from '../helpers/sink';

const NOW = new Date('2026-11-10T12:00:00Z');

describe('synthetic demo dataset', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb('UTC');
  });
  afterAll(async () => {
    await t.close();
  });

  it('is deterministic for a given date and seed', async () => {
    const a = collectingSink();
    const b = collectingSink();
    for (const part of buildDemoDataset(NOW).parts) await part.write(a.sink);
    for (const part of buildDemoDataset(NOW).parts) await part.write(b.sink);
    expect(a.out.messages.length).toBeGreaterThan(5000);
    expect(a.out.usage.length).toBeGreaterThan(1000);
    expect(a.out.costs.length).toBeGreaterThan(50);
    expect(JSON.stringify(a.out.messages.slice(0, 200))).toBe(JSON.stringify(b.out.messages.slice(0, 200)));
    expect(a.out.usage.length).toBe(b.out.usage.length);
    // nothing is dated in the future, and every chat estimate records that the model is unknown
    const latest = Math.max(...a.out.messages.map((m) => Date.parse(m.occurredAt)));
    expect(latest).toBeLessThanOrEqual(NOW.getTime());
    expect(a.out.messages.every((m) => m.modelKey === null && (m.limitationFlags & 1) === 1)).toBe(true);
  });

  it('loads into an empty workspace, flagged as synthetic everywhere', async () => {
    const res = await loadDemoDataset(t.db, t.userId, 'UTC', NOW);
    expect(res.conversations).toBeGreaterThan(500);
    expect(res.periodsAdded).toBe(true);

    const coverage = await getCoverage(t.db, t.userId, 'UTC');
    expect(coverage.hasSyntheticData).toBe(true);
    expect(coverage.sources.length).toBe(4);
    expect(coverage.sources.every((s) => s.isSynthetic)).toBe(true);
    expect(coverage.exactTokens).toBeGreaterThan(0);
    expect(coverage.estimatedTokens).toBeGreaterThan(0);
    expect(coverage.gaps.length).toBeGreaterThan(0);

    const periods = await listPeriods(t.db, t.userId, 'UTC');
    expect(periods.map((p) => p.planKey)).toEqual(['free', 'pro', 'max_5x']);
    expect(periods.every((p) => p.isSynthetic)).toBe(true);

    const filter = { userId: t.userId, timezone: 'UTC', basis: 'processed' as const };
    const overview = await getOverview(t.db, filter);
    expect(overview.tokens.total).toBe(overview.tokens.exact + overview.tokens.estimated);
    expect(overview.conversations.chats).toBeGreaterThan(0);
    expect(overview.conversations.codeSessions).toBeGreaterThan(0);

    const ba = await getBeforeAfter(t.db, filter);
    expect(ba.split?.planKey).toBe('pro');
    expect(ba.before!.tokens).toBeGreaterThan(0);
    expect(ba.after!.tokens).toBeGreaterThan(ba.before!.tokens);

    const value = await getApiValue(t.db, filter);
    expect(Number(value.exactUsd)).toBeGreaterThan(0);
    // chat estimates have no model, so they stay unpriced rather than priced on a guess
    expect(value.unpricedTokens).toBeGreaterThan(0);
  });

  it('refuses to load next to existing data', async () => {
    await expect(loadDemoDataset(t.db, t.userId, 'UTC', NOW)).rejects.toMatchObject({ code: 'demo_requires_empty_workspace' });
  });

  it('is removed completely when real data is imported', async () => {
    await importRecords(t.db, t.userId, { conversations: [conv('real-1')], messages: [msg('real-1', 0)] });
    const coverage = await getCoverage(t.db, t.userId, 'UTC');
    expect(coverage.hasSyntheticData).toBe(false);
    expect(coverage.sources.length).toBe(1);
    expect(await listPeriods(t.db, t.userId, 'UTC')).toEqual([]);
  });

  it('keeps subscription periods the user entered', async () => {
    await deleteAllData(t.db, t.userId);
    await t.db.query(
      `INSERT INTO subscription_periods (user_id, plan_key, started_at) VALUES ($1, 'pro', '2025-01-01T00:00:00Z')`,
      [t.userId],
    );
    const res = await loadDemoDataset(t.db, t.userId, 'UTC', NOW);
    expect(res.periodsAdded).toBe(false);
    const periods = await listPeriods(t.db, t.userId, 'UTC');
    expect(periods.length).toBe(1);
    expect(periods[0].isSynthetic).toBe(false);
  });
});
