'use client';

import { ChevronDown, FlaskConical } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Popover, PopoverClose } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import { formatInstant, formatTokens, plural } from '@/lib/format';
import { useApp } from '@/state/app';
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

/** Always-visible summary of what the numbers on screen are based on. */
export function CoverageIndicator() {
  const { settings } = useApp();
  const { data } = useCoverage();
  if (!data) return <div className="h-9 w-40 animate-pulse rounded-[var(--radius-control)] bg-raised" aria-hidden="true" />;

  const counted = data.sources.filter((s) => s.includeInTotals);
  const span =
    data.earliestRecordAt && data.latestRecordAt
      ? `${formatInstant(data.earliestRecordAt, settings.timezone)} – ${formatInstant(data.latestRecordAt, settings.timezone)}`
      : null;
  const label = !data.hasData ? 'No data yet' : data.hasSyntheticData ? 'Demo data' : plural(counted.length, 'source');
  const estimatedShare = data.exactTokens + data.estimatedTokens > 0 ? data.estimatedTokens / (data.exactTokens + data.estimatedTokens) : 0;

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
        <div className="p-1">
          <p className="font-medium text-ink">{data.hasSyntheticData ? 'Synthetic demo data is loaded' : 'What these numbers are based on'}</p>
          {data.hasSyntheticData ? <p className="mt-1">These figures are invented so you can try the app. They are not your usage.</p> : null}
          {span ? <p className="mt-1">Records from {span}.</p> : null}
          <ul className="mt-3 space-y-2 border-t border-line pt-3">
            {data.sources.map((s) => (
              <li key={s.id} className="flex items-baseline justify-between gap-3">
                <span className={cn('min-w-0 truncate text-ink', !s.includeInTotals && 'text-ink-3 line-through')}>{s.label}</span>
                <span className="tabular shrink-0 text-xs">
                  {s.includeInTotals ? `${formatTokens(s.exactTokens + s.estimatedTokens)} tokens` : 'left out of totals'}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">
            {estimatedShare === 0
              ? 'All token counts come from sources that meter them.'
              : `${Math.round(estimatedShare * 100)}% of the tokens are estimates reconstructed from conversation text.`}{' '}
            {data.gaps.length > 0 ? `${plural(data.gaps.length, 'stretch', 'stretches')} of ${data.gapDays}+ days have no records.` : ''}
          </p>
        </div>
      )}
      <PopoverClose asChild>
        <Link href="/#coverage" className="mt-2 block rounded-md px-1 py-1.5 text-[13px] text-accent-soft hover:bg-hover">
          See what is known and what is missing
        </Link>
      </PopoverClose>
    </Popover>
  );
}
