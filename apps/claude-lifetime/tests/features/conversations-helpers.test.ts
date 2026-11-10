import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsFilter } from '@/analytics/base';
import { getConversationDetail, listConversationModels, listConversations, type ConversationDetail } from '@/analytics/conversations';
import { getModelBreakdown } from '@/analytics/models';
import { getOverview } from '@/analytics/overview';
import { getApiValue } from '@/analytics/value';
import { Decimal } from '@/core/decimal';
import { formatBand, turnsOf } from '@/features/conversations/growth';
import {
  clearFilters,
  DEFAULT_STATE,
  defaultDirection,
  detailHref,
  explorerParams,
  hasFilters,
  listHref,
  PAGE_SIZE,
  pageWindow,
  parseExplorerState,
  parseTarget,
  toggleSort,
  toQuery,
  withChange,
  type ExplorerState,
} from '@/features/conversations/url-state';
import { loadDemoDataset } from '@/import/demo/load';
import { createTestDb, type TestDb } from '../helpers/db';

const params = (query: string) => new URLSearchParams(query);

describe('explorer state in the URL', () => {
  it('starts from the defaults when the query string is empty', () => {
    expect(parseExplorerState(params(''))).toEqual(DEFAULT_STATE);
    expect(DEFAULT_STATE).toEqual({ search: '', model: null, source: null, plan: null, sort: 'tokens', direction: 'desc', page: 1 });
    expect(explorerParams(DEFAULT_STATE).toString()).toBe('');
    expect(listHref(DEFAULT_STATE)).toBe('/conversations/');
  });

  it('reads every parameter', () => {
    const state = parseExplorerState(params('q=billing+module&model=claude-opus-4-5&source=claude_code&plan=max_5x&sort=created&dir=asc&page=3'));
    expect(state).toEqual({ search: 'billing module', model: 'claude-opus-4-5', source: 'claude_code', plan: 'max_5x', sort: 'created', direction: 'asc', page: 3 });
    expect(hasFilters(state)).toBe(true);
  });

  it('falls back to a default for anything it cannot read', () => {
    const state = parseExplorerState(params('q=+++&model=&source=telepathy&plan=&sort=price&dir=sideways&page=-2'));
    expect(state).toEqual(DEFAULT_STATE);
    expect(parseExplorerState(params('page=0')).page).toBe(1);
    expect(parseExplorerState(params('page=2.5')).page).toBe(1);
    expect(parseExplorerState(params('page=abc')).page).toBe(1);
    expect(parseExplorerState(params(`q=${'x'.repeat(500)}`)).search).toHaveLength(200);
  });

  it('sorts titles from A to Z and everything else largest first unless told otherwise', () => {
    expect(defaultDirection('title')).toBe('asc');
    expect(defaultDirection('tokens')).toBe('desc');
    expect(parseExplorerState(params('sort=title')).direction).toBe('asc');
    expect(parseExplorerState(params('sort=title&dir=desc')).direction).toBe('desc');
    expect(parseExplorerState(params('sort=messages')).direction).toBe('desc');
  });

  it('writes only what differs from the defaults, in a fixed order, and reads it back unchanged', () => {
    const states: ExplorerState[] = [
      DEFAULT_STATE,
      { ...DEFAULT_STATE, search: 'a b&c=d', page: 4 },
      { search: 'ramen', model: 'unknown', source: 'claude_export', plan: 'none', sort: 'title', direction: 'desc', page: 2 },
      { ...DEFAULT_STATE, sort: 'title' },
      { ...DEFAULT_STATE, sort: 'updated', direction: 'asc' },
      { ...DEFAULT_STATE, direction: 'asc' },
    ];
    for (const state of states) expect(parseExplorerState(explorerParams(state))).toEqual(state);
    expect(explorerParams(states[2]).toString()).toBe('q=ramen&model=unknown&source=claude_export&plan=none&sort=title&dir=desc&page=2');
    // a direction is written only when it is not the natural one for the column
    expect(explorerParams({ ...DEFAULT_STATE, sort: 'title', direction: 'asc' }).toString()).toBe('sort=title');
    expect(explorerParams({ ...DEFAULT_STATE, sort: 'title' }).toString()).toBe('sort=title&dir=desc');
    expect(explorerParams({ ...DEFAULT_STATE, direction: 'asc' }).toString()).toBe('dir=asc');
    expect(listHref({ ...DEFAULT_STATE, search: 'a b&c=d' })).toBe('/conversations/?q=a+b%26c%3Dd');
  });

  it('links to a conversation without losing the list it was opened from', () => {
    const state: ExplorerState = { ...DEFAULT_STATE, search: 'ramen', sort: 'created', page: 2 };
    expect(detailHref(570, DEFAULT_STATE)).toBe('/conversations/?id=570');
    const href = detailHref(570, state);
    expect(href).toBe('/conversations/?id=570&q=ramen&sort=created&page=2');
    const query = params(href.split('?')[1]);
    expect(parseTarget(query)).toEqual({ view: 'detail', id: 570 });
    expect(parseExplorerState(query)).toEqual(state);
    expect(listHref(parseExplorerState(query))).toBe('/conversations/?q=ramen&sort=created&page=2');
  });

  it('tells the list from a conversation, and treats an unreadable id as a conversation that cannot be found', () => {
    expect(parseTarget(params(''))).toEqual({ view: 'list' });
    expect(parseTarget(params('q=id'))).toEqual({ view: 'list' });
    expect(parseTarget(params('id=12'))).toEqual({ view: 'detail', id: 12 });
    expect(parseTarget(params('id=abc'))).toEqual({ view: 'detail', id: null });
    expect(parseTarget(params('id='))).toEqual({ view: 'detail', id: null });
    expect(parseTarget(params('id=0'))).toEqual({ view: 'detail', id: null });
    expect(parseTarget(params('id=-4'))).toEqual({ view: 'detail', id: null });
    expect(parseTarget(params('id=1.5'))).toEqual({ view: 'detail', id: null });
    expect(parseTarget(params('id=1e3'))).toEqual({ view: 'detail', id: null });
  });

  it('returns to the first page when a filter or the sort order changes', () => {
    const state: ExplorerState = { ...DEFAULT_STATE, search: 'x', model: 'unknown', page: 7 };
    expect(withChange(state, { plan: 'pro' })).toEqual({ ...state, plan: 'pro', page: 1 });
    expect(toggleSort(state, 'tokens')).toEqual({ ...state, direction: 'asc', page: 1 });
    expect(toggleSort({ ...state, direction: 'asc' }, 'tokens').direction).toBe('desc');
    expect(toggleSort(state, 'title')).toEqual({ ...state, sort: 'title', direction: 'asc', page: 1 });
    expect(toggleSort({ ...state, sort: 'title', direction: 'asc' }, 'created')).toMatchObject({ sort: 'created', direction: 'desc', page: 1 });
    expect(clearFilters({ ...state, sort: 'created', direction: 'asc' })).toEqual({ ...DEFAULT_STATE, sort: 'created', direction: 'asc' });
    expect(hasFilters(clearFilters(state))).toBe(false);
    expect(hasFilters({ ...DEFAULT_STATE, sort: 'title', page: 3 })).toBe(false);
  });

  it('turns the state into a query, with the date range from the top bar', () => {
    expect(toQuery(DEFAULT_STATE, { from: null, to: null })).toEqual({
      search: undefined, model: null, sourceKind: null, plan: null, from: null, to: null, sort: 'tokens', direction: 'desc', limit: PAGE_SIZE, offset: 0,
    });
    expect(toQuery({ search: ' ramen ', model: 'unknown', source: 'claude_export', plan: 'none', sort: 'title', direction: 'asc', page: 3 }, { from: '2026-01-01', to: '2026-06-30' })).toEqual({
      search: 'ramen', model: 'unknown', sourceKind: 'claude_export', plan: 'none', from: '2026-01-01', to: '2026-06-30', sort: 'title', direction: 'asc', limit: 50, offset: 100,
    });
  });

  it('describes the rows a page shows', () => {
    expect(PAGE_SIZE).toBe(50);
    expect(pageWindow(1, 0)).toEqual({ first: 0, last: 0, pages: 0 });
    expect(pageWindow(1, 1)).toEqual({ first: 1, last: 1, pages: 1 });
    expect(pageWindow(1, 50)).toEqual({ first: 1, last: 50, pages: 1 });
    expect(pageWindow(1, 51)).toEqual({ first: 1, last: 50, pages: 2 });
    expect(pageWindow(2, 51)).toEqual({ first: 51, last: 51, pages: 2 });
    expect(pageWindow(35, 1730)).toEqual({ first: 1701, last: 1730, pages: 35 });
    // a page beyond the end is described as the last one
    expect(pageWindow(999, 1730)).toEqual({ first: 1701, last: 1730, pages: 35 });
  });
});

