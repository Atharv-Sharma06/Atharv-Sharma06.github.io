'use client';

import Link from 'next/link';
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
        scoped ? (
          <EmptyState title="No usage in this range" action={<Button onClick={() => app.setRange({ preset: 'all', from: null, to: null })}>Show all time</Button>}>
            None of your imported usage is dated {rangeLabel}. Choose a wider date range in the top bar, or import more of your history.
          </EmptyState>
        ) : (
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
        )
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
