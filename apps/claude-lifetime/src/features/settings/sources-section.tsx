'use client';

import { FlaskConical, Trash, Upload } from 'lucide-react';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import type { SourceCoverage } from '@/analytics/coverage';
import { setSourceIncluded } from '@/analytics/settings';
import { deletePeriod, listPeriods } from '@/analytics/subscriptions';
import { LoadDemoButton } from '@/components/data/no-data';
import { SOURCE_KIND_LABEL } from '@/components/shell/coverage-indicator';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Switch } from '@/components/ui/controls';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { Dialog } from '@/components/ui/overlay';
import { deleteSource } from '@/import/delete';
import { cn } from '@/lib/cn';
import { formatInstant, formatInt, formatTokens, formatUsd, plural } from '@/lib/format';
import { useApp } from '@/state/app';
import { useCoverage } from '@/state/queries';
import { SaveError, SaveNote, SettingsSection, Tag, useSaveState } from './parts';

function Fact({ label, children, title, className }: { label: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="tabular mt-0.5 text-ink" title={title}>
        {children}
      </dd>
    </div>
  );
}

const NONE = <span className="text-ink-3">–</span>;

/** Asks why a source is left out. The reason is optional; it is only there to jog the user's memory later. */
function ExcludeDialog({
  source,
  onClose,
  onSave,
}: {
  source: SourceCoverage;
  onClose: () => void;
  onSave: (reason: string) => Promise<void>;
}) {
  const formId = useId();
  const [reason, setReason] = useState(source.exclusionReason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !source.includeInTotals;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={editing ? `Why “${source.label}” is left out` : `Leave “${source.label}” out of totals?`}
      description={
        editing
          ? 'The note is shown next to the source.'
          : 'Its tokens, conversations and reported costs stop counting towards every figure in the app. Nothing is deleted: the source stays stored and can be counted again at any time.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            {editing ? 'Save reason' : 'Leave out of totals'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onSave(reason);
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Reason (optional)" hint="For example: already counted in my Claude Code logs.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoComplete="off" autoFocus />
        </Field>
      </form>
      {error ? (
        <ErrorNote title="The change could not be saved" className="mt-4">
          {error}
        </ErrorNote>
      ) : null}
    </Dialog>
  );
}

function SourceItem({ source, lastSynthetic }: { source: SourceCoverage; lastSynthetic: boolean }) {
  const app = useApp();
  const tz = app.settings.timezone;
  const save = useSaveState();
  const [pending, setPending] = useState<{ include: boolean; reason: string | null } | null>(null);
  const [excluding, setExcluding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // What was just saved is shown until the re-read list confirms it, so the row never falls back to the old state in between.
  if (pending !== null && pending.include === source.includeInTotals && pending.reason === source.exclusionReason) setPending(null);
  const included = pending ? pending.include : source.includeInTotals;
  const reason = pending ? pending.reason : source.exclusionReason;
  const tokens = source.exactTokens + source.estimatedTokens;

  const setIncluded = async (include: boolean, why?: string) => {
    // Stored the way setSourceIncluded stores it: trimmed, empty as none, and dropped when the source counts again.
    setPending({ include, reason: include ? null : why?.trim() || null });
    try {
      await setSourceIncluded(app.db, app.userId, source.id, include, why);
    } catch (error) {
      setPending(null);
      throw error;
    }
    app.notifyDataChanged();
  };

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className={cn('text-sm font-medium', included ? 'text-ink' : 'text-ink-2')}>{source.label}</h3>
            {source.isSynthetic ? <Tag icon={<FlaskConical className="size-3 text-warning" aria-hidden="true" />}>Synthetic</Tag> : null}
            {!included ? <Tag>Left out of totals</Tag> : null}
          </div>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {SOURCE_KIND_LABEL[source.kind] ?? source.kind}, {plural(source.imports, 'import')}
            {source.lastImportAt ? `, the latest on ${formatInstant(source.lastImportAt, tz)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* A fixed slot in front of the switch on wide screens, the end of the line on narrow ones: the controls never move when it appears. */}
          <SaveNote state={save.state} className="order-last sm:order-first sm:w-16 sm:justify-end" />
          <label className="flex h-8 cursor-pointer items-center gap-2.5 text-[13px] text-ink-2">
            Count in totals
            <Switch
              label={`Count in totals: ${source.label}`}
              checked={included}
              onChange={(next) => {
                if (next) void save.run(() => setIncluded(true));
                else setExcluding(true);
              }}
            />
          </label>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
            <Trash className="size-3.5" aria-hidden="true" />
            Delete source
          </Button>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3 lg:grid-cols-[minmax(0,1.7fr)_repeat(4,minmax(0,1fr))]">
        <Fact label="Records dated" className="col-span-2 sm:col-span-1">
          {source.firstRecordAt ? `${formatInstant(source.firstRecordAt, tz)} – ${formatInstant(source.lastRecordAt, tz)}` : NONE}
        </Fact>
        <Fact label="Conversations">{source.conversations > 0 ? formatInt(source.conversations) : NONE}</Fact>
        <Fact label="Exact tokens" title={source.exactTokens > 0 ? `${formatInt(source.exactTokens)} tokens` : undefined}>
          {source.exactTokens > 0 ? formatTokens(source.exactTokens) : NONE}
        </Fact>
        <Fact label="Estimated tokens" title={source.estimatedTokens > 0 ? `${formatInt(source.estimatedTokens)} tokens` : undefined}>
          {source.estimatedTokens > 0 ? formatTokens(source.estimatedTokens) : NONE}
        </Fact>
        {source.reportedCostUsd !== null ? <Fact label="Billed cost reported">{formatUsd(source.reportedCostUsd)}</Fact> : null}
      </dl>

      {!included ? (
        <p className="mt-3 text-[13px] text-ink-2">
          {reason ? (
            <>
              Left out because: <span className="text-ink">{reason}</span>
            </>
          ) : (
            'No reason was noted for leaving it out.'
          )}{' '}
          <button type="button" onClick={() => setExcluding(true)} className="ml-1.5 rounded text-accent-soft underline-offset-4 hover:underline">
            {reason ? 'Edit reason' : 'Add a reason'}
          </button>
        </p>
      ) : null}
      <SaveError state={save.state} className="mt-2" />

      {excluding ? (
        <ExcludeDialog
          source={{ ...source, includeInTotals: included, exclusionReason: reason }}
          onClose={() => setExcluding(false)}
          onSave={async (reason) => {
            await setIncluded(false, reason);
            save.markSaved();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${source.label}”?`}
        confirmLabel="Delete source"
        onConfirm={async () => {
          await deleteSource(app.db, app.userId, source.id);
          if (lastSynthetic) {
            // The demo's invented subscription periods must not outlive the demo data they describe.
            const periods = await listPeriods(app.db, app.userId, tz);
            for (const period of periods) if (period.isSynthetic) await deletePeriod(app.db, app.userId, period.id);
          }
          app.notifyDataChanged();
        }}
      >
        <p>This removes the source from this device together with everything that was imported into it:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{source.imports === 1 ? 'its import' : `all ${formatInt(source.imports)} of its imports`}</li>
          {source.conversations > 0 ? (
            <li>
              {source.kind === 'claude_code'
                ? plural(source.conversations, 'Claude Code session')
                : `${plural(source.conversations, 'conversation')} and their message records`}
            </li>
          ) : null}
          <li>{tokens > 0 ? `its usage records, ${formatTokens(tokens)} processed tokens in all` : 'its usage records'}</li>
          {source.reportedCostUsd !== null ? <li>the {formatUsd(source.reportedCostUsd)} of billed cost it reported</li> : null}
          {lastSynthetic ? <li>the demo’s subscription periods, since this is the last demo source</li> : null}
        </ul>
        <p>
          Other sources, {lastSynthetic ? 'subscription periods you entered' : 'your subscription history'}, prices and settings are kept. Deleting cannot
          be undone; to get this data back you would import the files again.
        </p>
      </ConfirmDialog>
    </li>
  );
}

export function SourcesSection() {
  const timezone = useApp().settings.timezone;
  const coverage = useCoverage();
  const sources = coverage.data?.sources ?? [];
  const counted = sources.filter((s) => s.includeInTotals);
  const synthetic = sources.filter((s) => s.isSynthetic);

  return (
    <SettingsSection
      id="sources"
      title="Data sources"
      description={
        <>
          <p>
            Every import belongs to a source. Two sources can report the same usage: an Anthropic usage report and Claude Code logs when Claude Code
            ran on an API key, for example, or a Console CSV and an Admin API report for the same period. Counting both would double those tokens, so
            leave one of them out of the totals.
          </p>
          <p>A source you leave out stays stored and can be counted again at any time.</p>
        </>
      }
      action={
        <Link href="/import/" className={buttonClass('secondary', 'sm')}>
          See every import
        </Link>
      }
    >
      {coverage.error ? (
        <ErrorNote title="The sources could not be read from the local database">{coverage.error.message}</ErrorNote>
      ) : !coverage.data ? (
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-28 rounded-[var(--radius-card)]" />
          <Skeleton className="h-28 rounded-[var(--radius-card)]" />
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          title="No sources yet"
          action={
            <div className="flex flex-wrap items-start gap-3">
              <Link href="/import/" className={buttonClass('primary')}>
                <Upload className="size-4" aria-hidden="true" />
                Import your history
              </Link>
              <LoadDemoButton />
            </div>
          }
        >
          Every figure in the app comes from files you import: a claude.ai data export, Claude Code session logs or an Anthropic API usage report.
          Each of them shows up here as a source once it is imported. The demo data is synthetic and labelled as such on every page.
        </EmptyState>
      ) : (
        <Card className={cn('transition-opacity', coverage.isPlaceholderData && 'opacity-70')}>
          <p className="border-b border-line px-5 py-3 text-[13px] text-ink-2">
            {counted.length === sources.length ? (
              sources.length === 1 ? (
                'This source counts towards totals'
              ) : (
                <>All {formatInt(sources.length)} sources count towards totals</>
              )
            ) : (
              <>
                {formatInt(counted.length)} of {plural(sources.length, 'source')} {counted.length === 1 ? 'counts' : 'count'} towards totals
              </>
            )}
            {coverage.data.exactTokens + coverage.data.estimatedTokens > 0 ? (
              <>
                : <span className="tabular text-ink">{formatTokens(coverage.data.exactTokens)}</span> exact and{' '}
                <span className="tabular text-ink">{formatTokens(coverage.data.estimatedTokens)}</span> estimated tokens.
              </>
            ) : (
              '.'
            )}
          </p>
          <ul className="divide-y divide-line">
            {sources.map((source) => (
              <SourceItem key={source.id} source={source} lastSynthetic={source.isSynthetic && synthetic.length === 1} />
            ))}
          </ul>
          <p className="border-t border-line px-5 py-3 text-xs text-ink-3">
            Token figures in this list are processed tokens, whichever token basis is selected. Dates follow the timezone set above ({timezone}).
          </p>
        </Card>
      )}
    </SettingsSection>
  );
}
