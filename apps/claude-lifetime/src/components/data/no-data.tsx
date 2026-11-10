'use client';

import { FlaskConical, Upload } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { ErrorNote } from '@/components/ui/feedback';
import { useApp } from '@/state/app';

/** Loads the synthetic demo dataset. Only offered while the workspace is empty. */
export function LoadDemoButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Button
        variant={variant}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const { loadDemoDataset } = await import('@/import/demo/load');
            await loadDemoDataset(app.db, app.userId, app.settings.timezone);
            app.notifyDataChanged();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? null : <FlaskConical className="size-4" aria-hidden="true" />}
        {busy ? 'Loading demo data…' : 'Explore with demo data'}
      </Button>
      {error ? (
        <ErrorNote title="The demo data could not be loaded" className="mt-3">
          {error}
        </ErrorNote>
      ) : null}
    </div>
  );
}

/** Shown by every page while nothing has been imported: what is missing and how to change that. */
export function NoDataYet({ what = 'Nothing to show yet' }: { what?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-line-strong px-6 py-8">
      <h2 className="text-[17px] font-medium text-ink">{what}</h2>
      <p className="mt-2 max-w-[64ch] text-ink-2">
        Claude Lifetime only shows what you import: your claude.ai data export, Claude Code session logs, or Anthropic API usage reports. Nothing is
        fetched from your account, and nothing leaves this browser.
      </p>
      <div className="mt-5 flex flex-wrap items-start gap-3">
        <Link href="/import/" className={buttonClass('primary')}>
          <Upload className="size-4" aria-hidden="true" />
          Import your history
        </Link>
        <LoadDemoButton />
      </div>
      <p className="mt-4 max-w-[64ch] text-xs text-ink-3">
        The demo data is synthetic. It is labelled as such on every page and is removed automatically as soon as you import real data.
      </p>
    </div>
  );
}
