'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Granularity, TokenBasis } from '@/analytics/base';
import { getOverview, getTimeSeries, type Overview, type SeriesPoint } from '@/analytics/overview';
import type { SubscriptionPeriod } from '@/analytics/subscriptions';
import { ChartCard } from '@/components/charts/chart-card';
import { ChartLegend, SeriesChart, SeriesTable } from '@/components/charts/series-chart';
import { confidenceOf } from '@/components/data/confidence';
import { MetricCard } from '@/components/data/metric-card';
import { NoDataYet } from '@/components/data/no-data';
import { PageHeader } from '@/components/shell/page-header';
import { Button, buttonClass } from '@/components/ui/button';
import { Segmented, Select } from '@/components/ui/controls';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { formatDay, formatDayRange, formatInt, formatTokens, plural } from '@/lib/format';
import { bucketLabel } from '@/lib/series';
import { rangeKey, useApp, useData } from '@/state/app';
import { useCoverage, usePeriods } from '@/state/queries';
import { BusiestPeriods } from './busiest-periods';
import { useMediaQuery, useSettled } from './hooks';
import {
  categoryChart,
  confidenceChart,
  cumulativeChart,
  describeChart,
  familyChart,
  GRANULARITY_OPTIONS,
  groupOf,
  modelChart,
  planChart,
  rankBuckets,
  rankModels,
  recordedHistory,
  recordedSpan,
  resolveGranularity,
  UNIT,
  VIEW_OPTIONS,
  zoomSlice,
  zoomWindow,
  type ChartFrame,
  type ChartModel,
  type DaySpan,
  type GranularityChoice,
  type ModelGrouping,
  type RecordedHistory,
  type UsageView,
  type ZoomWindow,
} from './usage-model';
import { ZoomNavigator } from './zoom-navigator';

const ALL_TIME = { preset: 'all', from: null, to: null } as const;

/** Below this many buckets the whole range is readable at once and zooming adds nothing. */
const ZOOM_FROM_BUCKETS = 12;

function Loading() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
      <Skeleton className="h-[36rem]" />
    </div>
  );
}

function ExactEstimated({ exact, estimated }: { exact: number; estimated: number }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1">
      <div className="flex items-baseline gap-1.5">
        <dt className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-accent" aria-hidden="true" />
          Exact
        </dt>
        <dd className="tabular text-ink" title={`${formatInt(exact)} tokens`}>
          {formatTokens(exact)}
        </dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="inline-flex items-center gap-1.5">
          <span className="hatch-estimated size-2.5 rounded-[3px] bg-accent/45" aria-hidden="true" />
          Estimated
        </dt>
        <dd className="tabular text-ink" title={`${formatInt(estimated)} tokens`}>
          {formatTokens(estimated)}
        </dd>
      </div>
    </dl>
  );
}

/** Everything the tiles and the table show, read for one range and one bucket size. */
interface Stats {
  overview: Overview;
  span: DaySpan;
  granularity: Granularity;
  scoped: boolean;
  /** The selected range reaches beyond the recorded history, so the span is shorter than the range. */
  clipped: boolean;
  /** Buckets with usage at this granularity, largest first, at most ten. */
  ranked: SeriesPoint[];
}

function StatTiles({ stats }: { stats: Stats }) {
  const { overview, span, granularity } = stats;
  const t = overview.tokens;
  const level = confidenceOf(t.exact, t.estimated);
  const busiest = stats.ranked[0] ?? null;
  const unit = UNIT[granularity].one;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label={stats.scoped ? 'Tokens in this range' : 'Lifetime tokens'}
        value={formatTokens(t.total)}
        title={`${formatInt(t.total)} tokens`}
        confidence={level}
        confidenceHint={
          level === 'estimated' ? 'This total includes tokens reconstructed from conversation text. The exact and estimated parts are listed below it.' : undefined
        }
      >
        <ExactEstimated exact={t.exact} estimated={t.estimated} />
      </MetricCard>

      <MetricCard
        label="Average per day"
        value={formatTokens(t.total / span.days)}
        title={`${formatInt(t.total / span.days)} tokens per calendar day`}
        confidence={level}
        confidenceHint={level === 'estimated' ? 'The average of a total that includes estimated tokens.' : undefined}
      >
        <p>
          Across {plural(span.days, 'calendar day')}, {formatDayRange(span.from, span.to)}.{stats.clipped ? ' Days outside your recorded history are left out.' : ''}
        </p>
        {overview.activeDays > 0 ? (
          <p>
            <span className="tabular text-ink" title={`${formatInt(t.total / overview.activeDays)} tokens per active day`}>
              {formatTokens(t.total / overview.activeDays)}
            </span>{' '}
            per active day.
          </p>
        ) : null}
      </MetricCard>

      {busiest ? (
        <MetricCard
          label={`Busiest ${unit}`}
          value={
            <span className="text-[22px] tracking-[-0.01em]">{granularity === 'day' ? formatDay(busiest.bucket) : bucketLabel(busiest.bucket, granularity)}</span>
          }
          confidence={confidenceOf(busiest.exact, busiest.estimated)}
        >
          <p>
            <span className="tabular text-ink" title={`${formatInt(busiest.tokens)} tokens`}>
              {formatTokens(busiest.tokens)}
            </span>{' '}
            tokens {granularity === 'day' ? 'that day' : `in that ${unit}`}.
          </p>
          {busiest.conversations > 0 || busiest.messages > 0 ? (
            <p>
              {plural(busiest.conversations, 'conversation')} active, {plural(busiest.messages, 'message')}.
            </p>
          ) : null}
        </MetricCard>
      ) : (
        <MetricCard label={`Busiest ${unit}`} value={null} confidence="unavailable">
          <p>No usage is recorded in this range.</p>
        </MetricCard>
      )}

      <MetricCard
        label="Active days"
        value={formatInt(overview.activeDays)}
        confidence={overview.activeDays > 0 ? 'exact' : 'unavailable'}
        confidenceHint="Days on which at least one imported record falls. Usage in a source you have not imported is not part of it."
      >
        <p>of {plural(span.days, 'calendar day')} had recorded usage.</p>
      </MetricCard>
    </div>
  );
}

