import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCoverage } from '@/analytics/coverage';
import { getOverview } from '@/analytics/overview';
import { addManualUsage } from '@/analytics/settings';
import { coverageNote, CoverageSummary, sourceFigure } from '@/components/shell/coverage-indicator';
import { CoveragePanel } from '@/features/overview/coverage-panel';
import type { StagedCost } from '@/core/types';
import { commitImport, previewImport } from '@/import/commit';
import { genericCsvParser } from '@/import/generic';
import { resetStaging, StagingWriter } from '@/import/staging';
import { EXPECTED, loadDataset } from '../helpers/dataset';
import { createTestDb, type TestDb } from '../helpers/db';
import { fileOf } from '../helpers/sink';
import { importRecords, usage } from '../helpers/staged';

// The panel only needs an anchor from next/link; the router is not part of what is tested.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement('a', { href, ...rest }, children),
}));

/**
 * What the coverage panel on the overview and the coverage indicator in the top bar say.
 * Each kind of estimate is described for what it is, every token figure is on the basis
 * the page shows, shares never round to 0% or 100%, the number of gaps is the real one,
 * and a cost report is shown as money.
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

const panelOf = async (basis: 'processed' | 'new' = 'processed') => {
  const coverage = await getCoverage(t.db, t.userId, 'UTC', basis);
  return { coverage, panel: text(renderToStaticMarkup(createElement(CoveragePanel, { coverage }))) };
};
const summaryOf = async (basis: 'processed' | 'new' = 'processed') => {
  const coverage = await getCoverage(t.db, t.userId, 'UTC', basis);
  return text(renderToStaticMarkup(createElement(CoverageSummary, { data: coverage })));
};

async function importCsv(content: string) {
  await resetStaging(t.db);
  const writer = new StagingWriter(t.db);
  const parsed = await genericCsvParser.parse([fileOf('usage.csv', content)], writer, { options: { now: Date.UTC(2026, 10, 10) } });
  await writer.finish();
  await previewImport(t.db, t.userId, parsed);
  return commitImport(t.db, t.userId, parsed);
}

describe('estimates are described by where they come from', () => {
  it('a CSV of estimates is not called chat messages of a claude.ai export', async () => {
    // No model column and not declared exact: stored as estimates the file states.
    await importCsv(['timestamp,input_tokens,output_tokens', '2026-03-01,400000,100000', '2026-03-02,300000,200000'].join('\n'));
    const { coverage, panel } = await panelOf();
    expect(coverage).toMatchObject({ estimatedTokens: 1_000_000, statedEstimatedTokens: 1_000_000, textEstimatedTokens: 0 });

    expect(panel).toContain('1M processed tokens as stated in CSV files, which do not mark them as exact.');
    expect(panel).not.toContain('claude.ai export');
    expect(panel).not.toContain('chat message');
    expect(panel).toContain('The model behind 1M processed tokens. Their source does not record which model answered, and none is guessed.');

    const summary = await summaryOf();
    expect(summary).toContain('100% of the processed tokens are estimates: counts that a file or an entry states without marking them exact.');
    expect(summary).not.toContain('conversation text');
  });

  it('a manual estimate is named as an entry you typed in', async () => {
    await addManualUsage(t.db, t.userId, { date: '2026-05-01', inputTokens: 250_000, confidence: 'estimated', note: 'my guess' });
    const { panel } = await panelOf();
    expect(panel).toContain('250K processed tokens as stated in entries you typed in, which do not mark them as exact.');
    expect(panel).not.toContain('claude.ai export');
  });

  it('only sources that hold exact tokens are listed as having metered them, and each kind of estimate gets its own line', async () => {
    await loadDataset(t); // claude.ai export (estimated from text), Claude Code and an API usage report (exact)
    await importCsv(['timestamp,input_tokens', '2026-03-01,777'].join('\n'));
    await addManualUsage(t.db, t.userId, { date: '2026-05-01', inputTokens: 5, confidence: 'estimated' });
    const { coverage, panel } = await panelOf();

    expect(panel).toContain('14.9M processed tokens metered by Claude Code and API usage reports, with their date');
    expect(panel).toContain('625 processed tokens across 4 chat messages, reconstructed from their text because a claude.ai export contains no token counts.');
    expect(panel).toContain('782 processed tokens as stated in CSV files and entries you typed in, which do not mark them as exact.');
    expect(coverage.textEstimatedTokens + coverage.statedEstimatedTokens).toBe(coverage.estimatedTokens);

    const summary = await summaryOf();
    expect(summary).toContain('<1% of the processed tokens are estimates: some reconstructed from conversation text, some stated by a file or an entry');
  });
});

describe('coverage figures follow the token basis', () => {
  it('agree with the hero for the basis New and say which basis they are', async () => {
    await loadDataset(t);
    const hero = await getOverview(t.db, { userId: t.userId, timezone: 'UTC', basis: 'new' });
    const { coverage, panel } = await panelOf('new');

    expect(coverage.basis).toBe('new');
    expect(coverage.exactTokens).toBe(hero.tokens.exact);
    expect(coverage.estimatedTokens).toBe(hero.tokens.estimated);
    expect(coverage.exactTokens).toBe(EXPECTED.fresh.exact);
    expect(coverage.tokensWithModel + coverage.tokensWithoutModel).toBe(EXPECTED.fresh.total);
    const perSource = coverage.sources.reduce((sum, s) => sum + s.exactTokens + s.estimatedTokens, 0);
    expect(perSource).toBe(EXPECTED.fresh.total);

    expect(panel).toContain('4.91M new tokens metered by');
    expect(panel).toContain('Exact new tokens');
    expect(panel).toContain('of imported new tokens');
    expect(panel).not.toContain('processed');

    const summary = await summaryOf('new');
    expect(summary).toContain('new tokens');
    expect(summary).not.toContain('processed');
    // and the default stays the processed basis
    expect((await getCoverage(t.db, t.userId, 'UTC')).exactTokens).toBe(EXPECTED.processed.exact);
  });
});

describe('metered usage that has no tokens on the chosen basis', () => {
  // A resumed Claude Code session whose requests only read context back from the cache: metered, and no new tokens.
  const readsOnly = () =>
    importRecords(
      t.db,
      t.userId,
      { usage: [usage('cc:1', { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 250_000 })] },
      { source: { kind: 'claude_code', label: 'Claude Code (this computer)', externalRef: 'local' }, contentHash: 'cc' },
    );

  it('is not described as files without token counts, or as nothing being metered', async () => {
    await readsOnly();
    const { coverage, panel } = await panelOf('new');
    expect(coverage).toMatchObject({ exactTokens: 0, estimatedTokens: 0 });
    expect(coverage.sources[0]).toMatchObject({ hasUsage: true, hasExactUsage: true, exactTokens: 0 });

    expect(coverageNote(coverage)).toBe('The imported usage holds no new tokens. Processed shows what was read again.');
    expect(panel).toContain('Exact usage Present');
    expect(panel).toContain('The metered usage you imported holds no new tokens: it is context that was read again, which Processed counts.');
    expect(panel).not.toContain('No imported source meters tokens yet');

    // On the processed basis the same import is 250K exact tokens, with the ordinary wording.
    const processed = await panelOf('processed');
    expect(processed.coverage.exactTokens).toBe(250_000);
    expect(coverageNote(processed.coverage)).toBe('All token counts come from sources that meter them.');
    expect(processed.panel).toContain('250K processed tokens metered by');
  });

  it('keeps "nothing is metered" for imports that are estimates only', async () => {
    await importCsv(['timestamp,input_tokens,output_tokens', '2026-03-01,400000,100000'].join('\n'));
    const { coverage, panel } = await panelOf('new');
    expect(coverage.sources[0]).toMatchObject({ hasUsage: true, hasExactUsage: false });
    expect(panel).toContain('Exact usage None');
    expect(panel).toContain('No imported source meters tokens yet. Claude Code logs and API usage reports do.');
  });
});

describe('the coverage indicator', () => {
  it('does not round a small share of estimates to 0%', async () => {
    await addManualUsage(t.db, t.userId, { date: '2026-06-01', inputTokens: 2_000_000_000, confidence: 'exact' });
    await addManualUsage(t.db, t.userId, { date: '2026-06-01', inputTokens: 5_000_000, confidence: 'estimated' });
    const coverage = await getCoverage(t.db, t.userId, 'UTC');
    expect(coverageNote(coverage)).toBe('<1% of the processed tokens are estimates: counts that a file or an entry states without marking them exact.');
  });

  it('shows a cost report as money, not as 0 tokens', async () => {
    const cost = (key: string, occurredAt: string): StagedCost => ({
      modelKey: 'claude-sonnet-4-5',
      occurredAt,
      bucketSeconds: 86_400,
      costType: 'tokens',
      tokenType: 'output_tokens',
      description: null,
      amountUsd: '1.50',
      dedupKey: key,
    });
    await importRecords(
      t.db,
      t.userId,
      { costs: [cost('c1', '2026-04-01T00:00:00.000Z'), cost('c2', '2026-04-02T00:00:00.000Z')] },
      {
        source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' },
        contentHash: 'cost',
        replaceRanges: [{ start: '2026-04-01T00:00:00.000Z', end: '2026-04-03T00:00:00.000Z' }],
      },
    );
    const coverage = await getCoverage(t.db, t.userId, 'UTC');
    const [source] = coverage.sources;
    expect(source.hasUsage).toBe(false);
    expect(sourceFigure(source, coverage.basis)).toBe('$3.00 billed');
    const summary = await summaryOf();
    expect(summary).not.toMatch(/\b0 (processed )?tokens/);
    expect(summary).toContain('None of the imported files holds token counts.');
    expect(summary).not.toContain('come from sources that meter them');
  });
});

describe('the number of gaps', () => {
  it('is the real number, not the length of the list of the longest', async () => {
    // One day of Claude Code usage every 20 days, thirty times: 29 stretches of 19 days without records.
    const start = Date.UTC(2024, 0, 1);
    const rows = Array.from({ length: 30 }, (_, i) => usage(`cc:${i}`, { occurredAt: new Date(start + i * 20 * 86_400_000).toISOString() }));
    await importRecords(t.db, t.userId, { usage: rows }, { source: { kind: 'claude_code', label: 'Claude Code', externalRef: 'local' }, contentHash: 'code' });

    const { coverage, panel } = await panelOf();
    expect(coverage.gapCount).toBe(29);
    expect(coverage.gaps).toHaveLength(12);
    expect(panel).toContain('29 stretches of 14 days or more with no records; the 6 longest:');
    expect(coverageNote(coverage)).toContain('29 stretches of 14+ days have no records.');
  });

  it('lists every gap without "the longest" when there are few', async () => {
    const rows = ['2025-01-01', '2025-02-01', '2025-03-01'].map((d, i) => usage(`cc:${i}`, { occurredAt: `${d}T12:00:00.000Z` }));
    await importRecords(t.db, t.userId, { usage: rows }, { source: { kind: 'claude_code', label: 'Claude Code', externalRef: 'local' }, contentHash: 'code' });
    const { coverage, panel } = await panelOf();
    expect(coverage.gapCount).toBe(2);
    expect(panel).toContain('2 stretches of 14 days or more with no records');
    expect(panel).not.toContain('longest');
  });
});
