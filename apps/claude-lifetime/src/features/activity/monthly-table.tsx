'use client';

import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { formatDay, formatInt } from '@/lib/format';
import { recordedCount, type History, type MonthRow } from './activity-model';

/**
 * The selected year as numbers: the accessible twin of the calendar. Months that lie
 * wholly outside the recorded history say so in words instead of showing zeros.
 */
export function MonthlyTable({
  rows,
  year,
  history,
  conversations,
  className,
}: {
  rows: MonthRow[];
  year: number;
  history: History;
  /** Conversations active in the year, each counted once. Not the sum of the months. */
  conversations: number;
  className?: string;
}) {
  const inside = rows.filter((r) => r.state === 'inside');
  const tokens = inside.reduce((sum, r) => sum + r.tokens, 0);
  const messages = inside.reduce((sum, r) => sum + r.messages, 0);
  const activeDays = inside.reduce((sum, r) => sum + r.activeDays, 0);
  const unrecorded = inside.some((r) => r.tokens > 0 && (r.messages === 0 || r.conversations === 0));
  const startsLater = rows.some((r) => r.state === 'before');
  return (
    <Card className={className}>
      <CardHeader title={`Monthly totals, ${year}`} description="The same year as numbers. Active days are days with at least one record." />
      <CardBody>
        <TableFrame>
          <Table className="min-w-[32rem]">
            <THead>
              <tr>
                <Th>Month</Th>
                <Th align="right">Tokens</Th>
                <Th align="right">Messages</Th>
                <Th align="right">Conversations</Th>
                <Th align="right">Active days</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.month}>
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-ink">
                    {r.label}
                  </th>
                  {r.state === 'inside' ? (
                    <>
                      <Td numeric className={cellClass(r.tokens)}>
                        {formatInt(r.tokens)}
                      </Td>
                      <Td numeric className={cellClass(r.messages)}>
                        {recordedCount(r.messages, r.tokens)}
                      </Td>
                      <Td numeric className={cellClass(r.conversations)}>
                        {recordedCount(r.conversations, r.tokens)}
                      </Td>
                      <Td numeric className={cellClass(r.activeDays)}>
                        {formatInt(r.activeDays)}
                      </Td>
                    </>
                  ) : (
                    <td colSpan={4} className="px-3 py-1.5 text-ink-3">
                      {r.state === 'before' ? 'Before your first record' : 'After your last record'}
                    </td>
                  )}
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <Tr className="border-line-strong bg-raised/60">
                <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                  {year}
                </th>
                <Td numeric className="font-medium">
                  {formatInt(tokens)}
                </Td>
                <Td numeric className="font-medium">
                  {recordedCount(messages, tokens)}
                </Td>
                <Td numeric className="font-medium">
                  {recordedCount(conversations, tokens)}
                </Td>
                <Td numeric className="font-medium">
                  {formatInt(activeDays)}
                </Td>
              </Tr>
            </tfoot>
          </Table>
        </TableFrame>
        <p className="mt-2 text-xs text-ink-3">
          A conversation active in two months is counted in both, and once in the year.
          {startsLater ? ` Your first record is dated ${formatDay(history.first)}; nothing is known about earlier months.` : ''}
          {unrecorded ? ' A dash means the sources for that month record tokens only.' : ''}
        </p>
      </CardBody>
    </Card>
  );
}

const cellClass = (value: number) => (value === 0 ? 'py-1.5 text-ink-3' : 'py-1.5');
