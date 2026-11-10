import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenBasis } from '@/analytics/base';
import { getCoverage } from '@/analytics/coverage';
import { DEFAULT_SETTINGS, updateSettings, type AppSettings } from '@/analytics/settings';
import { TooltipProvider } from '@/components/ui/overlay';
import { DisplaySection } from '@/features/settings/display-section';
import { checkTimezone, listTimezones } from '@/features/settings/logic';
import { PricesSection } from '@/features/settings/prices-section';
import { recordsDated, SourcesSection, sourcesFootnote, usageRecordsLine } from '@/features/settings/sources-section';
import type { AppReady } from '@/state/app';
import { loadDataset } from '../helpers/dataset';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * The Settings page names the basis of every token figure it shows (or counts the figure
 * on the basis its words name), dates sources by the calendar days the charts use, takes
 * a timezone typed in any letter case, and puts no arrow after a link's text.
 *
 * The sections are rendered to HTML with the real query functions against a real
 * database: useData is replaced by a stand-in that answers from results read beforehand.
 */
const mocks = vi.hoisted(() => ({
  app: null as unknown as AppReady,
  results: new Map<string, unknown>(),
  pending: [] as Array<{ id: string; read: (app: AppReady) => Promise<unknown> }>,
}));
vi.mock('@/state/app', () => {
  const id = (key: readonly unknown[]) => JSON.stringify([mocks.app.settings.timezone, mocks.app.settings.basis, ...key]);
  return {
    useApp: () => mocks.app,
    useAppState: () => ({ status: 'ready', app: mocks.app }),
    rangeKey: () => '..',
    useData: (key: readonly unknown[], read: (app: AppReady) => Promise<unknown>) => {
      const k = id(key);
      if (!mocks.results.has(k)) mocks.pending.push({ id: k, read });
      return { data: mocks.results.get(k), error: null, isPlaceholderData: false };
    },
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement('a', { href, ...rest }, children),
}));

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  await loadDataset(t);
});
afterAll(() => t.close());
beforeEach(() => mocks.results.clear());

function setApp(settings: Partial<AppSettings>) {
  const full: AppSettings = { ...DEFAULT_SETTINGS, timezone: 'UTC', ...settings };
  const filter = { userId: t.userId, timezone: full.timezone, basis: full.basis };
  mocks.app = {
    db: t.db,
    userId: t.userId,
    settings: full,
    lifetime: filter,
    filter,
    resolved: { from: null, to: null },
    dataVersion: 0,
    saveSettings: async () => undefined,
    notifyDataChanged: () => undefined,
    setRange: () => undefined,
  } as unknown as AppReady;
}

/** Renders until every query the element asks for has its result, the way the page settles. */
async function renderSettled(element: ReactElement): Promise<string> {
  for (let round = 0; round < 10; round++) {
    mocks.pending.length = 0;
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, element));
    if (mocks.pending.length === 0) return html;
    for (const { id, read } of mocks.pending.splice(0)) mocks.results.set(id, await read(mocks.app));
  }
  throw new Error('the queries did not settle');
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();

describe('token figures on the Settings page say which tokens they count', () => {
  it('the list of sources names the selected basis, and no longer claims processed tokens under New', async () => {
    setApp({ basis: 'new' });
    const shown = text(await renderSettled(createElement(SourcesSection)));
    expect(shown).toContain('Token figures in this list are new tokens, the token basis selected above.');
    expect(shown).not.toContain('processed tokens');
    expect(sourcesFootnote('processed', 'UTC')).toBe(
      'Token figures in this list are processed tokens, the token basis selected above. Dates are calendar days: a record with a time of day falls on the day it has in the timezone set above (UTC), and a record that only knows its day, such as a daily report row, keeps that day.',
    );
  });

  it('the delete dialog states the deleted usage on the selected basis', async () => {
    const coverage = await getCoverage(t.db, t.userId, 'UTC', 'new');
    const code = coverage.sources.find((s) => s.kind === 'claude_code')!;
    // Claude Code: 4,803,500 new tokens; 14,803,500 processed ones with its cache reads.
    expect(usageRecordsLine(code, 'new')).toBe('its usage records, 4.8M new tokens in all');
    const processed = (await getCoverage(t.db, t.userId, 'UTC', 'processed')).sources.find((s) => s.kind === 'claude_code')!;
    expect(usageRecordsLine(processed, 'processed')).toBe('its usage records, 14.8M processed tokens in all');
    expect(usageRecordsLine({ exactTokens: 0, estimatedTokens: 0 }, 'new')).toBe('its usage records');
  });

  it('the assumed-model line counts processed tokens, as it says, under either basis', async () => {
    const without = async (basis: TokenBasis) => {
      setApp({ basis });
      const shown = text(await renderSettled(createElement(DisplaySection)));
      return /Nothing is guessed\. (\S+) processed tokens in your history have no recorded model and stay unpriced\./.exec(shown)?.[1];
    };
    // 625 estimated chat tokens (525 of them new) and an exact record of 2,000 tokens name no model.
    expect(await without('processed')).toBe('2,625');
    expect(await without('new')).toBe('2,625');
  });
});