type Message = ConversationDetail['messages'][number];
const message = (role: string, over: Partial<Message> = {}): Message => ({
  ordinal: 0, role, at: null, textChars: 0, thinkingChars: 0, toolChars: 0, attachmentChars: 0, fileCount: 0, input: 0, output: 0, replay: 0, requests: 0, ...over,
});

describe('turns of a conversation', () => {
  it('pairs each message from the user with the replies that follow it', () => {
    const turns = turnsOf([
      message('user', { at: '2026-01-01T10:00:00.000Z', input: 100 }),
      message('assistant', { at: '2026-01-01T10:00:20.000Z', output: 300, requests: 1 }),
      message('user', { at: '2026-01-01T10:05:00.000Z', input: 50 }),
      message('assistant', { at: '2026-01-01T10:05:10.000Z', output: 200, replay: 400, requests: 2 }),
    ]);
    expect(turns).toEqual([
      { turn: 1, at: '2026-01-01T10:00:00.000Z', messages: 2, input: 100, output: 300, replay: 0, requests: 1 },
      { turn: 2, at: '2026-01-01T10:05:00.000Z', messages: 2, input: 50, output: 200, replay: 400, requests: 2 },
    ]);
  });

  it('keeps consecutive messages of one side together and copes with a conversation that Claude opens', () => {
    const turns = turnsOf([
      message('assistant', { output: 10 }),
      message('user', { input: 1 }),
      message('user', { input: 2 }),
      message('assistant', { output: 20, replay: 5 }),
      message('other', { input: 7 }),
      message('assistant', { output: 30, replay: 9 }),
      message('user', { input: 4 }),
    ]);
    expect(turns.map((t) => [t.turn, t.messages, t.input, t.output, t.replay])).toEqual([
      [1, 1, 0, 10, 0],
      [2, 5, 10, 50, 14],
      [3, 1, 4, 0, 0],
    ]);
    expect(turnsOf([])).toEqual([]);
  });
});

