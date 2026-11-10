'use client';

import { useIsFetching } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip } from '@/components/ui/overlay';
import { autoSyncEnabled, useAutoSyncEnabled } from '@/features/import/local-files';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useApp } from '@/state/app';

/**
 * Shows when the figures were last read from the database, and re-reads them on demand.
 *
 * A refresh may also look into the remembered Claude Code folder, which saves new usage
 * without a preview. That is only done where the person asked for exactly this: with
 * "Read the folder automatically" switched on. With the switch off, and after a deletion
 * has switched it off, a refresh only reads what is stored: it must never put back usage
 * that was just deleted, nor save anything nobody previewed.
 */
export function RefreshStatus() {
  const { lastRefreshedAt, notifyDataChanged, db, userId } = useApp();
  const fetching = useIsFetching() > 0;
  const [now, setNow] = useState(() => Date.now());
  // Read again whenever the figures were refreshed: the switch is flipped on another page, or by a deletion.
  const readsFolder = useAutoSyncEnabled(lastRefreshedAt);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const [syncing, setSyncing] = useState(false);
  const refresh = async () => {
    notifyDataChanged();
    setSyncing(true);
    try {
      // Asked again at the moment of the click: the switch may have changed since this was drawn.
      if (!(await autoSyncEnabled())) return;
      // Only if the browser already allows it: no prompt from here.
      const { syncClaudeCodeFolder } = await import('@/features/import/background-sync');
      const result = await syncClaudeCodeFolder(db, userId, false);
      if (result.status === 'done' && !result.outcome.problem && result.outcome.added > 0) notifyDataChanged();
    } catch {
      // The figures were re-read above; a folder that cannot be read is reported on the import page.
    } finally {
      setSyncing(false);
    }
  };

  const text = fetching || syncing ? 'Refreshing…' : `Updated ${formatRelative(lastRefreshedAt, Math.max(now, lastRefreshedAt))}`;
  return (
    <Tooltip
      content={
        readsFolder
          ? 'Read every figure again from the database on this device, and check the remembered Claude Code folder for new sessions'
          : 'Read every figure again from the database on this device'
      }
    >
      <button
        type="button"
        onClick={() => void refresh()}
        aria-label={`${text}. Refresh now`}
        className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
      >
        <RefreshCw className={cn('size-4', (fetching || syncing) && 'animate-[spin-slow_0.9s_linear_infinite]')} aria-hidden="true" />
        <span className="hidden xl:inline" aria-live="polite">
          {text}
        </span>
      </button>
    </Tooltip>
  );
}
