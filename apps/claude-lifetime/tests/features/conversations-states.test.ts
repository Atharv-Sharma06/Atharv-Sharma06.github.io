import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getConversationDetail, listConversationModels, listConversations } from '@/analytics/conversations';
import { getCoverage } from '@/analytics/coverage';
import { getOverview } from '@/analytics/overview';
import { setSourceIncluded } from '@/analytics/settings';
import { getApiValue } from '@/analytics/value';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg, usage } from '../helpers/staged';

/**
 * The views of the Conversations page in the states the review found wrong, rendered to
 * HTML with figures read from a real database. The app's state and its data hook are
 * replaced by stand-ins that hand the views those figures, so only the views' own
 * decisions are under test.
 */
const store = vi.hoisted(() => ({ data: new Map<string, unknown>() }));

vi.mock('@/state/app', () => {
  const app = {
    settings: { basis: 'processed', timezone: 'UTC', costScenario: 'standard', assumedModelKey: null },
    resolved: { from: null, to: null },
    range: { preset: 'all', from: null, to: null },
    setRange: () => undefined,
  };
  return {
    useApp: () => app,
    rangeKey: () => '..',
    useData: (key: readonly unknown[]) => ({ data: store.data.get(String(key[0])), error: null, isPlaceholderData: false }),
  };
});
vi.mock('@/state/queries', () => ({
  useCoverage: () => ({ data: store.data.get('coverage'), error: null }),
  usePeriods: () => ({ data: [], error: null }),
}));

const { TooltipProvider } = await import('@/components/ui/overlay');
const { ConversationDetailView } = await import('@/features/conversations/detail');
const { Explorer } = await import('@/features/conversations/explorer');
const { DEFAULT_STATE } = await import('@/features/conversations/url-state');

const render = (element: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, element));
const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** The HTML of the page from the given text on. */
const section = (html: string, from: string) => {
  const start = html.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  return html.slice(start);
};

let t: TestDb;
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: 'UTC', basis: 'processed', ...over });
const ids = new Map<string, number>();

/** What the detail view's loader reads for a conversation, read with the same functions. */
async function loadDetail(id: number) {
  const detail = await getConversationDetail(t.db, filter(), id);
  if (!detail || detail.leftOutOfTotals) return { id, detail, overview: null, value: null, usage: null, models: null };
  const scoped = filter({ conversationId: id });
  return { id, detail, overview: await getOverview(t.db, scoped), value: await getApiValue(t.db, scoped), usage: null, models: null };
}

async function showDetail(id: number) {
  store.data.set('conversation', await loadDetail(id));
  return render(createElement(ConversationDetailView, { id, listState: DEFAULT_STATE }));
}

async function showList() {
  store.data.set('coverage', await getCoverage(t.db, t.userId, 'UTC'));
  store.data.set('conversation-models', await listConversationModels(t.db, t.userId));
  store.data.set('conversations', await listConversations(t.db, filter(), { limit: 50 }));
  return render(createElement(Explorer, { urlState: DEFAULT_STATE }));
}

beforeAll(async () => {
  t = await createTestDb('UTC');
  // A chat export whose last two messages have no time in the export.
  await importRecords(
    t.db,
    t.userId,
    {
      conversations: [conv('chat', { title: 'Undated replies' })],
      messages: [msg('chat', 0), msg('chat', 1), msg('chat', 2, { createdAt: null }), msg('chat', 3, { createdAt: null })],
    },
    { source: { kind: 'claude_export', label: 'Personal account', externalRef: 'acct-1' }, contentHash: 'export' },
  );
  // A CSV whose rows hang off a container: a container of usage rows, not a conversation.
  await importRecords(
    t.db,
    t.userId,
    {
      conversations: [conv('bucket', { dedupKey: 'generic:sheet:bucket', kind: 'usage_bucket', title: 'Refactoring notes' })],
      usage: [usage('g:1', { conversationKey: 'generic:sheet:bucket' })],
    },
    { source: { kind: 'generic_csv', label: 'Spreadsheet', externalRef: 'sheet' }, contentHash: 'csv', format: 'generic/csv' },
  );
  const rows = (await t.db.query<{ id: number; title: string; source_id: number }>(`SELECT id, title, source_id FROM conversations ORDER BY id`)).rows;
  for (const r of rows) ids.set(r.title, r.id);
  ids.set('export source', rows.find((r) => r.title === 'Undated replies')!.source_id);
});
afterAll(() => t.close());
beforeEach(() => store.data.clear());

