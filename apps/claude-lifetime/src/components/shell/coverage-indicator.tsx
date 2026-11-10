'use client';

import { ChevronDown, FlaskConical } from 'lucide-react';
import Link from 'next/link';
import type { Coverage, SourceCoverage } from '@/analytics/coverage';
import { Button } from '@/components/ui/button';
import { Popover, PopoverClose } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import { formatDay, formatShare, formatTokens, formatUsd, plural } from '@/lib/format';
import { useCoverage } from '@/state/queries';

export const SOURCE_KIND_LABEL: Record<string, string> = {
  claude_export: 'claude.ai export',
  claude_code: 'Claude Code',
  api_usage_report: 'API usage report',
  api_cost_report: 'API cost report',
  generic_json: 'JSON file',
  generic_csv: 'CSV file',
  manual: 'Manual entry',
};

/** The id of the coverage panel on the overview, which the indicator links to. */
export const COVERAGE_ID = 'coverage';

/**
 * Scrolls the coverage panel into view if it is on the page; returns whether it was. A
 * link to "/#coverage" alone does not do it: the panel appears only once the overview has
 * read its figures, after the browser has looked for the target, and following a link to
 * the address the page already has does not scroll at all.
 */
export function revealCoverage(): boolean {
  if (typeof document === 'undefined') return false;
  const panel = document.getElementById(COVERAGE_ID);
  if (!panel) return false;
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  panel.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  return true;
}

/** "processed tokens" or "new tokens": every token figure of the coverage summary is on the basis the page shows. */
export const basisTokens = (basis: Coverage['basis']) => (basis === 'new' ? 'new tokens' : 'processed tokens');

/** What one source contributes. A source without token usage, such as a cost report, holds money only. */
export function sourceFigure(source: SourceCoverage, basis: Coverage['basis']): string {
  if (!source.includeInTotals) return 'left out of totals';
  if (!source.hasUsage) return source.reportedCostUsd !== null ? `${formatUsd(source.reportedCostUsd)} billed` : 'no usage records';
  return `${formatTokens(source.exactTokens + source.estimatedTokens)} ${basisTokens(basis)}`;
}

/** The note under the list of sources: how much is estimated, of which kind, and how many stretches have no records. */
export function coverageNote(data: Coverage): string {
  const total = data.exactTokens + data.estimatedTokens;
  const tokens = basisTokens(data.basis);
  let estimates: string;
  if (total === 0) {
    // No tokens on this basis is not the same as no token counts: metered usage that is all cache reads has no new tokens.
    const usage = data.sources.some((s) => s.includeInTotals && s.hasUsage);
    estimates = !usage
      ? 'None of the imported files holds token counts.'
      : data.basis === 'new'
        ? 'The imported usage holds no new tokens. Processed shows what was read again.'
        : 'The imported usage records hold no token counts.';
  }
  else if (data.estimatedTokens === 0) estimates = 'All token counts come from sources that meter them.';
  else {
    const share = `${formatShare(data.estimatedTokens / total)} of the ${tokens} are estimates`;
    estimates =
      data.statedEstimatedTokens === 0
        ? `${share} reconstructed from conversation text.`
        : data.textEstimatedTokens === 0
          ? `${share}: counts that a file or an entry states without marking them exact.`
          : `${share}: some reconstructed from conversation text, some stated by a file or an entry without being marked exact.`;
  }
  const gaps =
    data.gapCount > 0
      ? ` ${plural(data.gapCount, 'stretch', 'stretches')} of ${data.gapDays}+ days ${data.gapCount === 1 ? 'has' : 'have'} no records.`
      : '';
  return estimates + gaps;
}

/** Always-visible summary of what the numbers on screen are based on. */
export function CoverageIndicator() {
  const { data } = useCoverage();
  if (!data) return <div className="h-9 w-40 animate-pulse rounded-[var(--radius-control)] bg-raised" aria-hidden="true" />;

  const counted = data.sources.filter((s) => s.includeInTotals);
  const label = !data.hasData ? 'No data yet' : data.hasSyntheticData ? 'Demo data' : plural(counted.length, 'source');

  return (
    <Popover
      align="end"
      trigger={
        <Button variant="secondary" aria-label={`Data coverage: ${label}`}>
          {data.hasSyntheticData ? (
            <FlaskConical className="size-4 text-warning" aria-hidden="true" />
          ) : (
            <span className={cn('size-2 rounded-full', data.hasData ? 'bg-good' : 'bg-ink-3')} aria-hidden="true" />
          )}
          <span className="hidden sm:inline">{label}</span>
          <ChevronDown className="size-4 text-ink-3" aria-hidden="true" />
        </Button>
      }
    >
      {!data.hasData ? (
        <div className="p-1">
          <p className="font-medium text-ink">Nothing has been imported</p>
          <p className="mt-1">Every figure in this app comes from files you import. Until then there is nothing to count.</p>
        </div>
      ) : (
        <CoverageSummary data={data} />
      )}
      <PopoverClose asChild>
        <Link
          href={`/#${COVERAGE_ID}`}
          // Scrolled by hand once the popover has closed (closing hands focus back to the trigger). When the panel is not
          // on the page yet, the panel scrolls itself into view as it appears with #coverage in the address.
          onClick={() => window.requestAnimationFrame(() => revealCoverage())}
          className="mt-2 block rounded-md px-1 py-1.5 text-[13px] text-accent-soft hover:bg-hover"
        >
          See what is known and what is missing
        </Link>
      </PopoverClose>
    </Popover>
  );
}

/** The body of the popover once something has been imported. */
export function CoverageSummary({ data }: { data: Coverage }) {
  const span = data.earliestDay && data.latestDay ? `${formatDay(data.earliestDay)} – ${formatDay(data.latestDay)}` : null;
  return (
    <div className="p-1">
      <p className="font-medium text-ink">{data.hasSyntheticData ? 'Synthetic demo data is loaded' : 'What these numbers are based on'}</p>
      {data.hasSyntheticData ? <p className="mt-1">These figures are invented so you can try the app. They are not your usage.</p> : null}
      {span ? <p className="mt-1">Records from {span}.</p> : null}
      <ul className="mt-3 space-y-2 border-t border-line pt-3">
        {data.sources.map((s) => (
          <li key={s.id} className="flex items-baseline justify-between gap-3">
            <span className={cn('min-w-0 truncate text-ink', !s.includeInTotals && 'text-ink-3 line-through')}>{s.label}</span>
            <span className="tabular shrink-0 text-xs">{sourceFigure(s, data.basis)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">{coverageNote(data)}</p>
    </div>
  );
}
