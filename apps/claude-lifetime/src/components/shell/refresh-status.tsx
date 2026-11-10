'use client';

import { useIsFetching } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useApp } from '@/state/app';

/** Shows when the figures were last read from the database, and re-reads them on demand. */
export function RefreshStatus() {
  const { lastRefreshedAt, notifyDataChanged } = useApp();
  const fetching = useIsFetching() > 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setNow(Date.now()), [lastRefreshedAt]);

  const text = fetching ? 'Refreshing…' : `Updated ${formatRelative(lastRefreshedAt, now)}`;
  return (
    <Tooltip content="Read every figure again from the database on this device">
      <button
        type="button"
        onClick={notifyDataChanged}
        aria-label={`${text}. Refresh now`}
        className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
      >
        <RefreshCw className={cn('size-4', fetching && 'animate-[spin-slow_0.9s_linear_infinite]')} aria-hidden="true" />
        <span className="hidden xl:inline" aria-live="polite">
          {text}
        </span>
      </button>
    </Tooltip>
  );
}
