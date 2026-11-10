import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOverview, getTimeSeries, type Overview } from '@/analytics/overview';
import { getApiValue, type ApiValue } from '@/analytics/value';
import { ConfidenceBadge } from '@/components/data/confidence';
import { TooltipProvider } from '@/components/ui/overlay';
import type { StagedCost } from '@/core/types';
import { ApiValueCard, apiValueHint, Composition, Hero, MostActiveDayCard, unpricedSentence } from '@/features/overview/overview';
import { commitImport, previewImport } from '@/import/commit';
import { genericCsvParser } from '@/import/generic';
import { resetStaging, StagingWriter } from '@/import/staging';
import { loadDataset } from '../helpers/dataset';
import { createTestDb, type TestDb } from '../helpers/db';
import { fileOf } from '../helpers/sink';
import { conv, importRecords, msg, usage } from '../helpers/staged';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement('a', { href, ...rest }, children),
}));

/**
 * The overview's hero and cards say no more than the imported files establish: no zero
 * for what is not known, the real reason a token is not priced, the caching scenario and
 * the assumed model behind the API value, and what the band of an estimate covers.
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
    .replace(/\s+/g, ' ');
// Cards carry a confidence badge, whose tooltip needs the provider the app shell puts around every page.
const render = (element: ReactElement) => text(renderToStaticMarkup(createElement(TooltipProvider, null, element)));

const lifetime = (basis: 'processed' | 'new' = 'processed') => ({ userId: t.userId, timezone: 'UTC', basis });
const overview = (basis: 'processed' | 'new' = 'processed') => getOverview(t.db, lifetime(basis));
const composition = (o: Overview, basis: 'processed' | 'new' = 'processed') => render(createElement(Composition, { tokens: o.tokens, basis }));

async function importCsv(content: string) {
  await resetStaging(t.db);
  const writer = new StagingWriter(t.db);
  const parsed = await genericCsvParser.parse([fileOf('usage.csv', content)], writer, { options: { now: Date.UTC(2026, 10, 10) } });
  await writer.finish();
  await previewImport(t.db, t.userId, parsed);
  return commitImport(t.db, t.userId, parsed);
}

const TOTALS_ONLY = ['date,model,total_tokens', '2026-03-01,claude-sonnet-4-6,400000', '2026-03-02,claude-sonnet-4-6,600000'].join('\n');

describe('what the total is made of', () => {
  it('shows totals without a split on their own line, and no zero for what no record states', async () => {
    await importCsv(TOTALS_ONLY);
    const o = await overview();
    expect(o.tokens).toMatchObject({ total: 1_000_000, input: 0, unsplit: 1_000_000 });
    const html = composition(o);
    expect(html).toContain('Not split into input and output 1M');
    expect(html).toContain('Input –');
    expect(html).toContain('Output –');
    expect(html).toContain('Cache reads –');
    expect(html).not.toMatch(/ 0 /);
    // Re-read context is a model for chat exports; without one in the range the line is not there at all.
    expect(html).not.toContain('Re-read context');
    expect(html).toContain(
      'No record in this range counts any input, output, cache writes, or cache reads. Whether there were none or the source does not record them is not known, so no figure is shown.',
    );
  });

  it('shows no zero for the output of a table that has no output column', async () => {
    await importCsv(['date,model,input_tokens', '2026-03-01,claude-sonnet-4-6,400000'].join('\n'));
    const o = await overview();
    expect(o.tokens).toMatchObject({ total: 400_000, input: 400_000, output: 0, unsplit: 0 });
    expect(o.tokens.recorded).toMatchObject({ input: true, output: false });
    const html = composition(o);
    expect(html).toContain('Input 400K');
    expect(html).toContain('Output –');
    expect(html).not.toMatch(/Output 0/);
    expect(html).toContain('No record in this range counts any output, cache writes, or cache reads.');

    // The other way round, and both columns: each side is shown for what the records hold.
    await t.reset();
    await importCsv(['date,model,output_tokens', '2026-03-01,claude-sonnet-4-6,50000'].join('\n'));
    const outputOnly = composition(await overview());
    expect(outputOnly).toContain('Input –');
    expect(outputOnly).toContain('Output 50K');
    await t.reset();
    await importCsv(['date,model,input_tokens,output_tokens', '2026-03-01,claude-sonnet-4-6,400000,50000'].join('\n'));
    const both = composition(await overview());
    expect(both).toContain('Input 400K');
    expect(both).toContain('Output 50K');
  });

  it('words the note for a single category in the singular', async () => {
    // A chat export alone: input, output and re-read context are estimated from the text; caches are not part of it.
    await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1)] }, { contentHash: 'chat' });
    const html = composition(await overview(), 'new');
    expect(html).toContain('No record in this range counts any cache writes. Whether there was none or the source does not record it is not known, so no figure is shown.');
  });

  it('charts those totals as their own series over time, not as input', async () => {
    await importCsv(['date,model,total_tokens,input_tokens,output_tokens', '2026-03-02,claude-sonnet-4-6,10000,,', '2026-03-02,claude-sonnet-4-6,,1000,500'].join('\n'));
    const [point] = await getTimeSeries(t.db, lifetime(), 'day');
    expect(point).toMatchObject({ bucket: '2026-03-02', tokens: 11_500, input: 1000, output: 500, unsplit: 10_000 });
    // The same split as the totals of the overview.
    expect((await overview()).tokens).toMatchObject({ input: 1000, output: 500, unsplit: 10_000 });
  });

  it('keeps metered zeros of a source that states every category, and dashes what only chat estimates have', async () => {
    await importRecords(t.db, t.userId, { usage: [usage('u1', { cacheWrite5mTokens: 0 })] }, { source: { kind: 'claude_code', label: 'Claude Code', externalRef: 'x' }, contentHash: 'c' });
    const html = composition(await overview());
    expect(html).toContain('Input 1,000');
    expect(html).toContain('Cache writes 0');
    // What a metered source re-reads is counted as cache reads. The modelled figure of chat exports has no line here.
    expect(html).not.toContain('Re-read context');
    expect(html).not.toContain('No record in this range');
    expect(html).not.toContain('Not split');
  });

  it('shows the re-read context of a chat export next to the metered categories', async () => {
    await importRecords(t.db, t.userId, { usage: [usage('u1')] }, { source: { kind: 'claude_code', label: 'Claude Code', externalRef: 'x' }, contentHash: 'c' });
    await importRecords(t.db, t.userId, { conversations: [conv('a')], messages: [msg('a', 0), msg('a', 1), msg('a', 2), msg('a', 3)] }, { contentHash: 'chat' });
    const html = composition(await overview());
    expect(html).toMatch(/Re-read context [\d.,]+[KM]?/);
    expect(html).not.toContain('–');
  });

  it('shows every category of the full dataset as before', async () => {
    await loadDataset(t);
    const o = await overview();
    const html = composition(o);
    expect(html).not.toContain('–');
    expect(html).not.toContain('No record in this range');
    expect(o.tokens.unsplit).toBe(0);
  });

  it('prints no zeros when there is no token usage at all, only a cost report', async () => {
    const cost: StagedCost = {
      modelKey: 'claude-sonnet-4-5',
      occurredAt: '2026-04-01T00:00:00.000Z',
      bucketSeconds: 86_400,
      costType: 'tokens',
      tokenType: 'output_tokens',
      description: null,
      amountUsd: '1.50',
      dedupKey: 'c1',
    };
    await importRecords(
      t.db,
      t.userId,
      { costs: [cost] },
      { source: { kind: 'api_cost_report', label: 'Cost report', externalRef: '' }, contentHash: 'cost', replaceRanges: [{ start: '2026-04-01T00:00:00.000Z', end: '2026-04-02T00:00:00.000Z' }] },
    );
    const html = composition(await overview());
    expect(html).not.toMatch(/\b0\b/);
    expect(html).toContain('No imported record in this range has token counts, so there is nothing to break down.');
  });
});

describe('most active day', () => {
  it('leaves out conversations and messages for a day that has neither', async () => {
    await importCsv(TOTALS_ONLY);
    const html = render(createElement(MostActiveDayCard, { day: (await overview()).mostActiveDay }));
    expect(html).toContain('600K tokens that day.');
    expect(html).not.toContain('conversation');
    expect(html).not.toContain('messages');
  });

  it('still names them for a day with conversations', async () => {
    await loadDataset(t);
    const html = render(createElement(MostActiveDayCard, { day: (await overview()).mostActiveDay }));
    expect(html).toMatch(/1 conversation active \(\d+ started\), \d+ messages\./);
  });
});

describe('the band under the hero', () => {
  it('says what the band covers and that missing content can only add to it', async () => {
    await loadDataset(t);
    const html = render(createElement(Hero, { overview: await overview(), basis: 'processed', scoped: false, rangeLabel: 'All time' }));
    expect(html).not.toContain('likely between');
    expect(html).toMatch(/The tokenizer of the model is not known for part of the text, so the counted content comes to between \S+ and \S+\./);
    expect(html).toContain('Content that is not in an export (system prompts, tool definitions, files, images) comes on top and can only make the real figure higher.');
  });
});

/** The props the card hands to MetricCard: ApiValueCard has no hooks, so it can be called directly. */
const cardProps = (value: ApiValue, scenario: 'standard' | 'cached') =>
  (ApiValueCard({ value, scenario }) as ReactElement<{ confidenceHint: string; children: ReactNode }>).props;
