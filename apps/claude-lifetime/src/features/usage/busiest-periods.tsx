'use client';

import type { Granularity } from '@/analytics/base';
import type { SeriesPoint } from '@/analytics/overview';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { formatInt } from '@/lib/format';
import { bucketLabel, type RangeCut } from '@/lib/series';
import { UNIT } from './usage-model';

/**
 * A count that not every source records. Usage reports carry tokens but no messages or
 * conversations, so a zero next to real token usage means "not recorded", not "none".
 */
function Recorded({ count }: { count: number }) {
  if (count > 0) return <>{formatInt(count)}</>;
  return (
    <span className="text-ink-3" title="Not recorded by the sources of this period">
      –
    </span>
  );
}

/** The largest buckets of the selected range at the chart's granularity, with their full figures. */
export function BusiestPeriods({ points, granularity, cut }: { points: SeriesPoint[]; granularity: Granularity; cut?: RangeCut | null }) {
  const unit = UNIT[granularity];
  const unrecorded = points.some((p) => p.messages === 0 || p.conversations === 0);
  return (
    <section aria-labelledby="busiest-periods" className="pt-4">
      <h2 id="busiest-periods" className="text-[15px] font-medium text-ink">
        Busiest periods
      </h2>
      <p className="mt-0.5 text-[13px] text-ink-2">
        {points.length < 10
          ? `Every ${unit.one} with usage in this range, largest first.`
          : `The ten ${unit.many} with the most tokens in this range.`}
      </p>
      <TableFrame className="mt-3 bg-surface">
        <Table className="min-w-[44rem]">
          <THead>
            <tr>
              <Th className="w-10 pr-0 text-ink-3">
                <span className="sr-only">Rank</span>
              </Th>
              <Th>{unit.one.charAt(0).toUpperCase() + unit.one.slice(1)}</Th>
              <Th align="right">Tokens</Th>
              <Th align="right">Exact</Th>
              <Th align="right">Estimated</Th>
              <Th align="right">Messages</Th>
              <Th align="right">Conversations</Th>
            </tr>
          </THead>
          <tbody>
            {points.map((p, i) => (
              <Tr key={p.bucket}>
                <Td numeric className="w-10 pr-0 text-ink-3">
                  {i + 1}
                </Td>
                <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal text-ink">
                  {bucketLabel(p.bucket, granularity, cut)}
                </th>
                <Td numeric className="font-medium">
                  {formatInt(p.tokens)}
                </Td>
                <Td numeric className={p.exact === 0 ? 'text-ink-3' : undefined}>
                  {formatInt(p.exact)}
                </Td>
                <Td numeric className={p.estimated === 0 ? 'text-ink-3' : undefined}>
                  {formatInt(p.estimated)}
                </Td>
                <Td numeric>
                  <Recorded count={p.messages} />
                </Td>
                <Td numeric>
                  <Recorded count={p.conversations} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableFrame>
      {unrecorded ? (
        <p className="mt-2 text-xs text-ink-3">
          A dash means the sources for that period record no messages or conversations. Usage reports, for example, carry tokens only.
        </p>
      ) : null}
    </section>
  );
}
