import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getCoverage } from '@/analytics/coverage';
import { getModelBreakdown } from '@/analytics/models';
import { getOverview } from '@/analytics/overview';
import { deleteUserPrice, getSettings, listModels, listPrices, saveUserPrice, setSourceIncluded, SettingsError, updateSettings } from '@/analytics/settings';
import { listPeriods, savePeriod } from '@/analytics/subscriptions';
import { getApiValue } from '@/analytics/value';
import { Decimal } from '@/core/decimal';
import { parsePostgresVersion, replacedByUserPrices } from '@/features/settings/logic';
import { deleteAllData, deleteSource } from '@/import/delete';
import { formatInstant } from '@/lib/format';
import { EXPECTED, loadDataset } from '../helpers/dataset';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * The figures the Settings page shows next to its controls, and what each control does
 * to the totals of the rest of the app, against the small dataset whose numbers can be
 * worked out by hand (see tests/helpers/dataset.ts).
 */
let t: TestDb;
let ids: Awaited<ReturnType<typeof loadDataset>>;
const lifetime = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: 'UTC', basis: 'processed', ...over });
const minus = (a: string, b: string) => Decimal.from(a).sub(b).toString(6);

beforeAll(async () => {
  t = await createTestDb('UTC');
  ids = await loadDataset(t);
});
afterAll(() => t.close());