const cardText = (value: ApiValue, scenario: 'standard' | 'cached') => render(createElement(ApiValueCard, { value, scenario }));

describe('equivalent API value', () => {
  const zero = { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, userMessageCount: 0, assistantMessageCount: 0 };
  const day = { occurredAt: '2026-03-09T00:00:00.000Z', bucketSeconds: 86_400 };
  const API = { kind: 'api_usage_report' as const, label: 'Anthropic API usage report', externalRef: '' };

  it('explains unpriced tokens by their real reason: no price for the model or tier', async () => {
    await importRecords(
      t.db,
      t.userId,
      {
        models: [{ key: 'claude-opus-6', displayName: 'claude-opus-6', family: 'opus', tokenizerFamily: 'unknown' }],
        usage: [
          usage('api:priority', { ...zero, ...day, modelKey: 'claude-sonnet-4-5', priceTier: 'priority', inputTokens: 900_000, outputTokens: 100_000 }),
          usage('api:new-model', { ...zero, ...day, modelKey: 'claude-opus-6', inputTokens: 400_000, outputTokens: 100_000 }),
          usage('api:priced', { ...zero, ...day, modelKey: 'claude-sonnet-4-5', inputTokens: 1_000_000, outputTokens: 0 }),
        ],
      },
      { source: API, contentHash: 'api' },
    );
    const value = await getApiValue(t.db, lifetime());
    expect(unpricedSentence(value)).toBe('1.5M processed tokens are not priced: no price is on file for their model or price tier.');
    expect(cardText(value, 'standard')).not.toContain('does not name a model');
  });

  it('names both reasons with their amounts when both apply', async () => {
    await importRecords(
      t.db,
      t.userId,
      {
        usage: [
          usage('api:priority', { ...zero, ...day, modelKey: 'claude-sonnet-4-5', priceTier: 'priority', inputTokens: 900_000, outputTokens: 100_000 }),
          usage('api:none', { ...zero, ...day, modelKey: null, inputTokens: 300_000, outputTokens: 0 }),
        ],
      },
      { source: API, contentHash: 'api' },
    );
    const value = await getApiValue(t.db, lifetime());
    expect(unpricedSentence(value)).toBe('1.3M processed tokens are not priced: 300K name no model, and for 1M no price is on file for their model or price tier.');
    // Nothing is priced, so the badge says why, by the same reasons.
    expect(apiValueHint(value)).toBe(
      'Part of the usage in this range names no model, and for the rest no price is on file for its model or price tier, so nothing can be priced.',
    );
  });

  it('says "no model" only for usage that names none', async () => {
    await importRecords(t.db, t.userId, { usage: [usage('api:none', { ...zero, ...day, modelKey: null })] }, { source: API, contentHash: 'api' });
    const value = await getApiValue(t.db, lifetime());
    expect(unpricedSentence(value)).toBe('1,500 processed tokens are not priced: their source does not name a model.');
    expect(cardProps(value, 'standard').confidenceHint).toBe('None of the usage in this range names a model, so nothing can be priced.');
  });

  it('says which caching scenario it shows and that an assumed model was applied', async () => {
    const messages = [];
    let context = 0;
    for (let turn = 0; turn < 10; turn++) {
      const asked = new Date(Date.UTC(2025, 5, 1, 10, turn * 2)).toISOString();
      const replied = new Date(Date.UTC(2025, 5, 1, 10, turn * 2 + 1)).toISOString();
      messages.push(msg('long', turn * 2, { createdAt: asked, occurredAt: asked, inputBase: 400, outputBase: 0, replayBase: 0, replayCachedBase: 0, requestCount: 0 }));
      messages.push(msg('long', turn * 2 + 1, { createdAt: replied, occurredAt: replied, inputBase: 0, outputBase: 800, replayBase: context, replayCachedBase: context, requestCount: 1 }));
      context += 1200;
    }
    await importRecords(t.db, t.userId, { conversations: [conv('long')], messages }, { contentHash: 'chat' });
    const value = await getApiValue(t.db, lifetime(), { assumedModelKey: 'claude-opus-4-1' });
    expect(value.assumedTokens).toBeGreaterThan(0);

    const standard = cardText(value, 'standard');
    expect(standard).toContain('Estimated chat usage is priced without prompt caching.');
    expect(standard).toMatch(/processed tokens without a recorded model are priced as Claude Opus 4\.1, your assumption\./);
    expect(cardText(value, 'cached')).toContain('Estimated chat usage is priced with a 5-minute prompt cache assumed.');
  });

  it('names no caching scenario for estimates that are counts a file states: they cost the same in both', async () => {
    // A table of estimates with a model, and no chat: nothing here is re-read context, which is all the scenarios differ in.
    await importCsv(['date,model,input_tokens,output_tokens', '2026-03-01,claude-sonnet-4-6,400000,50000'].join('\n'));
    const value = await getApiValue(t.db, lifetime());
    expect(Number(value.estimatedStandardUsd)).toBeGreaterThan(0);
    expect(value.estimatedCachedUsd).toBe(value.estimatedStandardUsd);
    for (const scenario of ['standard', 'cached'] as const) {
      const html = cardText(value, scenario);
      expect(html, scenario).not.toMatch(/cach/i);
      expect(html, scenario).not.toContain('chat usage');
    }
  });

  it('says nothing about caching or an assumption when the value is all metered', async () => {
    await importRecords(t.db, t.userId, { usage: [usage('u1')] }, { source: API, contentHash: 'api' });
    const html = cardText(await getApiValue(t.db, lifetime()), 'cached');
    expect(html).not.toMatch(/cach/i);
    expect(html).not.toContain('assumption');
  });
});

describe('the default explanation of "Estimated"', () => {
  it('covers counts a file states as well as text estimates, and names no export', () => {
    const help = (ConfidenceBadge({ level: 'estimated' }) as ReactElement<{ content: string }>).props.content;
    expect(help).toContain('stated by a file or an entry without being marked exact');
    expect(help).toContain('counted from conversation text');
    expect(help).not.toContain('claude.ai');
  });
});