describe('the page of a conversation', () => {
  it('marks the times the source does not record as inferred, in the message list and in the turn table', async () => {
    const html = await showDetail(ids.get('Undated replies')!);
    const messages = section(html, 'The size of each message');
    // Before the fix every time was a plain date, and the tooltip about a missing time could never appear.
    expect((messages.match(/data-inferred=""/g) ?? []).length).toBe(2);
    expect(messages).toContain('title="Inferred: the source records no time for this message.');
    expect(text(messages)).toContain('2 times in this list are inferred.');
    // The recorded times stay as they were: the first two rows carry no mark.
    const rows = [...messages.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).slice(2, 6);
    expect(rows.map((r) => r.includes('data-inferred'))).toEqual([false, false, true, true]);
    // The second turn starts with a message whose time is borrowed (msg 2 is from the user).
    const turnTable = await import('@/features/conversations/turn-chart');
    const { turnsOf } = await import('@/features/conversations/growth');
    const detail = (await getConversationDetail(t.db, filter(), ids.get('Undated replies')!))!;
    const turns = turnsOf(detail.messages);
    expect(turns.map((x) => x.atInferred)).toEqual([false, true]);
    const table = render(
      createElement(turnTable.TurnTable, { turns, series: [{ key: 'input', label: 'Input', color: '#000', estimated: true }], timezone: 'UTC' }),
    );
    expect((table.match(/data-inferred=""/g) ?? []).length).toBe(1);
    expect(table).toContain('Inferred: the source records no time for the first message of this turn.');
  });

  it('draws the categories of an estimated total hatched and lighter', async () => {
    const chat = section(await showDetail(ids.get('Undated replies')!), 'What the total is made of');
    const bars = chat.slice(0, chat.indexOf('</dl>'));
    // Before the fix every bar was the solid accent, whatever the confidence of the figure.
    expect(bars).toContain('data-part="estimated" class="hatch-estimated');
    expect(bars).not.toContain('data-part="exact"');
    expect(bars).toContain('tokens, estimated"');
  });

  it('treats a container of CSV rows as not found', async () => {
    const id = ids.get('Refactoring notes')!;
    expect(await getConversationDetail(t.db, filter(), id)).toBeNull();
    const html = text(await showDetail(id));
    expect(html).toContain('This conversation is not in your data');
    expect(html).not.toContain('Usage record');
  });

  it('says a conversation is left out of totals, with a link to Settings, and shows no figures', async () => {
    await setSourceIncluded(t.db, t.userId, ids.get('export source')!, false);
    try {
      const html = await showDetail(ids.get('Undated replies')!);
      const words = text(html);
      expect(words).toContain('Undated replies');
      expect(words).toContain('This conversation is left out of totals');
      expect(words).toContain('its source, “Personal account”, is left out of totals in Settings');
      expect(html).toMatch(/href="\/settings\/?#sources"/);
      // Before the fix the page called the tokens "Unavailable" and the card "Metered by the source",
      // next to a chart and a table of estimated tokens.
      for (const contradiction of ['Unavailable', 'Metered by the source', 'What the total is made of', 'How this conversation grew', 'Estimated tokens']) {
        expect(words).not.toContain(contradiction);
      }
    } finally {
      await setSourceIncluded(t.db, t.userId, ids.get('export source')!, true);
    }
  });
});

describe('the list of conversations', () => {
  it('says that the source of the conversations is left out of totals when it is the only one', async () => {
    await setSourceIncluded(t.db, t.userId, ids.get('export source')!, false);
    try {
      const html = await showList();
      const words = text(html);
      // Before the fix it said "Your imports contain no conversations" and pointed to Import.
      expect(words).not.toContain('Your imports contain no conversations');
      expect(words).toContain('The source of your conversations is left out of totals');
      expect(words).toContain('“Personal account” holds 1 conversation.');
      expect(words).toContain('Open data sources in Settings');
      expect(html).toMatch(/href="\/settings\/?#sources"/);
    } finally {
      await setSourceIncluded(t.db, t.userId, ids.get('export source')!, true);
    }
  });

  it('keeps its wording when the imports hold no conversation', async () => {
    const empty = await createTestDb('UTC');
    const saved = t;
    t = empty;
    try {
      await importRecords(t.db, t.userId, { usage: [usage('api:1', { bucketSeconds: 86_400 })] }, {
        source: { kind: 'api_usage_report', label: 'API', externalRef: 'org' },
        contentHash: 'api',
        format: 'anthropic/usage-report',
      });
      expect(text(await showList())).toContain('Your imports contain no conversations');
    } finally {
      t = saved;
      await empty.close();
    }
  });
});
