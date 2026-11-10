'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { TokenBasis } from '@/analytics/base';
import type { ModelUsage } from '@/analytics/models';
import { Swatch } from '@/components/charts/series-chart';
import { confidenceOf, type ConfidenceLevel } from '@/components/data/confidence';
import { Card, CardHeader } from '@/components/ui/card';
import { InfoTip } from '@/components/ui/overlay';
import { Table, TableFrame, Td, Th, THead, Tr, type SortDirection } from '@/components/ui/table';
import { cn } from '@/lib/cn';
import { formatInt, formatShare, formatTokens, formatUsd } from '@/lib/format';
import { familyColor, familyLabel } from '@/lib/palette';
import { ConfidenceMark } from '../conversations/confidence-mark';
import { familyOf, modelTotals, rowValue, sortModels, type CostScenario, type ModelSortKey } from './families';

/** Twelve columns have to fit a laptop screen: cells are a little tighter than the table default. */
const CELL = 'px-2';
const HEAD = cn(CELL, 'align-bottom');
/** The first and last columns line up with the card's own padding. */
const FIRST = 'pl-5';
const LAST = 'pr-5';
const NOT_RECORDED = 'text-ink-3';

/** A heading on two lines, so a long name does not widen a column of short figures. */
function TwoLines({ first, second }: { first: string; second: string }) {
  return (
    <span className="text-right leading-tight">
      {first}
      <br />
      {second}
    </span>
  );
}

/** A token figure with its full value on hover. */
function Tokens({ value, title, children }: { value: number; title?: string; children?: ReactNode }) {
  return (
    <Td numeric className={cn(CELL, 'whitespace-nowrap')} title={title ?? `${formatInt(value)} tokens`}>
      {formatTokens(value)}
      {children}
    </Td>
  );
}

/**
 * A figure none of the row's records has a count for. A dash, not a zero: a chat export
 * says nothing about the prompt cache, a table may have no cache columns, and usage a
 * source states has no modelled re-reading. Whether a category is recorded comes from the
 * records themselves (ModelUsage.recorded), never from whether the row is exact, so a
 * count that is part of the row's total is always shown.
 */
function NotRecorded({ why, className }: { why: string; className?: string }) {
  return (
    <Td numeric className={cn(CELL, NOT_RECORDED, className)} title={why}>
      –
    </Td>
  );
}

function ShareBar({ share }: { share: number }) {
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <span className="block h-full rounded-full bg-ink-3" style={{ width: `${share > 0 ? Math.max(4, share * 100) : 0}%` }} />
      </span>
      <span className="tabular w-9 text-right">{formatShare(share)}</span>
    </span>
  );
}

function confidenceTitle(level: ConfidenceLevel, exact: number, estimated: number): string {
  if (level === 'unavailable') return 'No tokens are recorded, only requests';
  if (level === 'exact') return 'Exact: metered by the source';
  // Estimates are of two kinds (counted from conversation text, or stated by a file without being marked exact); a row can hold either.
  return exact > 0
    ? `Estimated: ${formatTokens(exact)} metered, ${formatTokens(estimated)} estimated`
    : 'Estimated: counted from conversation text, or stated without being marked exact';
}

function ValueCell({ row, scenario, assumedModelName }: { row: ModelUsage; scenario: CostScenario; assumedModelName: string | null }) {
  const value = rowValue(row, scenario);
  if (value === null) {
    return (
      <NotRecorded
        className={LAST}
        why={row.modelKey === null ? 'Not priced: the source does not name the model, and no model is guessed.' : 'Not priced: no published price is on file for this model.'}
      />
    );
  }
  return (
    <Td numeric className={cn(CELL, LAST)}>
      {formatUsd(value)}
      {row.value.assumedTokens > 0 && assumedModelName !== null ? (
        <span
          className="block whitespace-nowrap text-xs font-normal text-ink-3"
          title={`Priced as ${assumedModelName}, the model you chose in Settings for usage with no recorded model. That is an assumption.`}
        >
          assumed model
        </span>
      ) : null}
      {row.value.unpricedTokens > 0 ? (
        <span className="block whitespace-nowrap text-xs font-normal text-ink-3" title="Processed tokens on a price tier that has no price on file">
          {formatTokens(row.value.unpricedTokens)} not priced
        </span>
      ) : null}
    </Td>
  );
}