describe('margin of an estimation method', () => {
  it('reads as percentages below and above the estimate', () => {
    expect(formatBand(0.88, 1.12)).toBe('−12% to +12%');
    expect(formatBand(0.68, 1.16)).toBe('−32% to +16%');
    expect(formatBand(0.77, 1.31)).toBe('−23% to +31%');
    expect(formatBand(0.92, 1.08)).toBe('−8% to +8%');
    expect(formatBand(1, 1.2)).toBe('+0% to +20%');
    expect(formatBand(1, 1)).toBe('no margin');
    expect(formatBand(Number.NaN, 1)).toBe('–');
  });
});

describe('figures on the conversations pages, against the demo dataset', () => {
  const NOW = new Date('2026-11-10T12:00:00Z');
  let t: TestDb;
  const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ userId: t.userId, timezone: 'UTC', basis: 'processed', ...over });
  const one = async <T,>(sql: string, values: unknown[] = []) => (await t.db.query<T>(sql, values)).rows[0];

  beforeAll(async () => {
    t = await createTestDb('UTC');
    await loadDemoDataset(t.db, t.userId, 'UTC', NOW);
  });
  afterAll(() => t.close());

  it('lists every conversation once across its pages, largest first', async () => {
    const counted = await one<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE kind IN ('chat', 'code_session')`);
    const first = await listConversations(t.db, filter(), toQuery(DEFAULT_STATE, { from: null, to: null }));
    expect(first.total).toBe(counted.n);
    expect(first.total).toBe((await getOverview(t.db, filter())).conversations.total);
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.rows.map((r) => r.tokens)).toEqual([...first.rows.map((r) => r.tokens)].sort((a, b) => b - a));

    const shown = pageWindow(1, first.total);
    const last = await listConversations(t.db, filter(), toQuery({ ...DEFAULT_STATE, page: shown.pages }, { from: null, to: null }));
    expect(last.rows).toHaveLength(pageWindow(shown.pages, first.total).last - pageWindow(shown.pages, first.total).first + 1);
    const second = await listConversations(t.db, filter(), toQuery({ ...DEFAULT_STATE, page: 2 }, { from: null, to: null }));
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(2 * PAGE_SIZE);
    expect(second.rows[0].tokens).toBeLessThanOrEqual(first.rows[PAGE_SIZE - 1].tokens);
  });

  it('applies the filters of a linked view', async () => {
    const state = parseExplorerState(params('q=ramen&source=claude_export&plan=pro&sort=created&dir=asc'));
    const page = await listConversations(t.db, filter(), toQuery(state, { from: null, to: null }));
    const direct = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations c JOIN data_sources s ON s.id = c.source_id
        WHERE c.title ILIKE '%ramen%' AND s.kind = 'claude_export'
          AND EXISTS (SELECT 1 FROM subscription_periods sp WHERE sp.plan_key = 'pro'
                        AND (c.created_at AT TIME ZONE 'UTC')::date >= sp.start_date AND (sp.last_date IS NULL OR (c.created_at AT TIME ZONE 'UTC')::date <= sp.last_date))`,
    );
    expect(page.total).toBe(direct.n);
    expect(page.total).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.sourceKind === 'claude_export' && r.planKey === 'pro' && /ramen/i.test(r.title ?? ''))).toBe(true);
    expect(page.rows.map((r) => r.createdAt)).toEqual([...page.rows.map((r) => r.createdAt)].sort());

    const range = { from: '2026-01-01', to: '2026-03-31' };
    const ranged = await listConversations(t.db, filter(), toQuery(DEFAULT_STATE, range));
    const inRange = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations WHERE kind IN ('chat', 'code_session') AND created_at >= '2026-01-01' AND created_at < '2026-04-01'`,
    );
    expect(ranged.total).toBe(inRange.n);
  });

  it('offers a model in the filter only when the filter will find conversations for it', async () => {
    const options = await listConversationModels(t.db, t.userId);
    expect(options.reduce((sum, o) => sum + o.conversations, 0)).toBe((await listConversations(t.db, filter(), { limit: 1 })).total);
    for (const option of options) {
      const page = await listConversations(t.db, filter(), { model: option.modelKey ?? 'unknown', limit: 1 });
      expect(page.total).toBe(option.conversations);
      expect(page.total).toBeGreaterThan(0);
    }
    // Haiku only ever assisted inside sessions here: it has usage, but no conversation is filed under it.
    const breakdown = await getModelBreakdown(t.db, filter());
    const assisting = breakdown.filter((m) => m.modelKey !== null && m.conversations > 0 && !options.some((o) => o.modelKey === m.modelKey));
    expect(assisting.map((m) => m.family)).toEqual(['haiku', 'haiku']);
  });

  it('shows a chat whose turns, message list and totals agree', async () => {
    const chat = (await listConversations(t.db, filter(), { sourceKind: 'claude_export', limit: 1 })).rows[0];
    const detail = (await getConversationDetail(t.db, filter(), chat.id))!;
    const overview = await getOverview(t.db, filter({ conversationId: chat.id }));
    expect(detail.messagesTruncated).toBe(false);

    // straight from the estimates table, converted and rounded per message as the view does
    const direct = await one<{ input: string; output: string; replay: string; messages: number }>(
      `SELECT sum(round(e.input_base * m.central_factor))::text AS input, sum(round(e.output_base * m.central_factor))::text AS output,
              sum(round(e.replay_base * m.central_factor))::text AS replay, count(*)::int AS messages
         FROM token_estimates e JOIN estimation_methods m ON m.id = e.method_id WHERE e.conversation_id = $1`,
      [chat.id],
    );
    const totals = { input: Number(direct.input), output: Number(direct.output), replay: Number(direct.replay) };
    expect(chat.tokens).toBe(totals.input + totals.output + totals.replay);
    expect(overview.tokens).toMatchObject({ total: chat.tokens, exact: 0, estimated: chat.tokens, ...totals, cacheRead: 0, cacheWrite: 0 });
    expect(detail.conversation.messageCount).toBe(direct.messages);

    const turns = turnsOf(detail.messages);
    expect(turns).toHaveLength(detail.conversation.userMessages);
    expect(turns.reduce((s, x) => s + x.messages, 0)).toBe(detail.messages.length);
    for (const key of ['input', 'output', 'replay'] as const) {
      expect(turns.reduce((s, x) => s + x[key], 0)).toBe(totals[key]);
      expect(detail.messages.reduce((s, m) => s + m[key], 0)).toBe(totals[key]);
    }
    expect(turns.reduce((s, x) => s + x.requests, 0)).toBe(overview.requests);
    // the first reply has nothing before it to re-read
    expect(turns[0].replay).toBe(0);
    expect(turns[turns.length - 1].replay).toBeGreaterThan(turns[1].replay);

    // under the New basis the re-read context is not part of the total
    const fresh = await getOverview(t.db, filter({ conversationId: chat.id, basis: 'new' }));
    expect(fresh.tokens.total).toBe(totals.input + totals.output);
  });

  it('shows the margin the estimation method gives', async () => {
    const chat = (await listConversations(t.db, filter(), { sourceKind: 'claude_export', limit: 1 })).rows[0];
    const detail = (await getConversationDetail(t.db, filter(), chat.id))!;
    const { tokens } = await getOverview(t.db, filter({ conversationId: chat.id }));
    // one method applies, so the band on screen is the estimated part scaled by its two factors
    expect(detail.methods).toHaveLength(1);
    const [method] = detail.methods;
    expect(method.messages).toBe(detail.messages.length);
    expect(Math.abs(tokens.low - (tokens.exact + tokens.estimated * method.lowFactor))).toBeLessThanOrEqual(1);
    expect(Math.abs(tokens.high - (tokens.exact + tokens.estimated * method.highFactor))).toBeLessThanOrEqual(1);
    expect(formatBand(method.lowFactor, method.highFactor)).toBe('−12% to +12%');
    expect(tokens.low).toBeLessThan(tokens.total);
    expect(tokens.high).toBeGreaterThan(tokens.total);

    // a recent chat is estimated with the wider "model not recorded" method
    const recent = (await listConversations(t.db, filter(), { sourceKind: 'claude_export', sort: 'created', direction: 'desc', limit: 1 })).rows[0];
    const recentDetail = (await getConversationDetail(t.db, filter(), recent.id))!;
    expect(recentDetail.methods.map((m) => formatBand(m.lowFactor, m.highFactor))).toEqual(['−23% to +31%']);
  });

  it('splits a Claude Code session by model without losing a token or a cent', async () => {
    const session = (await listConversations(t.db, filter(), { sourceKind: 'claude_code', limit: 1 })).rows[0];
    const scoped = filter({ conversationId: session.id });
    const detail = (await getConversationDetail(t.db, filter(), session.id))!;
    const overview = await getOverview(t.db, scoped);
    const models = await getModelBreakdown(t.db, scoped);
    const value = await getApiValue(t.db, scoped);

    const direct = await one<{ tokens: string; requests: string; models: number }>(
      `SELECT sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)::text AS tokens,
              sum(request_count)::text AS requests, count(DISTINCT model_id)::int AS models
         FROM usage_records WHERE conversation_id = $1`,
      [session.id],
    );
    expect(detail.messages).toEqual([]);
    expect(detail.methods).toEqual([]);
    expect(detail.limitations).toEqual([]);
    expect(session.tokens).toBe(Number(direct.tokens));
    expect(overview.tokens).toMatchObject({ total: session.tokens, exact: session.tokens, estimated: 0, low: session.tokens, high: session.tokens, replay: 0 });
    expect(overview.requests).toBe(Number(direct.requests));

    expect(models).toHaveLength(direct.models);
    expect(models.length).toBeGreaterThan(1);
    expect(models[0].modelKey).toBe(session.modelKey);
    expect(models.reduce((s, m) => s + m.total, 0)).toBe(session.tokens);
    expect(models.reduce((s, m) => s + m.requests, 0)).toBe(overview.requests);
    const summed = models.reduce((s, m) => s.add(m.value.totalStandardUsd), Decimal.zero);
    expect(Math.abs(summed.sub(value.totalStandardUsd).toNumber())).toBeLessThan(0.00001);
    expect(value.unpricedTokens).toBe(0);
    expect(value.totalStandardUsd).toBe(value.totalCachedUsd);
  });

  it('cannot price a chat whose source names no model', async () => {
    const chat = (await listConversations(t.db, filter(), { sourceKind: 'claude_export', limit: 1 })).rows[0];
    const value = await getApiValue(t.db, filter({ conversationId: chat.id }));
    expect(value).toMatchObject({ pricedTokens: 0, unpricedTokens: chat.tokens, totalStandardUsd: '0', assumedModel: null });
    expect(value.unpriced).toEqual([{ reason: 'unknown_model', modelKey: null, displayName: null, priceTier: 'standard', tokens: chat.tokens }]);
    // only an explicit assumption prices it, and then the two caching scenarios differ
    const assumed = await getApiValue(t.db, filter({ conversationId: chat.id }), { assumedModelKey: 'claude-sonnet-4-5' });
    expect(assumed.assumedTokens).toBe(chat.tokens);
    expect(Number(assumed.totalStandardUsd)).toBeGreaterThan(Number(assumed.totalCachedUsd));
    expect(Number(assumed.totalCachedUsd)).toBeGreaterThan(0);
  });

  it('answers with nothing for a conversation that does not exist', async () => {
    expect(await getConversationDetail(t.db, filter(), 99_999_999)).toBeNull();
  });
});
