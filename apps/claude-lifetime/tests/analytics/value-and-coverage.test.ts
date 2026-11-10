import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { listConversations } from '@/analytics/conversations';
import { getCoverage } from '@/analytics/coverage';
import { getOverview } from '@/analytics/overview';
import { deleteUserPrice, listPrices, saveUserPrice } from '@/analytics/settings';
import { getApiValue } from '@/analytics/value';
import { createTestDb, type TestDb } from '../helpers/db';
import { loadDataset } from '../helpers/dataset';
import { conv, importRecords, msg, usage } from '../helpers/staged';

const TZ = 'UTC';
let t: TestDb;
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: TZ, basis: 'processed', ...over });
const zero = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requestCount: 0, userMessageCount: 0, assistantMessageCount: 0 };

beforeAll(async () => {
  t = await createTestDb(TZ);
});
afterAll(() => t.close());

async function oneMillionInput(model: string | null, extra: Record<string, unknown> = {}) {
  await t.reset();
  await importRecords(
    t.db, t.userId,
    { usage: [usage('u1', { ...zero, modelKey: model, occurredAt: '2025-06-01T12:00:00.000Z', inputTokens: 1_000_000, outputTokens: 0, ...extra })] },
    { source: { kind: 'claude_code', label: 'cc', externalRef: '' }, contentHash: 'x' },
  );
}
const ownPrices = async () => (await listPrices(t.db)).filter((p) => !p.isBuiltin);

describe('which price applies', () => {
  it('prefers the user’s price, and among those the one in effect on the day', async () => {
    await oneMillionInput('claude-sonnet-4-5');
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('3');
    await saveUserPrice(t.db, { modelKey: 'claude-sonnet-4-5', input: '7', output: '1', sourceUrl: 'https://example.com/a' });
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('7');
    await saveUserPrice(t.db, { modelKey: 'claude-sonnet-4-5', input: '9', output: '1', effectiveFrom: '2025-06-01', sourceUrl: 'https://example.com/b' });
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('9');
    // a price that only starts the day after does not apply yet
    await saveUserPrice(t.db, { modelKey: 'claude-sonnet-4-5', input: '11', output: '1', effectiveFrom: '2025-06-02', sourceUrl: 'https://example.com/c' });
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('9');
    for (const p of await ownPrices()) await deleteUserPrice(t.db, p.id);
  });

  it('a price entered again for the same model, tier and start date replaces the earlier entry', async () => {
    await oneMillionInput('claude-sonnet-4-5');
    await saveUserPrice(t.db, { modelKey: 'claude-sonnet-4-5', input: '30', output: '15', sourceUrl: 'https://example.com/pricing' });
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('30');
    // the typing mistake is corrected by entering the price again
    await saveUserPrice(t.db, { modelKey: 'claude-sonnet-4-5', input: '3', output: '15', sourceUrl: 'https://example.com/pricing' });
    expect((await ownPrices()).map((p) => [p.modelKey, p.priceTier, p.effectiveFrom, p.input])).toEqual([['claude-sonnet-4-5', 'standard', null, '3']]);
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('3');

    // other tiers, other start dates and other models are separate prices and stay
    await saveUserPrice(t.db, { modelKey: 'claude-sonnet-4-5', priceTier: 'batch', input: '1.5', output: '7.5', sourceUrl: 'https://example.com/pricing' });
    await saveUserPrice(t.db, { modelKey: 'claude-sonnet-4-5', effectiveFrom: '2026-01-01', input: '4', output: '15', sourceUrl: 'https://example.com/pricing' });
    await saveUserPrice(t.db, { modelKey: 'claude-opus-4-5', input: '5', output: '25', sourceUrl: 'https://example.com/pricing' });
    await saveUserPrice(t.db, { modelKey: 'claude-sonnet-4-5', effectiveFrom: '2026-01-01', input: '4.5', output: '15', sourceUrl: 'https://example.com/pricing' });
    expect((await ownPrices()).map((p) => [p.modelKey, p.priceTier, p.effectiveFrom, p.input]).sort()).toEqual([
      ['claude-opus-4-5', 'standard', null, '5'],
      ['claude-sonnet-4-5', 'batch', null, '1.5'],
      ['claude-sonnet-4-5', 'standard', null, '3'],
      ['claude-sonnet-4-5', 'standard', '2026-01-01', '4.5'],
    ]);
    // a model that is not in the catalog is refused, and takes nothing away
    await expect(saveUserPrice(t.db, { modelKey: 'no-such-model', input: '1', output: '1', sourceUrl: 'https://example.com' })).rejects.toThrow(/not in the catalog/);
    expect(await ownPrices()).toHaveLength(4);
    // built-in prices are never replaced
    expect((await listPrices(t.db)).some((p) => p.isBuiltin && p.modelKey === 'claude-sonnet-4-5' && p.priceTier === 'standard')).toBe(true);
    for (const p of await ownPrices()) await deleteUserPrice(t.db, p.id);
  });

  it('with two rows for the same thing on file, the later entry applies', async () => {
    await oneMillionInput('claude-sonnet-4-5');
    // Rows as an earlier version of the app could have left them: the same model, tier and start date twice.
    for (const input of ['30', '3']) {
      await t.db.query(
        `INSERT INTO pricing_history (model_id, price_tier, input_usd_per_mtok, output_usd_per_mtok, source_url, source_retrieved_on, is_builtin)
         SELECT id, 'standard', $1::numeric, 15, 'https://example.com', CURRENT_DATE, false FROM model_catalog WHERE model_key = 'claude-sonnet-4-5'`,
        [input],
      );
    }
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('3');
    for (const p of await ownPrices()) await deleteUserPrice(t.db, p.id);
  });
});

