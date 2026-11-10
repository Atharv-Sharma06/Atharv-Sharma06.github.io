import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { listConversations, getConversationDetail } from '@/analytics/conversations';
import { getCoverage, listImports } from '@/analytics/coverage';
import { getModelBreakdown } from '@/analytics/models';
import { getOverview, getTimeSeries } from '@/analytics/overview';
import { addManualUsage, getSettings, saveUserPrice, setSourceIncluded, updateSettings } from '@/analytics/settings';
import { getActualSpend, getApiValue } from '@/analytics/value';
import { deleteBatch } from '@/import/delete';
import { createTestDb, type TestDb } from '../helpers/db';
import { EXPECTED, loadDataset } from '../helpers/dataset';

let t: TestDb;
let ids: Awaited<ReturnType<typeof loadDataset>>;
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: 'America/New_York', basis: 'processed', ...over });

beforeAll(async () => {
  t = await createTestDb('America/New_York');
  ids = await loadDataset(t);
});
afterAll(() => t.close());

describe('lifetime totals', () => {
  it('adds exact and estimated usage without mixing them', async () => {
    const o = await getOverview(t.db, filter());
    expect(o.tokens).toMatchObject({
      total: EXPECTED.processed.total,
      exact: EXPECTED.processed.exact,
      estimated: EXPECTED.processed.estimated,
      input: 125 + 50 + 1_000_000 + 1_000_000 + 1000 + 2000 + 100_000,
      output: 250 + 100 + 200_000 + 100_000 + 500 + 10_000,
      cacheRead: 10_000_000,
      cacheWrite: 2_500_000,
      replay: 100,
    });
    expect(o.tokens.exact + o.tokens.estimated).toBe(o.tokens.total);
    // the band only widens the estimated part: 625 x 0.88 and x 1.12
    expect(o.tokens.low).toBe(EXPECTED.processed.exact + 550);
    expect(o.tokens.high).toBe(EXPECTED.processed.exact + 700);
  });

  it('counts each token category once in the "new tokens" basis', async () => {
    const o = await getOverview(t.db, filter({ basis: 'new' }));
    expect(o.tokens).toMatchObject({ total: EXPECTED.fresh.total, exact: EXPECTED.fresh.exact, estimated: EXPECTED.fresh.estimated });
    // categories do not depend on the basis
    expect(o.tokens.cacheRead).toBe(10_000_000);
    expect(o.tokens.replay).toBe(100);
  });

  it('reports conversations, messages, activity and the most active day', async () => {
    const o = await getOverview(t.db, filter());
    expect(o.conversations).toEqual({ total: 3, chats: 2, codeSessions: 1 });
    expect(o.messages).toEqual({ user: 4, assistant: 5, total: 9 });
    expect(o.averageConversationLength).toBe(3);
    expect(o.requests).toBe(2 + 10 + 2 + 1 + 1);
    expect(o.firstUsageAt).toBe('2025-01-10T15:00:00.000Z');
    // usage facts are 15-minute buckets: the last message, at 03:31, lies in the bucket that starts at 03:30
    expect(o.lastUsageAt).toBe('2025-03-09T03:30:00.000Z');
    expect(o.activeDays).toBe(5);
    expect(o.mostActiveDay).toEqual({
      day: '2025-02-01',
      tokens: 14_800_000,
      exact: 14_800_000,
      estimated: 0,
      conversationsActive: 1,
      conversationsCreated: 1,
      messages: 5,
    });
  });

  it('respects the date range', async () => {
    const o = await getOverview(t.db, filter({ from: '2025-02-01', to: '2025-02-28' }));
    expect(o.tokens.total).toBe(13_700_000 + 1_100_000 + 1500 + 2000);
    expect(o.tokens.estimated).toBe(0);
    expect(o.conversations).toEqual({ total: 1, chats: 0, codeSessions: 1 });
    const none = await getOverview(t.db, filter({ from: '2024-01-01', to: '2024-12-31' }));
    expect(none.tokens.total).toBe(0);
    expect(none.mostActiveDay).toBeNull();
    expect(none.firstUsageAt).toBeNull();
    expect(none.averageConversationLength).toBeNull();
  });

  it('leaves out a source the user excluded, and brings it back', async () => {
    await setSourceIncluded(t.db, t.userId, ids.api.result.sourceId!, false, 'Already counted in Claude Code transcripts');
    expect((await getOverview(t.db, filter())).tokens.total).toBe(EXPECTED.processed.total - 110_000);
    const cov = await getCoverage(t.db, t.userId, 'America/New_York');
    expect(cov.sources.find((s) => s.kind === 'api_usage_report')).toMatchObject({ includeInTotals: false, exclusionReason: 'Already counted in Claude Code transcripts' });
    await setSourceIncluded(t.db, t.userId, ids.api.result.sourceId!, true);
    expect((await getOverview(t.db, filter())).tokens.total).toBe(EXPECTED.processed.total);
  });
});

