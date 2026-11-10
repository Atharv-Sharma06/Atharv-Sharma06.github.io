'use client';

import { CircleCheck, CircleDashed, CircleSlash } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Coverage } from '@/analytics/coverage';
import { SOURCE_KIND_LABEL } from '@/components/shell/coverage-indicator';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { LIMITATION_TEXT } from '@/core/limitations';
import { cn } from '@/lib/cn';
import { formatDay, formatInstant, formatInt, formatShare, formatTokens, formatUsd, plural } from '@/lib/format';
import { useApp } from '@/state/app';

function Group({ icon, tone, title, children }: { icon: typeof CircleCheck; tone: string; title: string; children: ReactNode }) {
  const Icon = icon;
  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
        <Icon className={cn('size-4', tone)} strokeWidth={2.25} aria-hidden="true" />
        {title}
      </h3>
      <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">{children}</ul>
    </section>
  );
}

/**
 * "What We Know About Your Claude History": where each number comes from and what no
 * source can tell. Coverage is described by what was imported — sources, dates and
 * gaps. A percentage of "all-time history covered" is deliberately absent: the true
 * total is not known to any source, so there is no honest denominator for it.
 */
export function CoveragePanel({ coverage }: { coverage: Coverage }) {
  const { settings } = useApp();
  const tz = settings.timezone;
  const counted = coverage.sources.filter((s) => s.includeInTotals);
  const kinds = new Set(counted.map((s) => s.kind));
  const hasExact = coverage.exactTokens > 0;
  const hasEstimated = coverage.estimatedTokens > 0;
  const conversations = counted.reduce((sum, s) => sum + s.conversations, 0);
  const total = coverage.exactTokens + coverage.estimatedTokens;
  const topLimits = coverage.limitations.filter((l) => l.name !== 'MODEL_UNKNOWN').slice(0, 4);
  const meteredBy = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    [
      kinds.has('claude_code') && 'Claude Code',
      (kinds.has('api_usage_report') || kinds.has('generic_csv') || kinds.has('generic_json')) && 'usage reports',
      kinds.has('manual') && 'entries you typed in',
    ].filter((v): v is string => typeof v === 'string'),
  );

  return (
    <Card id="coverage" className="scroll-mt-20">
      <CardHeader
        title="What We Know About Your Claude History"
        description="Every figure in this app is computed from the files you imported. This is what those files establish, what is reconstructed from them, and what none of them can tell."
      />
      <CardBody>
        <dl className="mb-6 grid gap-x-8 gap-y-4 rounded-[var(--radius-control)] border border-line px-4 py-3.5 text-[13px] sm:grid-cols-2 lg:grid-cols-5">
          <Summary label="Earliest record" value={coverage.earliestRecordAt ? formatInstant(coverage.earliestRecordAt, tz) : '–'} />
          <Summary label="Latest record" value={coverage.latestRecordAt ? formatInstant(coverage.latestRecordAt, tz) : '–'} />
          <Summary label="Sources counted" value={`${counted.length} of ${coverage.sources.length}`} detail={plural(coverage.importCount, 'import')} />
          <Summary
            label="Exact usage"
            value={hasExact ? 'Present' : 'None'}
            detail={total > 0 ? `${formatShare(coverage.exactTokens / total)} of imported tokens` : undefined}
          />
          <Summary
            label="Model recorded"
            value={coverage.tokensWithModel > 0 ? (coverage.tokensWithoutModel > 0 ? 'In part' : 'Yes') : 'No'}
            detail={total > 0 ? `for ${formatShare(coverage.tokensWithModel / total)} of imported tokens` : undefined}
          />
        </dl>
        <div className="grid gap-x-10 gap-y-7 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="scrollbar-thin overflow-x-auto rounded-[var(--radius-control)] border border-line">
            <table className="w-full min-w-[34rem] border-collapse text-[13px]">
              <thead className="bg-raised text-left text-xs text-ink-2">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Source
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Records from
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Exact tokens
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Estimated tokens
                  </th>
                </tr>
              </thead>
              <tbody>
                {coverage.sources.map((s) => (
                  <tr key={s.id} className="border-t border-line align-top">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <span className={cn('text-ink', !s.includeInTotals && 'text-ink-3')}>{s.label}</span>
                      <span className="block text-xs text-ink-3">
                        {SOURCE_KIND_LABEL[s.kind] ?? s.kind}, {plural(s.imports, 'import')}
                        {s.isSynthetic ? ', synthetic' : ''}
                        {!s.includeInTotals ? ', left out of totals' : ''}
                      </span>
                      {s.reportedCostUsd !== null ? <span className="block text-xs text-ink-3">{formatUsd(s.reportedCostUsd)} of billed cost reported</span> : null}
                    </th>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-2">
                      {s.firstRecordAt ? `${formatInstant(s.firstRecordAt, tz)} – ${formatInstant(s.lastRecordAt, tz)}` : 'No dated records'}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink">{s.exactTokens > 0 ? formatTokens(s.exactTokens) : '–'}</td>
                    <td className="tabular px-3 py-2 text-right text-ink">{s.estimatedTokens > 0 ? formatTokens(s.estimatedTokens) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 text-[13px] text-ink-2">
            {coverage.gaps.length === 0 ? (
              <p>
                No stretch of {coverage.gapDays} days or more is without records between your first and last imported day.
              </p>
            ) : (
              <>
                <p className="text-ink">
                  {plural(coverage.gaps.length, 'stretch', 'stretches')} of {coverage.gapDays} days or more with no records
                </p>
                <ul className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {coverage.gaps.slice(0, 6).map((g) => (
                    <li key={g.from} className="flex justify-between gap-3">
                      <span>
                        {formatDay(g.from)} – {formatDay(g.to)}
                      </span>
                      <span className="tabular text-ink-3">{formatInt(g.days)} days</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-ink-3">
                  A gap can mean you did not use Claude, or that the usage is in a source you have not imported. The files cannot tell which.
                </p>
              </>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <Group icon={CircleCheck} tone="text-good" title="Known exactly">
            {hasExact ? (
              <li>
                {formatTokens(coverage.exactTokens)} tokens metered by {meteredBy || 'your sources'}, with their date and, where the source names it, their
                model.
              </li>
            ) : (
              <li>No imported source meters tokens yet. Claude Code logs and API usage reports do.</li>
            )}
            {conversations > 0 ? <li>{formatInt(conversations)} conversations and sessions, with the dates they happened.</li> : null}
          </Group>

          <Group icon={CircleDashed} tone="text-warning" title="Estimated">
            {hasEstimated ? (
              <>
                <li>
                  {formatTokens(coverage.estimatedTokens)} tokens across {formatInt(coverage.estimatedMessages)} chat messages, reconstructed from their
                  text because a claude.ai export contains no token counts.
                </li>
                {topLimits.map((l) => (
                  <li key={l.name}>
                    {LIMITATION_TEXT[l.name].short}: {formatInt(l.messages)} messages.
                  </li>
                ))}
              </>
            ) : (
              <li>Nothing is estimated: none of your sources needed reconstruction.</li>
            )}
          </Group>

          <Group icon={CircleSlash} tone="text-ink-3" title="Not available">
            {coverage.tokensWithoutModel > 0 ? (
              <li>
                The model behind {formatTokens(coverage.tokensWithoutModel)} tokens. A claude.ai export does not record which model answered, and none
                is guessed.
              </li>
            ) : null}
            <li>Conversations deleted before an export, and anything in a source you have not imported.</li>
            <li>System prompts, tool definitions, images and files: they cost tokens but are not part of an export.</li>
            <li>The share of your all-time usage these files represent. No source knows the true total, so no percentage is shown.</li>
          </Group>

          <p className="text-[13px]">
            <Link href="/methodology/" className="text-accent-soft underline-offset-4 hover:underline">
              How the numbers are made
            </Link>
          </p>
        </div>
        </div>
      </CardBody>
    </Card>
  );
}

function Summary({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-2">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
      {detail ? <dd className="text-xs text-ink-3">{detail}</dd> : null}
    </div>
  );
}
