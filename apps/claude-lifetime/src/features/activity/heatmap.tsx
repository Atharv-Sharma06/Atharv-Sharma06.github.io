'use client';

import { useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { SeriesPoint } from '@/analytics/overview';
import { InfoTip, Tooltip } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import { addDays, formatDay, formatInt, formatTokens, plural } from '@/lib/format';
import {
  bandLabel,
  buildCalendar,
  isInside,
  metricRecorded,
  levelOf,
  METRIC_NOUN,
  METRIC_OPTIONS,
  rampStep,
  valueOf,
  type CalendarDay,
  type History,
  type Metric,
  type Scale,
} from './activity-model';

const GAP = 3;
const MIN_CELL = 12;
const MAX_CELL = 15;
/** Width of the weekday labels to the left of the grid, including the space after them. */
const GUTTER = 36;
/** Space kept free around the grid inside its scroll frame, so the focus ring of an edge square is not cut off. */
const RING = 3;
const TIP_WIDTH = 224;
/** Room a tooltip needs above a square before it would slide under the sticky top bar. */
const TIP_CLEARANCE = 190;

/**
 * The sequential ramp, from "no recorded activity" to the busiest level. Written out in
 * full: the stylesheet only contains the colour tokens whose names appear in the source.
 */
const RAMP = ['bg-seq-0', 'bg-seq-1', 'bg-seq-2', 'bg-seq-3', 'bg-seq-4', 'bg-seq-5'] as const;

/** The largest whole-pixel square that fits every week side by side in `box`, within the size a calendar square should have. */
function useCellSize(box: RefObject<HTMLDivElement | null>, weeks: number): number {
  const [cell, setCell] = useState(13);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setCell(Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((el.clientWidth - GUTTER - RING + GAP) / weeks) - GAP)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box, weeks]);
  return cell;
}

/** `unrecorded`: the day has usage, but its source does not record the metric that is shown. */
type DayState = 'recorded' | 'unrecorded' | 'empty' | 'before' | 'after';

function stateOf(history: History, day: string, point: SeriesPoint | undefined, metric: Metric): DayState {
  if (day < history.first) return 'before';
  if (!isInside(history, day)) return 'after';
  if (!point) return 'empty';
  return metricRecorded(point, metric) ? 'recorded' : 'unrecorded';
}

/** "3 messages", or "messages not recorded" for a day that has usage and no count: its source holds tokens only. */
function countWords(point: SeriesPoint, metric: 'messages' | 'conversations'): string {
  const noun = METRIC_NOUN[metric];
  return metricRecorded(point, metric) ? plural(point[metric], noun.one) : `${noun.many} not recorded`;
}

function tokenWords(point: SeriesPoint): string {
  if (point.tokens === 0) return 'no tokens';
  const total = `${formatTokens(point.tokens)} tokens`;
  if (point.exact > 0 && point.estimated > 0) return `${total}, ${formatTokens(point.exact)} exact and ${formatTokens(point.estimated)} estimated`;
  return `${total}, ${point.estimated > 0 ? 'estimated' : 'exact'}`;
}

/** What a square says to a screen reader: the same facts the tooltip shows. */
function describeDay(day: string, state: DayState, point: SeriesPoint | undefined, history: History): string {
  const date = formatDay(day, 'weekday');
  if (state === 'before') return `${date}: before your first record on ${formatDay(history.first)}`;
  if (state === 'after') return `${date}: after your last record on ${formatDay(history.last)}`;
  if (!point) return `${date}: no recorded activity`;
  return `${date}: ${tokenWords(point)}; ${countWords(point, 'conversations')}; ${countWords(point, 'messages')}`;
}

function TipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-2">{label}</dt>
      <dd className="tabular text-ink">{children}</dd>
    </div>
  );
}

