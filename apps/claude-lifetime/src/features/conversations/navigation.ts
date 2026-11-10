import type { MouseEvent } from 'react';
import { explorerParams, type ExplorerState } from './url-state';

/**
 * Moving between the list and a conversation.
 *
 * Both are views of one page, told apart by the query string, and everything they show
 * is read from the database in this browser. So the switch is done with the History
 * API: the URL changes in place, Next keeps useSearchParams in step, and nothing is
 * requested from anywhere. Back, forward, reload and copied links keep working because
 * the URL is the state. The links stay real links: a click that asks for a new tab or
 * window is left to the browser.
 */
type FocusTarget = { view: 'detail' } | { view: 'list'; id: number };

/** Where keyboard focus should land once the next view is on screen. */
let pendingFocus: FocusTarget | null = null;

/** Hands the pending focus target to the view it is meant for, once. */
export function takePendingFocus<V extends FocusTarget['view']>(view: V): Extract<FocusTarget, { view: V }> | null {
  if (pendingFocus?.view !== view) return null;
  const target = pendingFocus as Extract<FocusTarget, { view: V }>;
  pendingFocus = null;
  return target;
}

function pushQuery(query: string) {
  window.history.pushState(null, '', query === '' ? window.location.pathname : `?${query}`);
  // A new view starts at its top, as it would after following a link.
  window.scrollTo(0, 0);
}

export function isPlainClick(event: MouseEvent): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Shows a conversation. Focus moves to its heading, so a screen reader announces where the user now is. */
export function openConversation(id: number, state: ExplorerState) {
  pendingFocus = { view: 'detail' };
  const query = explorerParams(state).toString();
  pushQuery(`id=${id}${query === '' ? '' : `&${query}`}`);
}

/** Returns to the list a conversation was opened from. Focus returns to that conversation's row when it is on the page. */
export function returnToList(fromId: number | null, state: ExplorerState) {
  pendingFocus = fromId === null ? null : { view: 'list', id: fromId };
  pushQuery(explorerParams(state).toString());
}

/** Click handler for a link to a conversation: handles a plain click in place and leaves every other kind to the browser. */
export function onOpenClick(event: MouseEvent<HTMLAnchorElement>, id: number, state: ExplorerState) {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  openConversation(id, state);
}

/** Click handler for a link back to the list. */
export function onReturnClick(event: MouseEvent<HTMLAnchorElement>, fromId: number | null, state: ExplorerState) {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  returnToList(fromId, state);
}
