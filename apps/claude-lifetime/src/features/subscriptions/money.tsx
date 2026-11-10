'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ActualSpend, ApiValue, UnpricedGroup } from '@/analytics/value';
import { ConfidenceBadge } from '@/components/data/confidence';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/feedback';
import { formatDay, formatMoney, formatTokens, formatUsd, plural } from '@/lib/format';
import { leadingUsd, otherUsd, valueLevel, type CostScenario } from './logic';
import { Unavailable } from './parts';

export interface MoneyCardProps {
  /** Undefined while it is being read. */
  spend: ActualSpend | undefined;
  value: ApiValue | undefined;
  scenario: CostScenario;
  /** False while nothing is imported: there is no usage to price yet. */
  hasUsage: boolean;
  periodCount: number;
}

const FIGURE = 'text-[22px] font-medium leading-tight tracking-[-0.01em] text-ink';
const LINK = 'text-accent-soft underline-offset-4 hover:underline';
/** How many groups of unpriced usage are listed before the rest is summed up. */
const UNPRICED_LISTED = 3;

function Kind({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-5 items-center rounded-full border border-line bg-raised px-2 text-xs font-normal text-ink-2">{children}</span>;
}

/** Why a group of tokens has no price, as the rest of a sentence, or as a sentence of its own when it stands alone. */
function unpricedReason(group: UnpricedGroup, alone: boolean): string {
  if (group.reason === 'unknown_model') return `${alone ? 'Their' : 'their'} source does not record which model answered, and none is assumed`;
  const model = group.displayName ?? group.modelKey ?? (alone ? 'Their model' : 'their model');
  return group.priceTier === 'standard' ? `${model} has no price on file` : `${model} has no price on file for the ${group.priceTier.replace(/_/g, ' ')} tier`;
}

/**
 * Money that was paid, and what the same usage would cost at API list prices. The two
 * are different kinds of figure and are kept in separate groups; they are never added,
 * subtracted or presented as a saving.
 */
export function MoneyCard({ spend, value, scenario, hasUsage, periodCount }: MoneyCardProps) {
  const level = value ? valueLevel(value) : 'unavailable';
  const scenariosDiffer = value ? leadingUsd(value, scenario) !== otherUsd(value, scenario) : false;

  return (
    <Card>
      <CardHeader
        title="What you paid and what it would have cost"
        description="Money you actually paid, and a list-price calculation for the same usage. They are shown side by side, not set off against each other."
      />
      <CardBody className="grid gap-x-10 gap-y-7 md:grid-cols-2">
        <section className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            Paid
            <Kind>Actual money</Kind>
          </h3>
          {spend ? (
            <dl className="mt-4 space-y-5">
              <div>
                <dt className="text-[13px] text-ink-2">Subscription payments</dt>
                {spend.subscriptions ? (
                  <dd className="mt-1">
                    <ul className="space-y-1">
                      {spend.subscriptions.map((s) => (
                        <li key={s.currency} className="flex flex-wrap items-baseline gap-x-3">
                          <span className={FIGURE}>{formatMoney(s.amount, s.currency)}</span>
                          <span className="text-[13px] text-ink-2">{plural(s.cycles, 'monthly payment')}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 max-w-[58ch] text-[13px] text-ink-2">
                      Worked out from the monthly prices and dates you entered: one payment for every monthly cycle that has started. It is not read from invoices, so taxes,
                      discounts and yearly billing are not reflected.
                    </p>
                  </dd>
                ) : (
                  <dd className="mt-1">
                    <Unavailable className={FIGURE} />
                    <p className="mt-2 max-w-[58ch] text-[13px] text-ink-2">
                      {periodCount === 0
                        ? 'Add your periods with the monthly price you paid, and the payments are added up here.'
                        : 'None of your periods has a monthly price. Edit a paid period and enter what you paid per month, and the payments are added up here.'}
                    </p>
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-[13px] text-ink-2">API usage billed</dt>
                {spend.reportedApiUsd !== null ? (
                  <dd className="mt-1">
                    <span className={FIGURE}>{formatUsd(spend.reportedApiUsd, { cents: true })}</span>
                    <p className="mt-2 max-w-[58ch] text-[13px] text-ink-2">
                      The sum of the cost reports you imported
                      {spend.reportedRange ? `, which cover ${formatDay(spend.reportedRange.first)} to ${formatDay(spend.reportedRange.last)}` : ''}.
                    </p>
                  </dd>
                ) : (
                  <dd className="mt-1">
                    <Unavailable className={FIGURE} />
                    <p className="mt-2 max-w-[58ch] text-[13px] text-ink-2">
                      No cost report is imported. If you use the API, export a cost report from the Anthropic Console and{' '}
                      <Link href="/import/" className={LINK}>
                        import it
                      </Link>{' '}
                      to see what you were billed.
                    </p>
                  </dd>
                )}
              </div>
            </dl>
          ) : (
            <Skeleton className="mt-4 h-40" />
          )}
        </section>

        <section className="min-w-0 border-t border-line pt-7 md:border-l md:border-t-0 md:pl-10 md:pt-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            Equivalent API value
            <Kind>Hypothetical</Kind>
          </h3>
          {!hasUsage ? (
            <p className="mt-4 max-w-[58ch] text-[13px] text-ink-2">
              There is no usage to price yet. After an import, this shows what your recorded usage would cost at Anthropic’s published API prices.
            </p>
          ) : value ? (
            <>
              <p className="mt-4 text-[13px] text-ink-2">Your whole recorded history at API list prices</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                {level === 'unavailable' ? <Unavailable className={FIGURE} /> : <span className={FIGURE}>{formatUsd(leadingUsd(value, scenario), { cents: true })}</span>}
                <ConfidenceBadge
                  level={level}
                  hint={
                    level === 'unavailable'
                      ? 'None of your usage names a model with a published price, so nothing can be priced.'
                      : level === 'exact'
                        ? 'Metered token counts multiplied by Anthropic’s published API prices.'
                        : 'Includes estimated token counts or an assumed model.'
                  }
                />
              </p>
              <p className="mt-2 max-w-[58ch] text-[13px] text-ink-2">
                {level === 'unavailable' ? (
                  <>
                    None of your recorded usage names a model with a published price, so there is nothing to calculate. You can choose a reference model for such usage in{' '}
                    <Link href="/settings/" className={LINK}>
                      Settings
                    </Link>
                    ; the result is then labelled as an assumption.
                  </>
                ) : (
                  <>
                    A calculation, not a bill: it is not money you paid, and the difference to what you paid is not a saving.
                    {spend?.reportedApiUsd != null ? ' It also covers the API usage that was billed to you.' : ''}
                  </>
                )}
              </p>

              <dl className="mt-4 space-y-2.5 border-t border-line pt-4 text-[13px]">
                {level !== 'unavailable' ? (
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-ink-2">
                      {scenario === 'standard' ? 'With a 5-minute prompt cache assumed for chat usage' : 'Without prompt caching for chat usage'}
                      {!scenariosDiffer ? <span className="block text-xs text-ink-3">The same figure: none of the estimated chat usage is priced.</span> : null}
                    </dt>
                    <dd className="tabular shrink-0 text-ink">{formatUsd(otherUsd(value, scenario), { cents: true })}</dd>
                  </div>
                ) : null}
                {value.assumedModel && value.assumedTokens > 0 ? (
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-ink-2">
                      Priced as {value.assumedModel.displayName}, your assumption for usage with no recorded model
                      <span className="block text-xs text-ink-3">Processed tokens. The model is assumed, not recorded.</span>
                    </dt>
                    <dd className="tabular shrink-0 text-ink">{formatTokens(value.assumedTokens)}</dd>
                  </div>
                ) : null}
                {value.unpricedTokens > 0 ? (
                  <div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-ink-2">Not priced, in processed tokens</dt>
                      <dd className="tabular shrink-0 text-ink">{formatTokens(value.unpricedTokens)}</dd>
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-3">
                      {value.unpriced.slice(0, UNPRICED_LISTED).map((group) => (
                        <li key={`${group.reason}:${group.modelKey ?? ''}:${group.priceTier}`}>
                          {value.unpriced.length > 1 ? `${formatTokens(group.tokens)}: ` : ''}
                          {unpricedReason(group, value.unpriced.length === 1)}.
                        </li>
                      ))}
                      {value.unpriced.length > UNPRICED_LISTED ? (
                        <li>
                          {formatTokens(value.unpriced.slice(UNPRICED_LISTED).reduce((sum, group) => sum + group.tokens, 0))} in{' '}
                          {plural(value.unpriced.length - UNPRICED_LISTED, 'more group')} with no price on file.
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ) : null}
              </dl>
              <p className="mt-4 text-[13px]">
                <Link href="/models/" className={LINK}>
                  See the value by model
                </Link>
              </p>
            </>
          ) : (
            <Skeleton className="mt-4 h-40" />
          )}
        </section>
      </CardBody>
    </Card>
  );
}