describe('time series and timezones', () => {
  it('buckets by the user’s local day, including across a DST change', async () => {
    const ny = await getTimeSeries(t.db, filter(), 'day');
    expect(ny.map((p) => [p.bucket, p.tokens])).toEqual([
      ['2025-01-10', 475],
      ['2025-02-01', 14_800_000],
      ['2025-02-02', 3500],
      ['2025-03-08', 150], // 03:30 UTC on 9 Mar is still 8 Mar in New York
      ['2025-03-09', 110_000], // a one-day API bucket keeps its calendar day
    ]);
    const utc = await getTimeSeries(t.db, filter({ timezone: 'UTC' }), 'day');
    expect(utc.map((p) => [p.bucket, p.tokens])).toEqual([
      ['2025-01-10', 475],
      ['2025-02-01', 14_800_000],
      ['2025-02-02', 3500],
      ['2025-03-09', 110_150],
    ]);
    const kolkata = await getTimeSeries(t.db, filter({ timezone: 'Asia/Kolkata' }), 'day');
    // 2 Feb 2025 11:00 UTC is 16:30 in Kolkata (a half-hour offset); nothing moves day here
    expect(kolkata.map((p) => p.bucket)).toEqual(['2025-01-10', '2025-02-01', '2025-02-02', '2025-03-09']);
  });

  it('aggregates by week, month and year', async () => {
    const month = await getTimeSeries(t.db, filter(), 'month');
    expect(month.map((p) => [p.bucket, p.tokens, p.exact, p.estimated])).toEqual([
      ['2025-01-01', 475, 0, 475],
      ['2025-02-01', 14_803_500, 14_803_500, 0],
      ['2025-03-01', 110_150, 110_000, 150],
    ]);
    const week = await getTimeSeries(t.db, filter(), 'week');
    // ISO weeks start on Monday: 10 Jan 2025 is in the week of 6 Jan; 1-2 Feb in the week of 27 Jan
    expect(week.map((p) => p.bucket)).toEqual(['2025-01-06', '2025-01-27', '2025-03-03']);
    const year = await getTimeSeries(t.db, filter(), 'year');
    expect(year).toHaveLength(1);
    expect(year[0]).toMatchObject({ bucket: '2025-01-01', tokens: EXPECTED.processed.total, messages: 9, conversations: 3 });
  });

  it('groups by confidence, source, model and family', async () => {
    const byConfidence = await getTimeSeries(t.db, filter(), 'year', 'confidence');
    expect(Object.fromEntries(byConfidence.map((p) => [p.group, p.tokens]))).toEqual({ exact: EXPECTED.processed.exact, estimated: 625 });
    const bySource = await getTimeSeries(t.db, filter(), 'year', 'source');
    expect(Object.fromEntries(bySource.map((p) => [p.group, p.tokens]))).toEqual({ claude_export: 625, claude_code: 14_803_500, api_usage_report: 110_000 });
    const byModel = await getTimeSeries(t.db, filter(), 'year', 'model');
    expect(Object.fromEntries(byModel.map((p) => [p.group, p.tokens]))).toEqual({
      'Claude Sonnet 4.5': 13_700_000, 'Claude Haiku 5.5': 1_100_000, 'Claude Opus 4.5': 110_000, 'claude-opus-9': 1500, 'Unknown model': 2625,
    });
    const byFamily = await getTimeSeries(t.db, filter(), 'year', 'family');
    expect(Object.fromEntries(byFamily.map((p) => [p.group, p.tokens]))).toEqual({ sonnet: 13_700_000, haiku: 1_100_000, opus: 111_500, unknown: 2625 });
  });
});

