'use client';

import { Info, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { BeforeAfter, ConversationUsage, SideStats } from '@/analytics/subscriptions';
import { confidenceOf, ConfidenceLegend } from '@/components/data/confidence';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Segmented, Select } from '@/components/ui/controls';
import { EmptyState } from '@/components/ui/feedback';
import { Table, TableFrame, THead, Tr } from '@/components/ui/table';
import { cn } from '@/lib/cn';
import { addDays, dayInZone, formatDay, formatDayRange, formatInt, formatShare, formatTokens, formatUsd, plural } from '@/lib/format';
import {
  assessComparability, COMPARE_MODES, defaultMode, describeRatio, leadingUsd, pricedShare, rateRatio, sideFigure, valueLevel,
  type CompareMode, type CostScenario, type Figure, type Side,
} from './logic';
import { BadgedFigure, Unavailable } from './parts';

export interface BeforeAfterCardProps {
  data: BeforeAfter;
  /** Usage that belongs to conversations on each side; null when there is no paid period. */
  inConversations: { before: ConversationUsage; after: ConversationUsage } | null;
  /** Start of the first entered period, to tell whether the entered history begins before the imported records. */
  historyStart: string | null;
  timezone: string;
  scenario: CostScenario;
  /** How many periods are entered, for the wording of the empty state. */
  periodCount: number;
  /** The "Add period" action offered while no paid period exists. */
  action: ReactNode;
}

const SIDE_NAME: Record<Side, string> = { before: 'Before', after: 'After' };

/** Tighter on a phone, where the three columns have to share the width of the screen. */
const CELL = 'px-2 py-2.5 align-top sm:px-3';

function MeasureRow({ label, hint, before, after }: { label: string; hint?: string; before: ReactNode; after: ReactNode }) {
  return (
    <Tr>
      <th scope="row" className={cn(CELL, 'text-left font-normal text-ink-2 sm:whitespace-nowrap')}>
        {label}
        {hint ? <span className="mt-0.5 block text-xs text-ink-3">{hint}</span> : null}
      </th>
      <td className={cn(CELL, 'text-ink')}>{before}</td>
      <td className={cn(CELL, 'text-ink')}>{after}</td>
    </Tr>
  );
}

function Count({ value }: { value: number }) {
  return value > 0 ? <span className="tabular">{formatInt(value)}</span> : <Unavailable />;
}