/** One row per model, every figure sortable. The row for usage with no recorded model explains itself. */
export function ModelTableCard({
  rows,
  basis,
  scenario,
  assumedModelName,
}: {
  rows: ModelUsage[];
  basis: TokenBasis;
  scenario: CostScenario;
  assumedModelName: string | null;
}) {
  const processed = basis === 'processed';
  const [sort, setSort] = useState<{ key: ModelSortKey; direction: SortDirection }>({ key: 'total', direction: 'desc' });
  // Cache reads and re-read context are not columns under the New basis; a sort on one of them falls back to the total.
  const hidden = !processed && (sort.key === 'cacheRead' || sort.key === 'replay');
  const key = hidden ? 'total' : sort.key;
  const direction = hidden ? 'desc' : sort.direction;
  const sorted = useMemo(() => sortModels(rows, key, direction, scenario), [rows, key, direction, scenario]);
  const totals = useMemo(() => modelTotals(rows), [rows]);
  // The totals row has a figure for a category as soon as one row records it, and a dash when none does.
  const recorded = {
    cacheRead: rows.some((r) => r.recorded.cacheRead),
    cacheWrite: rows.some((r) => r.recorded.cacheWrite),
    replay: rows.some((r) => r.recorded.replay),
  };

  const sortProps = (column: ModelSortKey) => ({
    sort: key === column ? direction : null,
    onSort: () => setSort({ key: column, direction: key === column ? (direction === 'asc' ? 'desc' : 'asc') : column === 'name' ? 'asc' : 'desc' }),
  });
  const totalLevel = confidenceOf(totals.exact, totals.estimated);
  const totalValue = scenario === 'cached' ? totals.cachedUsd : totals.standardUsd;
  const cacheWriteTitle = (m5: number, h1: number) => `${formatInt(m5 + h1)} tokens: ${formatInt(m5)} to the 5-minute cache, ${formatInt(h1)} to the 1-hour cache`;

  return (
    <Card>
      <CardHeader
        title="Models compared"
        description={`One row per model that your sources name, with ${processed ? 'processed' : 'new'} tokens by category. Select a column heading to sort by it.`}
      />
      {/* The table runs edge to edge inside the card: its columns need the width. */}
      <TableFrame className="mt-4 rounded-none border-x-0">
        <Table>
          <THead>
            <tr>
              <Th {...sortProps('name')} className={cn(HEAD, FIRST, 'sticky left-0 z-[2] bg-raised')}>
                Model
              </Th>
              <Th className={HEAD}>Family</Th>
              <Th align="right" {...sortProps('input')} className={HEAD}>
                Input
              </Th>
              <Th align="right" {...sortProps('output')} className={HEAD}>
                Output
              </Th>
              {processed ? (
                <Th align="right" {...sortProps('cacheRead')} className={HEAD}>
                  <TwoLines first="Cache" second="read" />
                </Th>
              ) : null}
              <Th align="right" {...sortProps('cacheWrite')} className={HEAD}>
                <TwoLines first="Cache" second="write" />
              </Th>
              {processed ? (
                <Th align="right" {...sortProps('replay')} className={HEAD}>
                  <TwoLines first="Re-read" second="context" />
                </Th>
              ) : null}
              <Th align="right" {...sortProps('total')} className={HEAD}>
                Total
              </Th>
              <Th align="right" {...sortProps('share')} className={HEAD}>
                <TwoLines first="Share of" second="recorded usage" />
              </Th>
              <Th align="right" {...sortProps('conversations')} className={HEAD}>
                Conversations
              </Th>
              <Th align="right" {...sortProps('requests')} className={HEAD}>
                Requests
              </Th>
              <Th align="right" {...sortProps('value')} className={cn(HEAD, LAST)}>
                <TwoLines first="Equivalent" second="API value" />
              </Th>
            </tr>
          </THead>
          <tbody>
            {sorted.map((row) => {
              const unknown = row.modelKey === null;
              const level = confidenceOf(row.exact, row.estimated);
              return (
                <Tr key={row.modelKey ?? 'unknown'} className="group hover:bg-raised">
                  <Td className={cn(CELL, FIRST, 'sticky left-0 z-[1] bg-surface group-hover:bg-raised')}>
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <span className={cn(unknown && 'text-ink-2')}>{row.displayName}</span>
                      {unknown ? (
                        <InfoTip label="About usage with no recorded model" align="start">
                          <p>
                            This is usage whose source does not record which model produced it. A claude.ai export, for example, lists conversations without naming the
                            model.
                          </p>
                          <p>No model is guessed for it. It stays in this row and is not priced, unless you choose a model to price it as in Settings.</p>
                        </InfoTip>
                      ) : !row.inCatalog ? (
                        <span
                          title="This identifier is not in the built-in model catalog. It is listed as the source spells it, and has no price unless you add one in Settings."
                          className="rounded-[5px] border border-line bg-raised px-1.5 text-xs leading-5 text-ink-2"
                        >
                          not in catalog
                        </span>
                      ) : null}
                    </span>
                  </Td>
                  <Td className={CELL}>
                    {unknown ? (
                      <span className={NOT_RECORDED} title="No model is recorded, so no family is known.">
                        –
                      </span>
                    ) : (
                      <span className="flex items-center gap-2 whitespace-nowrap text-ink-2">
                        <Swatch series={{ color: familyColor(familyOf(row)) }} />
                        {familyLabel(familyOf(row))}
                      </span>
                    )}
                  </Td>
                  <Tokens value={row.input} />
                  <Tokens value={row.output} />
                  {processed ? (
                    row.recorded.cacheRead ? (
                      <Tokens value={row.cacheRead} />
                    ) : (
                      <NotRecorded why="No record of this model has a count for cache reads: there were none, or the source does not record them." />
                    )
                  ) : null}
                  {row.recorded.cacheWrite ? (
                    <Tokens value={row.cacheWrite5m + row.cacheWrite1h} title={cacheWriteTitle(row.cacheWrite5m, row.cacheWrite1h)} />
                  ) : (
                    <NotRecorded why="No record of this model has a count for cache writes: there were none, or the source does not record them." />
                  )}
                  {processed ? (
                    row.recorded.replay ? (
                      <Tokens value={row.replay} />
                    ) : (
                      <NotRecorded why="Re-read context is only modelled for usage reconstructed from conversation text. Counts that a source states show cache reads instead, where the source records them." />
                    )
                  ) : null}
                  <Tokens value={row.total}>
                    <ConfidenceMark compact level={level} title={confidenceTitle(level, row.exact, row.estimated)} className="ml-1.5" />
                  </Tokens>
                  <Td numeric className={CELL}>
                    <ShareBar share={row.share} />
                  </Td>
                  {row.conversations > 0 ? (
                    <Td numeric className={CELL}>
                      {formatInt(row.conversations)}
                    </Td>
                  ) : (
                    <NotRecorded why="This usage is not tied to conversations: usage reports give totals per day." />
                  )}
                  {row.requests > 0 ? (
                    <Td numeric className={CELL}>
                      {formatInt(row.requests)}
                    </Td>
                  ) : (
                    <NotRecorded why="The source records no request count." />
                  )}
                  <ValueCell row={row} scenario={scenario} assumedModelName={assumedModelName} />
                </Tr>
              );
            })}
          </tbody>
          <tfoot>
            <Tr className="border-line-strong bg-raised font-medium">
              <Td className={cn(CELL, FIRST, 'sticky left-0 z-[1] bg-raised')}>All models</Td>
              <Td className={CELL} />
              <Tokens value={totals.input} />
              <Tokens value={totals.output} />
              {processed ? (
                recorded.cacheRead ? (
                  <Tokens value={totals.cacheRead} />
                ) : (
                  <NotRecorded why="None of the sources of this usage records cache reads." />
                )
              ) : null}
              {recorded.cacheWrite ? (
                <Tokens value={totals.cacheWrite5m + totals.cacheWrite1h} title={cacheWriteTitle(totals.cacheWrite5m, totals.cacheWrite1h)} />
              ) : (
                <NotRecorded why="None of the sources of this usage records cache writes." />
              )}
              {processed ? (
                recorded.replay ? (
                  <Tokens value={totals.replay} />
                ) : (
                  <NotRecorded why="Re-read context is only modelled for usage reconstructed from conversation text, and none of this usage is." />
                )
              ) : null}
              <Tokens value={totals.total}>
                <ConfidenceMark compact level={totalLevel} title={confidenceTitle(totalLevel, totals.exact, totals.estimated)} className="ml-1.5" />
              </Tokens>
              <Td numeric className={CELL}>
                <ShareBar share={totals.total > 0 ? 1 : 0} />
              </Td>
              <NotRecorded why="A conversation that used two models is counted under both, so this column does not add up to a number of conversations." />
              {totals.requests > 0 ? (
                <Td numeric className={CELL}>
                  {formatInt(totals.requests)}
                </Td>
              ) : (
                <NotRecorded why="The sources record no request counts." />
              )}
              {totals.pricedTokens > 0 ? (
                <Td numeric className={cn(CELL, LAST)}>
                  {formatUsd(totalValue)}
                </Td>
              ) : (
                <NotRecorded className={LAST} why="None of this usage could be priced." />
              )}
            </Tr>
          </tfoot>
        </Table>
      </TableFrame>
      <div className="space-y-1.5 px-5 pb-4 pt-3 text-xs text-ink-3">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>Next to each total:</span>
          <span className="inline-flex items-center gap-1.5">
            <ConfidenceMark level="exact" /> metered by the source
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ConfidenceMark level="estimated" /> includes estimated tokens
          </span>
        </p>
        <p>Share is of the usage recorded in your imports for this range. It is not a share of everything you ever used.</p>
        <p>
          A dash means no record has a count for that figure: there was none, or the source does not record it. A conversation that used two models is counted under each of
          them, so the Conversations column has no total.
        </p>
        {processed ? null : <p>Cache reads and re-read context are left out: under the New basis each piece of content is counted once.</p>}
        <p>
          Equivalent API value is a list-price value under the scenario this app leads with ({scenario === 'cached' ? 'a 5-minute prompt cache' : 'no prompt caching'}),
          explained below.
        </p>
      </div>
    </Card>
  );
}
