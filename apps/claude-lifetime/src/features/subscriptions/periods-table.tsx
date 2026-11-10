'use client';

import { useEffect, useRef, useState } from 'react';
import type { SegmentStats, SubscriptionPeriod } from '@/analytics/subscriptions';
import { confidenceOf } from '@/components/data/confidence';
import { Button } from '@/components/ui/button';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { cn } from '@/lib/cn';
import { dayInZone, formatDay, formatInt, formatMoney, formatShare, formatSpan, formatTokens, formatUsd, plural } from '@/lib/format';
import { averagePerDay, describeDates, elapsedDays, hasRecords, leadingUsd, lengthDays, pricedShare, segmentDates, valueLevel, type CostScenario } from './logic';
import { BadgedFigure, PlanSwatch, SyntheticTag, Unavailable } from './parts';

export interface PeriodsTableProps {
  /** Periods and the gaps between them, in order. */
  segments: SegmentStats[];
  periods: SubscriptionPeriod[];
  /** The instant the segments were read at. */
  now: string;
  timezone: string;
  scenario: CostScenario;
  /** False while nothing is imported: the usage columns are then left out. */
  hasUsage: boolean;
  onEdit: (period: SubscriptionPeriod) => void;
  onDelete: (period: SubscriptionPeriod) => void;
  onAddPeriod: (dates: { startDate: string; lastDate: string | null }) => void;
}

const HEAD = 'px-2';
const CELL = 'px-2 py-2.5 align-top';
/** Rows for time without a recorded plan sit a shade lower than the periods. Opaque, because the pinned cell covers what scrolls under it. */
const GAP_ROW = 'bg-[color-mix(in_srgb,var(--color-page)_55%,var(--color-surface))]';
/** On wide screens the actions stay in view while the other columns scroll. */
const PINNED = 'lg:sticky lg:right-0';
/** A hairline along the pinned column, drawn only while columns really scroll under it. */
const PINNED_EDGE = 'lg:shadow-[inset_1px_0_0_var(--color-line-strong)]';

/**
 * Everything the timeline shows, as a table: one row per period and per stretch with no
 * recorded plan, oldest first. A segment without imported records shows a dash and says
 * so; a zero is only ever shown when the records themselves add up to zero.
 */