describe('equivalent API value', () => {
  it('prices every category at its published price, exactly', async () => {
    const v = await getApiValue(t.db, filter());
    // Sonnet 4.5: 1M x $3 + 0.2M x $15 + 10M x $0.30 + 2M x $3.75 + 0.5M x $6 = 19.50
    // Haiku 5.5 long context: 1M x $0.50 + 0.1M x $2.50 = 0.75;  Opus 4.5: 0.1M x $5 + 0.01M x $25 = 0.75
    expect(v.exactUsd).toBe('21');
    expect(v.webSearchUsd).toBe('0.05'); // 5 searches at $10 per 1,000
    expect(v.totalStandardUsd).toBe('21.05');
    expect(v.pricedTokens).toBe(13_700_000 + 1_100_000 + 110_000);
  });

  it('does not price usage whose model is unknown or has no price on file', async () => {
    const v = await getApiValue(t.db, filter());
    expect(v.estimatedStandardUsd).toBe('0');
    expect(v.estimatedCachedUsd).toBe('0');
    expect(v.unpricedTokens).toBe(625 + 2000 + 1500);
    expect(v.assumedTokens).toBe(0);
    expect(v.assumedModel).toBeNull();
    expect(v.unpriced).toEqual([
      { reason: 'unknown_model', modelKey: null, displayName: null, priceTier: 'standard', tokens: 2625 },
      { reason: 'no_price', modelKey: 'claude-opus-9', displayName: 'claude-opus-9', priceTier: 'standard', tokens: 1500 },
    ]);
    expect(v.sources).toEqual([{ url: 'https://platform.claude.com/docs/en/about-claude/pricing', retrievedOn: '2026-11-10', tokens: 14_910_000, userEntered: false }]);
  });

  it('prices unknown-model usage only under an explicit assumption, in both caching scenarios', async () => {
    const v = await getApiValue(t.db, filter(), { assumedModelKey: 'claude-sonnet-4-5' });
    expect(v.assumedModel).toEqual({ modelKey: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' });
    expect(v.assumedTokens).toBe(2625);
    // exact row without a model: 2,000 input x $3 / 1M
    expect(v.exactUsd).toBe('21.006');
    // standard: a (125 + 100) x 3 + 250 x 15 = 4425; b 50 x 3 + 100 x 15 = 1650  -> 6075 / 1M
    expect(v.estimatedStandardUsd).toBe('0.006075');
    // cached:   a (125 + 100 - 50) x 3.75 + 50 x 0.30 + 250 x 15 = 4421.25; b 50 x 3.75 + 100 x 15 = 1687.5 -> 6108.75 / 1M
    expect(v.estimatedCachedUsd).toBe('0.006109'); // rounded to 6 places
    expect(v.unpricedTokens).toBe(1500);
  });

  it('prefers a price the user entered and keeps its source', async () => {
    await saveUserPrice(t.db, { modelKey: 'claude-opus-9', input: '20', output: '100', sourceUrl: 'https://example.com/pricing', sourceNote: 'hypothetical' });
    const v = await getApiValue(t.db, filter());
    // 1,000 x $20 + 500 x $100 per million = 0.07
    expect(v.exactUsd).toBe('21.07');
    expect(v.unpriced.map((u) => u.reason)).toEqual(['unknown_model']);
    expect(v.sources.find((s) => s.userEntered)).toMatchObject({ url: 'https://example.com/pricing', tokens: 1500 });
    await t.db.query(`DELETE FROM pricing_history WHERE NOT is_builtin`);
    await expect(saveUserPrice(t.db, { modelKey: 'claude-opus-9', input: 'cheap', output: '1', sourceUrl: 'https://example.com' })).rejects.toThrow(/input price/);
    await expect(saveUserPrice(t.db, { modelKey: 'claude-opus-9', input: '1', output: '1', sourceUrl: 'from memory' })).rejects.toThrow(/web address/);
  });

  it('applies a price only inside its effective dates', async () => {
    await t.db.query(
      `INSERT INTO pricing_history (model_id, price_tier, effective_from, effective_to, input_usd_per_mtok, output_usd_per_mtok, source_url, source_retrieved_on, is_builtin)
       SELECT id, 'standard', '2025-02-02', '2025-02-03', 1000, 1000, 'https://example.com/a', CURRENT_DATE, false FROM model_catalog WHERE model_key = 'claude-opus-9'`,
    );
    const inside = await getApiValue(t.db, filter());
    expect(inside.exactUsd).toBe('22.5'); // 21 + 1,500 tokens x $1,000 / 1M
    await t.db.query(`UPDATE pricing_history SET effective_from = '2025-02-03', effective_to = NULL WHERE NOT is_builtin`);
    const outside = await getApiValue(t.db, filter());
    expect(outside.exactUsd).toBe('21');
    expect(outside.unpricedTokens).toBe(625 + 2000 + 1500);
    await t.db.query(`DELETE FROM pricing_history WHERE NOT is_builtin`);
  });

  it('keeps actual spend separate from equivalent value', async () => {
    expect(await getActualSpend(t.db, t.userId, 'UTC')).toEqual({ reportedApiUsd: null, reportedRange: null, subscriptions: null });
  });
});

describe('model breakdown', () => {
  it('lists every model with categories, share and value, and an explicit Unknown row', async () => {
    const rows = await getModelBreakdown(t.db, filter());
    expect(rows.map((r) => r.displayName)).toEqual(['Claude Sonnet 4.5', 'Claude Haiku 5.5', 'Claude Opus 4.5', 'Unknown model', 'claude-opus-9']);
    const sonnet = rows[0];
    expect(sonnet).toMatchObject({ modelKey: 'claude-sonnet-4-5', family: 'sonnet', inCatalog: true, input: 1_000_000, output: 200_000, cacheRead: 10_000_000, cacheWrite5m: 2_000_000, cacheWrite1h: 500_000, total: 13_700_000, exact: 13_700_000, estimated: 0, conversations: 1, requests: 10 });
    expect(sonnet.value.exactUsd).toBe('19.5');
    expect(sonnet.share).toBeCloseTo(13_700_000 / EXPECTED.processed.total, 10);
    const unknown = rows[3];
    expect(unknown).toMatchObject({ modelKey: null, family: 'unknown', total: 2625, exact: 2000, estimated: 625, conversations: 3, replay: 100 });
    expect(unknown.value).toMatchObject({ exactUsd: '0', pricedTokens: 0, unpricedTokens: 2625 });
    expect(rows[4]).toMatchObject({ modelKey: 'claude-opus-9', inCatalog: false, family: 'opus' });
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 10);
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(EXPECTED.processed.total);
  });
});

describe('conversation explorer', () => {
  it('lists conversations sorted by tokens, with source and model', async () => {
    const page = await listConversations(t.db, filter());
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => [r.title, r.tokens, r.exact, r.estimated, r.modelName, r.sourceKind, r.messageCount])).toEqual([
      ['Refactor importer', 14_803_500, 14_803_500, 0, 'Claude Sonnet 4.5', 'claude_code', 5],
      ['Conversation a', 475, 0, 475, 'Unknown model', 'claude_export', 2],
      ['Late night question', 150, 0, 150, 'Unknown model', 'claude_export', 2],
    ]);
  });

  it('searches, filters, sorts and pages', async () => {
    expect((await listConversations(t.db, filter(), { search: 'night' })).rows.map((r) => r.title)).toEqual(['Late night question']);
    expect((await listConversations(t.db, filter(), { search: '/home/alex' })).rows.map((r) => r.title)).toEqual(['Refactor importer']);
    expect((await listConversations(t.db, filter(), { search: '100%_' })).total).toBe(0);
    expect((await listConversations(t.db, filter(), { model: 'unknown' })).total).toBe(2);
    expect((await listConversations(t.db, filter(), { model: 'claude-sonnet-4-5' })).total).toBe(1);
    expect((await listConversations(t.db, filter(), { sourceKind: 'claude_export' })).total).toBe(2);
    // created 9 Mar 03:30 UTC = 8 Mar in New York
    expect((await listConversations(t.db, filter(), { from: '2025-03-08', to: '2025-03-08' })).rows.map((r) => r.title)).toEqual(['Late night question']);
    expect((await listConversations(t.db, filter(), { sort: 'created', direction: 'asc' })).rows.map((r) => r.title)).toEqual(['Conversation a', 'Refactor importer', 'Late night question']);
    const second = await listConversations(t.db, filter(), { sort: 'title', direction: 'asc', limit: 1, offset: 1 });
    expect(second.total).toBe(3);
    expect(second.rows.map((r) => r.title)).toEqual(['Late night question']);
  });

  it('shows per-conversation statistics without any message text', async () => {
    const a = (await listConversations(t.db, filter(), { search: 'Conversation a' })).rows[0];
    const d = (await getConversationDetail(t.db, filter(), a.id))!;
    expect(d.conversation).toMatchObject({ externalId: 'a', tokens: 475, estimated: 475, userMessages: 1, assistantMessages: 1 });
    expect(d.imports.map((i) => i.fileName)).toEqual(['conversations.json']);
    expect(d.methods).toEqual([expect.objectContaining({ methodKey: 'heuristic-v1/claude3', tokenizerBasis: 'claude3', messages: 2, lowFactor: 0.88, highFactor: 1.12 })]);
    expect(d.limitations).toEqual([
      { name: 'MODEL_UNKNOWN', messages: 2 },
      { name: 'HIDDEN_CONTEXT_EXCLUDED', messages: 2 },
      { name: 'BINARY_FILES_EXCLUDED', messages: 1 },
    ]);
    expect(d.messages.map((m) => [m.role, m.input, m.output, m.replay, m.requests])).toEqual([
      ['user', 125, 0, 0, 0],
      ['assistant', 0, 250, 100, 1],
    ]);
    expect(await getConversationDetail(t.db, filter(), 999_999)).toBeNull();
    // the same analytics work for a single conversation
    const o = await getOverview(t.db, filter({ conversationId: a.id }));
    expect(o.tokens.total).toBe(475);
  });
});

