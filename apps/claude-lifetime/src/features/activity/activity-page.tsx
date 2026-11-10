'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { TokenBasis } from '@/analytics/base';
import { getTimeSeries, type SeriesPoint } from '@/analytics/overview';
import { confidenceOf } from '@/components/data/confidence';
import { MetricCard } from '@/components/data/metric-card';
import { NoDataYet } from '@/components/data/no-data';
import { PageHeader } from '@/components/shell/page-header';
import { buttonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Segmented } from '@/components/ui/controls';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { ExactEstimated } from '@/features/usage/exact-estimated';
import { cn } from '@/lib/cn';
import { daysBetween, formatDay, formatDayRange, formatInt, formatTokens, plural, todayInZone } from '@/lib/format';
import { useApp, useData } from '@/state/app';
import { useCoverage } from '@/state/queries';
import {
  buildHistory,
  buildScale,
  METRIC_NOUN,
  METRIC_OPTIONS,
  monthRows,
  quantity,
  summariseYear,
  valueOf,
  weekdayAverages,
  type History,
  type Metric,
  type YearSummary,
} from './activity-model';
import { Heatmap } from './heatmap';
import { MonthlyTable } from './monthly-table';
import { WeekdayChart } from './weekday-chart';
import { YearNav } from './year-nav';

const COUNTED_HINT = 'Counted from the records you imported. Usage in a source you have not imported is not part of it.';

const HEATMAP_TEXT: Record<Metric, (basis: TokenBasis) => string> = {
  tokens: (basis) => `${basis === 'processed' ? 'Processed' : 'New'} tokens recorded on each day, exact and estimated together.`,
  messages: () => 'Messages recorded on each day, yours and Claude’s replies.',
  conversations: () => 'Conversations and sessions with recorded activity on each day.',
};

const ACTIVE_LABEL: Record<Metric, string> = {
  tokens: 'Active days',
  messages: 'Days with messages',
  conversations: 'Days with conversations',
};

function YearTiles({ summary, total, metric, year }: { summary: YearSummary; total: SeriesPoint | undefined; metric: Metric; year: number }) {
  const noun = METRIC_NOUN[metric];
  const label = METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? '';
  const value = valueOf(total, metric);
  const tokenLevel = total ? confidenceOf(total.exact, total.estimated) : 'unavailable';
  const { span, streak, busiest } = summary;
  const yearDays = daysBetween(`${year}-01-01`, `${year}-12-31`);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label={`${label} in ${year}`}
        value={metric === 'conversations' ? formatInt(value) : formatTokens(value)}
        title={`${formatInt(value)} ${noun.many}`}
        confidence={metric === 'tokens' ? tokenLevel : value > 0 ? 'exact' : 'unavailable'}
        confidenceHint={metric === 'tokens' ? undefined : COUNTED_HINT}
      >
        {value === 0 ? (
          <p>
            No {noun.many} are recorded in {year}.
          </p>
        ) : metric === 'tokens' && total ? (
          <ExactEstimated exact={total.exact} estimated={total.estimated} />
        ) : metric === 'conversations' ? (
          <p>Conversations and sessions with recorded activity in {year}, each counted once.</p>
        ) : (
          <p>Messages you sent and replies from Claude, where the source records them.</p>
        )}
      </MetricCard>

      <MetricCard
        label={ACTIVE_LABEL[metric]}
        value={formatInt(summary.activeDays)}
        confidence={span ? 'exact' : 'unavailable'}
        confidenceHint={COUNTED_HINT}
      >
        {span ? (
          <p>
            {span.days === yearDays
              ? `of ${formatInt(yearDays)} days in ${year} had recorded ${noun.many}.`
              : `of the ${plural(span.days, 'day')} of ${year} inside your recorded history, ${formatDayRange(span.from, span.to)}.`}
          </p>
        ) : null}
      </MetricCard>

      <MetricCard
        label="Longest streak"
        value={streak ? plural(streak.days, 'day') : null}
        confidence={streak ? 'exact' : 'unavailable'}
        confidenceHint={streak ? COUNTED_HINT : `No day of ${year} has recorded ${noun.many}, so there is no streak to measure.`}
      >
        {streak ? (
          <p>
            {streak.days === 1 ? formatDay(streak.from) : formatDayRange(streak.from, streak.to)}. Consecutive days with recorded {noun.many}, counted within{' '}
            {year}.
          </p>
        ) : (
          <p>
            No day of {year} has recorded {noun.many}.
          </p>
        )}
      </MetricCard>

      <MetricCard
        label="Busiest day"
        value={busiest ? <span className="text-[22px] tracking-[-0.01em]">{formatDay(busiest.bucket)}</span> : null}
        confidence={!busiest ? 'unavailable' : metric === 'tokens' ? confidenceOf(busiest.exact, busiest.estimated) : 'exact'}
        confidenceHint={!busiest ? `No day of ${year} has recorded ${noun.many}.` : metric === 'tokens' ? undefined : COUNTED_HINT}
      >
        {busiest ? (
          <p>
            <span className="tabular text-ink" title={`${formatInt(valueOf(busiest, metric))} ${noun.many}`}>
              {metric === 'conversations' ? formatInt(busiest.conversations) : formatTokens(valueOf(busiest, metric))}
            </span>{' '}
            {valueOf(busiest, metric) === 1 ? noun.one : noun.many} {metric === 'conversations' ? 'active that day' : 'that day'}.
          </p>
        ) : (
          <p>
            No day of {year} has recorded {noun.many}.
          </p>
        )}
      </MetricCard>
    </div>
  );
}

