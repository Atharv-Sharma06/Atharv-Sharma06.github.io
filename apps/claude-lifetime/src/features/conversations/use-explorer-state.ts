'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { explorerParams, parseExplorerState, type ExplorerState } from './url-state';

/**
 * The explorer's filters, sort and page, kept in step with the query string.
 *
 * While the list is on screen its own state leads and the URL follows: a change shows
 * at once and is then written to the address bar with the History API, which requests
 * nothing. The URL is not read back for our own changes, for a reason that is easy to
 * miss: the router applies a URL written this way a moment later, and while several
 * writes are settling (someone typing in the search box) `useSearchParams` can briefly
 * report an earlier one. Following it would undo what the user just did.
 *
 * A URL that changes without a write from here is a different matter: the back and
 * forward buttons, or the "Conversations" link in the sidebar. The state follows it at
 * once, unless the URL shows something this list held a moment ago. That is most
 * likely an echo of our own writes, so it is only adopted if it stays.
 */
const SETTLE_MS = 1000;
/** How long a state we moved away from is still treated as a possible echo. */
const ECHO_MS = 1500;

const keyOf = (state: ExplorerState) => explorerParams(state).toString();

function writeUrl(state: ExplorerState) {
  const query = keyOf(state);
  window.history.replaceState(null, '', query === '' ? window.location.pathname : `?${query}`);
}

export type ChangeExplorerState = (next: (current: ExplorerState) => ExplorerState) => void;

export function useExplorerState(fromUrl: ExplorerState): [ExplorerState, ChangeExplorerState] {
  const [state, setState] = useState(fromUrl);
  // The same value for event handlers, which must build on the latest change even when it has not rendered yet.
  const latest = useRef(fromUrl);
  const left = useRef<Array<{ key: string; until: number }>>([]);

  const change = useCallback<ChangeExplorerState>((next) => {
    const previous = latest.current;
    const value = next(previous);
    const now = performance.now();
    left.current = [...left.current.filter((entry) => entry.until > now), { key: keyOf(previous), until: now + ECHO_MS }];
    latest.current = value;
    setState(value);
    writeUrl(value);
  }, []);

  const urlKey = keyOf(fromUrl);
  const stateKey = keyOf(state);
  useEffect(() => {
    if (urlKey === stateKey) return;
    const now = performance.now();
    const maybeEcho = left.current.some((entry) => entry.key === urlKey && entry.until > now);
    const timer = window.setTimeout(
      () => {
        const adopted = parseExplorerState(new URLSearchParams(urlKey));
        latest.current = adopted;
        setState(adopted);
      },
      maybeEcho ? SETTLE_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [urlKey, stateKey]);

  return [state, change];
}