describe('coverage', () => {
  it('describes what was imported, what is exact, what has a model, and the gaps', async () => {
    const c = await getCoverage(t.db, t.userId, 'America/New_York');
    expect(c).toMatchObject({
      hasData: true, hasSyntheticData: false, importCount: 3,
      earliestRecordAt: '2025-01-10T15:00:00.000Z', latestRecordAt: '2025-03-09T03:30:00.000Z',
      exactTokens: EXPECTED.processed.exact, estimatedTokens: 625,
      tokensWithModel: 13_700_000 + 1_100_000 + 1500 + 110_000, tokensWithoutModel: 2625,
      estimatedMessages: 4,
    });
    expect(c.sources.map((s) => [s.kind, s.imports, s.conversations, s.exactTokens, s.estimatedTokens])).toEqual([
      ['claude_export', 1, 2, 0, 625],
      ['claude_code', 1, 1, 14_803_500, 0],
      ['api_usage_report', 1, 0, 110_000, 0],
    ]);
    expect(c.gaps).toEqual([
      { from: '2025-02-03', to: '2025-03-07', days: 33 },
      { from: '2025-01-11', to: '2025-01-31', days: 21 },
    ]);
    expect(c.limitations).toEqual([
      { name: 'MODEL_UNKNOWN', messages: 4 },
      { name: 'HIDDEN_CONTEXT_EXCLUDED', messages: 4 },
      { name: 'BINARY_FILES_EXCLUDED', messages: 1 },
    ]);
  });

  it('keeps an import history that traces every batch to its file', async () => {
    const imports = await listImports(t.db, t.userId);
    expect(imports.map((i) => [i.sourceKind, i.format, i.recordsInserted])).toEqual([
      ['api_usage_report', 'test/format', 1],
      ['claude_code', 'test/format', 4],
      ['claude_export', 'test/format', 4],
    ]);
    expect(imports[2]).toMatchObject({ coverageStart: '2025-01-10T15:00:00.000Z', coverageEnd: '2025-03-09T03:31:00.000Z', fileName: 'conversations.json' });
  });
});

