'use client';

import { Slider } from 'radix-ui';
import { useMemo, useRef, type PointerEvent } from 'react';
import type { Granularity } from '@/analytics/base';
import type { ChartSeries } from '@/components/charts/series-chart';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { formatDayRange, formatInt } from '@/lib/format';
import { bucketLabel, type ChartRow } from '@/lib/series';
import { bucketDays, UNIT, type DaySpan } from './usage-model';

/** A zoom narrower than this is a couple of lonely bars, not a chart. */
const MIN_BUCKETS = 2;

/**
 * The zoom control under the plot: a miniature of the whole selected range with a
 * window that can be resized from either end or dragged along. The chart above shows
 * the buckets inside the window.
 *
 * Built here rather than with the chart library's brush, whose handles announce
 * "Min value: undefined" to screen readers, cannot be reset and forget the window
 * whenever the bucket size changes.
 */
export function ZoomNavigator({
  rows,
  series,
  granularity,
  span,
  start,
  end,
  onChange,
}: {
  /** Every bucket of the selected range. */
  rows: ChartRow[];
  series: ChartSeries[];
  granularity: Granularity;
  span: DaySpan;
  /** The window: rows `start` up to, but not including, `end`. */
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
}) {
  const count = rows.length;
  const zoomed = start > 0 || end < count;
  const drag = useRef<{ x: number; start: number; end: number; slot: number } | null>(null);

  const heights = useMemo(() => {
    const totals = rows.map((row) => series.reduce((sum, s) => sum + (Number(row[s.key]) || 0), 0));
    const max = Math.max(1, ...totals);
    return totals.map((t) => (t > 0 ? Math.max(0.04, t / max) : 0));
  }, [rows, series]);

  const first = bucketDays(rows[start].bucket, granularity, span);
  const last = bucketDays(rows[end - 1].bucket, granularity, span);
  const unit = UNIT[granularity];

  // Dragging the window itself moves both ends together.
  const onWindowDown = (e: PointerEvent<HTMLSpanElement>) => {
    // Without this the slider would jump its nearest handle to the pointer.
    e.stopPropagation();
    const track = e.currentTarget.parentElement;
    if (!zoomed || !track) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start, end, slot: track.getBoundingClientRect().width / count };
  };
  const onWindowMove = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const shift = Math.max(-d.start, Math.min(count - d.end, Math.round((e.clientX - d.x) / d.slot)));
    if (d.start + shift !== start) onChange(d.start + shift, d.end + shift);
  };
  const onWindowUp = (e: PointerEvent<HTMLSpanElement>) => {
    if (!drag.current) return;
    e.stopPropagation();
    drag.current = null;
  };

  const thumb =
    'relative block h-6 w-2 cursor-ew-resize rounded-full border border-page bg-ink-2 hover:bg-ink before:absolute before:-inset-x-3 before:-inset-y-2 before:content-[""]';

  return (
    // Lines up with the plot area of the chart above: its y-axis is 46px wide.
    <div className="mt-3 pl-[46px] pr-1">
      <Slider.Root
        min={0}
        max={count}
        step={1}
        minStepsBetweenThumbs={Math.min(MIN_BUCKETS, count)}
        value={[start, end]}
        onValueChange={([a, b]) => onChange(a, b)}
        className="relative flex h-10 touch-none select-none items-center"
      >
        <Slider.Track className="relative h-full grow overflow-hidden rounded-[var(--radius-control)] border border-line bg-page">
          <svg viewBox={`0 0 ${count} 1`} preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 top-1 h-[calc(100%-0.25rem)] w-full" aria-hidden="true">
            {heights.map((h, i) =>
              h > 0 ? (
                <rect
                  key={rows[i].bucket}
                  x={count > 120 ? i : i + 0.15}
                  y={1 - h}
                  width={count > 120 ? 1 : 0.7}
                  height={h}
                  fill={i >= start && i < end ? 'var(--color-accent)' : 'var(--color-ink-3)'}
                  opacity={i >= start && i < end ? 0.8 : 0.4}
                />
              ) : null,
            )}
          </svg>
          <Slider.Range
            onPointerDown={onWindowDown}
            onPointerMove={onWindowMove}
            onPointerUp={onWindowUp}
            onPointerCancel={onWindowUp}
            className={cn('absolute h-full border-x border-accent/50 bg-accent/10', zoomed && 'cursor-grab active:cursor-grabbing')}
          />
        </Slider.Track>
        <Slider.Thumb className={thumb} aria-label="Start of the zoom window" aria-valuetext={`From ${bucketLabel(rows[start].bucket, granularity)}`} />
        <Slider.Thumb className={thumb} aria-label="End of the zoom window" aria-valuetext={`To ${bucketLabel(rows[end - 1].bucket, granularity)}`} />
      </Slider.Root>
      <div className="mt-2 flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[13px] text-ink-2">
        {zoomed ? (
          <>
            <p>
              Zoomed to <span className="text-ink">{formatDayRange(first.from, last.to)}</span>, {formatInt(end - start)} of {formatInt(count)} {unit.many}. The
              figures above and the table below still cover the whole range.
            </p>
            <Button variant="ghost" size="sm" onClick={() => onChange(0, count)}>
              Reset zoom
            </Button>
          </>
        ) : (
          <p className="text-xs text-ink-3">Drag the handles to zoom in, then drag the window to move along the range.</p>
        )}
      </div>
    </div>
  );
}
