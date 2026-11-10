import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getCoverage } from '@/analytics/coverage';
import { getModelBreakdown } from '@/analytics/models';
import { setSourceIncluded } from '@/analytics/settings';
import { getApiValue, type ApiValue } from '@/analytics/value';
import { TooltipProvider } from '@/components/ui/overlay';
import { ModelTableCard } from '@/features/models/model-table';
import { NoModelRows } from '@/features/models/models-page';
import { nothingPricedReason, ValueCard } from '@/features/models/value-card';
import { commitImport, previewImport } from '@/import/commit';
import { genericCsvParser } from '@/import/generic';
import { resetStaging, StagingWriter } from '@/import/staging';
import { loadDataset } from '../helpers/dataset';
import { createTestDb, type TestDb } from '../helpers/db';
import { fileOf } from '../helpers/sink';
import { importRecords, usage } from '../helpers/staged';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement('a', { href, ...rest }, children),
}));

/**
 * Model Breakdown says no more than the stored records establish: a count a record states
 * is shown, a dash stands only for a category no record has, every source left out of
 * totals is named as the reason for an empty page, an unpriced range lists no zero parts,
 * and links carry no arrow after their text.
 */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
const render = (element: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, element));
const rows = (html: string) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])));
const lifetime = (basis: AnalyticsFilter['basis'] = 'processed'): AnalyticsFilter => ({ userId: t.userId, timezone: 'UTC', basis });

/** The documented example table, imported with its default answer: the counts are estimated. */
async function importExampleCsv(content = readFileSync(fileURLToPath(new URL('../fixtures/generic/usage.csv', import.meta.url)), 'utf8')) {
  await resetStaging(t.db);
  const writer = new StagingWriter(t.db);
  const parsed = await genericCsvParser.parse([fileOf('usage.csv', content)], writer, { options: { now: Date.UTC(2026, 10, 10) } });
  await writer.finish();
  await previewImport(t.db, t.userId, parsed);
  return commitImport(t.db, t.userId, parsed);
}

describe('the comparison table shows what the records hold', () => {
  it('shows the cache counts an estimated table states, and a dash only where no record of the row has one', async () => {
    await importExampleCsv();
    const models = await getModelBreakdown(t.db, lifetime());
    const sonnet = models.find((m) => m.modelKey === 'claude-sonnet-4-6')!;
    expect(sonnet).toMatchObject({ exact: 0, cacheRead: 17_100, cacheWrite5m: 500 });
    expect(sonnet.recorded).toEqual({ cacheRead: true, cacheWrite: true, replay: false });
    // The table states no cache column for these rows: nothing is recorded, so nothing is claimed.
    expect(models.find((m) => m.modelKey === 'claude-opus-4-6')!.recorded).toEqual({ cacheRead: false, cacheWrite: false, replay: false });
    expect(models.find((m) => m.modelKey === 'claude-haiku-4-5')!.recorded).toEqual({ cacheRead: false, cacheWrite: true, replay: false });

    const table = rows(render(createElement(ModelTableCard, { rows: models, basis: 'processed', scenario: 'standard', assumedModelName: null })));
    const row = (name: string) => table.find((cells) => cells[0] === name)!;
    // Model, family, input, output, cache read, cache write, re-read context, total, ...
    expect(row('Claude Sonnet 4.6').slice(2, 8)).toEqual(['3,400', '760', '17.1K', '500', '–', '21.8K Estimated']);
    expect(row('Claude Opus 4.6').slice(4, 7)).toEqual(['–', '–', '–']);
    expect(row('Claude Haiku 4.5').slice(4, 7)).toEqual(['–', '250', '–']);
    // The visible parts of each row add up to its total.
    for (const m of models) expect(m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h + m.replay).toBe(m.total);
  });

  it('keeps metered zeros, modelled re-reading and a dash for the categories a chat export cannot know', async () => {
    await loadDataset(t);
    const models = await getModelBreakdown(t.db, lifetime());
    const html = render(createElement(ModelTableCard, { rows: models, basis: 'processed', scenario: 'standard', assumedModelName: null }));
    const table = rows(html);
    // Haiku 5.5 comes from Claude Code logs, which state cache counts on every record: its zeros are real zeros.
    expect(table.find((c) => c[0] === 'Claude Haiku 5.5')!.slice(4, 7)).toEqual(['0', '0', '–']);
    // The unknown-model row mixes chat estimates (re-read context modelled) and a Claude Code record (cache stated).
    expect(table.find((c) => c[0] === 'Unknown model')!.slice(4, 7)).toEqual(['0', '0', '100']);
    expect(html).toContain('Counts that a source states show cache reads instead, where the source records them.');
  });

  it('puts a dash in the totals row for a category that no row records', async () => {
    await importExampleCsv(['date,model,input_tokens,output_tokens', '2026-03-01,claude-sonnet-4-6,400,100'].join('\n'));
    const models = await getModelBreakdown(t.db, lifetime());
    const table = rows(render(createElement(ModelTableCard, { rows: models, basis: 'processed', scenario: 'standard', assumedModelName: null })));
    expect(table.find((c) => c[0] === 'All models')!.slice(4, 7)).toEqual(['–', '–', '–']);
  });
});