function DayTip({ day, state, point, history }: { day: string; state: DayState; point: SeriesPoint | undefined; history: History }) {
  return (
    <>
      <p className="font-medium text-ink">{formatDay(day, 'weekday')}</p>
      {state === 'before' ? (
        <p className="mt-1 text-ink-2">Before your first record on {formatDay(history.first)}. Nothing is known about this day.</p>
      ) : state === 'after' ? (
        <p className="mt-1 text-ink-2">After your last record on {formatDay(history.last)}. Nothing is imported for this day.</p>
      ) : !point ? (
        <p className="mt-1 text-ink-2">No recorded activity</p>
      ) : (
        <dl className="mt-1.5 space-y-1">
          <TipRow label={point.exact > 0 && point.estimated > 0 ? 'Tokens' : point.estimated > 0 ? 'Tokens, estimated' : point.tokens > 0 ? 'Tokens, exact' : 'Tokens'}>
            {formatTokens(point.tokens)}
          </TipRow>
          {point.exact > 0 && point.estimated > 0 ? (
            <>
              <div className="flex items-baseline justify-between gap-4 pl-3">
                <dt className="inline-flex items-center gap-1.5 text-ink-2">
                  <span className="size-2 rounded-[2px] bg-accent" aria-hidden="true" />
                  Exact
                </dt>
                <dd className="tabular text-ink-2">{formatTokens(point.exact)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 pl-3">
                <dt className="inline-flex items-center gap-1.5 text-ink-2">
                  <span className="hatch-estimated size-2 rounded-[2px] bg-accent/45" aria-hidden="true" />
                  Estimated
                </dt>
                <dd className="tabular text-ink-2">{formatTokens(point.estimated)}</dd>
              </div>
            </>
          ) : null}
          <TipRow label="Conversations">
            {point.conversations > 0 ? formatInt(point.conversations) : <span className="text-ink-3">{point.tokens > 0 ? 'Not recorded' : 'None'}</span>}
          </TipRow>
          <TipRow label="Messages">{point.messages > 0 ? formatInt(point.messages) : <span className="text-ink-3">{point.tokens > 0 ? 'Not recorded' : 'None'}</span>}</TipRow>
        </dl>
      )}
    </>
  );
}

interface Tip {
  day: string;
  /** Position inside the heatmap's own box. */
  x: number;
  y: number;
  below: boolean;
}

/**
 * One calendar year, a square per day: weeks run left to right, weekdays top to bottom
 * from Monday. Days inside the recorded history are filled, brighter with more activity;
 * days before the first record or after the last are only outlined, because nothing is
 * known about them.
 */
export function Heatmap({ history, year, metric, scale }: { history: History; year: number; metric: Metric; scale: Scale | null }) {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const calendar = useMemo(() => buildCalendar(year), [year]);
  const cell = useCellSize(root, calendar.weeks);
  const pitch = cell + GAP;
  const gridWidth = calendar.weeks * pitch - GAP;
  const levels = scale ? scale.thresholds.length + 1 : 0;

  // The most recent day of this year that the history covers: where the eye, the keyboard and the scroll position start.
  const latest = useMemo(() => {
    const inside = calendar.days.filter((d) => isInside(history, d.day));
    return inside[inside.length - 1] ?? calendar.days[0];
  }, [calendar, history]);

  const [focused, setFocused] = useState<string | null>(null);
  const [hoverTip, setHoverTip] = useState<Tip | null>(null);
  const [focusTip, setFocusTip] = useState<Tip | null>(null);
  const current = focused && focused.startsWith(`${year}-`) ? focused : latest.day;

  // A narrow screen cannot show 53 weeks at once: start at the most recent ones.
  useLayoutEffect(() => {
    const el = frame.current;
    if (el) el.scrollLeft = (latest.week + 2) * pitch - el.clientWidth;
  }, [latest.week, pitch, year]);

  const place = (el: HTMLElement): Tip | null => {
    const box = root.current?.getBoundingClientRect();
    const view = frame.current?.getBoundingClientRect();
    const day = el.dataset.day;
    if (!box || !view || !day) return null;
    const r = el.getBoundingClientRect();
    // A square that has been scrolled out of the frame has nothing to point at.
    if (r.right < view.left || r.left > view.right) return null;
    const half = TIP_WIDTH / 2 + 8;
    const centre = Math.max(half, Math.min(window.innerWidth - half, r.left + r.width / 2));
    const below = r.top < TIP_CLEARANCE;
    return { day, x: centre - box.left, y: (below ? r.bottom + 8 : r.top - 8) - box.top, below };
  };
  const cellOf = (target: EventTarget) => (target instanceof HTMLElement ? target.closest<HTMLElement>('[data-day]') : null);

  const onPointerOver = (e: PointerEvent) => {
    // A finger has no hover; a tap focuses the square instead and the tooltip stays until it loses focus.
    if (e.pointerType === 'touch') return;
    const el = cellOf(e.target);
    setHoverTip(el ? place(el) : null);
  };
  const onClick = (e: MouseEvent) => cellOf(e.target)?.focus();
  const onFocus = (e: FocusEvent) => {
    const el = cellOf(e.target);
    if (!el) return;
    setFocused(el.dataset.day ?? null);
    setFocusTip(place(el));
  };
  const onBlur = () => setFocusTip(null);
  const onScroll = () => {
    setHoverTip(null);
    const el = document.activeElement;
    if (el instanceof HTMLElement && frame.current?.contains(el)) setFocusTip(place(el));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const el = cellOf(e.target);
    const day = el?.dataset.day;
    if (!day) return;
    const first = `${year}-01-01`;
    const last = `${year}-12-31`;
    // Left and right move a week, up and down a day, like the grid reads.
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    const next = step !== undefined ? addDays(day, step) : e.key === 'Home' ? first : e.key === 'End' ? last : null;
    if (!next) return;
    e.preventDefault();
    const clamped = next < first ? first : next > last ? last : next;
    frame.current?.querySelector<HTMLElement>(`[data-day="${clamped}"]`)?.focus();
  };

  const rows = useMemo(() => {
    const byWeekday: Array<Array<CalendarDay | undefined>> = Array.from({ length: 7 }, () => new Array<CalendarDay | undefined>(calendar.weeks).fill(undefined));
    for (const d of calendar.days) byWeekday[d.weekday][d.week] = d;
    return byWeekday.map((row, weekday) => (
      <div role="row" key={weekday} className="flex" style={{ gap: GAP }}>
        {row.map((d, week) => {
          if (!d) return <span key={week} aria-hidden="true" className="shrink-0" style={{ width: cell, height: cell }} />;
          const point = history.days.get(d.day);
          const state = stateOf(history, d.day, point, metric);
          const outside = state === 'before' || state === 'after';
          const step = rampStep(levelOf(valueOf(point, metric), scale), levels);
          return (
            <div
              key={week}
              role="gridcell"
              data-day={d.day}
              tabIndex={d.day === current ? 0 : -1}
              aria-label={describeDay(d.day, state, point, history)}
              className={cn(
                'shrink-0 rounded-[3px] outline-offset-1 hover:outline hover:outline-ink/70 focus:rounded-[3px] focus:outline-2 focus:outline-ink',
                // A dashed square: usage on that day, and no count of the metric to colour it by.
                outside ? 'border border-line-strong/75' : state === 'unrecorded' ? 'border border-dashed border-ink-3' : RAMP[step],
              )}
              style={{ width: cell, height: cell }}
            />
          );
        })}
      </div>
    ));
  }, [calendar, history, metric, scale, levels, cell, current]);

  const shownTip = hoverTip ?? focusTip;
  const tip = shownTip && shownTip.day.startsWith(`${year}-`) ? shownTip : null;
  const tipPoint = tip ? history.days.get(tip.day) : undefined;
  const hasOutside = calendar.days.some((d) => !isInside(history, d.day));
  const hasUnrecorded = calendar.days.some((d) => stateOf(history, d.day, history.days.get(d.day), metric) === 'unrecorded');
  const noun = METRIC_NOUN[metric].many;
  const title = METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? 'Activity';

  return (
    <div ref={root} className="relative">
      <div className="flex">
        <div aria-hidden="true" className="flex shrink-0 flex-col pt-6 text-xs text-ink-3" style={{ gap: GAP, width: GUTTER - RING }}>
          {['Mon', '', 'Wed', '', 'Fri', '', ''].map((label, i) => (
            <span key={i} className="flex items-center" style={{ height: cell }}>
              {label}
            </span>
          ))}
        </div>
        <div ref={frame} onScroll={onScroll} className="scrollbar-thin min-w-0 flex-1 overflow-x-auto pb-2">
          <div className="box-content" style={{ width: gridWidth, padding: `0 ${RING}px` }}>
            <div aria-hidden="true" className="relative h-6 text-xs text-ink-3">
              {calendar.months.map((m) => (
                <span key={m.label} className="absolute top-0.5" style={{ left: m.week * pitch }}>
                  {m.label}
                </span>
              ))}
            </div>
            <div
              role="grid"
              aria-label={`${title} per day in ${year}. Rows are weekdays from Monday, columns are weeks. Use the arrow keys to move between days.`}
              className="flex flex-col"
              style={{ gap: GAP }}
              onPointerOver={onPointerOver}
              onPointerLeave={() => setHoverTip(null)}
              onClick={onClick}
              onFocus={onFocus}
              onBlur={onBlur}
              onKeyDown={onKeyDown}
            >
              {rows}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-ink-2" style={{ maxWidth: GUTTER + gridWidth }}>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('rounded-[3px]', RAMP[0])} style={{ width: cell, height: cell }} />
            No recorded activity
          </li>
          {hasUnrecorded ? (
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="rounded-[3px] border border-dashed border-ink-3" style={{ width: cell, height: cell }} />
              Usage without recorded {noun}
            </li>
          ) : null}
          {hasOutside ? (
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="rounded-[3px] border border-line-strong/75" style={{ width: cell, height: cell }} />
              Outside your recorded history
            </li>
          ) : null}
        </ul>
        {scale ? (
          <div className="flex items-center gap-2">
            <span>Less</span>
            <ul className="flex" style={{ gap: GAP }}>
              {Array.from({ length: levels }, (_, i) => i + 1).map((level) => (
                <li key={level} className="flex">
                  <Tooltip content={`${bandLabel(scale, level, metric)} in a day`}>
                    <span
                      role="img"
                      aria-label={`Level ${level} of ${levels}: ${bandLabel(scale, level, metric)} in a day`}
                      className={cn('rounded-[3px]', RAMP[rampStep(level, levels)])}
                      style={{ width: cell, height: cell }}
                    />
                  </Tooltip>
                </li>
              ))}
            </ul>
            <span>More</span>
            <InfoTip label="How the colours are assigned" align="end">
              <p>
                Every day with recorded {noun} in your whole history is ranked, and the ranking is cut into {levels === 1 ? 'one band' : `${levels} bands`} that hold
                about the same number of days. A colour therefore means the same amount in every year.
              </p>
              <ul className="space-y-1.5">
                {Array.from({ length: levels }, (_, i) => i + 1).map((level) => (
                  <li key={level} className="flex items-center gap-2">
                    <span aria-hidden="true" className={cn('size-3 shrink-0 rounded-[3px]', RAMP[rampStep(level, levels)])} />
                    <span className="text-ink">{bandLabel(scale, level, metric)}</span>
                    <span className="ml-auto tabular text-ink-3">{plural(scale.counts[level - 1], 'day')}</span>
                  </li>
                ))}
              </ul>
            </InfoTip>
          </div>
        ) : null}
      </div>

      {tip ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 rounded-[10px] border border-line-strong bg-raised px-3 py-2.5 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.5)]"
          style={{ left: tip.x, top: tip.y, width: TIP_WIDTH, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}
        >
          <DayTip day={tip.day} state={stateOf(history, tip.day, tipPoint, metric)} point={tipPoint} history={history} />
        </div>
      ) : null}
    </div>
  );
}