function Controls({
  view,
  onView,
  choice,
  onChoice,
  grouping,
  onGrouping,
  scoped,
  onAllTime,
  note,
}: {
  view: UsageView;
  onView: (view: UsageView) => void;
  choice: GranularityChoice;
  onChoice: (choice: GranularityChoice) => void;
  grouping: ModelGrouping;
  onGrouping: (grouping: ModelGrouping) => void;
  scoped: boolean;
  onAllTime: () => void;
  note: string | null;
}) {
  // The five view names do not fit side by side on a phone, so both switches become menus there.
  const wide = useMediaQuery('(min-width: 640px)');
  return (
    <>
      {wide ? (
        <>
          <Segmented label="What the chart shows" value={view} onChange={onView} options={VIEW_OPTIONS} />
          <Segmented label="Bucket size" value={choice} onChange={onChoice} options={GRANULARITY_OPTIONS} />
        </>
      ) : (
        <div className="grid w-full grid-cols-2 gap-2">
          <Select label="What the chart shows" value={view} onChange={onView} options={VIEW_OPTIONS} />
          <Select label="Bucket size" value={choice} onChange={onChoice} options={GRANULARITY_OPTIONS} />
        </div>
      )}
      {view === 'models' ? (
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink-2">Group by</span>
          <Segmented
            label="Group models by"
            value={grouping}
            onChange={onGrouping}
            options={[
              { value: 'family', label: 'Family' },
              { value: 'model', label: 'Model' },
            ]}
          />
        </div>
      ) : null}
      {scoped ? (
        <Button size="sm" onClick={onAllTime} className="sm:ml-auto">
          Show all time
        </Button>
      ) : null}
      {note ? <p className="basis-full text-[13px] text-ink-2">{note}</p> : null}
    </>
  );
}

/** One view of the chart, complete: what is drawn and the words that describe it. */
interface Chart extends ChartModel {
  granularity: Granularity;
  span: DaySpan;
  title: string;
  description: string;
  ariaLabel: string;
  /** Models folded into "Other models" in this range. */
  folded: number;
  /** The plan view was asked for, and no subscription periods have been entered. */
  needsPeriods: boolean;
}

function buildChart(
  view: UsageView,
  grouping: ModelGrouping,
  basis: TokenBasis,
  frame: ChartFrame,
  points: SeriesPoint[],
  ranked: string[],
  periods: SubscriptionPeriod[],
): ChartModel & { folded: number } {
  switch (view) {
    case 'tokens':
      return { ...confidenceChart(points, frame), folded: 0 };
    case 'cumulative':
      return { ...cumulativeChart(points, frame), folded: 0 };
    case 'categories':
      return { ...categoryChart(points, frame, basis), folded: 0 };
    case 'models':
      return grouping === 'family' ? { ...familyChart(points, frame), folded: 0 } : modelChart(points, frame, ranked);
    case 'plans':
      return { ...planChart(points, frame, periods), folded: 0 };
  }
}

function NothingInRange({ scoped, onAllTime }: { scoped: boolean; onAllTime: () => void }) {
  return (
    <EmptyState
      title="No usage in this range"
      action={
        scoped ? (
          <Button variant="primary" onClick={onAllTime}>
            Show all time
          </Button>
        ) : undefined
      }
    >
      None of your imported records falls inside the selected dates. Choose a wider range in the top bar, or go back to your whole history.
    </EmptyState>
  );
}

