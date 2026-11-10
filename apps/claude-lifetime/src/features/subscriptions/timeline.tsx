'use client';

import { ChevronRight, Plus } from 'lucide-react';
import { Tooltip as RTooltip } from 'radix-ui';
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { isPaidPlan, type SegmentStats } from '@/analytics/subscriptions';
import { confidenceOf } from '@/components/data/confidence';
import { cn } from '@/lib/cn';
import { dayInZone, formatDay, formatSpan, formatTokens, formatUsd, plural } from '@/lib/format';
import { planColor } from '@/lib/palette';
import {
  averagePerDay, blockLabelFit, boundaryX, describeDates, hasRecords, layoutTimeline, leadingUsd, placeAxisLabels, segmentDates, segmentSpans,
  timelineTicks, timelineX, valueLevel, type CostScenario,
} from './logic';
import { ConfidenceMark, PlanSwatch } from './parts';

/** A block never gets narrower than this, however short its period. */
const MIN_BLOCK = 12;
/** Surface-coloured gap between neighbouring blocks. */
const GAP = 2;
const LABEL_PADDING = 10;
/** Below this width the band cannot label its blocks, so a list underneath names them. */
const COMPACT_BELOW = 560;
/** Roughly one axis tick per this many pixels. */
const TICK_SPACING = 110;

const NAME_TEXT = 'whitespace-nowrap text-[13px] font-medium leading-[18px]';
const DATES_TEXT = 'whitespace-nowrap text-xs leading-4';
const ADD_HERE = 'Add a period here';
const FIRST_PAID = 'First paid plan';

export interface TimelineProps {
  /** Periods and the gaps between them, in order. */
  segments: SegmentStats[];
  /** The instant the segments were read at: where the band ends. */
  now: string;
  timezone: string;
  scenario: CostScenario;
  /** False while nothing is imported. Usage figures are then left out instead of being shown as empty. */
  hasUsage: boolean;
  onEditPeriod: (periodId: number) => void;
  onAddPeriod: (dates: { startDate: string; lastDate: string | null }) => void;
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0]?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

interface Probe {
  key: string;
  text: string;
  className: string;
}

const sameWidths = (a: Record<string, number>, b: Record<string, number>) => {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
};

/**
 * Measures how wide each label is in the font it will be drawn in, so a block only
 * shows a label that fits. The texts are laid out invisibly and re-measured whenever
 * their size changes, for instance once the web font has loaded.
 */
function TextProbes({ probes, onMeasure }: { probes: Probe[]; onMeasure: (widths: Record<string, number>) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const signature = probes.map((probe) => probe.key).join('\n');
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const elements = Array.from(root.children) as HTMLElement[];
    const observer = new ResizeObserver(() => {
      const widths: Record<string, number> = {};
      for (const element of elements) widths[element.dataset.key ?? ''] = Math.ceil(element.getBoundingClientRect().width);
      onMeasure(widths);
    });
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [signature, onMeasure]);
  return (
    <div ref={ref} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 h-0 max-w-full overflow-hidden whitespace-nowrap">
      {probes.map((probe) => (
        <span key={probe.key} data-key={probe.key} className={cn('inline-block', probe.className)}>
          {probe.text}
        </span>
      ))}
    </div>
  );
}

/**
 * The shared Tooltip keeps a tooltip open while the pointer travels towards it, and holds
 * back the tooltips of other triggers meanwhile. Along a row of adjacent blocks that makes
 * a narrow block easy to miss, so here a tooltip closes as soon as its block is left and
 * the next one opens at once. Its content has nothing to click, so nothing is lost.
 */
function BlockTooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RTooltip.Root disableHoverableContent>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-[18rem] animate-[fade-in_100ms_ease-out] rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-ink shadow-lg"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-5">
      <dt className="text-ink-2">{label}</dt>
      <dd className="tabular inline-flex items-center gap-1.5 text-ink">{children}</dd>
    </div>
  );
}

/** What hovering or focusing a block shows. The periods table below repeats every figure. */
function SegmentDetails({
  segment,
  datesText,
  nowMs,
  scenario,
  hasUsage,
}: {
  segment: SegmentStats;
  datesText: string;
  nowMs: number;
  scenario: CostScenario;
  hasUsage: boolean;
}) {
  const average = averagePerDay(segment, nowMs);
  return (
    <div className="min-w-[14rem] py-0.5">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
        <PlanSwatch planKey={segment.planKey} />
        {segment.label}
      </p>
      <p className="mt-0.5 text-ink-2">{datesText}</p>
      <dl className="mt-2 space-y-1 border-t border-line pt-2">
        <DetailRow label="Length">
          {plural(segment.days, 'day')}
          {segment.days >= 60 ? <span className="text-ink-2">({formatSpan(segment.days)})</span> : null}
        </DetailRow>
        {hasUsage && hasRecords(segment) ? (
          <>
            <DetailRow label="Tokens">
              {formatTokens(segment.tokens)}
              <ConfidenceMark level={confidenceOf(segment.exact, segment.estimated)} />
            </DetailRow>
            <DetailRow label="Average per day">{average === null ? '–' : formatTokens(average)}</DetailRow>
            <DetailRow label="Equivalent API value">
              {valueLevel(segment.value) === 'unavailable' ? <span className="text-ink-2">Not priced</span> : formatUsd(leadingUsd(segment.value, scenario), { cents: true })}
            </DetailRow>
          </>
        ) : null}
      </dl>
      {hasUsage && !hasRecords(segment) ? <p className="mt-1 text-ink-2">No recorded usage</p> : null}
      <p className="mt-2 text-ink-3">{segment.kind === 'period' ? 'Select to edit this period' : 'Select to add a period here'}</p>
    </div>
  );
}

