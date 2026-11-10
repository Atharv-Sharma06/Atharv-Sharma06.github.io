import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commitImport, importGeneration, loadKnownRequestKeys, previewImport } from '@/import/commit';
import { deleteAllData, deleteBatch, deleteSource } from '@/import/delete';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg, parsed, stage, usage } from '../helpers/staged';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const count = async (table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const facts = async () =>
  (
    await t.db.query<{ confidence: string; tokens: number; rows: number }>(
      `SELECT confidence::text, count(*)::int AS rows,
              sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens + replay_tokens)::bigint AS tokens
         FROM usage_facts GROUP BY confidence ORDER BY confidence`,
    )
  ).rows;

describe('import pipeline', () => {
  it('previews before committing and writes nothing until confirmed', async () => {
    await stage(t.db, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1), msg('a', 2), msg('a', 3)] });
    const preview = await previewImport(t.db, t.userId, parsed({ recordsSeen: 4 }));
    expect(preview.conversations).toEqual({ total: 1, new: 1, existing: 0 });
    expect(preview.messages).toMatchObject({ total: 4, new: 4, duplicate: 0, withoutModel: 4 });
    expect(preview.nothingNew).toBe(false);
    expect(preview.coverage.hasModel).toBe(false);
    expect(preview.coverage.hasExactUsage).toBe(false);
    // base units x 1.25 (claude3 factor), rounded per category like the usage_facts view:
    // 125 + (250 + 188) + 125 + (250 + 563) = 1501
    expect(preview.tokens).toEqual({ exact: 0, estimated: 1501 });
    expect(await count('conversations')).toBe(0);
    expect(await count('messages')).toBe(0);
  });

  it('importing the same file twice does not double count', async () => {
    const records = { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] };
    const first = await importRecords(t.db, t.userId, records);
    expect(first.result.inserted).toMatchObject({ conversations: 1, messages: 2 });
    const before = await facts();

    await stage(t.db, records);
    const preview = await previewImport(t.db, t.userId, parsed());
    expect(preview.previousImport?.batchId).toBe(first.result.batchId);
    expect(preview.messages).toMatchObject({ total: 2, new: 0, duplicate: 2 });
    expect(preview.nothingNew).toBe(true);

    const second = await commitImport(t.db, t.userId, parsed());
    expect(second.nothingNew).toBe(true);
    expect(second.batchId).toBeNull();
    expect(second.duplicates.messages).toBe(2);
    expect(await facts()).toEqual(before);
    expect(await count('import_batches')).toBe(1);
    expect(await count('messages')).toBe(2);
  });

  it('detects duplicate messages inside one file', async () => {
    const { result } = await importRecords(t.db, t.userId, {
      conversations: [conv('a')],
      messages: [msg('a', 0), msg('a', 1), msg('a', 1), msg('a', 0)],
    });
    expect(result.inserted.messages).toBe(2);
    expect(result.duplicates.messages).toBe(2);
    expect(await count('token_estimates')).toBe(2);
  });

  it('adds only the new messages when a conversation is exported again later', async () => {
    await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] });
    const later = await importRecords(
      t.db,
      t.userId,
      {
        conversations: [conv('a', { title: 'Renamed', updatedAt: '2025-02-01T00:00:00.000Z' })],
        messages: [msg('a', 0), msg('a', 1), msg('a', 2), msg('a', 3)],
      },
      { contentHash: 'hash-2' },
    );
    expect(later.preview.conversations).toEqual({ total: 1, new: 0, existing: 1 });
    expect(later.result.inserted).toMatchObject({ conversations: 0, messages: 2 });
    const c = (await t.db.query<Record<string, unknown>>(`SELECT title, message_count, user_message_count, assistant_message_count, updated_at FROM conversations`)).rows[0];
    expect(c).toMatchObject({ title: 'Renamed', message_count: 4, user_message_count: 2, assistant_message_count: 2 });
    expect((c.updated_at as Date).toISOString()).toBe('2025-02-01T00:00:00.000Z');
    expect(await count('import_batches')).toBe(2);
  });

  it('keeps exact and estimated usage apart', async () => {
    await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] });
    await importRecords(
      t.db,
      t.userId,
      { usage: [usage('cc:1'), usage('cc:2', { occurredAt: '2025-06-01T00:15:00.000Z' })] },
      { source: { kind: 'claude_code', label: 'Claude Code', externalRef: 'laptop' }, contentHash: 'hash-cc' },
    );
    expect(await count('usage_records')).toBe(2);
    expect(await count('token_estimates')).toBe(2);
    const byConfidence = Object.fromEntries((await facts()).map((r) => [r.confidence, r]));
    expect(byConfidence.exact).toMatchObject({ rows: 2, tokens: 49000 });
    // base units x 1.25, rounded per category: 125 + (250 + 188). The two messages are one minute apart,
    // so the view serves them as a single 15-minute bucket.
    expect(byConfidence.estimated).toMatchObject({ rows: 1, tokens: 563 });
  });

  it('stores unknown model identifiers verbatim and never invents one', async () => {
    await importRecords(
      t.db,
      t.userId,
      {
        models: [{ key: 'claude-opus-9', displayName: 'claude-opus-9-20300101', family: 'opus', tokenizerFamily: 'unknown' }],
        usage: [usage('u1', { modelKey: 'claude-opus-9' }), usage('u2', { modelKey: null })],
      },
      { source: { kind: 'generic_json', label: 'Custom', externalRef: '' } },
    );
    const rows = (await t.db.query<{ model_key: string | null; is_builtin: boolean | null }>(
      `SELECT m.model_key, m.is_builtin FROM usage_records u LEFT JOIN model_catalog m ON m.id = u.model_id ORDER BY u.dedup_key`,
    )).rows;
    expect(rows).toEqual([{ model_key: 'claude-opus-9', is_builtin: false }, { model_key: null, is_builtin: null }]);
  });

  it('replaces a restated time range instead of adding to it', async () => {
    const source = { kind: 'api_usage_report' as const, label: 'Anthropic Console', externalRef: '' };
    const day = (d: number, tokens: number) =>
      usage(`api:${d}`, { occurredAt: `2025-03-0${d}T00:00:00.000Z`, bucketSeconds: 86400, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0 });
    await importRecords(t.db, t.userId, { usage: [day(1, 100), day(2, 200), day(3, 300)] }, {
      source, contentHash: 'r1', replaceRange: { start: '2025-03-01T00:00:00.000Z', end: '2025-03-04T00:00:00.000Z' },
    });
    // a later, revised report for days 2-4 with hourly keys (different dedup keys)
    const revised = [2, 3, 4].map((d) => usage(`api-h:${d}`, { occurredAt: `2025-03-0${d}T00:00:00.000Z`, bucketSeconds: 3600, inputTokens: 1000 * d, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0 }));
    await stage(t.db, { usage: revised });
    const meta = parsed({ source, contentHash: 'r2', replaceRange: { start: '2025-03-02T00:00:00.000Z', end: '2025-03-05T00:00:00.000Z' } });
    const preview = await previewImport(t.db, t.userId, meta);
    expect(preview.replaced).toEqual({ usageRows: 2, costRows: 0, tokens: 500 });
    const result = await commitImport(t.db, t.userId, meta);
    expect(result.replaced.usageRows).toBe(2);
    const total = (await t.db.query<{ s: number }>(`SELECT sum(input_tokens)::bigint AS s FROM usage_records`)).rows[0].s;
    expect(total).toBe(100 + 2000 + 3000 + 4000);
  });

  it('persists request hashes and rejects a commit prepared before another import', async () => {
    const source = { kind: 'claude_code' as const, label: 'Claude Code', externalRef: 'laptop' };
    const generation = await importGeneration(t.db, t.userId);
    await importRecords(t.db, t.userId, { usage: [usage('cc:a')] }, { source, contentHash: 'c1', requestKeys: [11n, -9223372036854775808n, 9223372036854775807n] }, { generation });
    const known = await loadKnownRequestKeys(t.db, t.userId);
    expect([...known].sort()).toEqual([11n, -9223372036854775808n, 9223372036854775807n].sort());

    await stage(t.db, { usage: [usage('cc:b')] });
    await expect(
      commitImport(t.db, t.userId, parsed({ source, contentHash: 'c2', requestKeys: [12n] }), { generation }),
    ).rejects.toThrow(/Run the import again/);
    expect(await count('usage_records')).toBe(1);
  });

  it('rolls the whole import back when any part fails', async () => {
    await stage(t.db, {
      conversations: [conv('a')],
      messages: [msg('a', 0), msg('a', 1)],
      usage: [usage('bad', { inputTokens: -5 })], // violates usage_records_non_negative
    });
    await expect(commitImport(t.db, t.userId, parsed())).rejects.toThrow(/usage_records_non_negative/);
    expect(await count('data_sources')).toBe(0);
    expect(await count('import_batches')).toBe(0);
    expect(await count('conversations')).toBe(0);
    expect(await count('messages')).toBe(0);
  });

  it('never mixes the synthetic demo dataset with real data', async () => {
    const demo = { kind: 'claude_export' as const, label: 'Demo', externalRef: 'demo', isSynthetic: true };
    await importRecords(t.db, t.userId, { conversations: [conv('demo')], messages: [msg('demo', 0), msg('demo', 1)] }, { source: demo, contentHash: 'd' });
    await t.db.query(`INSERT INTO subscription_periods (user_id, plan_key, start_date, is_synthetic) VALUES ($1, 'pro', '2025-01-01', true)`, [t.userId]);

    const real = await importRecords(t.db, t.userId, { conversations: [conv('real')], messages: [msg('real', 0)] }, { contentHash: 'r' });
    expect(real.preview.willRemoveDemoData).toBe(true);
    expect(real.result.removedDemoData).toBe(true);
    expect((await t.db.query<{ external_id: string }>(`SELECT external_id FROM conversations`)).rows).toEqual([{ external_id: 'real' }]);
    expect(await count('subscription_periods')).toBe(0);

    await stage(t.db, { conversations: [conv('demo')], messages: [msg('demo', 0)] });
    await expect(commitImport(t.db, t.userId, parsed({ source: demo, contentHash: 'd2' }))).rejects.toThrow(/empty workspace/);
  });
});

