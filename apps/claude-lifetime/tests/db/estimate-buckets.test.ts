import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTimeSeries } from '@/analytics/overview';
import { deleteBatch } from '@/import/delete';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg } from '../helpers/staged';

/**
 * estimate_buckets is a derived copy of token_estimates that the analytics read for
 * speed. These tests pin down the one property that matters: every figure computed
 * from the buckets equals the figure computed from the per-message rows.
 */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb('UTC');
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const at = (iso: string) => ({ createdAt: iso, occurredAt: iso });

/** Totals per conversation and local day, straight from the per-message rows. */
const fromMessages = async (tz: string) =>
  (
    await t.db.query<Record<string, unknown>>(
      `SELECT e.conversation_id, (e.occurred_at AT TIME ZONE $1::text)::date::text AS day,
              sum(round(e.input_base * m.central_factor))::int AS input,
              sum(round(e.output_base * m.central_factor))::int AS output,
              sum(round(e.replay_base * m.central_factor))::int AS replay,
              sum(round(e.replay_cached_base * m.central_factor))::int AS replay_cached,
              sum(e.request_count)::int AS requests,
              count(*) FILTER (WHERE e.role = 'user')::int AS user_messages,
              count(*) FILTER (WHERE e.role = 'assistant')::int AS assistant_messages
         FROM token_estimates e JOIN estimation_methods m ON m.id = e.method_id
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [tz],
    )
  ).rows;

/** The same totals as the analytics see them. */
const fromFacts = async (tz: string) =>
  (
    await t.db.query<Record<string, unknown>>(
      `SELECT f.conversation_id, (f.occurred_at AT TIME ZONE $1::text)::date::text AS day,
              sum(f.input_tokens)::int AS input, sum(f.output_tokens)::int AS output,
              sum(f.replay_tokens)::int AS replay, sum(f.replay_cached_tokens)::int AS replay_cached,
              sum(f.request_count)::int AS requests,
              sum(f.user_message_count)::int AS user_messages, sum(f.assistant_message_count)::int AS assistant_messages
         FROM usage_facts f WHERE f.confidence = 'estimated'
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [tz],
    )
  ).rows;

const ZONES = ['UTC', 'America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Adelaide', 'Pacific/Chatham'];

describe('estimate buckets', () => {
  it('give the same totals as the per-message estimates, in every timezone, including quarter-hour offsets', async () => {
    // Messages placed around the points where a local day turns over in zones with :30 and :45 offsets.
    const times = [
      '2025-03-01T18:14:59.000Z', '2025-03-01T18:15:00.000Z', '2025-03-01T18:29:59.999Z', '2025-03-01T18:30:00.000Z',
      '2025-03-01T10:14:00.000Z', '2025-03-01T10:16:00.000Z', '2025-03-01T13:29:00.000Z', '2025-03-01T13:31:00.000Z',
      '2025-03-01T23:59:59.000Z', '2025-03-02T00:00:00.000Z', '2025-03-02T04:59:00.000Z', '2025-03-02T05:00:30.000Z',
    ];
    await importRecords(t.db, t.userId, {
      conversations: [conv('a'), conv('b')],
      messages: times.flatMap((time, i) => [
        msg('a', i, { ...at(time), inputBase: 3 + i, outputBase: i % 2 ? 7 * i + 1 : 0, replayBase: 11 * i, replayCachedBase: 5 * i }),
        msg('b', i, { ...at(time), inputBase: 1, outputBase: 1, replayBase: 1, replayCachedBase: 0 }),
      ]),
    });
    expect((await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM estimate_buckets`)).rows[0].n).toBeGreaterThan(8);
    for (const tz of ZONES) expect(await fromFacts(tz), tz).toEqual(await fromMessages(tz));
  });

  it('never rounds differently from the per-message figures', async () => {
    // 1.25 x 2 = 2.5 and 1.25 x 6 = 7.5: summing first and rounding once would give other totals.
    await importRecords(t.db, t.userId, {
      conversations: [conv('a')],
      messages: Array.from({ length: 9 }, (_, i) => msg('a', i, { inputBase: 2, outputBase: 6, replayBase: 2, replayCachedBase: 2 })),
    });
    const [row] = await fromFacts('UTC');
    expect(row).toMatchObject({ input: 9 * 3, output: 9 * 8, replay: 9 * 3, replay_cached: 9 * 3 });
    expect(await fromFacts('UTC')).toEqual(await fromMessages('UTC'));
  });

  it('follow their import: a later import adds buckets, deleting an import removes exactly its own', async () => {
    const first = await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] });
    const second = await importRecords(
      t.db,
      t.userId,
      { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1), msg('a', 2), msg('a', 3)] },
      { contentHash: 'hash-2' },
    );
    expect(await fromFacts('UTC')).toEqual(await fromMessages('UTC'));
    const batches = async () =>
      (await t.db.query<{ batch_id: number }>(`SELECT DISTINCT batch_id FROM estimate_buckets ORDER BY 1`)).rows.map((r) => r.batch_id);
    expect(await batches()).toEqual([first.result.batchId, second.result.batchId]);

    await deleteBatch(t.db, t.userId, second.result.batchId!);
    expect(await batches()).toEqual([first.result.batchId]);
    expect(await fromFacts('UTC')).toEqual(await fromMessages('UTC'));

    await deleteBatch(t.db, t.userId, first.result.batchId!);
    expect(await fromFacts('UTC')).toEqual([]);
  });

  it('are rebuilt when a method gets a new factor', async () => {
    await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0, { inputBase: 100 }), msg('a', 1, { outputBase: 200, replayBase: 100 })] });
    try {
      await t.db.exec(`UPDATE estimation_methods SET central_factor = 1.5 WHERE tokenizer_basis = 'claude3'; SELECT refresh_estimate_buckets();`);
      expect(await fromFacts('UTC')).toEqual(await fromMessages('UTC'));
      expect((await fromFacts('UTC'))[0]).toMatchObject({ input: 150, output: 300, replay: 150 });
    } finally {
      // the catalog is shared by the tests in this file
      await t.db.exec(`UPDATE estimation_methods SET central_factor = 1.25 WHERE tokenizer_basis = 'claude3'; SELECT refresh_estimate_buckets();`);
    }
  });

  it('keep daily series identical for a user in a half-hour timezone', async () => {
    // 18:29 UTC is 23:59 in Kolkata, 18:31 UTC is 00:01 the next day.
    await importRecords(t.db, t.userId, {
      conversations: [conv('a')],
      messages: [msg('a', 0, { ...at('2025-06-10T18:29:00.000Z'), inputBase: 80 }), msg('a', 1, { ...at('2025-06-10T18:31:00.000Z'), outputBase: 160, replayBase: 80 })],
    });
    const series = await getTimeSeries(t.db, { userId: t.userId, timezone: 'Asia/Kolkata', basis: 'processed' }, 'day');
    expect(series.map((p) => [p.bucket, p.tokens])).toEqual([
      ['2025-06-10', 100],
      ['2025-06-11', 300],
    ]);
  });
});
