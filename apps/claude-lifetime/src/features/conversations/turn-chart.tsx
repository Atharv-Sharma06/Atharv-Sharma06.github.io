'use client';

import { useId } from 'react';
import { Bar, BarStack, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Swatch, type ChartSeries } from '@/components/charts/series-chart';
import { formatAxis, formatInstant, formatInt } from '@/lib/format';
import { MessageTime } from './confidence-mark';
import type { Turn } from './growth';

/** The tooltip of a turn whose start the source does not record. */
const INFERRED_TURN_HINT =
  'Inferred: the source records no time for the first message of this turn. The time shown is borrowed from the nearest message that has one, or from the conversation itself.';

/**
 * Tokens per turn of a chat. It follows SeriesChart mark for mark (thin stacked bars,
 * hairline grid, hatched estimates); it exists separately because its axis counts
 * turns, and SeriesChart's axis is built for calendar buckets.
 */
export type TurnSeriesKey = 'input' | 'output' | 'replay';
export type TurnSeries = ChartSeries & { key: TurnSeriesKey };

interface TooltipEntry {
  dataKey?: unknown;
  value?: unknown;
}

function TurnTooltip({
  active,
  payload,
  label,
  series,
  turns,
  timezone,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: string | number;
  series: TurnSeries[];
  turns: Turn[];
  timezone: string;
}) {
  if (!active || !payload || payload.length === 0 || label === undefined) return null;
  const turn = turns.find((t) => t.turn === Number(label));
  const values = new Map<string, number>();
  for (const p of payload) values.set(String(p.dataKey), Number(p.value) || 0);
  const shown = series.filter((s) => values.has(s.key));
  const total = shown.reduce((sum, s) => sum + (values.get(s.key) ?? 0), 0);
  return (
    <div className="min-w-[12rem] rounded-[10px] border border-line-strong bg-raised px-3 py-2.5 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.5)]">
      <p className="font-medium text-ink">Turn {label}</p>
      {turn?.at ? (
        <p className="text-ink-3">
          {formatInstant(turn.at, timezone, 'datetime')}
          {turn.atInferred ? ', inferred' : ''}
        </p>
      ) : null}
      <ul className="mt-1.5 space-y-1">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-4 text-ink-2">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Swatch series={s} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="tabular text-ink">{formatInt(values.get(s.key) ?? 0)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 flex items-center justify-between gap-4 border-t border-line pt-1.5 text-ink-2">
        <span>{shown.length > 1 ? 'Total estimated tokens' : 'Estimated tokens'}</span>
        <span className="tabular font-medium text-ink">{formatInt(total)}</span>
      </p>
    </div>
  );
}

export function TurnChart({ turns, series, timezone, ariaLabel, height = 300 }: { turns: Turn[]; series: TurnSeries[]; timezone: string; ariaLabel: string; height?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const patternId = (i: number) => `turn-hatch-${uid}-${i}`;
  const dense = turns.length > 70;

  return (
    <div role="img" aria-label={ariaLabel} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={turns} margin={{ top: 8, right: 4, bottom: 18, left: 0 }} barCategoryGap={dense ? 0 : '18%'} accessibilityLayer={false}>
          <defs>
            {series.map((s, i) =>
              s.estimated ? (
                <pattern key={s.key} id={patternId(i)} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill={s.color} opacity={0.42} />
                  <rect width="1.5" height="6" fill={s.color} opacity={0.95} />
                </pattern>
              ) : null,
            )}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--color-line)" />
          <XAxis
            dataKey="turn"
            tick={{ fill: 'var(--color-ink-3)', fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-line-strong)' }}
            minTickGap={22}
            tickMargin={8}
            interval="preserveStartEnd"
            label={{ value: 'Turn', position: 'insideBottom', offset: -12, fill: 'var(--color-ink-3)', fontSize: 12 }}
          />
          <YAxis tickFormatter={(v: number) => formatAxis(v)} tick={{ fill: 'var(--color-ink-3)', fontSize: 12 }} tickLine={false} axisLine={false} width={46} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: 'rgb(255 255 255 / 0.05)' }}
            isAnimationActive={false}
            offset={14}
            wrapperStyle={{ outline: 'none', zIndex: 10 }}
            content={(props) => (
              <TurnTooltip active={props.active} payload={props.payload as readonly TooltipEntry[]} label={props.label} series={series} turns={turns} timezone={timezone} />
            )}
          />
          <BarStack radius={[4, 4, 0, 0]}>
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.estimated ? `url(#${patternId(i)})` : s.color}
                maxBarSize={24}
                isAnimationActive={false}
                stroke={dense ? undefined : 'var(--color-surface)'}
                strokeWidth={dense ? 0 : 1}
              />
            ))}
          </BarStack>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The same numbers as a table, first turn first. */
export function TurnTable({ turns, series, timezone }: { turns: Turn[]; series: TurnSeries[]; timezone: string }) {
  return (
    <div className="scrollbar-thin max-h-[22rem] overflow-auto rounded-[var(--radius-control)] border border-line">
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead className="sticky top-0 bg-raised text-left text-xs text-ink-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Turn
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Started
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">
                {s.label}
              </th>
            ))}
            {series.length > 1 ? (
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Total
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {turns.map((turn) => (
            <tr key={turn.turn} className="border-t border-line">
              <th scope="row" className="tabular px-3 py-1.5 text-left font-normal text-ink-2">
                {turn.turn}
              </th>
              <td className="whitespace-nowrap px-3 py-1.5 text-ink-2">
                <MessageTime at={turn.at} inferred={turn.atInferred} timezone={timezone} hint={INFERRED_TURN_HINT} />
              </td>
              {series.map((s) => (
                <td key={s.key} className="tabular px-3 py-1.5 text-right text-ink">
                  {formatInt(turn[s.key])}
                </td>
              ))}
              {series.length > 1 ? <td className="tabular px-3 py-1.5 text-right text-ink">{formatInt(series.reduce((sum, s) => sum + turn[s.key], 0))}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