describe('display and accounting', () => {
  it('token basis: the two lifetime totals shown under the choice', async () => {
    const processed = await getOverview(t.db, lifetime({ basis: 'processed' }));
    const fresh = await getOverview(t.db, lifetime({ basis: 'new' }));
    expect(processed.tokens.total).toBe(EXPECTED.processed.total);
    expect(fresh.tokens.total).toBe(EXPECTED.fresh.total);
    // the difference is exactly what "new" leaves out: cache reads and re-read context
    expect(processed.tokens.total - fresh.tokens.total).toBe(processed.tokens.cacheRead + processed.tokens.replay);
  });

  it('cost scenario: without an assumed model the estimated chat usage is unpriced, so both scenarios agree', async () => {
    const value = await getApiValue(t.db, lifetime());
    expect(value.estimatedStandardUsd).toBe('0');
    expect(value.estimatedCachedUsd).toBe('0');
    expect(value.totalStandardUsd).toBe(value.totalCachedUsd);
  });

  it('assumed model: prices exactly the usage with no recorded model and nothing else', async () => {
    const coverage = await getCoverage(t.db, t.userId, 'UTC');
    // 625 estimated chat tokens and one exact record of 2,000 tokens name no model
    expect(coverage.tokensWithoutModel).toBe(625 + 2000);

    const baseline = await getApiValue(t.db, lifetime());
    const assumed = await getApiValue(t.db, lifetime(), { assumedModelKey: 'claude-sonnet-4-5' });
    expect(baseline.assumedTokens).toBe(0);
    expect(assumed.assumedTokens).toBe(coverage.tokensWithoutModel);
    expect(assumed.assumedModel).toEqual({ modelKey: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' });

    // Sonnet 4.5: $3 input, $15 output, $0.30 cache read, $3.75 five-minute cache write, per million tokens.
    // Chat, no caching: (175 new input + 100 re-read) x 3 + 350 output x 15 = 6,075 millionths of a dollar.
    expect(assumed.estimatedStandardUsd).toBe('0.006075');
    // Chat, 5-minute cache: (275 - 50 cacheable) x 3.75 + 50 x 0.30 + 350 x 15 = 6,108.75 millionths.
    expect(assumed.estimatedCachedUsd).toBe('0.006109');
    // "adds ... to your lifetime equivalent API value": the chat part plus the exact record, 2,000 x 3.
    expect(minus(assumed.totalStandardUsd, baseline.totalStandardUsd)).toBe('0.012075');
    expect(minus(assumed.totalCachedUsd, baseline.totalCachedUsd)).toBe('0.012109');
    // exact usage (and web search) is valued the same in both scenarios: only the estimated part differs
    expect(minus(assumed.totalStandardUsd, assumed.estimatedStandardUsd)).toBe(minus(assumed.totalCachedUsd, assumed.estimatedCachedUsd));
  });

  it('assumed model: token counts and the model breakdown stay as imported', async () => {
    const plain = await getModelBreakdown(t.db, lifetime());
    const assumed = await getModelBreakdown(t.db, lifetime(), { assumedModelKey: 'claude-sonnet-4-5' });
    expect(assumed.map((m) => [m.modelKey, m.total])).toEqual(plain.map((m) => [m.modelKey, m.total]));
    const unknown = assumed.find((m) => m.modelKey === null)!;
    expect(unknown.total).toBe(625 + 2000);
    // only the value of the unknown-model row changes
    expect(plain.find((m) => m.modelKey === null)!.value.pricedTokens).toBe(0);
    expect(unknown.value.assumedTokens).toBe(625 + 2000);
    const sonnet = (rows: typeof plain) => rows.find((m) => m.modelKey === 'claude-sonnet-4-5')!;
    expect(sonnet(assumed).total).toBe(sonnet(plain).total);
    expect(sonnet(assumed).value).toEqual(sonnet(plain).value);
  });

  it('timezone: an unknown name is refused with a message for the user and the stored zone is kept', async () => {
    await expect(updateSettings(t.db, t.userId, { timezone: 'Mars/Olympus_Mons' })).rejects.toThrow(SettingsError);
    await expect(updateSettings(t.db, t.userId, { timezone: 'Mars/Olympus_Mons' })).rejects.toThrow('"Mars/Olympus_Mons" is not a timezone this app knows');
    expect((await getSettings(t.db, t.userId)).timezone).toBe('UTC');
  });

  it('timezone: the day a late-evening message belongs to moves with the zone', async () => {
    // conversation b starts on 9 Mar 2025 at 03:30 UTC, which is still 8 Mar in New York
    const utc = await getOverview(t.db, lifetime({ from: '2025-03-08', to: '2025-03-08' }));
    const newYork = await getOverview(t.db, lifetime({ timezone: 'America/New_York', from: '2025-03-08', to: '2025-03-08' }));
    expect(utc.tokens.total).toBe(0);
    expect(newYork.tokens.total).toBe(150);
  });
});

describe('data sources', () => {
  it('lists each source with the figures of its row', async () => {
    const coverage = await getCoverage(t.db, t.userId, 'UTC');
    const row = (kind: string) => coverage.sources.find((s) => s.kind === kind)!;
    expect(row('claude_export')).toMatchObject({ imports: 1, conversations: 2, exactTokens: 0, estimatedTokens: 625, includeInTotals: true, reportedCostUsd: null });
    expect(row('claude_code')).toMatchObject({ imports: 1, conversations: 1, exactTokens: 14_803_500, estimatedTokens: 0 });
    expect(row('api_usage_report')).toMatchObject({ imports: 1, conversations: 0, exactTokens: 110_000, estimatedTokens: 0 });
    // "Records dated", as the row writes it in the user's timezone
    expect(formatInstant(row('claude_export').firstRecordAt, 'UTC')).toBe('Jan 10, 2025');
    expect(formatInstant(row('claude_export').lastRecordAt, 'UTC')).toBe('Mar 9, 2025');
    expect(formatInstant(row('claude_export').lastRecordAt, 'America/New_York')).toBe('Mar 8, 2025');
    // the summary line above the list
    expect(coverage.exactTokens).toBe(EXPECTED.processed.exact);
    expect(coverage.estimatedTokens).toBe(EXPECTED.processed.estimated);
  });

  it('"Count in totals": leaving a source out lowers every total by exactly its tokens, and the reason is kept', async () => {
    const api = ids.api.result.sourceId!;
    await setSourceIncluded(t.db, t.userId, api, false, '  Already counted in my Claude Code logs ');
    let coverage = await getCoverage(t.db, t.userId, 'UTC');
    expect(coverage.sources.find((s) => s.id === api)).toMatchObject({ includeInTotals: false, exclusionReason: 'Already counted in my Claude Code logs', exactTokens: 110_000 });
    expect(coverage.exactTokens).toBe(EXPECTED.processed.exact - 110_000);
    expect((await getOverview(t.db, lifetime())).tokens.total).toBe(EXPECTED.processed.total - 110_000);

    // no reason given is stored as no reason
    await setSourceIncluded(t.db, t.userId, api, false, '   ');
    coverage = await getCoverage(t.db, t.userId, 'UTC');
    expect(coverage.sources.find((s) => s.id === api)!.exclusionReason).toBeNull();

    // counting it again restores the totals and drops the reason
    await setSourceIncluded(t.db, t.userId, api, true);
    coverage = await getCoverage(t.db, t.userId, 'UTC');
    expect(coverage.sources.find((s) => s.id === api)).toMatchObject({ includeInTotals: true, exclusionReason: null });
    expect((await getOverview(t.db, lifetime())).tokens.total).toBe(EXPECTED.processed.total);
  });
});

describe('prices', () => {
  it('the built-in table has a traceable source for every row', async () => {
    const prices = await listPrices(t.db);
    expect(prices.length).toBeGreaterThan(40);
    expect(prices.every((p) => p.isBuiltin && /^https:\/\//.test(p.sourceUrl) && /^\d{4}-\d{2}-\d{2}$/.test(p.sourceRetrievedOn))).toBe(true);
    expect(prices.find((p) => p.modelKey === 'claude-sonnet-4-5' && p.priceTier === 'standard')).toMatchObject({
      input: '3',
      output: '15',
      cacheRead: '0.3',
      cacheWrite5m: '3.75',
      cacheWrite1h: '6',
      effectiveFrom: null,
    });
  });

  it('a price the user enters takes precedence, from its date on, and deleting it restores the built-in price', async () => {
    const before = await getApiValue(t.db, lifetime());
    // The API report holds 100,000 input and 10,000 output tokens of Opus 4.5 on 9 Mar 2025: $0.75 at the built-in $5 / $25.
    await saveUserPrice(t.db, { modelKey: 'claude-opus-4-5', input: '10', output: '50', sourceUrl: 'https://example.com/my-price', sourceNote: 'doubled for the test' });
    let prices = await listPrices(t.db);
    const mine = prices.find((p) => !p.isBuiltin)!;
    expect(mine).toMatchObject({ modelKey: 'claude-opus-4-5', priceTier: 'standard', input: '10', output: '50', cacheRead: null, sourceUrl: 'https://example.com/my-price', sourceNote: 'doubled for the test' });
    const builtin = prices.find((p) => p.isBuiltin && p.modelKey === 'claude-opus-4-5' && p.priceTier === 'standard')!;
    expect(replacedByUserPrices(prices).get(builtin.id)).toEqual({ scope: 'all' });

    const withMine = await getApiValue(t.db, lifetime());
    expect(minus(withMine.exactUsd, before.exactUsd)).toBe('0.75');
    expect(withMine.sources.some((s) => s.userEntered && s.url === 'https://example.com/my-price')).toBe(true);

    // the same price, but only from the day after the usage: the built-in price still applies to that day
    await deleteUserPrice(t.db, mine.id);
    await saveUserPrice(t.db, { modelKey: 'claude-opus-4-5', effectiveFrom: '2025-03-10', input: '10', output: '50', sourceUrl: 'https://example.com/my-price' });
    prices = await listPrices(t.db);
    const later = prices.find((p) => !p.isBuiltin)!;
    expect(replacedByUserPrices(prices).get(builtin.id)).toEqual({ scope: 'part', from: '2025-03-10' });
    expect((await getApiValue(t.db, lifetime())).exactUsd).toBe(before.exactUsd);

    await deleteUserPrice(t.db, later.id);
    expect((await listPrices(t.db)).every((p) => p.isBuiltin)).toBe(true);
    expect(await getApiValue(t.db, lifetime())).toEqual(before);
  });

  it('deleting never touches a built-in price', async () => {
    const prices = await listPrices(t.db);
    await deleteUserPrice(t.db, prices[0].id);
    expect((await listPrices(t.db)).length).toBe(prices.length);
  });

  it('a price without a web address is refused with a message for the user', async () => {
    await expect(saveUserPrice(t.db, { modelKey: 'claude-opus-4-5', input: '10', output: '50', sourceUrl: 'my notes' })).rejects.toThrow(SettingsError);
    await expect(saveUserPrice(t.db, { modelKey: 'no-such-model', input: '10', output: '50', sourceUrl: 'https://example.com' })).rejects.toThrow('That model is not in the catalog.');
  });

  it('a model without a standard price is not offered as an assumed model until the user prices it', async () => {
    const unpriced = (await listModels(t.db)).filter((m) => !m.hasStandardPrice).map((m) => m.modelKey);
    expect(unpriced).toContain('claude-2.1');
    await saveUserPrice(t.db, { modelKey: 'claude-2.1', input: '8', output: '24', sourceUrl: 'https://example.com/claude-2' });
    expect((await listModels(t.db)).find((m) => m.modelKey === 'claude-2.1')!.hasStandardPrice).toBe(true);
    const mine = (await listPrices(t.db)).find((p) => !p.isBuiltin)!;
    await deleteUserPrice(t.db, mine.id);
    expect((await listModels(t.db)).find((m) => m.modelKey === 'claude-2.1')!.hasStandardPrice).toBe(false);
  });
});

describe('about', () => {
  it('reads the PostgreSQL version the page shows', async () => {
    const { rows } = await t.db.query<{ version: string }>('SELECT version() AS version');
    const version = parsePostgresVersion(rows[0].version);
    expect(version.postgres).toMatch(/^\d+\.\d+/);
    expect(version.engine).toMatch(/^PGlite /);
  });
});

// Last: these tests remove the data the ones above read.
describe('delete data', () => {
  it('"Delete source" removes that source with its conversations and usage, and nothing else', async () => {
    const before = await getCoverage(t.db, t.userId, 'UTC');
    const result = await deleteSource(t.db, t.userId, ids.api.result.sourceId!);
    expect(result.deleted).toBe(true);
    const after = await getCoverage(t.db, t.userId, 'UTC');
    expect(after.sources.map((s) => s.kind).sort()).toEqual(['claude_code', 'claude_export']);
    expect(after.exactTokens).toBe(before.exactTokens - 110_000);
    expect(after.estimatedTokens).toBe(before.estimatedTokens);
    expect((await getOverview(t.db, lifetime())).tokens.total).toBe(EXPECTED.processed.total - 110_000);
  });

  it('"Delete all imported data" keeps settings, subscription history and entered prices unless they are ticked', async () => {
    await updateSettings(t.db, t.userId, { basis: 'new', costScenario: 'cached', assumedModelKey: 'claude-sonnet-4-5', timezone: 'Europe/Berlin' });
    await savePeriod(t.db, t.userId, 'Europe/Berlin', { planKey: 'pro', startDate: '2025-01-01', monthlyPrice: '20' });
    await saveUserPrice(t.db, { modelKey: 'claude-opus-4-5', input: '10', output: '50', sourceUrl: 'https://example.com/my-price' });
    const builtinPrices = (await listPrices(t.db)).filter((p) => p.isBuiltin).length;

    await deleteAllData(t.db, t.userId);
    let coverage = await getCoverage(t.db, t.userId, 'Europe/Berlin');
    expect(coverage.hasData).toBe(false);
    expect(coverage.sources).toEqual([]);
    expect((await getOverview(t.db, lifetime())).tokens.total).toBe(0);
    expect((await listPeriods(t.db, t.userId, 'Europe/Berlin')).map((p) => p.planKey)).toEqual(['pro']);
    expect((await listPrices(t.db)).filter((p) => !p.isBuiltin).length).toBe(1);
    expect(await getSettings(t.db, t.userId)).toEqual({ timezone: 'Europe/Berlin', basis: 'new', costScenario: 'cached', assumedModelKey: 'claude-sonnet-4-5' });

    await deleteAllData(t.db, t.userId, { subscriptions: true, customPrices: true });
    coverage = await getCoverage(t.db, t.userId, 'Europe/Berlin');
    expect(coverage.hasData).toBe(false);
    expect(await listPeriods(t.db, t.userId, 'Europe/Berlin')).toEqual([]);
    const prices = await listPrices(t.db);
    expect(prices.filter((p) => !p.isBuiltin)).toEqual([]);
    // the built-in table and the settings are never part of it
    expect(prices.length).toBe(builtinPrices);
    expect(await getSettings(t.db, t.userId)).toEqual({ timezone: 'Europe/Berlin', basis: 'new', costScenario: 'cached', assumedModelKey: 'claude-sonnet-4-5' });
  });
});