describe('US-only inference', () => {
  it('is valued at 1.1 times the price of its tier on the models that offer it', async () => {
    await oneMillionInput('claude-opus-5-5', { priceTier: 'standard' });
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('4');
    await oneMillionInput('claude-opus-5-5', { priceTier: 'standard_us', outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWrite5mTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 });
    // input 4, output 20, cache read 0.2, 5-minute write 5, 1-hour write 8; each times 1.1
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('40.92');
    await oneMillionInput('claude-opus-5-5', { priceTier: 'batch_us' });
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('2.2');
    await oneMillionInput('claude-haiku-5-5', { priceTier: 'long_context_us' });
    expect((await getApiValue(t.db, filter())).exactUsd).toBe('0.55');
  });

  it('is left unpriced, and listed as such, on a model that has no US-only price', async () => {
    // Claude Sonnet 4.5 came before the models that accept inference_geo
    await oneMillionInput('claude-sonnet-4-5', { priceTier: 'standard_us' });
    const value = await getApiValue(t.db, filter());
    expect(value.exactUsd).toBe('0');
    expect(value.unpriced).toMatchObject([{ modelKey: 'claude-sonnet-4-5', priceTier: 'standard_us', reason: 'no_price', tokens: 1_000_000 }]);
  });
});

describe('usage that names no model stays unknown, whatever model is assumed', () => {
  it('is not listed as usage of the assumed model when that model has no price for it', async () => {
    // an API report grouped by service tier only: no model, on a tier Sonnet 4.5 has no price for
    await oneMillionInput(null, { priceTier: 'priority' });
    const unknown = [{ reason: 'unknown_model', modelKey: null, displayName: null, priceTier: 'priority', tokens: 1_000_000 }];
    expect((await getApiValue(t.db, filter())).unpriced).toEqual(unknown);
    const assumed = await getApiValue(t.db, filter(), { assumedModelKey: 'claude-sonnet-4-5' });
    expect(assumed.unpriced).toEqual(unknown);
    expect(assumed.assumedTokens).toBe(0);
    // the same with an assumed model that has no price at all
    expect((await getApiValue(t.db, filter(), { assumedModelKey: 'claude-2.1' })).unpriced).toEqual(unknown);
  });

  it('is kept apart from real usage of that model', async () => {
    await t.reset();
    await importRecords(
      t.db, t.userId,
      {
        usage: [
          usage('real', { ...zero, modelKey: 'claude-sonnet-4-5', priceTier: 'priority', occurredAt: '2025-06-01T12:00:00.000Z', inputTokens: 300, outputTokens: 0 }),
          usage('nomodel', { ...zero, modelKey: null, priceTier: 'priority', occurredAt: '2025-06-01T12:00:00.000Z', inputTokens: 700, outputTokens: 0 }),
        ],
      },
      { source: { kind: 'api_usage_report', label: 'api', externalRef: '' }, contentHash: 'y' },
    );
    const value = await getApiValue(t.db, filter(), { assumedModelKey: 'claude-sonnet-4-5' });
    expect(value.unpriced).toEqual([
      { reason: 'unknown_model', modelKey: null, displayName: null, priceTier: 'priority', tokens: 700 },
      { reason: 'no_price', modelKey: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', priceTier: 'priority', tokens: 300 },
    ]);
  });

  it('is priced with the assumed model where that model has a price, and counted as assumed', async () => {
    await oneMillionInput(null);
    const value = await getApiValue(t.db, filter(), { assumedModelKey: 'claude-sonnet-4-5' });
    expect(value).toMatchObject({ exactUsd: '3', assumedTokens: 1_000_000, unpricedTokens: 0, unpriced: [] });
  });
});

describe('stretches without records', () => {
  const coverage = async () => (await getCoverage(t.db, t.userId, TZ)).gaps;
  const row = (key: string, day: string, days: number) => usage(key, { ...zero, occurredAt: `${day}T00:00:00.000Z`, bucketSeconds: days * 86_400, inputTokens: 1_000, outputTokens: 0 });
  const source = { source: { kind: 'generic_csv' as const, label: 'Monthly totals', externalRef: 'csv' }, contentHash: 'monthly' };

  it('a row that adds up a whole month covers that month', async () => {
    await t.reset();
    await importRecords(t.db, t.userId, { usage: [row('jan', '2025-01-01', 31), row('feb', '2025-02-01', 28), row('mar', '2025-03-01', 31)] }, source);
    expect(await coverage()).toEqual([]);
  });

  it('reports the days after a wide row ends, not the days inside it', async () => {
    await t.reset();
    // January as one row, then nothing until a single day in April
    await importRecords(t.db, t.userId, { usage: [row('jan', '2025-01-01', 31), row('apr', '2025-04-10', 1)] }, source);
    expect(await coverage()).toEqual([{ from: '2025-02-01', to: '2025-04-09', days: 68 }]);
  });

  it('does not let a short record inside a wide one open a gap', async () => {
    await t.reset();
    // a quarter as one row, with a daily record in its first week; the next record follows right after the quarter
    await importRecords(t.db, t.userId, { usage: [row('q1', '2025-01-01', 90), row('d', '2025-01-05', 1), row('next', '2025-04-01', 1)] }, source);
    expect(await coverage()).toEqual([]);
  });

  it('still reports a stretch between ordinary daily records', async () => {
    await t.reset();
    await importRecords(t.db, t.userId, { usage: [row('a', '2025-01-01', 1), row('b', '2025-03-01', 1)] }, source);
    expect(await coverage()).toEqual([{ from: '2025-01-02', to: '2025-02-28', days: 58 }]);
  });
});

describe('the busiest day counts the conversations started under the same filter as everything else on the card', () => {
  const NY = 'America/New_York';
  const inNewYork = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: NY, basis: 'processed', ...over });

  it('follows the source filter and a single conversation', async () => {
    await t.reset();
    await loadDataset(t); // the Claude Code session "Refactor importer" starts on 1 February 2025
    // three chats started on the same day
    await importRecords(
      t.db, t.userId,
      {
        conversations: ['x', 'y', 'z'].map((id) => conv(id, { createdAt: '2025-02-01T15:00:00.000Z', updatedAt: '2025-02-01T15:00:00.000Z' })),
        messages: ['x', 'y', 'z'].map((id) => msg(id, 0, { createdAt: '2025-02-01T15:00:00.000Z', occurredAt: '2025-02-01T15:00:00.000Z', inputBase: 8 })),
      },
      { contentHash: 'more-chats' },
    );
    expect((await getOverview(t.db, inNewYork())).mostActiveDay).toMatchObject({ day: '2025-02-01', conversationsActive: 4, conversationsCreated: 4 });

    const codeOnly = await getOverview(t.db, inNewYork({ sourceKinds: ['claude_code'] }));
    expect(codeOnly.conversations).toEqual({ total: 1, chats: 0, codeSessions: 1 });
    expect(codeOnly.mostActiveDay).toMatchObject({ day: '2025-02-01', conversationsActive: 1, conversationsCreated: 1 });

    const session = (await listConversations(t.db, inNewYork(), { search: 'Refactor importer' })).rows[0];
    expect((await getOverview(t.db, inNewYork({ conversationId: session.id }))).mostActiveDay).toMatchObject({ conversationsActive: 1, conversationsCreated: 1 });
  });
});
