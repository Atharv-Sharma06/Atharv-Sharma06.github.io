'use client';

import Link from 'next/link';
import type { Coverage } from '@/analytics/coverage';
import { getModelBreakdown } from '@/analytics/models';
import { getApiValue } from '@/analytics/value';
import { NoDataYet } from '@/components/data/no-data';
import { PageHeader } from '@/components/shell/page-header';
import { Button, buttonClass } from '@/components/ui/button';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { formatDayRange } from '@/lib/format';
import { rangeKey, useApp, useData } from '@/state/app';
import { useCoverage } from '@/state/queries';
import { FamilyDonutCard } from './family-donut';
import { ModelTableCard } from './model-table';
import { ValueCard } from './value-card';

/**
 * Why the breakdown has no rows although something was imported. Sources left out of
 * totals come first: their usage is stored, only not counted, so neither "nothing in this
 * range" nor "no token usage" would be true, and the way back is in Settings, not on the
 * Import page.
 */
export function NoModelRows({
  coverage,
  scoped,
  rangeLabel,
  onShowAll,
}: {
  coverage: Coverage;
  scoped: boolean;
  rangeLabel: string;
  onShowAll: () => void;
}) {
  const counted = coverage.sources.some((s) => s.includeInTotals && s.hasUsage);
  const leftOut = coverage.sources.some((s) => !s.includeInTotals && s.hasUsage);
  if (!counted && leftOut) {
    const every = coverage.sources.every((s) => !s.includeInTotals);
    return (
      <EmptyState
        title={every ? 'Every source is left out of totals' : 'Every source with token usage is left out of totals'}
        action={
          <Link href="/settings/#sources" className={buttonClass('secondary')}>
            Go to data sources
          </Link>
        }
      >
        {every
          ? 'Your imports hold token usage, but every source is left out of totals, so none of it is counted here.'
          : 'Your imports hold token usage, but each source that holds it is left out of totals, so none of it is counted here.'}{' '}
        Count a source again under Data sources in Settings to see its models.
      </EmptyState>
    );
  }
  if (scoped) {
    return (
      <EmptyState title="No usage in this range" action={<Button onClick={onShowAll}>Show all time</Button>}>
        None of your imported usage is dated {rangeLabel}. Choose a wider date range in the top bar, or import more of your history.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      title="Your imports contain no token usage"
      action={
        <Link href="/import/" className={buttonClass('secondary')}>
          Import usage
        </Link>
      }
    >
      A cost report lists amounts billed, not tokens. Import a claude.ai data export, Claude Code session logs or an API usage report to see models here.
    </EmptyState>
  );
}

export function ModelsPage() {
  const app = useApp();
  const { settings, resolved } = app;
  const scoped = resolved.from !== null || resolved.to !== null;
  const rangeLabel = formatDayRange(resolved.from, resolved.to);
  const valueOptions = { assumedModelKey: settings.assumedModelKey };

  const coverage = useCoverage();
  const models = useData(['models', rangeKey(app), settings.assumedModelKey], (a) => getModelBreakdown(a.db, a.filter, valueOptions));
  const value = useData(['api-value', rangeKey(app), settings.assumedModelKey], (a) => getApiValue(a.db, a.filter, valueOptions));

  const failure = coverage.error ?? models.error ?? value.error;

  return (
    <div>
      <PageHeader
        title="Model Breakdown"
        description="Which Claude models your recorded usage ran on, and what that usage would cost at API list prices. Usage whose source names no model keeps its own row: a model is never guessed."
      />

      {failure ? (
        <ErrorNote title="The model figures could not be read from the local database" className="mb-6">
          {failure.message}
        </ErrorNote>
      ) : null}

      {!coverage.data || !models.data ? (
        failure ? null : (
          <div aria-busy="true" className="space-y-4">
            <Skeleton className="h-72" />
            <Skeleton className="h-96" />
            <Skeleton className="h-64" />
          </div>
        )
      ) : !coverage.data.hasData ? (
        <NoDataYet what="No models to compare yet" />
      ) : models.data.length === 0 ? (
        <NoModelRows
          coverage={coverage.data}
          scoped={scoped}
          rangeLabel={rangeLabel}
          onShowAll={() => app.setRange({ preset: 'all', from: null, to: null })}
        />
      ) : (
        <div className={cn('space-y-4 transition-opacity', models.isPlaceholderData && 'opacity-70')}>
          <FamilyDonutCard rows={models.data} basis={settings.basis} rangeLabel={rangeLabel} scoped={scoped} />
          <ModelTableCard rows={models.data} basis={settings.basis} scenario={settings.costScenario} assumedModelName={value.data?.assumedModel?.displayName ?? null} />
          {value.data ? <ValueCard value={value.data} scenario={settings.costScenario} rangeLabel={rangeLabel} scoped={scoped} /> : <Skeleton className="h-64" />}
        </div>
      )}
    </div>
  );
}
