import type { ConversationQuery, ConversationSort } from '@/analytics/conversations';
import type { SourceKind } from '@/core/types';

/**
 * The explorer keeps its filters, sort and page in the query string, so a view can be
 * linked, survives a reload, and is still there when the user comes back from a
 * conversation. Defaults are left out of the URL; anything unreadable falls back to
 * its default instead of failing.
 *
 *   /conversations/?q=&model=&source=&plan=&sort=&dir=&page=     the list
 *   /conversations/?id=<id>&...the same list parameters...        one conversation
 */
export const PAGE_SIZE = 50;

/** Value of `model` for conversations whose source names no model. */
export const UNKNOWN_MODEL = 'unknown';

export interface ExplorerState {
  search: string;
  /** model_catalog.model_key, UNKNOWN_MODEL, or null for every model. */
  model: string | null;
  source: SourceKind | null;
  /** A plan key, 'none' (no subscription recorded), or null for every plan. */
  plan: string | null;
  sort: ConversationSort;
  direction: 'asc' | 'desc';
  /** 1-based. */
  page: number;
}

const SORTS: readonly ConversationSort[] = ['tokens', 'created', 'updated', 'messages', 'title'];
const SOURCE_KINDS: readonly SourceKind[] = ['claude_export', 'claude_code', 'api_usage_report', 'api_cost_report', 'generic_json', 'generic_csv', 'manual'];
const MAX_TEXT = 200;

/** Titles read naturally from A to Z; everything else is most useful largest or newest first. */
export function defaultDirection(sort: ConversationSort): 'asc' | 'desc' {
  return sort === 'title' ? 'asc' : 'desc';
}

export const DEFAULT_STATE: ExplorerState = {
  search: '',
  model: null,
  source: null,
  plan: null,
  sort: 'tokens',
  direction: defaultDirection('tokens'),
  page: 1,
};

/** Anything with `get`, so both URLSearchParams and Next's read-only variant fit. */
export interface ParamReader {
  get(name: string): string | null;
}

function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed.slice(0, MAX_TEXT);
}

function positiveInt(value: string | null): number | null {
  if (value === null || !/^\d{1,15}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

export function parseExplorerState(params: ParamReader): ExplorerState {
  const sortParam = params.get('sort');
  const sort = SORTS.find((s) => s === sortParam) ?? DEFAULT_STATE.sort;
  const dirParam = params.get('dir');
  const sourceParam = params.get('source');
  return {
    search: text(params.get('q')) ?? '',
    model: text(params.get('model')),
    source: SOURCE_KINDS.find((k) => k === sourceParam) ?? null,
    plan: text(params.get('plan')),
    sort,
    direction: dirParam === 'asc' || dirParam === 'desc' ? dirParam : defaultDirection(sort),
    page: positiveInt(params.get('page')) ?? 1,
  };
}

/** The state as query parameters, in a fixed order, without defaults. */
export function explorerParams(state: ExplorerState): URLSearchParams {
  const out = new URLSearchParams();
  const search = state.search.trim();
  if (search !== '') out.set('q', search);
  if (state.model) out.set('model', state.model);
  if (state.source) out.set('source', state.source);
  if (state.plan) out.set('plan', state.plan);
  if (state.sort !== DEFAULT_STATE.sort) out.set('sort', state.sort);
  if (state.direction !== defaultDirection(state.sort)) out.set('dir', state.direction);
  if (state.page > 1) out.set('page', String(state.page));
  return out;
}

const LIST_PATH = '/conversations/';

export function listHref(state: ExplorerState): string {
  const query = explorerParams(state).toString();
  return query === '' ? LIST_PATH : `${LIST_PATH}?${query}`;
}

/** A conversation's page. It carries the list state so "Back to conversations" returns to the same view. */
export function detailHref(id: number, state: ExplorerState): string {
  const query = explorerParams(state).toString();
  return `${LIST_PATH}?id=${id}${query === '' ? '' : `&${query}`}`;
}

export type Target = { view: 'list' } | { view: 'detail'; id: number | null };

/** Which view the URL asks for. An `id` that is not a number still means "a conversation", one that cannot be found. */
export function parseTarget(params: ParamReader): Target {
  const raw = params.get('id');
  if (raw === null) return { view: 'list' };
  return { view: 'detail', id: positiveInt(raw.trim()) };
}

export function hasFilters(state: ExplorerState): boolean {
  return state.search.trim() !== '' || state.model !== null || state.source !== null || state.plan !== null;
}

/** A change to the filters or the sort order always returns to the first page. */
export function withChange(state: ExplorerState, patch: Partial<Omit<ExplorerState, 'page'>>): ExplorerState {
  return { ...state, ...patch, page: 1 };
}

/** Clicking the active column flips its direction; a new column starts in its natural direction. */
export function toggleSort(state: ExplorerState, sort: ConversationSort): ExplorerState {
  const direction = state.sort === sort ? (state.direction === 'asc' ? 'desc' : 'asc') : defaultDirection(sort);
  return withChange(state, { sort, direction });
}

export function clearFilters(state: ExplorerState): ExplorerState {
  return withChange(state, { search: '', model: null, source: null, plan: null });
}

/** The explorer state as a query for `listConversations`; the date range comes from the top bar. */
export function toQuery(state: ExplorerState, range: { from: string | null; to: string | null }): ConversationQuery {
  return {
    search: state.search.trim() || undefined,
    model: state.model,
    sourceKind: state.source,
    plan: state.plan,
    from: range.from,
    to: range.to,
    sort: state.sort,
    direction: state.direction,
    limit: PAGE_SIZE,
    offset: (state.page - 1) * PAGE_SIZE,
  };
}

export interface PageWindow {
  /** 1-based positions of the first and last row shown; both 0 when there is nothing. */
  first: number;
  last: number;
  pages: number;
}

export function pageWindow(page: number, total: number): PageWindow {
  if (total <= 0) return { first: 0, last: 0, pages: 0 };
  const pages = Math.ceil(total / PAGE_SIZE);
  const current = Math.min(Math.max(page, 1), pages);
  return { first: (current - 1) * PAGE_SIZE + 1, last: Math.min(current * PAGE_SIZE, total), pages };
}
