import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { listConversations } from '@/analytics/conversations';
import { getModelBreakdown } from '@/analytics/models';
import { getOverview } from '@/analytics/overview';
import { getApiValue } from '@/analytics/value';
import { loadDemoDataset } from '@/import/demo/load';
import { createTestDb, type TestDb } from '../helpers/db';

const NOW = new Date('2026-11-10T12:00:00Z');
let t: TestDb;
const OUT: string[] = [];
beforeAll(async () => {
  t = await createTestDb('UTC');
  await loadDemoDataset(t.db, t.userId, 'UTC', NOW);
});
afterAll(async () => {
  writeFileSync('/tmp/claude-0/-home-user/bb0dfdd4-dd86-5a48-a206-6d561655db66/scratchpad/conv-work/explore4.txt', OUT.join('\n'));
  await t.close();
});

describe('timing', () => {
  it('prints', async () => {
    const filter = { userId: t.userId, timezone: 'UTC', basis: 'processed' as const };
    const time = async (label: string, fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      await fn();
      OUT.push(`${label}: ${Math.round(performance.now() - t0)} ms`);
    };
    const all = async (tag: string) => {
      await time(`${tag} list default`, () => listConversations(t.db, filter, { limit: 50 }));
      await time(`${tag} list sort created`, () => listConversations(t.db, filter, { limit: 50, sort: 'created' }));
      await time(`${tag} list plan pro`, () => listConversations(t.db, filter, { limit: 50, plan: 'pro' }));
      await time(`${tag} list unknown model`, () => listConversations(t.db, filter, { limit: 50, model: 'unknown' }));
      await time(`${tag} list range`, () => listConversations(t.db, filter, { limit: 50, from: '2026-01-01', to: '2026-06-30' }));
      await time(`${tag} overview`, () => getOverview(t.db, filter));
      await time(`${tag} breakdown`, () => getModelBreakdown(t.db, filter));
      await time(`${tag} value`, () => getApiValue(t.db, filter));
    };
    await all('before');
    await time('ANALYZE', () => t.db.exec('ANALYZE'));
    await all('after');
    await all('after2');
  });
});