describe('an empty breakdown names its real reason', () => {
  const props = { scoped: false, rangeLabel: 'All time', onShowAll: () => undefined };

  it('says that every source is left out of totals and links to the sources in Settings', async () => {
    const { sourceId } = await importExampleCsv();
    await setSourceIncluded(t.db, t.userId, sourceId!, false, 'comparing with the Admin API report');
    expect(await getModelBreakdown(t.db, lifetime())).toEqual([]);
    const coverage = await getCoverage(t.db, t.userId, 'UTC');
    for (const scoped of [false, true]) {
      const html = render(createElement(NoModelRows, { ...props, scoped, coverage }));
      expect(text(html)).toContain('Every source is left out of totals');
      expect(text(html)).toContain('Your imports hold token usage, but every source is left out of totals');
      expect(html).toContain('href="/settings/#sources"');
      expect(text(html)).not.toContain('contain no token usage');
      expect(text(html)).not.toContain('No usage in this range');
    }
  });

  it('keeps the existing wording where it is true', async () => {
    await importExampleCsv();
    const coverage = await getCoverage(t.db, t.userId, 'UTC');
    expect(text(render(createElement(NoModelRows, { ...props, scoped: true, coverage })))).toContain('No usage in this range');
    const costOnly = { ...coverage, sources: coverage.sources.map((s) => ({ ...s, hasUsage: false })) };
    expect(text(render(createElement(NoModelRows, { ...props, coverage: costOnly })))).toContain('Your imports contain no token usage');
  });
});

describe('the value card when nothing can be priced', () => {
  const card = (value: ApiValue) => text(render(createElement(ValueCard, { value, scenario: 'standard', rangeLabel: 'All time', scoped: false })));

  it('says why instead of listing parts at $0.00', async () => {
    await importExampleCsv(['timestamp,model,input_tokens,output_tokens,id', '2026-03-01T09:15:00Z,,120000,35000,r1', '2026-03-02T09:15:00Z,my-proxy-model,50000,5000,r2'].join('\n'));
    const value = await getApiValue(t.db, lifetime());
    expect(value.pricedTokens).toBe(0);
    const shown = card(value);
    expect(shown).not.toContain('Exact usage');
    expect(shown).not.toContain('at its own published price');
    expect(shown).not.toContain('$0.00');
    expect(shown).toContain(
      'Nothing in this range can be priced. For part of the usage its source records no model, and no model is guessed. The rest is on a model or price tier that has no published price on file.',
    );
  });

  it('names the one reason when there is one', () => {
    const group = (reason: 'unknown_model' | 'no_price') => ({ reason, modelKey: null, displayName: null, priceTier: 'standard', tokens: 10 });
    expect(nothingPricedReason({ unpriced: [group('unknown_model')], assumedModel: null })).toBe(
      'Nothing in this range can be priced: its source records no model, and no model is guessed.',
    );
    expect(nothingPricedReason({ unpriced: [group('no_price')], assumedModel: null })).toBe(
      'Nothing in this range can be priced: its models or price tiers have no published price on file.',
    );
    expect(nothingPricedReason({ unpriced: [group('unknown_model')], assumedModel: { modelKey: 'x', displayName: 'Claude X' } })).toBe(
      'Nothing in this range can be priced: its source records no model, and Claude X, the model you chose to price it as, has no price on file for it.',
    );
  });

  it('keeps the web searches, which have a price of their own, when no token usage can be priced', async () => {
    // A report on a model with no published price that also made web searches: $10 per 1,000 searches.
    await importRecords(
      t.db,
      t.userId,
      {
        models: [{ key: 'claude-opus-9', displayName: 'claude-opus-9', family: 'opus', tokenizerFamily: 'unknown' }],
        usage: [usage('api:1', { modelKey: 'claude-opus-9', occurredAt: '2026-03-09T00:00:00.000Z', bucketSeconds: 86_400, webSearchRequests: 500 })],
      },
      { source: { kind: 'api_usage_report', label: 'Anthropic API usage report', externalRef: '' }, contentHash: 'api' },
    );
    const value = await getApiValue(t.db, lifetime());
    expect(value.pricedTokens).toBe(0);
    expect(Number(value.webSearchUsd)).toBe(5);
    const shown = card(value);
    // The total is the price of the searches, and their line is there; the token parts are replaced by the reason.
    expect(shown).toContain('$5.00');
    expect(shown).toContain('Web search Billed per search');
    expect(shown).toContain('No token usage in this range can be priced: its models or price tiers have no published price on file.');
    expect(shown).not.toContain('Nothing in this range can be priced');
    expect(shown).not.toContain('Exact usage');
    expect(shown).not.toContain('Nothing in this range could be priced');
  });

  it('does not say that no estimated usage is priced next to a priced estimate', async () => {
    // The example table, estimated, with models that have prices: the two scenarios agree because a stated count has no re-read context.
    await importExampleCsv();
    const value = await getApiValue(t.db, lifetime());
    expect(Number(value.estimatedStandardUsd)).toBeGreaterThan(0);
    expect(value.totalCachedUsd).toBe(value.totalStandardUsd);
    const shown = card(value);
    expect(shown).not.toContain('no estimated usage in this range is priced');
    expect(shown).toContain('Both scenarios give the same total here: the estimated usage in this range is counts that a file or an entry states');
  });

  it('still lists the parts when something is priced, and the price links carry no arrow', async () => {
    await loadDataset(t);
    const value = await getApiValue(t.db, lifetime());
    const html = render(createElement(ValueCard, { value, scenario: 'standard', rangeLabel: 'All time', scoped: false }));
    expect(text(html)).toContain('Exact usage Every token category at its own published price');
    const links = [...html.matchAll(/<a [^>]*target="_blank"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).not.toContain('<svg');
      expect(link).toContain('(opens in a new tab)');
    }
  });
});