/**
 * The plans a person was on, as a band scaled by time: one block per entered period,
 * in the colour of its plan, and an empty dashed block wherever nothing was recorded.
 */
export function Timeline({ segments, now, timezone, scenario, hasUsage, onEditPeriod, onAddPeriod }: TimelineProps) {
  const [frameRef, frameWidth] = useElementWidth<HTMLDivElement>();
  const [textWidths, setTextWidths] = useState<Record<string, number>>({});
  const onMeasure = useCallback((next: Record<string, number>) => setTextWidths((previous) => (sameWidths(previous, next) ? previous : next)), []);

  const nowMs = Date.parse(now);
  const today = dayInZone(now, timezone);
  const items = segments.map((segment, index) => {
    const dates = segmentDates(segment, timezone);
    const datesText = describeDates(dates, today);
    const activate = () => (segment.kind === 'period' && segment.periodId !== null ? onEditPeriod(segment.periodId) : onAddPeriod(dates));
    const action = segment.kind === 'period' ? 'Edit this period' : ADD_HERE;
    return {
      key: `${segment.kind}:${segment.periodId ?? index}:${segment.start}`,
      segment,
      dates,
      datesText,
      activate,
      accessibleName: `${segment.label}, ${datesText}, ${plural(segment.days, 'day')}. ${action}.`,
    };
  });

  const probes = new Map<string, Probe>();
  const probe = (kind: 'name' | 'dates', text: string) => probes.set(`${kind}:${text}`, { key: `${kind}:${text}`, text, className: kind === 'name' ? NAME_TEXT : DATES_TEXT });
  for (const item of items) {
    probe('name', item.segment.label);
    probe('dates', item.datesText);
  }
  probe('name', ADD_HERE);
  probe('dates', FIRST_PAID);

  const compact = frameWidth > 0 && frameWidth < COMPACT_BELOW;
  const layout = layoutTimeline(segmentSpans(segments, nowMs), frameWidth, { minBlock: MIN_BLOCK, gap: GAP });
  const firstBlock = layout.blocks[0];
  const lastBlock = layout.blocks[layout.blocks.length - 1];

  const ticks = firstBlock
    ? timelineTicks(firstBlock.startMs, lastBlock.endMs, timezone, Math.floor(layout.width / TICK_SPACING)).map((tick) => ({ ...tick, x: timelineX(layout, tick.ms) }))
    : [];
  const todayX = timelineX(layout, nowMs);
  const todayAtEnd = todayX >= layout.width - 1;
  const axisLabels = firstBlock
    ? placeAxisLabels(layout.width, [
        { x: todayAtEnd ? layout.width : todayX, text: 'Today', anchor: todayAtEnd ? 'end' : 'middle', major: true },
        { x: 0, text: formatDay(items[0].dates.startDate), anchor: 'start', major: true },
        ...ticks.map((tick) => ({ x: tick.x, text: tick.label, anchor: 'middle' as const, major: tick.major })),
      ])
    : [];

  const paidIndex = segments.findIndex((segment) => segment.kind === 'period' && isPaidPlan(segment.planKey));
  const hasMarker = paidIndex >= 0;
  const markerX = hasMarker && firstBlock ? boundaryX(layout, paidIndex, GAP) : null;
  // The label stands to the right of its marker, or to the left when it would leave the band there.
  const markerLabelStyle: CSSProperties =
    markerX === null
      ? {}
      : markerX + 7 + (textWidths[`dates:${FIRST_PAID}`] ?? 0) <= layout.width
        ? { left: markerX + 7 }
        : { right: layout.width - markerX + 7 };
  // The offer on an unrecorded stretch: a plus icon, a small space and the text.
  const addLabelWidth = (textWidths[`name:${ADD_HERE}`] ?? Number.POSITIVE_INFINITY) + 20;

  return (
    <div ref={frameRef} className="relative">
      <TextProbes probes={[...probes.values()]} onMeasure={onMeasure} />

      <div className="scrollbar-thin overflow-x-auto">
        <div className="relative" style={firstBlock ? { width: layout.width } : undefined}>
          {hasMarker ? (
            <div className="relative h-6">
              {markerX === null ? null : hasUsage ? (
                <a
                  href="#before-after"
                  title="The comparison further down splits your usage at this date"
                  className="absolute top-0 whitespace-nowrap text-xs leading-4 text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                  style={markerLabelStyle}
                >
                  {FIRST_PAID}
                </a>
              ) : (
                <span className="absolute top-0 whitespace-nowrap text-xs leading-4 text-ink-2" style={markerLabelStyle}>
                  {FIRST_PAID}
                </span>
              )}
            </div>
          ) : null}

          <ol className="relative h-12" aria-label="Periods and unrecorded stretches, oldest first" aria-hidden={compact || undefined}>
            {items.map((item, index) => {
              const block = layout.blocks[index];
              if (!block) return null;
              const { segment } = item;
              const isGap = segment.kind === 'gap';
              const fit = blockLabelFit(block.width, textWidths[`name:${segment.label}`], textWidths[`dates:${item.datesText}`], LABEL_PADDING);
              const offersAdd = isGap && addLabelWidth + 2 * LABEL_PADDING <= block.width;
              return (
                <li key={item.key} className="absolute inset-y-0" style={{ left: block.x, width: block.width }}>
                  <BlockTooltip content={<SegmentDetails segment={segment} datesText={item.datesText} nowMs={nowMs} scenario={scenario} hasUsage={hasUsage} />}>
                    <button
                      type="button"
                      onClick={item.activate}
                      aria-label={item.accessibleName}
                      tabIndex={compact ? -1 : undefined}
                      style={isGap ? undefined : ({ '--plan': planColor(segment.planKey) } as CSSProperties)}
                      className={cn(
                        'group flex size-full flex-col justify-center rounded-[5px] text-left transition-colors focus-visible:-outline-offset-2',
                        (fit !== 'none' || offersAdd) && 'px-2.5',
                        isGap
                          ? 'border border-dashed border-line-strong hover:bg-raised focus-visible:bg-raised'
                          : 'border-t-[3px] border-[var(--plan)] bg-[color-mix(in_srgb,var(--plan)_17%,var(--color-surface))] hover:bg-[color-mix(in_srgb,var(--plan)_27%,var(--color-surface))] focus-visible:bg-[color-mix(in_srgb,var(--plan)_27%,var(--color-surface))]',
                      )}
                    >
                      {fit !== 'none' ? (
                        <span className={cn('flex flex-col', offersAdd && 'group-hover:hidden group-focus-visible:hidden')}>
                          <span className={cn(NAME_TEXT, isGap ? 'text-ink-2' : 'text-ink')}>{segment.label}</span>
                          {fit === 'full' ? <span className={cn(DATES_TEXT, isGap ? 'text-ink-3' : 'text-ink-2')}>{item.datesText}</span> : null}
                        </span>
                      ) : isGap && block.width >= 28 ? (
                        <Plus className={cn('mx-auto size-3.5 text-ink-3', offersAdd && 'group-hover:hidden group-focus-visible:hidden')} aria-hidden="true" />
                      ) : null}
                      {offersAdd ? (
                        <span className={cn(NAME_TEXT, 'hidden items-center gap-1.5 text-ink group-hover:flex group-focus-visible:flex')}>
                          <Plus className="size-3.5" aria-hidden="true" />
                          {ADD_HERE}
                        </span>
                      ) : null}
                    </button>
                  </BlockTooltip>
                </li>
              );
            })}
          </ol>

          <div className="relative h-7 text-xs" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick.ms} className={cn('absolute top-0 w-px', tick.major ? 'h-2 bg-ink-3' : 'h-1.5 bg-line-strong')} style={{ left: tick.x }} />
            ))}
            {!todayAtEnd && firstBlock ? <span className="absolute top-0 h-2 w-px bg-ink-2" style={{ left: todayX }} /> : null}
            {axisLabels.map((label) => (
              <span
                key={`${label.anchor}:${label.x}:${label.text}`}
                className={cn('tabular absolute top-3 whitespace-nowrap leading-4', label.major ? 'text-ink-2' : 'text-ink-3')}
                style={
                  label.anchor === 'start'
                    ? { left: label.x }
                    : label.anchor === 'end'
                      ? { right: layout.width - label.x }
                      : { left: label.x, transform: 'translateX(-50%)' }
                }
              >
                {label.text}
              </span>
            ))}
          </div>

          {markerX !== null ? (
            <span aria-hidden="true" className="pointer-events-none absolute top-1 h-[74px] w-0.5 rounded-full bg-ink-2" style={{ left: Math.max(0, markerX - 1) }} />
          ) : null}
        </div>
      </div>

      {compact ? (
        <ol className="mt-2 divide-y divide-line border-t border-line" aria-label="Periods and unrecorded stretches, oldest first">
          {items.map((item) => {
            const isGap = item.segment.kind === 'gap';
            return (
              <li key={item.key}>
                <button type="button" onClick={item.activate} aria-label={item.accessibleName} className="flex min-h-11 w-full items-center gap-3 py-2 text-left">
                  <PlanSwatch planKey={item.segment.planKey} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-[13px]', isGap ? 'text-ink-2' : 'font-medium text-ink')}>{item.segment.label}</span>
                    <span className="block text-xs text-ink-3">{item.datesText}</span>
                  </span>
                  <span className="tabular shrink-0 text-xs text-ink-2">{plural(item.segment.days, 'day')}</span>
                  {isGap ? <Plus className="size-4 shrink-0 text-ink-3" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
