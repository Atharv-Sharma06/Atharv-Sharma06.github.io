import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getCoverage } from '@/analytics/coverage';
import { getModelBreakdown, type ModelUsage } from '@/analytics/models';
import { getOverview, getTimeSeries } from '@/analytics/overview';
import { getApiValue, ZERO_FIGURES } from '@/analytics/value';
import { familyOf, familySlices, modelTotals, ringArcs, rowValue, sortModels } from '@/features/models/families';
import { loadDemoDataset } from '@/import/demo/load';
import { FAMILY_ORDER, NEUTRAL } from '@/lib/palette';
import { createTestDb, type TestDb } from '../helpers/db';

const model = (displayName: string, over: Partial<ModelUsage> = {}): ModelUsage => {
  const total = over.total ?? 0;
  return {
    modelKey: displayName.toLowerCase().replace(/\s+/g, '-'),
    displayName,
    family: 'sonnet',
    inCatalog: true,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    replay: 0,
    total,
    exact: total,
    estimated: 0,
    share: 0,
    conversations: 0,
    requests: 0,
    value: ZERO_FIGURES,
    recorded: { cacheRead: true, cacheWrite: true, replay: false },
    ...over,
  };
};
const priced = (usd: string, tokens = 1) => ({ ...ZERO_FIGURES, exactUsd: usd, totalStandardUsd: usd, totalCachedUsd: usd, pricedTokens: tokens });

describe('model families for the chart', () => {
  it('never files usage without a recorded model under a real family', () => {
    expect(familyOf({ modelKey: null, family: 'unknown' })).toBe('unknown');
    // whatever the row says about its family, no model means no family
    expect(familyOf({ modelKey: null, family: 'sonnet' })).toBe('unknown');
    expect(familyOf({ modelKey: 'claude-sonnet-4-5', family: 'sonnet' })).toBe('sonnet');
    expect(familyOf({ modelKey: 'claude-2.1', family: 'claude-2' })).toBe('claude-2');
    // a named model keeps an identity even when its family has no slot of its own
    expect(familyOf({ modelKey: 'some-new-model', family: 'nova' })).toBe('other');
    expect(familyOf({ modelKey: 'odd-model', family: 'unknown' })).toBe('other');
  });

  it('adds models up per family in the fixed order of the palette', () => {
    const { slices, total, exact, estimated } = familySlices([
      model('Unknown model', { modelKey: null, family: 'unknown', total: 100, exact: 0, estimated: 100 }),
      model('Claude Haiku 4.5', { family: 'haiku', total: 50 }),
      model('Claude Sonnet 4.5', { family: 'sonnet', total: 500 }),
      model('Claude Sonnet 5', { family: 'sonnet', total: 250, exact: 200, estimated: 50 }),
      model('Claude Opus 4.5', { family: 'opus', total: 100 }),
      model('requests only', { family: 'fable', total: 0, requests: 3 }),
    ]);
    expect(total).toBe(1000);
    expect(exact).toBe(850);
    expect(estimated).toBe(150);
    expect(slices.map((s) => [s.family, s.label, s.tokens, s.exact, s.estimated, s.models])).toEqual([
      ['sonnet', 'Claude Sonnet', 750, 700, 50, 2],
      ['opus', 'Claude Opus', 100, 100, 0, 1],
      ['haiku', 'Claude Haiku', 50, 50, 0, 1],
      ['unknown', 'Unknown model', 100, 0, 100, 1],
    ]);
    expect(slices.map((s) => s.share)).toEqual([0.75, 0.1, 0.05, 0.1]);
    expect(slices.find((s) => s.family === 'unknown')!.color).toBe(NEUTRAL);
    expect(new Set(slices.map((s) => s.color)).size).toBe(slices.length);
    // the palette has eight slots and the neutral colour: no input produces more slices
    const everything = familySlices([...FAMILY_ORDER, 'nova', 'zeta'].map((family, i) => model(`m${i}`, { family, modelKey: family === 'unknown' ? null : `m${i}`, total: 1 })));
    expect(everything.slices.map((s) => s.family)).toEqual([...FAMILY_ORDER]);
    expect(everything.slices.find((s) => s.family === 'other')!.models).toBe(3);
    expect(familySlices([])).toEqual({ slices: [], total: 0, exact: 0, estimated: 0 });
  });
});