describe('data deletion', () => {
  it('deleting an import removes exactly what it contributed', async () => {
    const first = await importRecords(t.db, t.userId, { conversations: [conv('a'), conv('b')], messages: [msg('a', 0), msg('a', 1), msg('b', 0)] });
    const second = await importRecords(
      t.db, t.userId,
      { conversations: [conv('a'), conv('c')], messages: [msg('a', 0), msg('a', 1), msg('a', 2), msg('c', 0)] },
      { contentHash: 'hash-2' },
    );
    const res = await deleteBatch(t.db, t.userId, second.result.batchId!);
    expect(res).toEqual({ deleted: true, conversationsRemoved: 1 }); // conversation c had nothing else
    expect((await t.db.query<{ external_id: string; message_count: number }>(`SELECT external_id, message_count FROM conversations ORDER BY 1`)).rows).toEqual([
      { external_id: 'a', message_count: 2 },
      { external_id: 'b', message_count: 1 },
    ]);
    expect(await count('token_estimates')).toBe(3);

    await deleteBatch(t.db, t.userId, first.result.batchId!);
    for (const table of ['conversations', 'messages', 'token_estimates', 'import_batches', 'data_sources']) expect(await count(table)).toBe(0);
  });

  it('deleting a source cascades to everything imported from it', async () => {
    const a = await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] });
    await importRecords(t.db, t.userId, { usage: [usage('cc:1')] }, { source: { kind: 'claude_code', label: 'Claude Code', externalRef: 'x' }, contentHash: 'cc' });
    const res = await deleteSource(t.db, t.userId, a.result.sourceId!);
    expect(res.deleted).toBe(true);
    expect(await count('messages')).toBe(0);
    expect(await count('token_estimates')).toBe(0);
    expect(await count('usage_records')).toBe(1);
  });

  it('delete all removes every imported row but keeps the catalog and, by default, subscriptions', async () => {
    await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0)] });
    await importRecords(
      t.db, t.userId,
      { models: [{ key: 'custom-model', displayName: 'custom-model', family: 'other', tokenizerFamily: 'unknown' }], usage: [usage('g1', { modelKey: 'custom-model' })] },
      { source: { kind: 'generic_json', label: 'Custom', externalRef: '' }, contentHash: 'g' },
    );
    await t.db.query(`INSERT INTO subscription_periods (user_id, plan_key, start_date) VALUES ($1, 'pro', '2025-01-01')`, [t.userId]);
    const builtin = await count('model_catalog WHERE is_builtin');

    await deleteAllData(t.db, t.userId);
    for (const table of ['data_sources', 'import_batches', 'conversations', 'messages', 'token_estimates', 'usage_records']) expect(await count(table)).toBe(0);
    expect(await count('model_catalog')).toBe(builtin);
    expect(await count('subscription_periods')).toBe(1);
    expect(await count('pricing_history')).toBeGreaterThan(0);

    await deleteAllData(t.db, t.userId, { subscriptions: true });
    expect(await count('subscription_periods')).toBe(0);
  });
});
