'use client';

import { useState, useSyncExternalStore } from 'react';

/**
 * Holds on to the last complete value while the next one is being read.
 *
 * The page derives its figures from several queries plus the controls. While a new
 * range or view is loading, some of those inputs already describe the new request and
 * others still the old one; mixing them would put wrong numbers on screen for a moment.
 * Callers pass `null` until everything belongs to the same request, and the previous
 * complete value stays visible (dimmed) in the meantime.
 */
export function useSettled<T>(value: T | null): { value: T | null; stale: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  if (value !== null && value !== kept) setKept(value);
  return { value: value ?? kept, stale: value === null && kept !== null };
}

/** Whether a CSS media query matches. False until the page runs in the browser. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