describe('settings and manual entries', () => {
  it('stores preferences and validates the timezone', async () => {
    expect(await getSettings(t.db, t.userId)).toEqual({ timezone: 'America/New_York', basis: 'processed', assumedModelKey: null, costScenario: 'standard' });
    const s = await updateSettings(t.db, t.userId, { timezone: 'Europe/Berlin', basis: 'new', assumedModelKey: 'claude-sonnet-4-5', costScenario: 'cached' });
    expect(s).toEqual({ timezone: 'Europe/Berlin', basis: 'new', assumedModelKey: 'claude-sonnet-4-5', costScenario: 'cached' });
    await expect(updateSettings(t.db, t.userId, { timezone: 'Mars/Olympus_Mons' })).rejects.toThrow(/not a timezone/);
    await expect(updateSettings(t.db, t.userId, { assumedModelKey: 'gpt-4' })).rejects.toThrow(/catalog/);
    await updateSettings(t.db, t.userId, { timezone: 'America/New_York', basis: 'processed', assumedModelKey: null, costScenario: 'standard' });
  });

  it('adds a manual record as its own deletable import, labelled with its confidence', async () => {
    const before = (await getOverview(t.db, filter())).tokens;
    const batchId = await addManualUsage(t.db, t.userId, { date: '2024-11-05', model: 'claude-3-5-sonnet-20241022', inputTokens: 40_000, outputTokens: 10_000, confidence: 'estimated', note: 'Estimated from my November invoice' });
    const after = (await getOverview(t.db, filter())).tokens;
    expect(after.total).toBe(before.total + 50_000);
    expect(after.estimated).toBe(before.estimated + 50_000);
    expect(after.exact).toBe(before.exact);
    const day = await getTimeSeries(t.db, filter({ from: '2024-11-01', to: '2024-11-30' }), 'day', 'model');
    expect(day).toEqual([expect.objectContaining({ bucket: '2024-11-05', group: 'Claude Sonnet 3.5', tokens: 50_000 })]);
    // priced at Sonnet 3.5's launch price: 0.04M x $3 + 0.01M x $15 = 0.27
    expect((await getApiValue(t.db, filter({ from: '2024-11-01', to: '2024-11-30' }))).estimatedStandardUsd).toBe('0.27');
    await expect(addManualUsage(t.db, t.userId, { date: 'yesterday', confidence: 'exact', inputTokens: 1 })).rejects.toThrow(/valid date/);
    await expect(addManualUsage(t.db, t.userId, { date: '2024-11-05', confidence: 'exact' })).rejects.toThrow(/at least one/);
    await expect(addManualUsage(t.db, t.userId, { date: '2024-11-05', confidence: 'exact', inputTokens: -3 })).rejects.toThrow(/whole number/);
    await deleteBatch(t.db, t.userId, batchId!);
    expect((await getOverview(t.db, filter())).tokens).toEqual(before);
  });
});