export function PeriodsTable({ segments, periods, now, timezone, scenario, hasUsage, onEdit, onDelete, onAddPeriod }: PeriodsTableProps) {
  const nowMs = Date.parse(now);
  const today = dayInZone(now, timezone);
  const byId = new Map(periods.map((period) => [period.id, period]));

  const body = useRef<HTMLTableSectionElement | null>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const table = body.current?.closest('table');
    const frame = table?.parentElement;
    if (!table || !frame) return;
    const observer = new ResizeObserver(() => setScrolls(frame.scrollWidth > frame.clientWidth + 1));
    observer.observe(frame);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);
  const pinned = cn(PINNED, scrolls && PINNED_EDGE);

  return (
    <TableFrame className="rounded-none border-x-0 border-b-0">
      <Table>
        <THead>
          <tr>
            <Th className="py-2 pl-5 pr-2">Plan</Th>
            <Th className={HEAD}>Start</Th>
            <Th className={HEAD}>End</Th>
            <Th align="right" className={HEAD}>
              Length
            </Th>
            {hasUsage ? (
              <>
                <Th align="right" className={HEAD}>
                  {/* Over the figures, not over the badges that follow them. */}
                  <span className="mr-[6.25rem]">Tokens</span>
                </Th>
                <Th align="right" className={cn(HEAD, 'leading-tight')}>
                  Average
                  <br />
                  per day
                </Th>
                <Th align="right" className={HEAD}>
                  Conversations
                </Th>
                <Th align="right" className={HEAD}>
                  Messages
                </Th>
                <Th align="right" className={cn(HEAD, 'leading-tight')}>
                  Equivalent
                  <br />
                  API value
                </Th>
              </>
            ) : null}
            <Th align="right" className={cn(HEAD, 'leading-tight')}>
              Monthly
              <br />
              price
            </Th>
            <Th className={cn('bg-raised py-2 pl-2 pr-5', pinned)}>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </THead>
        <tbody ref={body}>
          {segments.map((segment, index) => {
            const period = segment.periodId === null ? undefined : byId.get(segment.periodId);
            const isGap = segment.kind === 'gap';
            const dates = segmentDates(segment, timezone);
            const datesText = describeDates(dates, today);
            const length = lengthDays(segment, nowMs);
            const elapsed = elapsedDays(segment, nowMs);
            const recorded = hasRecords(segment);
            const average = averagePerDay(segment);
            const level = valueLevel(segment.value);
            const share = pricedShare(segment.value);

            return (
              <Tr key={`${segment.kind}:${segment.periodId ?? index}:${segment.start}`} className={cn(isGap && GAP_ROW)}>
                <th scope="row" className="py-2.5 pl-5 pr-2 text-left align-top font-normal">
                  <span className="flex items-center gap-2">
                    <PlanSwatch planKey={segment.planKey} />
                    <span className={cn('whitespace-nowrap', isGap ? 'text-ink-2' : 'text-ink')}>{segment.label}</span>
                    {period?.isSynthetic ? <SyntheticTag /> : null}
                  </span>
                  {period?.notes ? (
                    <span className="mt-0.5 block max-w-[15rem] truncate pl-[18px] text-xs text-ink-3" title={period.notes}>
                      {period.notes}
                    </span>
                  ) : null}
                </th>
                <Td className={cn(CELL, 'whitespace-nowrap', isGap && 'text-ink-2')}>{formatDay(dates.startDate)}</Td>
                <Td className={cn(CELL, 'whitespace-nowrap', isGap && 'text-ink-2')}>
                  {dates.lastDate ? (
                    formatDay(dates.lastDate)
                  ) : isGap ? (
                    'Ongoing'
                  ) : length === null ? (
                    <span className="text-ink-2">Not started</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-good" aria-hidden="true" />
                      Active
                    </span>
                  )}
                </Td>
                <Td numeric className={cn(CELL, 'whitespace-nowrap', isGap && 'text-ink-2')}>
                  {length === null ? (
                    <Unavailable />
                  ) : (
                    <>
                      <span title={formatSpan(length)}>{plural(length, 'day')}</span>
                      {elapsed < length ? <span className="mt-0.5 block text-xs text-ink-3">{elapsed === 0 ? 'Not started' : `${formatInt(elapsed)} so far`}</span> : null}
                    </>
                  )}
                </Td>
                {hasUsage ? (
                  recorded ? (
                    <>
                      {/* The badge is taller than a line of text; one pixel less on top keeps the figure on the row's baseline. */}
                      <Td align="right" className={cn(CELL, 'pt-[9px]')}>
                        <BadgedFigure column level={confidenceOf(segment.exact, segment.estimated)} title={`${formatInt(segment.tokens)} tokens`}>
                          {formatTokens(segment.tokens)}
                        </BadgedFigure>
                      </Td>
                      <Td numeric className={cn(CELL, 'whitespace-nowrap')}>
                        {average === null ? (
                          <Unavailable />
                        ) : (
                          <>
                            <span title={`${formatInt(average)} tokens per day, over the ${plural(segment.recordedDays, 'day')} of this period between your first and last imported record`}>
                              {formatTokens(average)}
                            </span>
                            {/* Days outside the imported history are unknown, not empty, so they are not averaged in. */}
                            {segment.recordedDays < elapsed ? <span className="mt-0.5 block text-xs text-ink-3">over {plural(segment.recordedDays, 'day')}</span> : null}
                          </>
                        )}
                      </Td>
                      <Td numeric className={CELL}>
                        {segment.conversations > 0 ? formatInt(segment.conversations) : <Unavailable />}
                      </Td>
                      <Td numeric className={CELL}>
                        {segment.messages > 0 ? formatInt(segment.messages) : <Unavailable />}
                      </Td>
                      <Td numeric className={cn(CELL, 'whitespace-nowrap')}>
                        {level === 'unavailable' ? (
                          <span title="The source of this usage names no model with a published price, so no price can be applied.">
                            <Unavailable>Not priced</Unavailable>
                          </span>
                        ) : (
                          <>
                            {formatUsd(leadingUsd(segment.value, scenario), { cents: true })}
                            {share !== null && share < 1 ? (
                              <span
                                className="mt-0.5 block text-xs text-ink-3"
                                title={`${formatInt(segment.value.unpricedTokens)} processed tokens name no model, or a model with no price on file, and are left out of this value.`}
                              >
                                {formatShare(share)} priced
                              </span>
                            ) : null}
                          </>
                        )}
                      </Td>
                    </>
                  ) : (
                    <>
                      <Td align="right" className={CELL}>
                        {/* The dash stands where the figure would, the reason where its badge would. */}
                        <span className="inline-flex items-start justify-end gap-2 text-ink-3">
                          <span aria-hidden="true">–</span>
                          <span className="w-[5.75rem] pt-0.5 text-left text-xs leading-tight">No recorded usage</span>
                        </span>
                      </Td>
                      {['average', 'conversations', 'messages', 'value'].map((column) => (
                        <Td key={column} numeric className={CELL}>
                          <Unavailable />
                        </Td>
                      ))}
                    </>
                  )
                ) : null}
                <Td numeric className={cn(CELL, 'whitespace-nowrap')}>
                  {period ? period.monthlyPrice ? formatMoney(period.monthlyPrice, period.currency) : <Unavailable>Not entered</Unavailable> : null}
                </Td>
                <Td align="right" className={cn('whitespace-nowrap py-1 pl-2 align-top', pinned, isGap ? cn(GAP_ROW, 'pr-5') : 'bg-surface pr-3')}>
                  {period ? (
                    <span className="inline-flex gap-0.5">
                      <Button variant="ghost" size="sm" onClick={() => onEdit(period)} aria-label={`Edit ${segment.label}, ${datesText}`}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(period)} aria-label={`Delete ${segment.label}, ${datesText}`}>
                        Delete
                      </Button>
                    </span>
                  ) : isGap ? (
                    <Button variant="secondary" size="sm" onClick={() => onAddPeriod(dates)} aria-label={`Add period for ${datesText}`}>
                      Add period
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableFrame>
  );
}
