'use client';

import Link from 'next/link';
import { useId, useMemo } from 'react';
import { getOverview, getTimeSeries, type Overview, type TokenTotals } from '@/analytics/overview';
import { getBeforeAfter, type BeforeAfter, type SideStats } from '@/analytics/subscriptions';
import { getApiValue, type ApiValue } from '@/analytics/value';
import { ChartCard } from '@/components/charts/chart-card';
import { ChartLegend, SeriesChart, SeriesTable, SERIES_COLORS, type ChartSeries } from '@/components/charts/series-chart';
import { ConfidenceBadge, confidenceOf } from '@/components/data/confidence';
import { MetricCard } from '@/components/data/metric-card';
import { NoDataYet } from '@/components/data/no-data';
import { buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { formatDay, formatDayRange, formatDecimal, formatInt, formatShare, formatSpan, formatTokens, formatUsd, plural } from '@/lib/format';
import { autoGranularity, pivot, spanOf } from '@/lib/series';
import { useCountUp } from '@/lib/use-count-up';
import { rangeKey, useApp, useData } from '@/state/app';
import { useCoverage } from '@/state/queries';
import { CoveragePanel } from './coverage-panel';

const BASIS_TEXT = {
  processed: 'Processed tokens: everything the model read and wrote, including context it re-read on every turn.',
  new: 'New tokens: each piece of content given to or produced by the model, counted once.',
} as const;

function SplitBar({ exact, estimated }: { exact: number; estimated: number }) {
  const total = exact + estimated;
  if (total <= 0) return null;
  const exactShare = exact / total;
  return (
    <div>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${formatShare(exactShare)} exact, ${formatShare(1 - exactShare)} estimated`}>
        {exact > 0 ? <div className="h-full rounded-full bg-accent" style={{ flexGrow: exact, flexBasis: 0, minWidth: 6 }} /> : null}
        {estimated > 0 ? <div className="hatch-estimated h-full rounded-full bg-accent/45" style={{ flexGrow: estimated, flexBasis: 0, minWidth: 6 }} /> : null}
      </div>
      <dl className="mt-2.5 flex flex-wrap gap-x-8 gap-y-1 text-[13px]">
        {exact > 0 ? (
          <div className="flex items-baseline gap-2">
            <dt className="inline-flex items-center gap-1.5 text-ink-2">
              <span className="size-2.5 rounded-[3px] bg-accent" aria-hidden="true" />
              Exact
            </dt>
            <dd className="tabular text-ink" title={`${formatInt(exact)} tokens`}>
              {formatTokens(exact)}
            </dd>
          </div>
        ) : null}
        {estimated > 0 ? (
          <div className="flex items-baseline gap-2">
            <dt className="inline-flex items-center gap-1.5 text-ink-2">
              <span className="hatch-estimated size-2.5 rounded-[3px] bg-accent/45" aria-hidden="true" />
              Estimated
            </dt>
            <dd className="tabular text-ink" title={`${formatInt(estimated)} tokens`}>
              {formatTokens(estimated)}
            </dd>
          </div>
        ) : null}
        {exact === 0 || estimated === 0 ? (
          <div className="text-ink-3">{exact === 0 ? 'No source in this range meters tokens.' : 'Nothing in this range is estimated.'}</div>
        ) : (
          // A share of what was imported, which is a known quantity. It says nothing about usage that was never imported.
          <div className="text-ink-3">{formatShare(exactShare)} of these tokens are exact.</div>
        )}
      </dl>
    </div>
  );
}

function Composition({ tokens, basis }: { tokens: TokenTotals; basis: 'processed' | 'new' }) {
  const rows = [
    { label: 'Input', value: tokens.input, hint: 'New content given to the model' },
    { label: 'Output', value: tokens.output, hint: 'What the model wrote' },
    { label: 'Cache writes', value: tokens.cacheWrite, hint: 'Input stored in the prompt cache' },
    ...(basis === 'processed'
      ? [
          { label: 'Cache reads', value: tokens.cacheRead, hint: 'Context re-read from the cache (exact sources)' },
          { label: 'Re-read context', value: tokens.replay, hint: 'Context re-sent on later turns (modelled for chat exports)' },
        ]
      : []),
  ];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      <h3 className="text-[13px] text-ink-2">What the total is made of</h3>
      <dl className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[7.5rem_minmax(0,1fr)_4rem] items-center gap-3 text-[13px]" title={r.hint}>
            <dt className="truncate text-ink-2">{r.label}</dt>
            <div className="h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
              <div className="h-full rounded-full bg-accent/80" style={{ width: `${r.value > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%` }} />
            </div>
            <dd className="tabular text-right text-ink">{formatTokens(r.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Hero({
  overview,
  basis,
  scoped,
  rangeLabel,
  className,
}: {
  overview: Overview;
  basis: 'processed' | 'new';
  scoped: boolean;
  rangeLabel: string;
  className?: string;
}) {
  const t = overview.tokens;
  const shown = useCountUp(t.total);
  const level = confidenceOf(t.exact, t.estimated);
  const headingId = useId();
  return (
    <Card role="group" aria-labelledby={headingId} className={cn('grid gap-x-8 gap-y-7 px-6 py-5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]', className)}>
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <h2 id={headingId} className="text-[13px] text-ink-2">
            {scoped ? `Tokens, ${rangeLabel}` : 'Lifetime tokens'}
          </h2>
          <ConfidenceBadge
            level={level}
            hint={
              level === 'estimated'
                ? 'This total includes tokens reconstructed from conversation text. The exact and estimated parts are shown separately below.'
                : undefined
            }
          />
        </div>
        {level === 'unavailable' ? (
          <p className="mt-3 text-[56px] font-medium leading-none text-ink-3">–</p>
        ) : (
          <p className="mt-3 text-[56px] font-medium leading-none tracking-[-0.03em] text-ink sm:text-[64px]" title={`${formatInt(t.total)} tokens`}>
            {formatTokens(Math.round(shown))}
          </p>
        )}
        <p className="mt-3 max-w-[52ch] text-[13px] text-ink-2">{BASIS_TEXT[basis]}</p>
        <div className="mt-5">
          <SplitBar exact={t.exact} estimated={t.estimated} />
        </div>
        {t.estimated > 0 && t.low !== t.high ? (
          <p className="mt-3 text-[13px] text-ink-2">
            Estimates carry a margin: the total is likely between <span className="tabular text-ink">{formatTokens(t.low)}</span> and{' '}
            <span className="tabular text-ink">{formatTokens(t.high)}</span>.
          </p>
        ) : null}
      </div>
      <div className="min-w-0 border-line md:border-l md:pl-8">
        <Composition tokens={t} basis={basis} />
        {overview.firstDay && overview.lastDay ? (
          <p className="mt-5 text-[13px] text-ink-2">
            Records from {formatDay(overview.firstDay)} to {formatDay(overview.lastDay)}:{' '}
            {plural(overview.activeDays, 'active day')}
            {overview.requests > 0 ? `, ${formatInt(overview.requests)} model requests` : ''}.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function SubscriptionSide({
  label,
  side,
  data,
  scoped,
}: {
  label: string;
  side: 'before' | 'after';
  data: BeforeAfter;
  scoped: boolean;
}) {
  if (!data.split) {
    return (
      <MetricCard
        label={label}
        value={null}
        confidence="unavailable"
        confidenceHint="This figure needs the date of your first paid plan, which only you know."
        action={
          <Link href="/subscriptions/" className={buttonClass('secondary', 'sm')}>
            Add subscription history
          </Link>
        }
      >
        <p>Enter when your plans started and ended to split your usage at your first paid subscription.</p>
      </MetricCard>
    );
  }
  const stats: SideStats | null = side === 'before' ? data.before : data.after;
  const splitDay = formatDay(data.split.date);
  if (!stats || stats.tokens === 0) {
    return (
      <MetricCard label={label} value={null} confidence="unavailable" confidenceHint="No imported record falls on this side of the date.">
        <p>
          No imported usage is dated {side === 'before' ? 'before' : 'on or after'} {splitDay}
          {scoped ? ' within the selected range' : ''}.
        </p>
      </MetricCard>
    );
  }
  const perDay = stats.spanDays > 0 ? stats.tokens / stats.spanDays : null;
  return (
    <MetricCard
      label={label}
      value={formatTokens(stats.tokens)}
      title={`${formatInt(stats.tokens)} tokens`}
      confidence={confidenceOf(stats.exact, stats.estimated)}
    >
      <p>
        {side === 'before' ? 'Before' : 'Since'} {data.split.label} started on {splitDay}.
      </p>
      <dl className="mt-3 space-y-1.5 border-t border-line pt-3">
        <div className="flex justify-between gap-3">
          <dt>Records</dt>
          <dd className="tabular text-right text-ink">
            {stats.firstDay && stats.lastDay ? `${formatDay(stats.firstDay)} – ${formatDay(stats.lastDay)}` : '–'}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Conversations</dt>
          <dd className="tabular text-ink">{formatInt(stats.conversations)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Messages</dt>
          <dd className="tabular text-ink">{formatInt(stats.messages)}</dd>
        </div>
        {perDay !== null ? (
          <div className="flex justify-between gap-3">
            <dt>Tokens per day</dt>
            <dd className="tabular text-ink" title={`Over ${formatSpan(stats.spanDays)}`}>
              {formatTokens(perDay)}
            </dd>
          </div>
        ) : null}
      </dl>
    </MetricCard>
  );
}

function ApiValueCard({ value, scenario }: { value: ApiValue; scenario: 'standard' | 'cached' }) {
  const total = scenario === 'cached' ? value.totalCachedUsd : value.totalStandardUsd;
  const hasEstimate = Number(value.estimatedStandardUsd) > 0 || value.assumedTokens > 0;
  const level = value.pricedTokens === 0 ? 'unavailable' : hasEstimate ? 'estimated' : 'exact';
  return (
    <MetricCard
      label="Equivalent API value"
      value={formatUsd(total)}
      confidence={level}
      confidenceHint={
        level === 'unavailable'
          ? 'None of the usage in this range names a model with a published price, so nothing can be priced.'
          : level === 'exact'
            ? 'Metered token counts multiplied by Anthropic’s published API prices.'
            : 'Includes estimated token counts or an assumed model. See Model Breakdown for the parts.'
      }
    >
      <p>What this usage would cost at API list prices. It is not money you paid.</p>
      {value.unpricedTokens > 0 ? (
        <p>
          {/* priced and unpriced amounts are always in processed tokens, whichever basis the page shows */}
          <span className="tabular text-ink">{formatTokens(value.unpricedTokens)}</span> processed tokens are not priced: their source does not
          name a model.{' '}
          <Link href="/models/" className="text-accent-soft underline-offset-4 hover:underline">
            Details
          </Link>
        </p>
      ) : null}
    </MetricCard>
  );
}

export function OverviewPage() {
  const app = useApp();
  const { settings, resolved } = app;
  const scoped = resolved.from !== null || resolved.to !== null;
  const rangeLabel = formatDayRange(resolved.from, resolved.to);
  const valueOptions = { assumedModelKey: settings.assumedModelKey };

  const coverage = useCoverage();
  const overview = useData(['overview', rangeKey(app)], (a) => getOverview(a.db, a.filter));
  const beforeAfter = useData(['before-after', rangeKey(app), settings.assumedModelKey], (a) => getBeforeAfter(a.db, a.filter, valueOptions));
  const value = useData(['api-value', rangeKey(app), settings.assumedModelKey], (a) => getApiValue(a.db, a.filter, valueOptions));

  const firstDay = resolved.from ?? overview.data?.firstDay ?? null;
  const lastDay = resolved.to ?? overview.data?.lastDay ?? null;
  const granularity = autoGranularity(spanOf(firstDay, lastDay));
  const series = useData(['series', 'confidence', granularity, rangeKey(app)], (a) => getTimeSeries(a.db, a.filter, granularity, 'confidence'));

  const chart = useMemo(() => {
    const pivoted = pivot(series.data ?? [], granularity, (p) => p.tokens, { from: resolved.from, to: resolved.to, groups: ['exact', 'estimated'] });
    const defs: ChartSeries[] = [
      { key: 'exact', label: 'Exact', color: SERIES_COLORS[0] },
      { key: 'estimated', label: 'Estimated', color: SERIES_COLORS[0], estimated: true },
    ];
    return { rows: pivoted.rows, series: defs.filter((s) => pivoted.totals[s.key] > 0) };
  }, [series.data, granularity, resolved.from, resolved.to]);

  const failure = overview.error ?? coverage.error ?? beforeAfter.error ?? value.error ?? series.error;

  return (
    <div>
      <header className="mb-7">
        <h1 className="text-[26px] font-semibold leading-none tracking-[0.08em] text-ink sm:text-[30px]">CLAUDE LIFETIME</h1>
        <p className="mt-2.5 text-[15px] text-ink-2">Your entire history with Claude, quantified.</p>
      </header>

      {failure ? (
        <ErrorNote title="The figures could not be read from the local database" className="mb-6">
          {failure.message}
        </ErrorNote>
      ) : null}

      {!coverage.data || !overview.data ? (
        <div aria-busy="true" className="grid gap-4 md:grid-cols-4">
          <Skeleton className="h-64 md:col-span-4" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : !coverage.data.hasData ? (
        <NoDataYet what="Your history starts with an import" />
      ) : (
        <div className={cn('space-y-4 transition-opacity', overview.isPlaceholderData && 'opacity-70')}>
          <div className="grid gap-4 lg:grid-cols-3">
            <Hero overview={overview.data} basis={settings.basis} scoped={scoped} rangeLabel={rangeLabel} className="lg:col-span-2" />
            <MetricCard
              label="Total conversations"
              value={formatInt(overview.data.conversations.total)}
              confidence={overview.data.conversations.total > 0 ? 'exact' : 'unavailable'}
              confidenceHint="Counted from the records you imported. Conversations deleted before an export are not part of it."
              action={
                <Link href="/conversations/" className="text-[13px] text-accent-soft underline-offset-4 hover:underline">
                  Explore conversations
                </Link>
              }
            >
              <p>
                {new Intl.ListFormat('en', { type: 'conjunction' }).format(
                  [
                    overview.data.conversations.chats > 0 ? plural(overview.data.conversations.chats, 'chat') : null,
                    overview.data.conversations.codeSessions > 0 ? plural(overview.data.conversations.codeSessions, 'Claude Code session') : null,
                  ].filter((v): v is string => v !== null),
                ) || 'No conversations in this range'}
                .
              </p>
              {overview.data.messages.total > 0 ? (
                <dl className="mt-3 space-y-1.5 border-t border-line pt-3">
                  <div className="flex justify-between gap-3">
                    <dt>Messages you sent</dt>
                    <dd className="tabular text-ink">{formatInt(overview.data.messages.user)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Replies from Claude</dt>
                    <dd className="tabular text-ink">{formatInt(overview.data.messages.assistant)}</dd>
                  </div>
                  {overview.data.averageConversationLength !== null ? (
                    <div className="flex justify-between gap-3">
                      <dt>Messages per conversation</dt>
                      <dd className="tabular text-ink">{formatDecimal(overview.data.averageConversationLength, 1)}</dd>
                    </div>
                  ) : null}
                  {overview.data.firstDay ? (
                    <div className="flex justify-between gap-3">
                      <dt>Earliest record</dt>
                      <dd className="tabular text-ink">{formatDay(overview.data.firstDay)}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </MetricCard>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {beforeAfter.data ? (
              <>
                <SubscriptionSide label="Before subscription" side="before" data={beforeAfter.data} scoped={scoped} />
                <SubscriptionSide label="After subscription" side="after" data={beforeAfter.data} scoped={scoped} />
              </>
            ) : (
              <>
                <Skeleton className="h-36" />
                <Skeleton className="h-36" />
              </>
            )}

            {value.data ? <ApiValueCard value={value.data} scenario={settings.costScenario} /> : <Skeleton className="h-36" />}

            {overview.data.mostActiveDay ? (
              <MetricCard
                label="Most active day"
                value={<span className="text-[22px] tracking-[-0.01em]">{formatDay(overview.data.mostActiveDay.day)}</span>}
                confidence={confidenceOf(overview.data.mostActiveDay.exact, overview.data.mostActiveDay.estimated)}
              >
                <p>
                  <span className="tabular text-ink" title={`${formatInt(overview.data.mostActiveDay.tokens)} tokens`}>
                    {formatTokens(overview.data.mostActiveDay.tokens)}
                  </span>{' '}
                  tokens that day.
                </p>
                <p>
                  {plural(overview.data.mostActiveDay.conversationsActive, 'conversation')} active ({formatInt(overview.data.mostActiveDay.conversationsCreated)}{' '}
                  started), {formatInt(overview.data.mostActiveDay.messages)} messages.
                </p>
              </MetricCard>
            ) : (
              <MetricCard label="Most active day" value={null} confidence="unavailable">
                <p>No usage is recorded in this range.</p>
              </MetricCard>
            )}
          </div>

          <ChartCard
            title="Usage over time"
            description={`Tokens per ${granularity}${scoped ? `, ${rangeLabel}` : ', all time'}. Solid bars are metered; hatched bars are reconstructed from text.`}
            legend={<ChartLegend series={chart.series} />}
            footer={
              <Link href="/usage/" className="text-accent-soft underline-offset-4 hover:underline">
                Open Lifetime Usage for cumulative totals, models and plans
              </Link>
            }
          >
            {(view) =>
              chart.rows.length === 0 ? (
                <EmptyState title="No usage in this range">Choose a wider date range, or import more of your history.</EmptyState>
              ) : view === 'chart' ? (
                <SeriesChart rows={chart.rows} series={chart.series} granularity={granularity} ariaLabel={`Tokens per ${granularity}, exact and estimated`} />
              ) : (
                <SeriesTable rows={chart.rows} series={chart.series} granularity={granularity} formatValue={formatInt} />
              )
            }
          </ChartCard>

          <CoveragePanel coverage={coverage.data} />
        </div>
      )}
    </div>
  );
}
