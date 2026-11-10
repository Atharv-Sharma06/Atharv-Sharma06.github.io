'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  deletePeriod, getBeforeAfter, getBeforeAfterConversationUsage, getRecordedHistory, getSegmentStats, planLabel, type SubscriptionPeriod,
} from '@/analytics/subscriptions';
import { getActualSpend, getApiValue } from '@/analytics/value';
import { PageHeader } from '@/components/shell/page-header';
import { Button, buttonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { dayInZone, formatDay, todayInZone } from '@/lib/format';
import { useApp, useData } from '@/state/app';
import { useCoverage, usePeriods } from '@/state/queries';
import { BeforeAfterCard } from './before-after';
import { describeDates, focusTargetAfterChange, pricesEstimates, scenarioPhrase, segmentDays } from './logic';
import { MoneyCard } from './money';
import { PeriodEditor, type EditorTarget } from './period-editor';
import { PeriodsTable, StoredPeriodsTable } from './periods-table';
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
  const spend = useData(['subscriptions', 'spend'], (a) => getActualSpend(a.db, a.userId, a.settings.timezone));
  const recorded = useData(['subscriptions', 'recorded-history'], (a) => getRecordedHistory(a.db, a.lifetime));

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
    // One tick later, after the dialog's own focus handling has run. The view stays where it is.
    const timer = window.setTimeout(() => (element.isConnected ? element : document.getElementById('main'))?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [dialogOpen]);

  // After a save or a delete the page reads its data again, and the row or block that
  // opened the dialog may be replaced by then. The dialog hands the focus back to it while
  // it is still on screen, before the new data arrives, and the focus would be lost with
  // it. So the focus is placed once more after the new data is on the page.
  const pendingFocus = useRef<{ opener: HTMLElement | null; periodId: number | null; stalePeriods: unknown; staleTimeline: unknown } | null>(null);
  const afterChange = (periodId: number | null) => {
    pendingFocus.current = { opener: opener.current, periodId, stalePeriods: periods.data, staleTimeline: timeline.data };
    // The element that opened the dialog is handled below, not on close.
    opener.current = null;
  };
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || dialogOpen || periods.isFetching || timeline.isFetching) return;
    // Both have been read again; without its figures (an error) the page shows the stored periods alone.
    if (periods.data === pending.stalePeriods || (timeline.data === pending.staleTimeline && !timeline.error)) return;
    pendingFocus.current = null;
    window.setTimeout(() => {
      // Reading the data again takes a moment. Someone who has moved on to another control meanwhile keeps their place:
      // the focus is only placed when it is nowhere (the row it was on is gone) or still where the dialog handed it back.
      const active = document.activeElement;
      const movedOn = active instanceof HTMLElement && active !== document.body && active.isConnected && active !== pending.opener && active.id !== 'main';
      if (movedOn) return;
      const target = focusTargetAfterChange<HTMLElement>(pending, {
        periodEditButton: (id) => document.querySelector<HTMLElement>(`[data-period-edit="${id}"]`),
        main: () => document.getElementById('main'),
      });
      target?.focus({ preventScroll: true });
    }, 0);
  }, [dialogOpen, periods.data, periods.isFetching, timeline.data, timeline.error, timeline.isFetching]);

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

  const failure = periods.error ?? coverage.error ?? timeline.error ?? beforeAfter.error ?? inConversations.error ?? value.error ?? spend.error ?? recorded.error;
  const ready = coverage.data !== undefined && periods.data !== undefined && timeline.data !== undefined;
  const hasUsage = coverage.data?.hasData ?? false;
  const periodCount = periods.data?.length ?? 0;
  const segments = timeline.data?.segments ?? [];
  const firstSegment = segments[0];
  const today = timeline.data ? dayInZone(timeline.data.now, settings.timezone) : null;
  // A period entered with dates in the future makes the band run past today.
  const lastDates = segments.length > 0 ? segmentDays(segments[segments.length - 1]) : null;
  const lastDay = lastDates ? (lastDates.lastDate ?? lastDates.startDate) : null;
  const timelineEnd = today && lastDay && lastDay > today ? formatDay(lastDay) : 'today';
  // "Pro, Jan 10 – Dec 10, 2025" or "Max 5x, since Dec 11, 2025", for sentences about one period.
  const describe = (period: SubscriptionPeriod) => {
    const dates = describeDates(period, today ?? todayInZone(settings.timezone));
    return `${planLabel(period.planKey, period.label)}, ${period.lastDate ? dates : dates.charAt(0).toLowerCase() + dates.slice(1)}`;
  };

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

      {/* Without its figures the page still lists what is stored, so that a period the
          figures cannot be worked out for can be corrected or removed here. */}
      {failure && !periods.error && periods.data && periods.data.length > 0 && (timeline.error || !ready) ? (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title="Your periods" description="The periods as you entered them. Correct or delete a period here; the figures are worked out again after each change." />
          <div className="mt-4">
            <StoredPeriodsTable periods={periods.data} today={todayInZone(settings.timezone)} onEdit={editPeriod} onDelete={askToDelete} />
          </div>
        </Card>
      ) : null}

      {!ready || timeline.error ? (
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
                The files you import do not say which plan you were on, and nothing is assumed, so this page starts empty. Enter when each plan started and ended to get:
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
                  description={`Scaled by time, from ${formatDay(firstSegment.startDate)} to ${timelineEnd}. Select a period to edit it${
                    segments.some((segment) => segment.kind === 'gap') ? ', or a stretch with no recorded plan to add one there' : ''
                  }.`}
                />
                <CardBody>
                  <Timeline
                    segments={segments}
                    now={timeline.data.now}
                    today={today ?? firstSegment.startDate}
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
                    today={today ?? firstSegment.startDate}
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
                    {segments.some((segment) => pricesEstimates(segment.value))
                      ? ` Usage estimated from conversation text is priced ${scenarioPhrase(settings.costScenario)}, as chosen in Settings.`
                      : ''}
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
              historyStart={periods.data?.[0]?.startDate ?? null}
              scenario={settings.costScenario}
              periodCount={periodCount}
              action={addButton}
            />
          ) : (
            <Skeleton className="h-72" />
          )}

          <MoneyCard
            spend={spend.data}
            value={value.data}
            scenario={settings.costScenario}
            hasUsage={hasUsage}
            periods={periods.data ?? []}
            today={today ?? todayInZone(settings.timezone)}
            recorded={recorded.data ?? null}
          />
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
            afterChange(period.id);
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
          // The row that held the focus is about to disappear; the page content takes it once the page is read again.
          opener.current = null;
          afterChange(null);
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