function ActivityBody({ history, months, years }: { history: History; months: SeriesPoint[]; years: SeriesPoint[] }) {
  const { settings } = useApp();
  const [metric, setMetric] = useState<Metric>('tokens');
  const [picked, setPicked] = useState<number | null>(null);
  // The latest year with records, until the reader picks another one.
  const year = picked !== null && history.years.includes(picked) ? picked : history.years[history.years.length - 1];

  const scale = useMemo(() => buildScale([...history.days.values()].map((p) => valueOf(p, metric))), [history, metric]);
  const summary = useMemo(() => summariseYear(history, year, metric), [history, year, metric]);
  const weekdays = useMemo(() => weekdayAverages(history, year, metric), [history, year, metric]);
  const monthly = useMemo(() => monthRows(history, months, year), [history, months, year]);
  const byYear = useMemo(() => new Map(years.map((p) => [Number(p.bucket.slice(0, 4)), p])), [years]);
  const total = byYear.get(year);
  const label = METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? '';

  const totalOf = (y: number) => {
    const value = valueOf(byYear.get(y), metric);
    if (value === 0) return 'none';
    return metric === 'conversations' ? formatInt(value) : formatTokens(value);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="What the squares count" value={metric} onChange={setMetric} options={METRIC_OPTIONS} />
        <YearNav years={history.years} year={year} onChange={setPicked} totalOf={totalOf} />
      </div>

      <Card>
        <CardHeader title={`${label} per day, ${year}`} description={`${HEATMAP_TEXT[metric](settings.basis)} Hover or tap a day, or move through the days with the arrow keys, to read its figures.`} />
        <CardBody>
          <Heatmap history={history} year={year} metric={metric} scale={scale} />
        </CardBody>
      </Card>

      <YearTiles summary={summary} total={total} metric={metric} year={year} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {summary.span ? <WeekdayChart rows={weekdays} metric={metric} year={year} span={summary.span} className="min-w-0 lg:col-span-2" /> : null}
        <MonthlyTable
          rows={monthly}
          year={year}
          history={history}
          conversations={total?.conversations ?? 0}
          className={cn('min-w-0', summary.span ? 'lg:col-span-3' : 'lg:col-span-5')}
        />
      </div>
    </div>
  );
}

export function ActivityPage() {
  const { settings } = useApp();
  const coverage = useCoverage();
  // One read of the whole history. The date range in the top bar is deliberately not part of the key:
  // a calendar of whole years has no use for it.
  const series = useData(['activity', 'history'], async (a) => {
    const days = await getTimeSeries(a.db, a.lifetime, 'day', 'none');
    // Conversations cannot be summed over days (one conversation can be active on several), so months and years are counted by the database.
    const months = await getTimeSeries(a.db, a.lifetime, 'month', 'none');
    const years = await getTimeSeries(a.db, a.lifetime, 'year', 'none');
    return { days, months, years };
  });
  const today = todayInZone(settings.timezone);
  const history = useMemo(() => (series.data ? buildHistory(series.data.days, today) : null), [series.data, today]);
  const failure = coverage.error ?? series.error;

  return (
    <div>
      <PageHeader
        title="Activity Heatmap"
        description="One square per day, brighter with more activity. This page always shows whole calendar years of your full history, so it does not follow the date range in the top bar."
      />

      {failure ? (
        <ErrorNote title="The activity figures could not be read from the local database">{failure.message}</ErrorNote>
      ) : !coverage.data || !series.data ? (
        <div aria-busy="true" className="space-y-4">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-64" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        </div>
      ) : !coverage.data.hasData ? (
        <NoDataYet what="Your calendar starts with an import" />
      ) : !history ? (
        <EmptyState
          title="Nothing to put on the calendar yet"
          action={
            <Link href="/import/" className={buttonClass('primary')}>
              Import usage
            </Link>
          }
        >
          The sources that count towards your totals hold no usage records. Import a claude.ai export, Claude Code logs or an API usage report to see
          your activity day by day.
        </EmptyState>
      ) : (
        <div className={cn('transition-opacity', series.isPlaceholderData && 'opacity-70')}>
          <ActivityBody history={history} months={series.data.months} years={series.data.years} />
        </div>
      )}
    </div>
  );
}
