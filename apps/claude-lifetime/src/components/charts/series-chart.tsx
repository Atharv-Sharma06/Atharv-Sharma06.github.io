'use client';

import { useId } from 'react';
import { Area, Bar, BarStack, Brush, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Granularity } from '@/analytics/base';
import { cn } from '@/lib/cn';
import { formatAxis, formatTokens } from '@/lib/format';
import { bucketLabel, bucketTick, type ChartRow, type RangeCut } from '@/lib/series';

/**
 * One series of a chart. Colour identifies the entity and is taken from the fixed
 * categorical palette (see globals.css); `estimated` switches the mark to the lighter,
 * hatched treatment that means "estimated" everywhere in the app.
 */
export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  estimated?: boolean;
}

/** The categorical palette in its fixed order. Never cycle or reorder it. */
export const SERIES_COLORS = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
  'var(--color-series-6)',
  'var(--color-series-7)',
  'var(--color-series-8)',
] as const;
export const NEUTRAL_SERIES_COLOR = 'var(--color-series-none)';

export function Swatch({ series, className }: { series: Pick<ChartSeries, 'color' | 'estimated'>; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2.5 shrink-0 rounded-[3px]', series.estimated && 'hatch-estimated', className)}
      style={{ backgroundColor: series.estimated ? `color-mix(in srgb, ${series.color} 45%, transparent)` : series.color }}
    />
  );
}

export function ChartLegend({ series, className }: { series: ChartSeries[]; className?: string }) {
  if (series.length < 2) return null;
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-2', className)}>
      {series.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <Swatch series={s} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

interface TooltipEntry {
  dataKey?: unknown;
  value?: unknown;
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
  granularity,
  cut,
  formatValue,
  unit,
  showTotal,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: string | number;
  series: ChartSeries[];
  granularity: Granularity;
  cut?: RangeCut | null;
  formatValue: (n: number) => string;
  unit: string;
  showTotal: boolean;
}) {
  if (!active || !payload || payload.length === 0 || label === undefined) return null;
  const values = new Map<string, number>();
  for (const p of payload) values.set(String(p.dataKey), Number(p.value) || 0);
  const shown = series.filter((s) => values.has(s.key));
  const total = shown.reduce((sum, s) => sum + (values.get(s.key) ?? 0), 0);
  return (
    <div className="min-w-[11rem] rounded-[10px] border border-line-strong bg-raised px-3 py-2.5 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.5)]">
      <p className="mb-1.5 font-medium text-ink">{bucketLabel(String(label), granularity, cut)}</p>
      <ul className="space-y-1">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Swatch series={s} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="tabular text-ink">{formatValue(values.get(s.key) ?? 0)}</span>
          </li>
        ))}
      </ul>
      {showTotal && shown.length > 1 ? (
        <p className="mt-1.5 flex items-center justify-between gap-4 border-t border-line pt-1.5 text-ink-2">
          <span>Total {unit}</span>
          <span className="tabular font-medium text-ink">{formatValue(total)}</span>
        </p>
      ) : shown.length === 1 ? (
        <p className="mt-1 text-ink-3">{unit}</p>
      ) : null}
    </div>
  );
}

export interface SeriesChartProps {
  rows: ChartRow[];
  series: ChartSeries[];
  granularity: Granularity;
  /** bar: stacked bars per bucket. area: stacked areas (running totals). line: one line per series, not stacked. */
  kind?: 'bar' | 'area' | 'line';
  height?: number;
  formatValue?: (n: number) => string;
  /** What the values are, for the tooltip: "tokens", "messages", "USD". */
  unit?: string;
  /** Adds a range slider under the plot to zoom into part of the series. */
  zoomable?: boolean;
  /** Accessible description of what the chart shows. */
  ariaLabel: string;
  /** Where the selected range cuts into recorded usage, so that a partial week, month or year is named as one. */
  cut?: RangeCut | null;
}