/** One thin bar per side, the metered part solid and the estimated part hatched, with the figure at its tip. */
function CompareBars({ rows, unit }: { rows: Array<{ side: Side; figure: Figure | null; missing: string }>; unit: string }) {
  const max = Math.max(0, ...rows.map((row) => row.figure?.value ?? 0));
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
      {rows.map(({ side, figure, missing }) => (
        <div key={side} className="contents">
          <dt className="text-[13px] text-ink-2">{SIDE_NAME[side]}</dt>
          <dd className="flex min-w-0 items-center gap-2.5">
            {figure ? (
              <>
                {figure.value > 0 ? (
                  <span
                    aria-hidden="true"
                    className="flex h-4 min-w-[3px] gap-0.5"
                    // The figure at the tip needs room even next to the longest bar.
                    style={{ width: `calc((100% - 4.5rem) * ${max > 0 ? figure.value / max : 0})` }}
                  >
                    {figure.exact > 0 ? <span className="h-full min-w-[2px] bg-accent last:rounded-r-[4px]" style={{ flexGrow: figure.exact, flexBasis: 0 }} /> : null}
                    {figure.estimated > 0 ? (
                      <span className="hatch-estimated h-full min-w-[2px] bg-accent/45 last:rounded-r-[4px]" style={{ flexGrow: figure.estimated, flexBasis: 0 }} />
                    ) : null}
                  </span>
                ) : null}
                <span className="tabular shrink-0 text-[13px] text-ink" title={`${formatInt(figure.value)} ${unit}`}>
                  {formatTokens(figure.value)}
                </span>
              </>
            ) : (
              <span className="text-[13px] text-ink-3">– {missing}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Note({ caution = false, lead, children }: { caution?: boolean; lead: string; children: ReactNode }) {
  const Icon = caution ? TriangleAlert : Info;
  return (
    <li className="flex gap-2.5">
      <Icon className={cn('mt-0.5 size-4 shrink-0', caution ? 'text-warning' : 'text-ink-3')} strokeWidth={2} aria-hidden="true" />
      <p>
        <span className="text-ink">{lead}</span> {children}
      </p>
    </li>
  );
}

/**
 * Usage before and after the first paid plan. The two sides usually differ in length, and
 * often in how they were measured, so the card leads with averages, states the range each
 * side really covers, and says in plain words when the comparison should not be trusted.
 */
export function BeforeAfterCard({ data, inConversations, historyStart, timezone, scenario, periodCount, action }: BeforeAfterCardProps) {
  const [chosenMode, setChosenMode] = useState<CompareMode | null>(null);
  const { split, before, after } = data;

  if (!split) {
    return (
      <Card id="before-after" className="scroll-mt-20">
        <CardHeader title="Before vs. after your first paid plan" />
        <CardBody>
          <EmptyState title="This comparison needs a paid period" action={action}>
            <p>
              {periodCount === 1 ? 'The period you entered is' : `None of the ${periodCount} periods you entered is`} on a paid plan. Add the period in which you
              first paid for Claude and your usage is split at the day it started.
            </p>
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  const comparability = assessComparability(before, after, { timezone, historyStart });
  const mode = chosenMode ?? defaultMode(comparability);
  const modeInfo = COMPARE_MODES.find((m) => m.value === mode) ?? COMPARE_MODES[0];
  const sides: Array<{ side: Side; stats: SideStats | null; conversations: ConversationUsage | null }> = [
    { side: 'before', stats: before, conversations: inConversations?.before ?? null },
    { side: 'after', stats: after, conversations: inConversations?.after ?? null },
  ];
  const figures = sides.map(({ side, stats, conversations }) => ({
    side,
    figure: sideFigure(mode, stats, conversations),
    missing: !stats || stats.spanDays <= 0 ? 'no imported usage' : 'no conversations',
  }));
  const ratio = rateRatio(
    mode,
    { figure: figures[0].figure, spanDays: before?.spanDays ?? 0 },
    { figure: figures[1].figure, spanDays: after?.spanDays ?? 0 },
    comparability,
  );

  const splitDay = formatDay(split.date);
  const range = (side: Side, stats: SideStats) =>
    side === 'before'
      ? formatDayRange(stats.firstAt ? dayInZone(stats.firstAt, timezone) : null, addDays(split.date, -1))
      : formatDayRange(split.date, stats.lastAt ? dayInZone(stats.lastAt, timezone) : null);

  const cell = (render: (stats: SideStats, conversations: ConversationUsage | null, side: Side) => ReactNode, side: Side) => {
    const entry = sides.find((s) => s.side === side);
    if (!entry?.stats || entry.stats.spanDays <= 0) return <Unavailable />;
    return render(entry.stats, entry.conversations, side);
  };
  const row = (label: string, render: (stats: SideStats, conversations: ConversationUsage | null, side: Side) => ReactNode, hint?: string) => (
    <MeasureRow label={label} hint={hint} before={cell(render, 'before')} after={cell(render, 'after')} />
  );

  return (
    <Card id="before-after" className="scroll-mt-20">
      <CardHeader
        title="Before vs. after your first paid plan"
        description={`Your usage on either side of ${splitDay}, the day ${split.label} started. Each side reaches only as far as your imported records do.`}
      />
      <CardBody className="grid gap-x-10 gap-y-7 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <th scope="col" className="px-2 py-2 font-medium sm:px-3">
                    <span className="sr-only">Measure</span>
                  </th>
                  {sides.map(({ side, stats }) => (
                    <th key={side} scope="col" className="px-2 py-2 text-left align-top font-normal sm:px-3">
                      <span className="block text-[13px] font-medium text-ink">{SIDE_NAME[side]}</span>
                      {stats && stats.spanDays > 0 ? (
                        <>
                          <span className="block sm:whitespace-nowrap">{range(side, stats)}</span>
                          <span className="tabular block text-ink-3">{plural(stats.spanDays, 'day')}</span>
                        </>
                      ) : (
                        <span className="block text-ink-3">
                          No imported usage {side === 'before' ? 'before' : 'from'} {splitDay}
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </THead>
              <tbody>
                {row('Total tokens', (stats) => (
                  <BadgedFigure level={confidenceOf(stats.exact, stats.estimated)} title={`${formatInt(stats.tokens)} tokens`}>
                    {formatTokens(stats.tokens)}
                  </BadgedFigure>
                ))}
                {row('Conversations', (stats) => <Count value={stats.conversations} />)}
                {row('Messages', (stats) => <Count value={stats.messages} />)}
                {row('Tokens per day', (stats) => {
                  const perDay = sideFigure('day', stats, null);
                  return perDay ? (
                    <BadgedFigure level={confidenceOf(stats.exact, stats.estimated)} title={`${formatInt(perDay.value)} tokens per day`}>
                      {formatTokens(perDay.value)}
                    </BadgedFigure>
                  ) : (
                    <Unavailable />
                  );
                })}
                {row(
                  'Average conversation size',
                  (stats, conversations) => {
                    const size = sideFigure('conversation', stats, conversations);
                    if (!size || !conversations) return <Unavailable>No conversations</Unavailable>;
                    return (
                      <>
                        <BadgedFigure level={confidenceOf(conversations.exact, conversations.estimated)} title={`${formatInt(size.value)} tokens per conversation`}>
                          {formatTokens(size.value)}
                        </BadgedFigure>
                        <span className="mt-0.5 block text-xs text-ink-3">
                          {formatTokens(conversations.tokens)} tokens in {plural(conversations.conversations, 'conversation')}
                        </span>
                      </>
                    );
                  },
                  'tokens per conversation',
                )}
                {row('Equivalent API value', (stats) => {
                  const level = valueLevel(stats.value);
                  const share = pricedShare(stats.value);
                  if (level === 'unavailable') {
                    return (
                      <>
                        <BadgedFigure level="unavailable" hint="None of the usage on this side names a model with a published price, so nothing can be priced.">
                          <span className="text-ink-3">–</span>
                        </BadgedFigure>
                        <span className="mt-0.5 block text-xs text-ink-3">Not priced: no model recorded</span>
                      </>
                    );
                  }
                  return (
                    <>
                      <BadgedFigure
                        level={level}
                        hint={
                          level === 'exact'
                            ? 'Metered token counts multiplied by Anthropic’s published API prices. Not money you paid.'
                            : 'Includes estimated token counts or an assumed model. Not money you paid.'
                        }
                      >
                        {formatUsd(leadingUsd(stats.value, scenario), { cents: true })}
                      </BadgedFigure>
                      {share !== null && share < 1 ? (
                        <span className="mt-0.5 block text-xs text-ink-3" title={`${formatInt(stats.value.unpricedTokens)} processed tokens name no model, or a model with no price on file.`}>
                          {formatShare(share)} of the tokens priced
                        </span>
                      ) : null}
                    </>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        </div>

        <div className="@container min-w-0 border-line lg:border-l lg:pl-10">
          {/* The same choice twice: side by side where the column is wide enough, as a menu where it is not. */}
          <Segmented
            label="Compare by"
            value={mode}
            onChange={setChosenMode}
            options={COMPARE_MODES.map((m) => ({ value: m.value, label: m.short, title: m.label }))}
            className="hidden @min-[27rem]:inline-flex"
          />
          <Select label="Compare by" value={mode} onChange={setChosenMode} options={COMPARE_MODES} className="w-full @min-[27rem]:hidden" />

          <h3 className="mt-5 text-[13px] text-ink-2">{modeInfo.heading}</h3>
          <div className="mt-3">
            <CompareBars rows={figures} unit={modeInfo.unit} />
          </div>
          {figures.some((f) => (f.figure?.estimated ?? 0) > 0) ? <ConfidenceLegend className="mt-3" /> : null}
          {ratio ? <p className="mt-4 text-[13px] text-ink">{describeRatio(ratio, modeInfo.unit)}</p> : null}

          {comparability.lengths || comparability.measurement || comparability.firstRecord || comparability.short.length > 0 ? (
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="text-[13px] font-medium text-ink">What limits this comparison</h3>
              <ul className="mt-2.5 space-y-2.5 text-[13px] text-ink-2">
                {comparability.lengths ? (
                  <Note caution={mode === 'total'} lead="Different lengths of time.">
                    Before covers {plural(comparability.lengths.beforeDays, 'day')} and after covers {plural(comparability.lengths.afterDays, 'day')}.{' '}
                    {mode === 'total' ? (
                      <>
                        These totals are not comparable.{' '}
                        <button type="button" onClick={() => setChosenMode('day')} className="text-accent-soft underline-offset-4 hover:underline">
                          Show the average per day
                        </button>
                      </>
                    ) : (
                      'Totals over such different lengths are not comparable, which is why this comparison opens on an average.'
                    )}
                  </Note>
                ) : null}
                {comparability.measurement ? (
                  <Note caution lead="Measured differently.">
                    {SIDE_NAME[comparability.measurement.estimatedSide]} is entirely estimated from conversation text, while {formatShare(comparability.measurement.meteredShare)} of{' '}
                    {comparability.measurement.estimatedSide === 'before' ? 'after' : 'before'} is metered by sources that count tokens. Estimates leave out what an export does not
                    contain, such as system prompts, tool definitions, images and files, so part of the difference comes from the method. No ratio is stated for that reason.
                  </Note>
                ) : null}
                {comparability.firstRecord ? (
                  <Note lead="Before starts at your first imported record.">
                    {comparability.firstRecord.unrecordedDays >= 14 && historyStart ? (
                      <>
                        The periods you entered start on {formatDay(dayInZone(historyStart, timezone))}, but the earliest record is from {formatDay(comparability.firstRecord.day)}.
                        Nothing is recorded for those {plural(comparability.firstRecord.unrecordedDays, 'day')}: either you did not use Claude then, or that usage is not in the
                        imported files.
                      </>
                    ) : (
                      <>
                        That record is from {formatDay(comparability.firstRecord.day)}. Anything you did with Claude before that date is not in the imported files, so this side may be
                        incomplete.
                      </>
                    )}
                  </Note>
                ) : null}
                {comparability.short.map(({ side, days }) => (
                  <Note key={side} lead={`${SIDE_NAME[side]} is short.`}>
                    It covers only {plural(days, 'day')}. An average over so few days can swing widely, so no ratio is stated.
                  </Note>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
