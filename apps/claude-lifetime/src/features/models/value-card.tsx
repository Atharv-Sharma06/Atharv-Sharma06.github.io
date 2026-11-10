import Link from 'next/link';
import type { ApiValue } from '@/analytics/value';
import { ConfidenceBadge, type ConfidenceLevel } from '@/components/data/confidence';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { tierLabel, WEB_SEARCH_USD_PER_1000 } from '@/core/catalog';
import { formatDay, formatInt, formatShare, formatTokens, formatUsd } from '@/lib/format';
import type { CostScenario } from './families';

const SCENARIO: Record<CostScenario, { name: string; assumption: string }> = {
  standard: { name: 'No prompt caching', assumption: 'Estimated chat usage is priced as if nothing was cached: re-read context at the input price.' },
  cached: {
    name: '5-minute prompt cache',
    assumption: 'Estimated chat usage is priced as if a 5-minute prompt cache was used: re-read context a cache could have served at the cache-read price, the rest as cache writes.',
  },
};

const REASON_LABEL = { unknown_model: 'The source records no model', no_price: 'No published price on file' } as const;

/** The parts of a sum are shown to the cent, so the reader can add them up. */
const cents = (value: string) => formatUsd(value, { cents: true });

function isWebAddress(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Why nothing in the range has a price, from the reasons the valuation gives for the
 * usage it could not price. Said instead of listing parts that would all be zero.
 */
export function nothingPricedReason(value: Pick<ApiValue, 'unpriced' | 'assumedModel'>): string {
  return notPricedReason('Nothing in this range can be priced', value);
}

/**
 * The same for a range in which web searches have a price and no token usage has one:
 * the searches keep their line, and this stands where the token parts would be.
 */
export function tokensNotPricedReason(value: Pick<ApiValue, 'unpriced' | 'assumedModel'>): string {
  return notPricedReason('No token usage in this range can be priced', value);
}

function notPricedReason(lead: string, value: Pick<ApiValue, 'unpriced' | 'assumedModel'>): string {
  const noModel = value.unpriced.some((u) => u.reason === 'unknown_model');
  const noPrice = value.unpriced.some((u) => u.reason === 'no_price');
  const withoutModel = value.assumedModel
    ? `its source records no model, and ${value.assumedModel.displayName}, the model you chose to price it as, has no price on file for it`
    : 'its source records no model, and no model is guessed';
  if (noModel && noPrice) {
    return `${lead}. For part of the usage ${withoutModel}. The rest is on a model or price tier that has no published price on file.`;
  }
  if (noModel) return `${lead}: ${withoutModel}.`;
  if (noPrice) return `${lead}: its models or price tiers have no published price on file.`;
  return `${lead}: none of its usage has token counts.`;
}

function Part({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-ink-2">
        {label}
        {note ? <span className="block text-xs text-ink-3">{note}</span> : null}
      </dt>
      <dd className="tabular shrink-0 text-ink">{value}</dd>
    </div>
  );
}

/**
 * Explains the money figures on the page. Equivalent API value is a hypothetical: the
 * recorded usage multiplied by published list prices. It is never money that was paid,
 * and everything that could not be priced is listed instead of being guessed.
 */
export function ValueCard({ value, scenario, rangeLabel, scoped }: { value: ApiValue; scenario: CostScenario; rangeLabel: string; scoped: boolean }) {
  const other: CostScenario = scenario === 'cached' ? 'standard' : 'cached';
  const total = (s: CostScenario) => (s === 'cached' ? value.totalCachedUsd : value.totalStandardUsd);
  const estimated = (s: CostScenario) => (s === 'cached' ? value.estimatedCachedUsd : value.estimatedStandardUsd);
  // No token usage has a price. Web searches are billed per search and can still have one.
  const noTokensPriced = value.pricedTokens === 0;
  const nothingPriced = noTokensPriced && Number(value.webSearchUsd) === 0;
  const hasEstimate = Number(value.estimatedStandardUsd) > 0 || Number(value.estimatedCachedUsd) > 0 || value.assumedTokens > 0;
  const level: ConfidenceLevel = nothingPriced ? 'unavailable' : hasEstimate ? 'estimated' : 'exact';
  const scenariosDiffer = total(scenario) !== total(other);
  const allTokens = value.pricedTokens + value.unpricedTokens;
  const pricedShare = allTokens > 0 ? value.pricedTokens / allTokens : 0;

  return (
    <Card id="value" className="scroll-mt-20">
      <CardHeader
        title="Equivalent API value"
        description={`What the usage recorded ${scoped ? `for ${rangeLabel}` : 'in your imports'} would cost at Anthropic’s published API prices. It is a hypothetical list-price value, not money you paid.`}
        action={
          <Link href="/settings/" className="text-[13px] text-accent-soft underline-offset-4 hover:underline">
            Change pricing assumptions
          </Link>
        }
      />
      <CardBody className="space-y-7">
        <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-[13px] text-ink-2">{SCENARIO[scenario].name} (leading scenario)</h3>
              <ConfidenceBadge
                level={level}
                hint={
                  level === 'unavailable'
                    ? 'None of the usage in this range names a model with a published price, so nothing can be priced.'
                    : level === 'exact'
                      ? 'Metered token counts multiplied by Anthropic’s published API prices.'
                      : 'Includes estimated token counts or an assumed model.'
                }
              />
            </div>
            {nothingPriced ? (
              <p className="mt-2 text-[28px] font-medium leading-none text-ink-3">–</p>
            ) : (
              <p className="mt-2 text-[28px] font-medium leading-none tracking-[-0.02em] text-ink">{formatUsd(total(scenario))}</p>
            )}
            <p className="mt-2.5 text-[13px] text-ink-2">{nothingPriced ? 'Nothing in this range could be priced. The reasons are listed below.' : SCENARIO[scenario].assumption}</p>

            {nothingPriced ? null : (
              <div className="mt-4 border-t border-line pt-3 text-[13px] text-ink-2">
                <p>
                  {SCENARIO[other].name}: <span className="tabular text-ink">{formatUsd(total(other))}</span>
                </p>
                <p className="mt-1">
                  {scenariosDiffer
                    ? 'The two scenarios differ only in how estimated chat usage is priced. Exact usage costs the same in both, because its cache reads and writes are metered rather than assumed.'
                    : Number(estimated(scenario)) > 0
                      ? // Counts a file states have no re-read context, which is all the scenarios price differently.
                        'Both scenarios give the same total here: the estimated usage in this range is counts that a file or an entry states, with no re-read context to price one way or the other, and exact usage costs the same in both because its cache reads and writes are metered.'
                      : 'Both scenarios give the same total here: no estimated usage in this range is priced, and exact usage costs the same in both because its cache reads and writes are metered.'}
                </p>
              </div>
            )}
          </section>

          <section className="min-w-0">
            <h3 className="text-[13px] text-ink-2">What the total is made of</h3>
            {nothingPriced ? (
              // Each part would be a sum of nothing: a zero next to usage that has no price would read as a price of zero.
              <p className="mt-2 text-[13px] text-ink-2">{nothingPricedReason(value)}</p>
            ) : (
              <dl className="mt-1 divide-y divide-line text-[13px]">
                {noTokensPriced ? (
                  // Only the web searches have a price. A zero for the tokens would read as a price of zero, so the reason stands in its place.
                  <div className="py-2 text-ink-2">{tokensNotPricedReason(value)}</div>
                ) : (
                  <>
                    <Part label="Exact usage" note="Every token category at its own published price" value={cents(value.exactUsd)} />
                    <Part
                      label="Estimated usage"
                      note={
                        Number(estimated(scenario)) === 0 && Number(estimated(other)) === 0
                          ? 'None of it is priced in this range'
                          : `${cents(estimated(other))} under the other scenario`
                      }
                      value={cents(estimated(scenario))}
                    />
                  </>
                )}
                <Part label="Web search" note={`Billed per search: $${WEB_SEARCH_USD_PER_1000} per 1,000 searches`} value={cents(value.webSearchUsd)} />
                <div className="flex items-baseline justify-between gap-4 py-2 font-medium">
                  <dt className="text-ink">Total</dt>
                  <dd className="tabular text-ink">{cents(total(scenario))}</dd>
                </div>
              </dl>
            )}
          </section>
        </div>

        {value.assumedModel ? (
          <div className="rounded-[var(--radius-control)] border border-line-strong bg-raised px-3.5 py-3 text-[13px] text-ink-2">
            <p className="font-medium text-ink">Usage with no recorded model is priced as {value.assumedModel.displayName}</p>
            <p className="mt-1">
              You chose this in Settings. It is an assumption, not something a source recorded.{' '}
              {value.assumedTokens > 0 ? (
                <>
                  It decides the price of <span className="tabular text-ink">{formatTokens(value.assumedTokens)}</span> processed tokens in this range.
                </>
              ) : (
                'No usage in this range is affected by it.'
              )}
            </p>
          </div>
        ) : null}

        {allTokens > 0 ? (
          <section>
            <h3 className="text-[13px] text-ink-2">How much of the usage could be priced</h3>
            <div
              className="mt-2.5 flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
              role="img"
              aria-label={`${formatShare(pricedShare)} of processed tokens priced, ${formatShare(1 - pricedShare)} not priced`}
            >
              {value.pricedTokens > 0 ? <div className="h-full rounded-full bg-accent" style={{ flexGrow: value.pricedTokens, flexBasis: 0, minWidth: 6 }} /> : null}
              {value.unpricedTokens > 0 ? <div className="h-full rounded-full bg-series-none" style={{ flexGrow: value.unpricedTokens, flexBasis: 0, minWidth: 6 }} /> : null}
            </div>
            <dl className="mt-2.5 flex flex-wrap gap-x-8 gap-y-1 text-[13px]">
              <div className="flex items-baseline gap-2">
                <dt className="inline-flex items-center gap-1.5 text-ink-2">
                  <span className="size-2.5 rounded-[3px] bg-accent" aria-hidden="true" />
                  Priced
                </dt>
                <dd className="tabular text-ink" title={`${formatInt(value.pricedTokens)} processed tokens`}>
                  {formatTokens(value.pricedTokens)}
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="inline-flex items-center gap-1.5 text-ink-2">
                  <span className="size-2.5 rounded-[3px] bg-series-none" aria-hidden="true" />
                  Not priced
                </dt>
                <dd className="tabular text-ink" title={`${formatInt(value.unpricedTokens)} processed tokens`}>
                  {formatTokens(value.unpricedTokens)}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-ink-3">Counted in processed tokens, whichever token basis is selected: a price applies to every token the model read or wrote.</p>
          </section>
        ) : null}

        {value.unpriced.length > 0 ? (
          <section>
            <h3 className="text-[13px] text-ink-2">What is not priced, and why</h3>
            <TableFrame className="mt-2.5">
              <Table>
                <THead>
                  <tr>
                    <Th>Model and reason</Th>
                    <Th>Price tier</Th>
                    <Th align="right">Processed tokens</Th>
                  </tr>
                </THead>
                <tbody>
                  {value.unpriced.map((u) => (
                    <Tr key={`${u.reason}-${u.modelKey ?? ''}-${u.priceTier}`}>
                      <Td>
                        {u.displayName ?? u.modelKey ?? 'Unknown model'}
                        <span className="block text-xs text-ink-3">{REASON_LABEL[u.reason]}</span>
                      </Td>
                      <Td className="whitespace-nowrap align-top text-ink-2">{tierLabel(u.priceTier)}</Td>
                      <Td numeric className="align-top" title={`${formatInt(u.tokens)} processed tokens`}>
                        {formatTokens(u.tokens)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
            <p className="mt-2.5 max-w-[80ch] text-[13px] text-ink-2">
              Usage with no recorded model stays unpriced, because no model is guessed. You can choose a model to price it as, and add a price for a model that has none, in{' '}
              <Link href="/settings/" className="text-accent-soft underline-offset-4 hover:underline">
                Settings
              </Link>
              .
            </p>
          </section>
        ) : null}

        {value.sources.length > 0 ? (
          <section>
            <h3 className="text-[13px] text-ink-2">Where the prices come from</h3>
            <ul className="mt-1.5 divide-y divide-line text-[13px]">
              {value.sources.map((s) => (
                <li key={`${s.url}-${s.retrievedOn}`} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 py-2">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    {isWebAddress(s.url) ? (
                      <a href={s.url} target="_blank" rel="noreferrer" className="min-w-0 text-accent-soft underline-offset-4 [overflow-wrap:anywhere] hover:underline">
                        {s.url.replace(/^https?:\/\//i, '')}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <span className="text-ink [overflow-wrap:anywhere]">{s.url}</span>
                    )}
                    {s.userEntered ? <span className="rounded-[5px] border border-line bg-raised px-1.5 text-xs leading-5 text-ink-2">entered by you</span> : null}
                  </span>
                  <span className="text-ink-2">
                    Retrieved {formatDay(s.retrievedOn)}. Used to price <span className="tabular text-ink">{formatTokens(s.tokens)}</span> processed tokens.
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}
