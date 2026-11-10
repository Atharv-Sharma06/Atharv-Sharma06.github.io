'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  deletePeriod, getBeforeAfter, getBeforeAfterConversationUsage, getSegmentStats, planLabel, type SubscriptionPeriod,
} from '@/analytics/subscriptions';
import { getActualSpend, getApiValue } from '@/analytics/value';
import { PageHeader } from '@/components/shell/page-header';
import { Button, buttonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { dayInZone, formatDay } from '@/lib/format';
import { useApp, useData } from '@/state/app';
import { useCoverage, usePeriods } from '@/state/queries';
import { BeforeAfterCard } from './before-after';
import { describeDates, segmentDates } from './logic';
import { MoneyCard } from './money';
import { PeriodEditor, type EditorTarget } from './period-editor';
import { PeriodsTable } from './periods-table';
import { Timeline } from './timeline';

/**
 * Subscription History: the plans a person was on, entered by them, and what their
 * usage looked like on each. Nothing about plans is detected or assumed. The page always
 * covers the whole history, because a period keeps its meaning whatever range is selected.
 */
export function SubscriptionsPage() {
  const app = useApp();
  const { settings } = app;
  const valueOptions = { assumedModelKey: settings.assumedModelKey };

  const coverage = useCoverage();
  const periods = usePeriods();
  // "Now" is fixed when the segments are read, so the timeline ends exactly where their figures do.
  const timeline = useData(['subscriptions', 'segments', settings.assumedModelKey], async (a) => {
    const now = new Date();
    return { now: now.toISOString(), segments: await getSegmentStats(a.db, a.lifetime, valueOptions, now) };
  });
  const beforeAfter = useData(['subscriptions', 'before-after', settings.assumedModelKey], (a) => getBeforeAfter(a.db, a.lifetime, valueOptions));
  const inConversations = useData(['subscriptions', 'conversation-usage'], (a) => getBeforeAfterConversationUsage(a.db, a.lifetime));
  const value = useData(['subscriptions', 'api-value', settings.assumedModelKey], (a) => getApiValue(a.db, a.lifetime, valueOptions));
  const spend = useData(['subscriptions', 'spend'], (a) => getActualSpend(a.db, a.userId));

  const [editor, setEditor] = useState<{ target: EditorTarget; visit: number } | null>(null);
  const [deleting, setDeleting] = useState<SubscriptionPeriod | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // The shared Dialog has no trigger element to hand the focus back to when it closes, so
  // the page remembers what opened a dialog and returns the focus there itself.
  const opener = useRef<HTMLElement | null>(null);
  const dialogOpen = editor !== null || deleting !== null;
  const rememberOpener = () => {
    if (!dialogOpen) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  useEffect(() => {
    if (dialogOpen) return;
    const element = opener.current;
    opener.current = null;
    if (!element) return;
    // One tick later, after the dialog's own focus handling has run.
    const timer = window.setTimeout(() => (element.isConnected ? element : document.getElementById('main'))?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [dialogOpen]);

  // Each visit to the editor gets a new key, so the form always starts from the stored values.
  const open = (target: EditorTarget) => {
    rememberOpener();
    setEditor((previous) => ({ target, visit: (previous?.visit ?? 0) + 1 }));
  };
  const addPeriod = (dates?: { startDate: string; lastDate: string | null }) => open({ kind: 'add', dates });
  const editPeriod = (period: SubscriptionPeriod) => open({ kind: 'edit', period });
  const askToDelete = (period: SubscriptionPeriod) => {
    rememberOpener();
    setDeleting(period);
  };

  const failure = periods.error ?? coverage.error ?? timeline.error ?? beforeAfter.error ?? inConversations.error ?? value.error ?? spend.error;
  const ready = coverage.data !== undefined && periods.data !== undefined && timeline.data !== undefined;
  const hasUsage = coverage.data?.hasData ?? false;
  const periodCount = periods.data?.length ?? 0;
  const segments = timeline.data?.segments ?? [];
  const firstSegment = segments[0];
  const today = timeline.data ? dayInZone(timeline.data.now, settings.timezone) : null;
  // A period entered with dates in the future makes the band run past today.
  const lastDates = segments.length > 0 ? segmentDates(segments[segments.length - 1], settings.timezone) : null;
  const lastDay = lastDates ? (lastDates.lastDate ?? lastDates.startDate) : null;
  const timelineEnd = today && lastDay && lastDay > today ? formatDay(lastDay) : 'today';
  const describe = (period: SubscriptionPeriod) => `${planLabel(period.planKey, period.label)}, ${describeDates(period, today ?? period.startDate)}`;

  const addButton = (
    <Button variant="primary" onClick={() => addPeriod()}>
      <Plus className="size-4" aria-hidden="true" />
      Add period
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Subscription History"
        description="The plans you were on, as you entered them, and what your usage looked like on each. This page always covers your whole history; the date range above does not apply here."
        actions={addButton}
      />

      {failure ? (
        <ErrorNote title="The figures could not be read from the local database" className="mb-6">
          {failure.message}
        </ErrorNote>
      ) : null}

      {!ready ? (
        failure ? null : (
          <div aria-busy="true" className="space-y-4">
            <Skeleton className="h-44" />
            <Skeleton className="h-56" />
            <Skeleton className="h-72" />
          </div>
        )
      ) : (
        <div className={cn('space-y-4 transition-opacity', (timeline.isPlaceholderData || periods.isPlaceholderData) && 'opacity-70')}>
          {periodCount === 0 || !timeline.data || !firstSegment ? (
            <EmptyState title="No subscription periods yet" action={addButton}>
              <p>
                Your imported files do not say which plan you were on, and nothing is assumed, so this page starts empty. Enter when each plan started and ended to get:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>a timeline of your plans, with the tokens, conversations and equivalent API value of each period</li>
                <li>your usage before and after your first paid plan, compared per day rather than in totals</li>
                <li>what your subscriptions cost, next to what the same usage would cost at API prices</li>
              </ul>
            </EmptyState>
          ) : (
            <>
              <Card>
                <CardHeader
                  title="Your plans over time"
                  description={`Scaled by time, from ${formatDay(segmentDates(firstSegment, settings.timezone).startDate)} to ${timelineEnd}. Select a period to edit it${
                    segments.some((segment) => segment.kind === 'gap') ? ', or a stretch with no recorded plan to add one there' : ''
                  }.`}
                />
                <CardBody>
                  <Timeline
                    segments={segments}
                    now={timeline.data.now}
                    timezone={settings.timezone}
                    scenario={settings.costScenario}
                    hasUsage={hasUsage}
                    onEditPeriod={(id) => {
                      const period = periods.data?.find((p) => p.id === id);
                      if (period) editPeriod(period);
                    }}
                    onAddPeriod={addPeriod}
                  />
                </CardBody>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader
                  title="Periods"
                  description={
                    hasUsage
                      ? 'Every period and every stretch between them, oldest first. Usage belongs to a period by its date, so editing a period re-assigns it at once.'
                      : 'Every period and every stretch between them, oldest first.'
                  }
                />
                <div className="mt-4">
                  <PeriodsTable
                    segments={segments}
                    periods={periods.data ?? []}
                    now={timeline.data.now}
                    timezone={settings.timezone}
                    scenario={settings.costScenario}
                    hasUsage={hasUsage}
                    onEdit={editPeriod}
                    onDelete={askToDelete}
                    onAddPeriod={addPeriod}
                  />
                </div>
                {hasUsage ? (
                  <p className="border-t border-line px-5 py-3 text-xs text-ink-3">
                    Equivalent API value is what the usage would cost at API list prices, not money you paid. Where only a share is priced, the remaining tokens name no model, or
                    one with no price on file, and are left out.
                  </p>
                ) : null}
              </Card>
            </>
          )}

          {!hasUsage ? (
            <Card className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-[15px] font-medium text-ink">Statistics appear after an import</h2>
                <p className="mt-0.5 max-w-[70ch] text-[13px] text-ink-2">
                  Tokens, conversations, the before and after comparison and the equivalent API value are computed from imported files. The periods you enter here are kept and
                  applied to your usage by date as soon as there is some.
                </p>
              </div>
              <Link href="/import/" className={buttonClass('secondary')}>
                Import your history
              </Link>
            </Card>
          ) : periodCount === 0 ? null : beforeAfter.data && inConversations.data !== undefined ? (
            <BeforeAfterCard
              data={beforeAfter.data}
              inConversations={inConversations.data}
              historyStart={periods.data?.[0]?.startedAt ?? null}
              timezone={settings.timezone}
              scenario={settings.costScenario}
              periodCount={periodCount}
              action={addButton}
            />
          ) : (
            <Skeleton className="h-72" />
          )}

          <MoneyCard spend={spend.data} value={value.data} scenario={settings.costScenario} hasUsage={hasUsage} periodCount={periodCount} />
        </div>
      )}

      <p role="status" className="sr-only">
        {announcement}
      </p>

      {editor ? (
        <PeriodEditor
          key={editor.visit}
          target={editor.target}
          onClose={() => setEditor(null)}
          onSaved={(period) => {
            setEditor(null);
            setAnnouncement(`Saved ${describe(period)}.`);
            app.notifyDataChanged();
          }}
          onDelete={(period) => {
            setEditor(null);
            setDeleting(period);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleting(null);
        }}
        title="Delete this period?"
        confirmLabel="Delete period"
        onConfirm={async () => {
          if (!deleting) return;
          await deletePeriod(app.db, app.userId, deleting.id);
          // The row that held the focus is about to disappear; the page content takes it instead.
          opener.current = document.getElementById('main');
          setAnnouncement(`Deleted ${describe(deleting)}.`);
          app.notifyDataChanged();
        }}
      >
        {deleting ? (
          <>
            <p>
              <span className="text-ink">{describe(deleting)}</span> will be removed from your subscription history.
            </p>
            <p>Your imported usage is not touched. Usage from those days is then shown as “No subscription recorded”, and every figure on this page is worked out again.</p>
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