describe('the ring', () => {
  const TURN = Math.PI * 2;
  const GAP = 0.02;
  const MIN = 0.03;
  const width = (arc: { start: number; end: number }) => arc.end - arc.start;

  it('gives each value its share of the ring, with a gap between neighbours', () => {
    const arcs = ringArcs([600, 300, 100], GAP, MIN);
    const room = TURN - 3 * GAP;
    expect(arcs.map(width)).toEqual([expect.closeTo(room * 0.6, 10), expect.closeTo(room * 0.3, 10), expect.closeTo(room * 0.1, 10)]);
    expect(arcs[0].start).toBeCloseTo(GAP / 2, 10);
    expect(arcs[1].start - arcs[0].end).toBeCloseTo(GAP, 10);
    expect(arcs[2].start - arcs[1].end).toBeCloseTo(GAP, 10);
    // the last gap closes the circle
    expect(TURN - arcs[2].end + arcs[0].start).toBeCloseTo(GAP, 10);
  });

  it('keeps a value that is too small to see at a visible width, and takes the room from the others', () => {
    const arcs = ringArcs([900_000, 99_990, 10], GAP, MIN);
    expect(width(arcs[2])).toBeCloseTo(MIN, 10);
    const room = TURN - 3 * GAP - MIN;
    expect(width(arcs[0])).toBeCloseTo((room * 900_000) / 999_990, 10);
    expect(arcs.reduce((sum, arc) => sum + width(arc), 0) + 3 * GAP).toBeCloseTo(TURN, 10);
    // the order around the ring is the order of the values
    expect(arcs[0].end).toBeLessThan(arcs[1].start);
    expect(arcs[1].end).toBeLessThan(arcs[2].start);
  });

  it('draws a single value as a full ring and leaves out values without tokens', () => {
    expect(ringArcs([42], GAP, MIN)).toEqual([{ start: 0, end: TURN }]);
    expect(ringArcs([], GAP, MIN)).toEqual([]);
    const withZero = ringArcs([0, 5, 0], GAP, MIN);
    expect(withZero[1]).toEqual({ start: 0, end: TURN });
    expect(width(withZero[0])).toBe(0);
    expect(width(withZero[2])).toBe(0);
    expect(ringArcs([0, 0], GAP, MIN).every((arc) => width(arc) === 0)).toBe(true);
    // more tiny values than there is room for still fit on the ring
    const many = ringArcs(Array.from({ length: 400 }, () => 1), GAP, MIN);
    expect(many.reduce((sum, arc) => sum + width(arc), 0) + 400 * GAP).toBeCloseTo(TURN, 8);
  });
});

describe('the comparison table', () => {
  const rows = [
    model('Claude Sonnet 4.5', { total: 900, input: 5, cacheWrite5m: 10, cacheWrite1h: 2, value: priced('12.5') }),
    model('Unknown model', { modelKey: null, family: 'unknown', total: 500, input: 80, value: { ...ZERO_FIGURES, unpricedTokens: 500 } }),
    model('Claude Opus 4.5', { family: 'opus', total: 300, input: 9, cacheWrite5m: 1, cacheWrite1h: 30, value: priced('40') }),
    model('claude-opus-9', { family: 'opus', inCatalog: false, total: 100, input: 9, value: { ...ZERO_FIGURES, unpricedTokens: 100 } }),
    model('Claude Sonnet 10', { total: 50, input: 1, value: priced('0.004') }),
  ];
  const names = (sorted: ModelUsage[]) => sorted.map((r) => r.displayName);

  it('sorts by any figure in either direction', () => {
    expect(names(sortModels(rows, 'total', 'desc', 'standard'))).toEqual(['Claude Sonnet 4.5', 'Unknown model', 'Claude Opus 4.5', 'claude-opus-9', 'Claude Sonnet 10']);
    expect(names(sortModels(rows, 'total', 'asc', 'standard'))).toEqual(['Claude Sonnet 10', 'claude-opus-9', 'Claude Opus 4.5', 'Unknown model', 'Claude Sonnet 4.5']);
    expect(names(sortModels(rows, 'cacheWrite', 'desc', 'standard')).slice(0, 2)).toEqual(['Claude Opus 4.5', 'Claude Sonnet 4.5']);
    // equal figures keep the order they came in
    expect(names(sortModels(rows, 'input', 'desc', 'standard'))).toEqual(['Unknown model', 'Claude Opus 4.5', 'claude-opus-9', 'Claude Sonnet 4.5', 'Claude Sonnet 10']);
    expect(rows.map((r) => r.displayName)[0]).toBe('Claude Sonnet 4.5');
  });

  it('sorts names the way a person reads them', () => {
    // 4.5 before 10, whatever the case; an identifier written with hyphens comes after the names written with spaces
    expect(names(sortModels(rows, 'name', 'asc', 'standard'))).toEqual(['Claude Opus 4.5', 'Claude Sonnet 4.5', 'Claude Sonnet 10', 'claude-opus-9', 'Unknown model']);
    expect(names(sortModels(rows, 'name', 'desc', 'standard'))[0]).toBe('Unknown model');
  });

  it('keeps rows that could not be priced at the end when sorting by value', () => {
    expect(rowValue(rows[0], 'standard')).toBe('12.5');
    expect(rowValue(rows[1], 'standard')).toBeNull();
    expect(names(sortModels(rows, 'value', 'desc', 'standard'))).toEqual(['Claude Opus 4.5', 'Claude Sonnet 4.5', 'Claude Sonnet 10', 'Unknown model', 'claude-opus-9']);
    expect(names(sortModels(rows, 'value', 'asc', 'standard'))).toEqual(['Claude Sonnet 10', 'Claude Sonnet 4.5', 'Claude Opus 4.5', 'Unknown model', 'claude-opus-9']);
  });

  it('follows the leading cost scenario', () => {
    const a = model('a', { value: { ...ZERO_FIGURES, pricedTokens: 1, totalStandardUsd: '10', totalCachedUsd: '2' } });
    const b = model('b', { value: { ...ZERO_FIGURES, pricedTokens: 1, totalStandardUsd: '5', totalCachedUsd: '4' } });
    expect(rowValue(a, 'standard')).toBe('10');
    expect(rowValue(a, 'cached')).toBe('2');
    expect(names(sortModels([a, b], 'value', 'desc', 'standard'))).toEqual(['a', 'b']);
    expect(names(sortModels([a, b], 'value', 'desc', 'cached'))).toEqual(['b', 'a']);
  });

  it('adds the rows up, money exactly', () => {
    const totals = modelTotals([
      model('a', { total: 10, exact: 6, estimated: 4, input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, replay: 6, requests: 7, value: priced('0.1', 9) }),
      model('b', { total: 5, input: 10, requests: 1, value: priced('0.2', 5) }),
      model('c', { total: 1, value: { ...ZERO_FIGURES, unpricedTokens: 1 } }),
    ]);
    expect(totals).toEqual({
      input: 11, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, replay: 6, total: 16, exact: 12, estimated: 4, requests: 8, pricedTokens: 14,
      // 0.1 + 0.2 is 0.30000000000000004 in floating point
      standardUsd: '0.3', cachedUsd: '0.3',
    });
    expect(modelTotals([])).toMatchObject({ total: 0, standardUsd: '0', cachedUsd: '0', pricedTokens: 0 });
  });
});