function UsageContent({
  span,
  clipped,
  view,
  setView,
  choice,
  setChoice,
  grouping,
  setGrouping,
}: {
  span: DaySpan;
  clipped: boolean;
  view: UsageView;
  setView: (view: UsageView) => void;
  choice: GranularityChoice;
  setChoice: (choice: GranularityChoice) => void;
  grouping: ModelGrouping;
  setGrouping: (grouping: ModelGrouping) => void;
}) {
  const app = useApp();
  const { settings, resolved, setRange } = app;
  const scoped = resolved.from !== null || resolved.to !== null;
  const range = rangeKey(app);
  const tall = useMediaQuery('(min-width: 640px)');
  // A zoom belongs to the range it was made in; another range starts unzoomed.
  const [zoom, setZoom] = useState<{ range: string; window: ZoomWindow } | null>(null);

  const { granularity, tooFine } = useMemo(() => resolveGranularity(choice, span), [choice, span]);
  const group = groupOf(view, grouping);
  const needsRanking = view === 'models' && grouping === 'model';

  const overview = useData(['overview', range], (a) => getOverview(a.db, a.filter));
  const base = useData(['series', 'none', granularity, range], (a) => getTimeSeries(a.db, a.filter, granularity, 'none'));
  const grouped = useData(['series', group, granularity, range], (a) => getTimeSeries(a.db, a.filter, granularity, group));
  // A single model's colour follows its lifetime rank, so the ranking ignores the date range. It is only read while that view is open.
  const ranking = useData(['usage', 'model-ranking', needsRanking], (a) =>
    needsRanking ? getTimeSeries(a.db, a.lifetime, 'year', 'model') : Promise.resolve(null),
  );
  const periods = usePeriods();

  const stats = useSettled(
    useMemo<Stats | null>(() => {
      if (!overview.data || overview.isPlaceholderData || !base.data || base.isPlaceholderData) return null;
      return { overview: overview.data, span, granularity, scoped, clipped, ranked: rankBuckets(base.data, 10) };
    }, [overview.data, overview.isPlaceholderData, base.data, base.isPlaceholderData, span, granularity, scoped, clipped]),
  );

  const chart = useSettled(
    useMemo<Chart | null>(() => {
      if (!grouped.data || grouped.isPlaceholderData || !periods.data || periods.isPlaceholderData) return null;
      if (needsRanking && (!ranking.data || ranking.isPlaceholderData)) return null;
      const frame = { granularity, span };
      const ranked = needsRanking && ranking.data ? rankModels(ranking.data) : [];
      return {
        ...buildChart(view, grouping, settings.basis, frame, grouped.data, ranked, periods.data),
        ...describeChart(view, grouping, settings.basis, frame),
        granularity,
        span,
        needsPeriods: view === 'plans' && periods.data.length === 0,
      };
    }, [grouped.data, grouped.isPlaceholderData, periods.data, periods.isPlaceholderData, needsRanking, ranking.data, ranking.isPlaceholderData, view, grouping, granularity, span, settings.basis]),
  );

  const shown = chart.value;
  const zoomDays = zoom && zoom.range === range ? zoom.window : null;
  const [start, end] = useMemo(() => (shown ? zoomSlice(shown.rows, shown.granularity, zoomDays) : [0, 0]), [shown, zoomDays]);

  const failure = overview.error ?? base.error ?? grouped.error ?? ranking.error ?? periods.error;
  const showAllTime = () => setRange(ALL_TIME);

  if (failure) {
    return <ErrorNote title="The usage figures could not be read from the local database">{failure.message}</ErrorNote>;
  }
  if (!stats.value || !shown) return <Loading />;
  if (stats.value.ranked.length === 0 && !stats.stale) return <NothingInRange scoped={scoped} onAllTime={showAllTime} />;

  const zoomable = !shown.needsPeriods && shown.rows.length > ZOOM_FROM_BUCKETS;
  const zoomed = zoomable && (start > 0 || end < shown.rows.length);
  const visible = zoomed ? shown.rows.slice(start, end) : shown.rows;
  const tooFineNote = tooFine
    ? `${GRANULARITY_OPTIONS.find((o) => o.value === tooFine.chosen)?.label} buckets would draw ${formatInt(tooFine.buckets)} bars across this range, so the chart shows ${UNIT[granularity].many} instead. Choose a shorter range to see single ${UNIT[tooFine.chosen].many}.`
    : null;

  return (
    <div className="space-y-4">
      <div className={cn('transition-opacity', stats.stale && 'opacity-70')}>
        <StatTiles stats={stats.value} />
      </div>

      <ChartCard
        title={shown.title}
        description={shown.description}
        controls={
          <Controls
            view={view}
            onView={setView}
            choice={choice}
            onChoice={setChoice}
            grouping={grouping}
            onGrouping={setGrouping}
            scoped={scoped}
            onAllTime={showAllTime}
            note={tooFineNote}
          />
        }
        legend={shown.needsPeriods ? undefined : <ChartLegend series={shown.series} />}
        footer={
          shown.folded > 0
            ? `${plural(shown.folded, 'model')} with less lifetime usage ${shown.folded === 1 ? 'is' : 'are'} grouped as Other models. The seven largest keep their colour in every range.`
            : undefined
        }
      >
        {(mode) => (
          <div className={cn('transition-opacity', chart.stale && 'opacity-70')}>
            {shown.needsPeriods ? (
              <EmptyState
                title="No subscription periods entered yet"
                action={
                  <Link href="/subscriptions/" className={buttonClass('primary')}>
                    Add subscription history
                  </Link>
                }
              >
                Your plan history is not part of any export, so this view uses the dates you enter yourself. Add when each plan started and ended, and
                every bar is split by the plan that covered it.
              </EmptyState>
            ) : mode === 'chart' ? (
              <>
                <SeriesChart
                  rows={visible}
                  series={shown.series}
                  granularity={shown.granularity}
                  kind={shown.kind}
                  height={tall ? 380 : 300}
                  ariaLabel={zoomed ? `${shown.ariaLabel}, zoomed to ${formatInt(end - start)} of ${formatInt(shown.rows.length)} ${UNIT[shown.granularity].many}` : shown.ariaLabel}
                />
                {zoomable ? (
                  <ZoomNavigator
                    rows={shown.rows}
                    series={shown.series}
                    granularity={shown.granularity}
                    span={shown.span}
                    start={start}
                    end={end}
                    onChange={(a, b) => {
                      const next = zoomWindow(shown.rows, shown.granularity, a, b);
                      setZoom(next ? { range, window: next } : null);
                    }}
                  />
                ) : null}
              </>
            ) : (
              <SeriesTable rows={shown.rows} series={shown.series} granularity={shown.granularity} formatValue={formatInt} />
            )}
          </div>
        )}
      </ChartCard>

      <div className={cn('transition-opacity', stats.stale && 'opacity-70')}>
        <BusiestPeriods points={stats.value.ranked} granularity={stats.value.granularity} />
      </div>
    </div>
  );
}

