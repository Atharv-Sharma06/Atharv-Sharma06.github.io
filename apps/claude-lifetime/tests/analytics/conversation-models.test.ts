import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { listConversationModels, listConversations } from '@/analytics/conversations';
import { getModelBreakdown } from '@/analytics/models';
import { setSourceIncluded } from '@/analytics/settings';
import { createTestDb, type TestDb } from '../helpers/db';
import { loadDataset } from '../helpers/dataset';

let t: TestDb;
let ids: Awaited<ReturnType<typeof loadDataset>>;
const filter = (): AnalyticsFilter => ({ userId: t.userId, timezone: 'America/New_York', basis: 'processed' });

beforeAll(async () => {
  t = await createTestDb('America/New_York');
  ids = await loadDataset(t);
});
afterAll(() => t.close());

describe('models that conversations are filed under', () => {
  it('lists the model each conversation names, with an explicit entry for no model', async () => {
    expect(await listConversationModels(t.db, t.userId)).toEqual([
      { modelKey: null, displayName: 'Unknown model', conversations: 2 },
      { modelKey: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', conversations: 1 },
    ]);
  });

  it('offers exactly the choices the explorer filter can match', async () => {
    const options = await listConversationModels(t.db, t.userId);
    for (const option of options) {
      const page = await listConversations(t.db, filter(), { model: option.modelKey ?? 'unknown' });
      expect(page.total).toBe(option.conversations);
    }
    // Models that only assisted inside the session have usage but are no conversation's model.
    const breakdown = await getModelBreakdown(t.db, filter());
    const helpers = breakdown.filter((m) => m.modelKey !== null && !options.some((o) => o.modelKey === m.modelKey));
    expect(helpers.map((m) => m.modelKey).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-4-5', 'claude-opus-9']);
    for (const helper of helpers) {
      expect((await listConversations(t.db, filter(), { model: helper.modelKey })).total).toBe(0);
    }
  });

  it('leaves out sources the user excluded from totals', async () => {
    await setSourceIncluded(t.db, t.userId, ids.code.result.sourceId!, false, 'test');
    expect(await listConversationModels(t.db, t.userId)).toEqual([{ modelKey: null, displayName: 'Unknown model', conversations: 2 }]);
    await setSourceIncluded(t.db, t.userId, ids.code.result.sourceId!, true);
    expect(await listConversationModels(t.db, t.userId)).toHaveLength(2);
  });
});