describe('dates of a source', () => {
  it('are the calendar days the charts use: a daily UTC report row keeps its date west of UTC', async () => {
    setApp({ timezone: 'America/Los_Angeles' });
    const shown = text(await renderSettled(createElement(SourcesSection)));
    expect(shown).toContain('Anthropic API usage report');
    // The instant of that row, midnight UTC, is still 8 March in Los Angeles; that day must not be shown for it.
    expect(shown).not.toMatch(/Anthropic API usage report .*?Records dated Mar 8, 2025/);
    expect(shown).toMatch(/Anthropic API usage report .*?Records dated Mar 9, 2025 – Mar 9, 2025/);
    const coverage = await getCoverage(t.db, t.userId, 'America/Los_Angeles');
    expect(recordsDated(coverage.sources.find((s) => s.kind === 'api_usage_report')!)).toBe('Mar 9, 2025 – Mar 9, 2025');
    // Chat message b was sent on 8 March in Los Angeles: a record with a time of day is local.
    expect(recordsDated(coverage.sources.find((s) => s.label === 'claude.ai export')!)).toBe('Jan 10, 2025 – Mar 8, 2025');
  });
});

describe('timezone typed in any letter case', () => {
  it('is matched to its proper spelling, also for a zone the browser lists under an older name', () => {
    const zones = listTimezones();
    expect(zones).toContain('Asia/Kolkata');
    expect(zones).toContain('Europe/Kyiv');
    expect(new Set(zones).size).toBe(zones.length);
    expect(checkTimezone('asia/kolkata', zones)).toEqual({ ok: true, timezone: 'Asia/Kolkata' });
    expect(checkTimezone('america/new_york', zones)).toEqual({ ok: true, timezone: 'America/New_York' });
  });

  it('is stored under its proper spelling, so the zones the message recommends are never refused', async () => {
    const t2 = await createTestDb();
    try {
      for (const [typed, stored] of [
        ['asia/kolkata', 'Asia/Kolkata'],
        ['AMERICA/NEW_YORK', 'America/New_York'],
        ['us/pacific', 'US/Pacific'],
        ['Asia/Calcutta', 'Asia/Calcutta'],
      ]) {
        expect((await updateSettings(t2.db, t2.userId, { timezone: typed })).timezone).toBe(stored);
      }
      await expect(updateSettings(t2.db, t2.userId, { timezone: 'mars/olympus' })).rejects.toThrow('is not a timezone this app knows');
      // Every suggestion, the added current names included, is a zone PostgreSQL knows.
      const { rows } = await t2.db.query<{ name: string }>(`SELECT name FROM pg_timezone_names WHERE name = ANY($1::text[])`, [listTimezones()]);
      expect(rows.length).toBe(listTimezones().length);
    } finally {
      await t2.close();
    }
  });
});

describe('links', () => {
  it('have no arrow after their text in the prices section', async () => {
    setApp({});
    const html = await renderSettled(createElement(PricesSection));
    const link = /<a [^>]*>(\s*the pricing page[\s\S]*?)<\/a>/.exec(html)?.[1];
    expect(link).toBeDefined();
    expect(link).not.toContain('<svg');
    expect(link).toContain('(opens in a new tab)');
  });
});