describe('figures on the Model Breakdown page, against the demo dataset', () => {
  const NOW = new Date('2026-11-10T12:00:00Z');
  let t: TestDb;
  const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: 'UTC', basis: 'processed', ...over });
  const one = async <T,>(sql: string, values: unknown[] = []) => (await t.db.query<T>(sql, values)).rows[0];
  const PROCESSED = `input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens + replay_tokens`;

  beforeAll(async () => {
    t = await createTestDb('UTC');
    await loadDemoDataset(t.db, t.userId, 'UTC', NOW);
  });
  afterAll(() => t.close());

  it('puts every recorded token in exactly one slice of the ring', async () => {
    const rows = await getModelBreakdown(t.db, filter());
    const ring = familySlices(rows);
    const direct = await one<{ total: string; without_model: string; estimated: string }>(
      `SELECT sum(${PROCESSED})::text AS total, sum(${PROCESSED}) FILTER (WHERE model_id IS NULL)::text AS without_model,
              sum(${PROCESSED}) FILTER (WHERE confidence = 'estimated')::text AS estimated
         FROM usage_facts`,
    );
    expect(ring.total).toBe(Number(direct.total));
    expect(ring.estimated).toBe(Number(direct.estimated));
    expect(ring.exact + ring.estimated).toBe(ring.total);
    expect(ring.slices.reduce((sum, s) => sum + s.tokens, 0)).toBe(ring.total);
    expect(ring.slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 12);
    expect(ring.slices.reduce((sum, s) => sum + s.models, 0)).toBe(rows.length);
    expect(ring.total).toBe((await getOverview(t.db, filter())).tokens.total);

    // the centre of the ring and the unknown slice are the figures the Overview shows
    const unknown = ring.slices.find((s) => s.family === 'unknown')!;
    expect(unknown.tokens).toBe(Number(direct.without_model));
    expect(unknown.tokens).toBe((await getCoverage(t.db, t.userId, 'UTC')).tokensWithoutModel);
    expect(unknown).toMatchObject({ exact: 0, models: 1, color: NEUTRAL });
    expect(ring.slices.map((s) => s.family)).toEqual(['sonnet', 'opus', 'haiku', 'unknown']);

    // the same families as the time series groups them
    const byFamily = await getTimeSeries(t.db, filter(), 'year', 'family');
    const perFamily = new Map<string, number>();
    for (const p of byFamily) perFamily.set(p.group, (perFamily.get(p.group) ?? 0) + p.tokens);
    expect(Object.fromEntries(ring.slices.map((s) => [s.family, s.tokens]))).toEqual(Object.fromEntries(perFamily));
  });

  it('follows the token basis and the date range', async () => {
    const fresh = familySlices(await getModelBreakdown(t.db, filter({ basis: 'new' })));
    const direct = await one<{ total: string }>(
      `SELECT sum(input_tokens + output_tokens + cache_write_5m_tokens + cache_write_1h_tokens)::text AS total FROM usage_facts`,
    );
    expect(fresh.total).toBe(Number(direct.total));
    expect(fresh.total).toBeLessThan(familySlices(await getModelBreakdown(t.db, filter())).total);

    const range = { from: '2026-01-01', to: '2026-03-31' };
    const ranged = familySlices(await getModelBreakdown(t.db, filter(range)));
    expect(ranged.total).toBe((await getOverview(t.db, filter(range))).tokens.total);
    expect(ranged.total).toBeGreaterThan(0);
    expect(await getModelBreakdown(t.db, filter({ from: '2020-01-01', to: '2020-12-31' }))).toEqual([]);
  });

  it('adds the table up to the totals row and to the value card', async () => {
    const rows = await getModelBreakdown(t.db, filter());
    const totals = modelTotals(rows);
    const value = await getApiValue(t.db, filter());
    const overview = await getOverview(t.db, filter());
    expect(totals).toMatchObject({
      total: overview.tokens.total,
      exact: overview.tokens.exact,
      estimated: overview.tokens.estimated,
      input: overview.tokens.input,
      output: overview.tokens.output,
      cacheRead: overview.tokens.cacheRead,
      replay: overview.tokens.replay,
      requests: overview.requests,
      pricedTokens: value.pricedTokens,
    });
    expect(totals.cacheWrite5m + totals.cacheWrite1h).toBe(overview.tokens.cacheWrite);
    // rows are rounded to six decimals each, so the sum may differ from the total in the last of them
    expect(Math.abs(Number(totals.standardUsd) - Number(value.totalStandardUsd))).toBeLessThan(0.0001);
    expect(Math.abs(Number(totals.cachedUsd) - Number(value.totalCachedUsd))).toBeLessThan(0.0001);
    expect(value.pricedTokens + value.unpricedTokens).toBe(overview.tokens.total);

    // sorted by value, the unpriced row is last, and the default order is by total
    const byValue = sortModels(rows, 'value', 'desc', 'standard');
    expect(byValue[byValue.length - 1].modelKey).toBeNull();
    expect(Number(rowValue(byValue[0], 'standard'))).toBeGreaterThan(Number(rowValue(byValue[1], 'standard')));
    expect(sortModels(rows, 'total', 'desc', 'standard').map((r) => r.modelKey)).toEqual(rows.map((r) => r.modelKey));
  });

  it('prices unknown-model usage only under an explicit assumption', async () => {
    const plain = await getApiValue(t.db, filter());
    expect(plain.assumedModel).toBeNull();
    expect(plain.unpriced).toEqual([expect.objectContaining({ reason: 'unknown_model', modelKey: null, priceTier: 'standard', tokens: plain.unpricedTokens })]);
    expect(plain.estimatedStandardUsd).toBe('0');
    expect(plain.totalStandardUsd).toBe(plain.totalCachedUsd);

    const assumed = await getApiValue(t.db, filter(), { assumedModelKey: 'claude-sonnet-4-5' });
    expect(assumed.assumedModel).toEqual({ modelKey: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' });
    expect(assumed.assumedTokens).toBe(plain.unpricedTokens);
    expect(assumed.unpricedTokens).toBe(0);
    expect(assumed.exactUsd).toBe(plain.exactUsd);
    // the two scenarios now differ, and only in the estimated part
    expect(Number(assumed.estimatedStandardUsd)).toBeGreaterThan(Number(assumed.estimatedCachedUsd));
    expect(Number(assumed.totalStandardUsd) - Number(assumed.totalCachedUsd)).toBeCloseTo(Number(assumed.estimatedStandardUsd) - Number(assumed.estimatedCachedUsd), 4);
    const unknownRow = (await getModelBreakdown(t.db, filter(), { assumedModelKey: 'claude-sonnet-4-5' })).find((r) => r.modelKey === null)!;
    expect(unknownRow.value.assumedTokens).toBe(unknownRow.total);
    expect(rowValue(unknownRow, 'cached')).toBe(unknownRow.value.totalCachedUsd);
  });
});