describe('source filter', () => {
  it('restricts every figure to the chosen kinds of source', async () => {
    const all = await getOverview(t.db, filter());
    const chats = await getOverview(t.db, filter({ sourceKinds: ['claude_export'] }));
    const metered = await getOverview(t.db, filter({ sourceKinds: ['claude_code', 'api_usage_report'] }));
    expect(chats.tokens.total).toBe(625);
    expect(chats.tokens.exact).toBe(0);
    expect(metered.tokens.estimated).toBe(0);
    expect(chats.tokens.total + metered.tokens.total).toBe(all.tokens.total);
    expect((await getOverview(t.db, filter({ sourceKinds: [] }))).tokens.total).toBe(all.tokens.total);
  });
});

describe('first and last day of the records', () => {
  it('follow the chart rule: a daily bucket is a UTC calendar day, a timed record a local day', async () => {
    // The dataset's API report holds daily buckets at UTC midnight; in New York that instant is the evening before.
    const o = await getOverview(t.db, filter({ sourceKinds: ['api_usage_report'] }));
    expect(o.firstUsageAt).toMatch(/T00:00:00\.000Z$/);
    expect(o.firstDay).toBe(o.firstUsageAt!.slice(0, 10));
    expect(o.lastDay).toBe(o.lastUsageAt!.slice(0, 10));

    // Timed records are assigned to the local day: the latest chat message is at 03:30 UTC on 9 March,
    // which is still 8 March in New York.
    const chats = await getOverview(t.db, filter({ sourceKinds: ['claude_export'] }));
    expect(chats.lastUsageAt).toBe('2025-03-09T03:30:00.000Z');
    expect(chats.lastDay).toBe('2025-03-08');

    // Over everything, the last day is the daily bucket's own day, not the instant converted to New York.
    const all = await getOverview(t.db, filter());
    expect(all.lastDay).toBe('2025-03-09');

    const c = await getCoverage(t.db, t.userId, 'America/New_York');
    expect([c.earliestDay, c.latestDay]).toEqual([all.firstDay, all.lastDay]);
    const api = c.sources.find((s) => s.kind === 'api_usage_report')!;
    expect([api.firstDay, api.lastDay]).toEqual([o.firstDay, o.lastDay]);
  });
});

describe('timezone setting', () => {
  it('accepts IANA names and refuses abbreviations, offsets and unknown zones', async () => {
    const { updateSettings, getSettings } = await import('@/analytics/settings');
    const before = (await getSettings(t.db, t.userId)).timezone;
    for (const zone of ['Asia/Kolkata', 'UTC', 'Europe/Berlin', before]) {
      expect((await updateSettings(t.db, t.userId, { timezone: zone })).timezone).toBe(zone);
    }
    // PostgreSQL would take every one of these, and read "UTC+5" as five hours WEST of Greenwich
    for (const zone of ['PST', 'UTC+5', '+02:00', 'Mars/Olympus_Mons', '']) {
      await expect(updateSettings(t.db, t.userId, { timezone: zone })).rejects.toThrow(/not a timezone this app knows/);
    }
    expect((await getSettings(t.db, t.userId)).timezone).toBe(before);
  });
});
