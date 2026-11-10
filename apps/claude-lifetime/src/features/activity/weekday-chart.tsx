'use client';

import { ChartCard } from '@/components/charts/chart-card';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/overlay';
import { daysBetween, formatDecimal, formatInt, formatTokens, plural } from '@/lib/format';
import { METRIC_NOUN, METRIC_OPTIONS, quantity, type DaySpan, type Metric, type WeekdayAverage } from './activity-model';

/** Averages of small counts keep one decimal; large ones are shortened like every other figure. */
function formatAverage(value: number): string {
  return value >= 100 ? formatTokens(value) : formatDecimal(value, 1);
}

/**
 * Seven bars, Monday to Sunday: the average of the chosen metric on each weekday of the
 * selected year. Only days inside the recorded history are averaged over, so a year
 * that is still running is not diluted by days that have not happened.
 */
export function WeekdayChart({
  rows,
  metric,
  year,
  span,
  className,
}: {
  rows: WeekdayAverage[];
  metric: Metric;
  year: number;
  /** The days of the year that are averaged over. */
  span: DaySpan;
  className?: string;
}) {
  const noun = METRIC_NOUN[metric].many;
  const title = METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? '';
  const max = Math.max(0, ...rows.map((r) => r.average ?? 0));
  const whole = span.days === daysBetween(`${year}-01-01`, `${year}-12-31`);
  return (
    <ChartCard
      className={className}
      title={`${title} by weekday`}
      description={
        `Average ${noun} per day on each weekday of ${year}` +
        (whole ? '.' : `, over the ${formatInt(span.days)} days of the year inside your recorded history.`) +
        (metric === 'tokens' ? ' Exact and estimated tokens are added together.' : '')
      }
    >
      {(view) =>
        view === 'chart' ? (
          <div>
            {/* On wide screens the card stands beside the monthly table; the taller plot lets the two end level. */}
            <div role="list" aria-label={`Average ${noun} per day by weekday, ${year}`} className="flex h-56 items-end gap-1 border-b border-line-strong sm:gap-2 lg:h-[22rem]">
              {rows.map((r) => (
                <Tooltip
                  key={r.weekday}
                  content={
                    r.average === null
                      ? `No ${r.label} of ${year} lies inside your recorded history.`
                      : `${r.label}s: ${quantity(r.total, metric)} over ${plural(r.days, 'day')}, ${formatAverage(r.average)} a day on average.`
                  }
                >
                  <div
                    role="listitem"
                    aria-label={r.average === null ? `${r.label}: not available` : `${r.label}: ${formatAverage(r.average)} ${noun} a day on average`}
                    className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                  >
                    <span className="tabular mb-1.5 h-4 text-xs leading-4 text-ink-2 group-hover:text-ink">{r.average === null ? '–' : formatAverage(r.average)}</span>
                    <div
                      className="w-full max-w-6 rounded-t-[4px] bg-accent group-hover:bg-accent-soft"
                      style={{ height: r.average && max > 0 ? `max(2px, calc((100% - 1.375rem) * ${r.average / max}))` : 0 }}
                    />
                  </div>
                </Tooltip>
              ))}
            </div>
            <div aria-hidden="true" className="mt-2 flex gap-1 text-xs text-ink-3 sm:gap-2">
              {rows.map((r) => (
                <span key={r.weekday} className="min-w-0 flex-1 text-center">
                  {r.label.slice(0, 3)}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <Th>Weekday</Th>
                  <Th align="right">Average a day</Th>
                  <Th align="right">Days</Th>
                  <Th align="right">Total</Th>
                </tr>
              </THead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.weekday}>
                    <th scope="row" className="px-3 py-2 text-left font-normal text-ink">
                      {r.label}
                    </th>
                    <Td numeric>{r.average === null ? '–' : formatAverage(r.average)}</Td>
                    <Td numeric>{formatInt(r.days)}</Td>
                    <Td numeric>{formatInt(r.total)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        )
      }
    </ChartCard>
  );
}