export function SeriesChart({
  rows,
  series,
  granularity,
  kind = 'bar',
  height = 300,
  formatValue = formatTokens,
  unit = 'tokens',
  zoomable = false,
  ariaLabel,
  cut,
}: SeriesChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const patternId = (i: number) => `hatch-${uid}-${i}`;
  const fillOf = (s: ChartSeries, i: number) => (s.estimated ? `url(#${patternId(i)})` : s.color);
  // Few bars get a gap and a hairline in the surface colour between stacked segments; many bars get
  // thinner gaps, and a great many are drawn edge to edge so they read as one shape.
  const sparse = rows.length <= 60;
  const dense = rows.length > 160;
  const showBrush = zoomable && rows.length > 12;
  const multiYear = rows.length > 1 && rows[0].bucket.slice(0, 4) !== rows[rows.length - 1].bucket.slice(0, 4);

  return (
    <div role="img" aria-label={ariaLabel} style={{ height: height + (showBrush ? 44 : 0) }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap={dense ? 0 : sparse ? '18%' : '12%'} accessibilityLayer={false}>
          <defs>
            {series.map((s, i) =>
              s.estimated ? (
                <pattern key={s.key} id={patternId(i)} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill={s.color} opacity={kind === 'area' ? 0.16 : 0.42} />
                  <rect width="1.5" height="6" fill={s.color} opacity={kind === 'area' ? 0.5 : 0.95} />
                </pattern>
              ) : null,
            )}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--color-line)" />
          <XAxis
            dataKey="bucket"
            tickFormatter={(b: string) => bucketTick(b, granularity, multiYear)}
            tick={{ fill: 'var(--color-ink-3)', fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-line-strong)' }}
            minTickGap={28}
            tickMargin={8}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v: number) => formatAxis(v)}
            tick={{ fill: 'var(--color-ink-3)', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={46}
            allowDecimals={false}
          />
          <Tooltip
            cursor={kind === 'bar' ? { fill: 'rgb(255 255 255 / 0.05)' } : { stroke: 'var(--color-line-strong)', strokeWidth: 1 }}
            isAnimationActive={false}
            offset={14}
            wrapperStyle={{ outline: 'none', zIndex: 10 }}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                payload={props.payload as readonly TooltipEntry[]}
                label={props.label}
                series={series}
                granularity={granularity}
                cut={cut}
                formatValue={formatValue}
                unit={unit}
                showTotal={kind !== 'line'}
              />
            )}
          />
          {kind === 'bar' ? (
            <BarStack radius={[4, 4, 0, 0]}>
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  fill={fillOf(s, i)}
                  maxBarSize={24}
                  isAnimationActive={false}
                  stroke={sparse ? 'var(--color-surface)' : undefined}
                  strokeWidth={sparse ? 1 : 0}
                />
              ))}
            </BarStack>
          ) : null}
          {kind === 'area'
            ? series.map((s, i) => (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId="stack"
                  type="monotone"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.estimated ? '5 4' : undefined}
                  fill={s.estimated ? `url(#${patternId(i)})` : s.color}
                  fillOpacity={s.estimated ? 1 : 0.14}
                  isAnimationActive={false}
                  activeDot={{ r: 4, stroke: 'var(--color-surface)', strokeWidth: 2 }}
                />
              ))
            : null}
          {kind === 'line'
            ? series.map((s) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  type="monotone"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.estimated ? '5 4' : undefined}
                  dot={false}
                  isAnimationActive={false}
                  activeDot={{ r: 4, stroke: 'var(--color-surface)', strokeWidth: 2 }}
                />
              ))
            : null}
          {showBrush ? (
            <Brush
              dataKey="bucket"
              height={28}
              travellerWidth={9}
              stroke="var(--color-ink-3)"
              fill="var(--color-page)"
              tickFormatter={(b: string) => bucketTick(b, granularity, multiYear)}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The same numbers as a table: every chart offers this view. */
export function SeriesTable({
  rows,
  series,
  granularity,
  formatValue = formatTokens,
  showTotal = true,
  className,
  cut,
}: {
  rows: ChartRow[];
  series: ChartSeries[];
  granularity: Granularity;
  /** Where the selected range cuts into recorded usage (see SeriesChartProps). */
  cut?: RangeCut | null;
  formatValue?: (n: number) => string;
  showTotal?: boolean;
  className?: string;
}) {
  const newestFirst = [...rows].reverse();
  return (
    <div className={cn('scrollbar-thin max-h-[22rem] overflow-auto rounded-[var(--radius-control)] border border-line', className)}>
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead className="sticky top-0 bg-raised text-left text-xs text-ink-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Period
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">
                {s.label}
              </th>
            ))}
            {showTotal && series.length > 1 ? (
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Total
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {newestFirst.map((row) => {
            const total = series.reduce((sum, s) => sum + (Number(row[s.key]) || 0), 0);
            return (
              <tr key={row.bucket} className="border-t border-line">
                <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-normal text-ink-2">
                  {bucketLabel(row.bucket, granularity, cut)}
                </th>
                {series.map((s) => (
                  <td key={s.key} className="tabular px-3 py-1.5 text-right text-ink">
                    {formatValue(Number(row[s.key]) || 0)}
                  </td>
                ))}
                {showTotal && series.length > 1 ? <td className="tabular px-3 py-1.5 text-right text-ink">{formatValue(total)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
