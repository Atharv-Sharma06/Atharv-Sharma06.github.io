import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getConversationDetail, listConversations, MAX_ID } from '@/analytics/conversations';
import { getOverview } from '@/analytics/overview';
import { setSourceIncluded } from '@/analytics/settings';
import { DEFAULT_STATE, followRange, parseTarget } from '@/features/conversations/url-state';
import { createTestDb, type TestDb } from '../helpers/db';
import { conv, importRecords, msg, usage } from '../helpers/staged';

/**
 * The queries behind the Conversations page at its edges: what an address can hold,
 * conversations whose sources are left out of totals, containers of report rows,
 * messages without a time, the order of titles and the confidence of each category.
 */
describe('conversation queries at the edges', () => {
  let t: TestDb;
  const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: 'UTC', basis: 'processed', ...over });
  const id = new Map<string, number>();
  let exportSource = 0;
  let codeSource = 0;

  beforeAll(async () => {
    t = await createTestDb('UTC');
    await importRecords(
      t.db,
      t.userId,
      {
        conversations: ['zebra crossing', 'Émile and the école', 'apple pie', 'Eve', 'Ångström units'].map((title, i) => conv(`c${i}`, { title })),
        messages: [
          msg('c0', 0),
          msg('c0', 1, { createdAt: null, occurredAt: '2025-01-01T10:00:00.000Z' }),
          msg('c0', 2),
          ...[1, 2, 3, 4].map((i) => msg(`c${i}`, 0)),
        ],
      },
      { source: { kind: 'claude_export', label: 'Old account', externalRef: 'acct-old' }, contentHash: 'export' },
    );
    await importRecords(
      t.db,
      t.userId,
      {
        conversations: [
          conv('bucket', { dedupKey: 'generic:sheet:bucket', kind: 'usage_bucket', title: 'Refactoring notes' }),
          conv('session', { dedupKey: 'claude_code:session', kind: 'code_session', title: 'A session' }),
        ],
        usage: [usage('g:1', { conversationKey: 'generic:sheet:bucket' }), usage('cc:1', { conversationKey: 'claude_code:session' })],
      },
      { source: { kind: 'generic_csv', label: 'Spreadsheet', externalRef: 'sheet' }, contentHash: 'csv', format: 'generic/csv' },
    );
    const rows = (await t.db.query<{ id: number; title: string; source_id: number }>(`SELECT id, title, source_id FROM conversations`)).rows;
    for (const r of rows) id.set(r.title, r.id);
    exportSource = rows.find((r) => r.title === 'zebra crossing')!.source_id;
    codeSource = rows.find((r) => r.title === 'A session')!.source_id;
  });
  afterAll(() => t.close());

  it('answers an id beyond what the database holds with "not found", not an error', async () => {
    // Before the fix PostgreSQL rejected the parameter: value "99999999999999" is out of range for type integer.
    await expect(getConversationDetail(t.db, filter(), 99_999_999_999_999)).resolves.toBeNull();
    await expect(getConversationDetail(t.db, filter(), MAX_ID + 1)).resolves.toBeNull();
    await expect(getConversationDetail(t.db, filter(), MAX_ID)).resolves.toBeNull();
    // and the address never asks for one
    expect(parseTarget(new URLSearchParams('id=99999999999999'))).toEqual({ view: 'detail', id: null });
    expect(parseTarget(new URLSearchParams('id=2147483648'))).toEqual({ view: 'detail', id: null });
    expect(parseTarget(new URLSearchParams('id=2147483647'))).toEqual({ view: 'detail', id: MAX_ID });
  });

  it('finds nothing for a search with a NUL character, without an error', async () => {
    // Before the fix: invalid byte sequence for encoding "UTF8": 0x00.
    await expect(listConversations(t.db, filter(), { search: 'zebra\u0000' })).resolves.toEqual({ total: 0, rows: [] });
    await expect(listConversations(t.db, filter(), { search: '\u0000' })).resolves.toEqual({ total: 0, rows: [] });
    expect((await listConversations(t.db, filter(), { search: 'zebra' })).total).toBe(1);
  });

  it('treats a container of CSV rows as not found, and still shows a Claude Code session', async () => {
    expect(await getConversationDetail(t.db, filter(), id.get('Refactoring notes')!)).toBeNull();
    const session = await getConversationDetail(t.db, filter(), id.get('A session')!);
    expect(session?.conversation.kind).toBe('code_session');
  });

  it('orders titles alphabetically, with accented letters next to their base letter', async () => {
    const titles = async (direction: 'asc' | 'desc') =>
      (await listConversations(t.db, filter(), { sort: 'title', direction })).rows.map((r) => r.title);
    // Before the fix the C collation put "Émile" and "Ångström" after "zebra".
    expect(await titles('asc')).toEqual(['A session', 'Ångström units', 'apple pie', 'Émile and the école', 'Eve', 'zebra crossing']);
    expect(await titles('desc')).toEqual(['zebra crossing', 'Eve', 'Émile and the école', 'apple pie', 'Ångström units', 'A session']);
  });

  it('says which message times the source does not record, and keeps their place', async () => {
    const detail = (await getConversationDetail(t.db, filter(), id.get('zebra crossing')!))!;
    expect(detail.messages.map((m) => [m.ordinal, m.at, m.timeInferred])).toEqual([
      [0, '2025-01-01T10:00:00.000Z', false],
      [1, '2025-01-01T10:00:00.000Z', true],
      [2, '2025-01-01T10:02:00.000Z', false],
    ]);
  });

  it('gives the estimated part of each category, which is all of a chat and none of a metered session', async () => {
    const chatId = id.get('zebra crossing')!;
    const chat = (await getConversationDetail(t.db, filter(), chatId))!;
    const { tokens } = await getOverview(t.db, filter({ conversationId: chatId }));
    expect(tokens.exact).toBe(0);
    expect(chat.estimatedParts).toEqual({
      input: tokens.input,
      output: tokens.output,
      unsplit: tokens.unsplit,
      cacheWrite: tokens.cacheWrite,
      cacheRead: tokens.cacheRead,
      replay: tokens.replay,
    });
    expect(chat.estimatedParts.input + chat.estimatedParts.output).toBeGreaterThan(0);

    const session = (await getConversationDetail(t.db, filter(), id.get('A session')!))!;
    expect(session.estimatedParts).toEqual({ input: 0, output: 0, unsplit: 0, cacheWrite: 0, cacheRead: 0, replay: 0 });
  });

  it('says a conversation is left out of totals, with its source, instead of returning figures that leave its usage out', async () => {
    await setSourceIncluded(t.db, t.userId, exportSource, false);
    await setSourceIncluded(t.db, t.userId, codeSource, false);
    try {
      const detail = (await getConversationDetail(t.db, filter(), id.get('zebra crossing')!))!;
      // Before the fix: leftOutOfTotals did not exist, tokens were 0 and the messages still carried estimates.
      expect(detail.leftOutOfTotals).toBe(true);
      expect(detail.leftOutSources).toEqual(['Old account']);
      expect(detail.conversation.title).toBe('zebra crossing');
      expect(detail.messages).toEqual([]);
      expect(detail.methods).toEqual([]);
      const session = (await getConversationDetail(t.db, filter(), id.get('A session')!))!;
      expect(session).toMatchObject({ leftOutOfTotals: true, leftOutSources: ['Spreadsheet'] });
    } finally {
      await setSourceIncluded(t.db, t.userId, exportSource, true);
      await setSourceIncluded(t.db, t.userId, codeSource, true);
    }
    const counted = (await getConversationDetail(t.db, filter(), id.get('zebra crossing')!))!;
    expect(counted).toMatchObject({ leftOutOfTotals: false, leftOutSources: [] });
    expect(counted.messages).toHaveLength(3);
  });

  it('shows only the messages of sources that count when two sources added to one conversation', async () => {
    // A second export of the same account, filed under another source, adds two later messages to "zebra crossing".
    const second = await importRecords(
      t.db,
      t.userId,
      { conversations: [conv('c0', { title: 'zebra crossing' })], messages: [msg('c0', 3), msg('c0', 4)] },
      { source: { kind: 'claude_export', label: 'Second copy', externalRef: 'acct-copy' }, contentHash: 'export-copy' },
    );
    const shared = id.get('zebra crossing')!;
    try {
      expect((await getConversationDetail(t.db, filter(), shared))!.messages).toHaveLength(5);

      await setSourceIncluded(t.db, t.userId, second.result.sourceId!, false);
      const detail = (await getConversationDetail(t.db, filter(), shared))!;
      // Still shown: its first source counts. The table, the methods and the limitations follow the totals.
      expect(detail.leftOutOfTotals).toBe(false);
      expect(detail.messages).toHaveLength(3);
      const listed = detail.messages.reduce((sum, m) => sum + m.input + m.output + m.replay, 0);
      const total = (await getOverview(t.db, filter({ conversationId: shared }))).tokens.total;
      expect(listed).toBe(total);
      expect(detail.methods.reduce((sum, m) => sum + m.messages, 0)).toBe(3);
    } finally {
      await setSourceIncluded(t.db, t.userId, second.result.sourceId!, true);
    }
  });

  it('finds nothing for a model or plan filter with a NUL character, without an error', async () => {
    await expect(listConversations(t.db, filter(), { model: 'claude\u0000' })).resolves.toEqual({ total: 0, rows: [] });
    await expect(listConversations(t.db, filter(), { plan: '\u0000' })).resolves.toEqual({ total: 0, rows: [] });
  });
});

describe('the page of the list when the date range changes', () => {
  it('returns to the first page, as any other filter does', () => {
    const onPage3 = { ...DEFAULT_STATE, search: 'refactor', page: 3 };
    // Before the fix nothing reset the page, and the list stayed on page 3 of a different result.
    expect(followRange(onPage3, '..', '2025-11-10..2026-11-10')).toEqual({ ...onPage3, page: 1 });
    // A page taken from the address is kept while the range stays the same.
    expect(followRange(onPage3, '..', '..')).toBe(onPage3);
    expect(followRange(DEFAULT_STATE, '..', '2025-11-10..')).toBe(DEFAULT_STATE);
  });
});