function UsageBody({ history }: { history: RecordedHistory }) {
  const { resolved, setRange } = useApp();
  const { from, to } = resolved;
  const [view, setView] = useState<UsageView>('tokens');
  const [choice, setChoice] = useState<GranularityChoice>('auto');
  const [grouping, setGrouping] = useState<ModelGrouping>('family');
  const span = useMemo(() => recordedSpan({ from, to }, history), [from, to, history]);
  const scoped = from !== null || to !== null;

  if (!span) return <NothingInRange scoped={scoped} onAllTime={() => setRange(ALL_TIME)} />;
  const clipped = (from !== null && from < span.from) || (to !== null && to > span.to);
  return (
    <UsageContent
      span={span}
      clipped={clipped}
      view={view}
      setView={setView}
      choice={choice}
      setChoice={setChoice}
      grouping={grouping}
      setGrouping={setGrouping}
    />
  );
}

export function UsagePage() {
  const coverage = useCoverage();
  // The first and last recorded day of the whole history bound every range on this page.
  const days = useData(['usage', 'recorded-days'], (a) => getTimeSeries(a.db, a.lifetime, 'day', 'none'));
  const history = useMemo(() => (days.data ? recordedHistory(days.data) : null), [days.data]);
  const failure = coverage.error ?? days.error;

  return (
    <div>
      <PageHeader title="Lifetime Usage" description="Your token usage over time, from the earliest record to the latest, by day, week, month or year." />

      {failure ? (
        <ErrorNote title="The usage figures could not be read from the local database">{failure.message}</ErrorNote>
      ) : !coverage.data || !days.data ? (
        <Loading />
      ) : !coverage.data.hasData ? (
        <NoDataYet what="Your usage chart starts with an import" />
      ) : !history ? (
        <EmptyState
          title="Nothing to chart yet"
          action={
            <Link href="/import/" className={buttonClass('primary')}>
              Import usage
            </Link>
          }
        >
          The sources that count towards your totals hold no usage records. Import a claude.ai export, Claude Code logs or an API usage report to see
          usage over time.
        </EmptyState>
      ) : (
        <UsageBody history={history} />
      )}
    </div>
  );
}
