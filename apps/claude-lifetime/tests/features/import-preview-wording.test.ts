import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/overlay';
import { ImportPreviewView } from '@/features/import/preview';
import type { ImportPreview } from '@/import/commit';
import type { Detected } from '@/import/detect';
import type { PreparedImport } from '@/import/session';

/**
 * What the preview says in words about a file, for the cases where the plain
 * sentence would be wrong: a file that adds nothing and takes stored rows away, a
 * file whose records are all stored already, and a selection of which only a part
 * is read.
 */
const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  format: 'anthropic/usage-report',
  formatLabel: 'Anthropic API usage report',
  source: { kind: 'api_usage_report', label: 'Anthropic API', externalRef: 'default', isSynthetic: false } as ImportPreview['source'],
  fileName: 'usage-report.json',
  fileSize: 2048,
  previousImport: null,
  recordsSeen: 3,
  recordsSkipped: 0,
  conversations: { total: 0, new: 0, existing: 0 },
  messages: { total: 0, new: 0, duplicate: 0, withoutModel: 0, withoutTimestamp: 0 },
  usageRows: { total: 3, new: 3, duplicate: 0, withoutModel: 0 },
  costRows: { total: 0, new: 0, duplicate: 0 },
  requests: null,
  prompts: null,
  replaced: null,
  rereadsEarlierImport: false,
  tokens: { exact: 1200, estimated: 0 },
  dateRange: { start: '2026-04-01T00:00:00.000Z', end: '2026-04-03T00:00:00.000Z' },
  coveredDays: { first: '2026-04-01', last: '2026-04-03' },
  coverage: { hasExactUsage: true, hasModel: true, modelShare: 1, hasTimestamps: true },
  figures: { exactTokens: true, statedTokens: false, textEstimates: false, costs: false },
  models: ['claude-sonnet-4-6'],
  missingFields: [],
  warnings: [],
  willRemoveDemoData: false,
  nothingNew: false,
  ...over,
});

const detected = (over: Partial<Detected> = {}): Detected => ({
  parser: 'api-usage',
  fileIndexes: [0],
  totalBytes: 2048,
  recognisedAs: 'JSON file with an Anthropic API usage report',
  ignoredFiles: 0,
  ...over,
});

const text = (p: Partial<ImportPreview> = {}, d: Partial<Detected> = {}) => {
  const prepared = { detected: detected(d), parsed: {}, preview: preview(p), generation: 0, staging: 'x' } as unknown as PreparedImport;
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ImportPreviewView, { prepared, timezone: 'UTC' })))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
};

describe('what the import preview says under the token figure', () => {
  it('says how the tokens of new records were obtained', () => {
    expect(text()).toContain('metered by the source');
    expect(text({ tokens: { exact: 0, estimated: 500 }, figures: { exactTokens: false, statedTokens: false, textEstimates: true, costs: false } })).toContain(
      'reconstructed from message text',
    );
  });

  it('says that stored rows will be removed when a restated report has nothing to add', () => {
    const restated = { tokens: { exact: 0, estimated: 0 }, usageRows: { total: 2, new: 0, duplicate: 2, withoutModel: 0 } };
    const out = text({ ...restated, replaced: { usageRows: 3, costRows: 0, tokens: 45_000 } });
    expect(out).toContain('nothing to add; 3 stored rows with 45K tokens will be removed');
    expect(out).not.toContain('this file carries no token counts');
    // Without a token figure for the rows that go, none is invented.
    expect(text({ ...restated, replaced: { usageRows: 1, costRows: 0, tokens: 0 } })).toContain('nothing to add; 1 stored row will be removed');
  });

  it('says that everything is stored already when that is so, and not that the file has no token counts', () => {
    const out = text({ tokens: { exact: 0, estimated: 0 }, usageRows: { total: 3, new: 0, duplicate: 3, withoutModel: 0 }, nothingNew: true });
    expect(out).toContain('nothing to add: what the file holds is stored already');
    expect(out).not.toContain('this file carries no token counts');
  });

  it('keeps "no token counts" for records that are new and carry none', () => {
    // New rows that state requests but no tokens: the file adds something, and what it adds has no token counts.
    const out = text({ tokens: { exact: 0, estimated: 0 }, usageRows: { total: 3, new: 3, duplicate: 0, withoutModel: 0 }, replaced: { usageRows: 2, costRows: 0, tokens: 100 } });
    expect(out).toContain('this file carries no token counts');
    expect(out).not.toContain('nothing to add');
  });

  it('says that a cost report states money, also when all of its rows are stored already', () => {
    const cost = { format: 'anthropic/cost-report', tokens: { exact: 0, estimated: 0 }, usageRows: { total: 0, new: 0, duplicate: 0, withoutModel: 0 } };
    const fresh = text({ ...cost, costRows: { total: 4, new: 4, duplicate: 0 }, figures: { exactTokens: false, statedTokens: false, textEstimates: false, costs: true } });
    const stored = text({ ...cost, costRows: { total: 4, new: 0, duplicate: 4 }, figures: { exactTokens: false, statedTokens: false, textEstimates: false, costs: false }, nothingNew: true });
    for (const out of [fresh, stored]) expect(out).toContain('this file states amounts of money, not tokens');
  });
});

describe('what the import preview says about the selection', () => {
  it('names the files of a selection that are not read', () => {
    expect(text({}, { ignoredFiles: 2 })).toContain('2 other files in the selection are not part of this import and will be ignored.');
    expect(text({}, { ignoredFiles: 1 })).toContain('1 other file in the selection is not part of this import and will be ignored.');
    expect(text()).not.toContain('will be ignored');
  });

  it('gives the days a file covers as calendar days', () => {
    expect(text()).toMatch(/Covers\s+Apr 1, 2026\s+Apr 1, 2026 – Apr 3, 2026/);
    expect(text({ coveredDays: { first: null, last: null } })).toContain('No dated records');
  });
});
