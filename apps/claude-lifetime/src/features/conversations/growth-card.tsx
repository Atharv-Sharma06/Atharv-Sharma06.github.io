'use client';

import { useMemo } from 'react';
import type { Granularity, TokenBasis } from '@/analytics/base';
import type { ModelUsage } from '@/analytics/models';
import type { SeriesPoint, TokenTotals } from '@/analytics/overview';
import { ChartCard } from '@/components/charts/chart-card';
import { ChartLegend, SeriesChart, SeriesTable, SERIES_COLORS, Swatch, type ChartSeries } from '@/components/charts/series-chart';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { formatDay, formatInt, formatShare, formatTokens, formatUsd, plural } from '@/lib/format';
import { familyColor } from '@/lib/palette';
import { pivot } from '@/lib/series';
import type { Turn } from './growth';
import { TurnChart, TurnTable, type TurnSeries } from './turn-chart';

export interface UsageOverTime {
  granularity: Granularity;
  points: SeriesPoint[];
}

type CostScenario = 'standard' | 'cached';

/**
 * Token categories keep one colour each wherever a conversation is charted. Every
 * per-message figure of a chat is reconstructed from its text, so all three series
 * are drawn as estimates; re-read context is additionally a modelled quantity.
 */
const TURN_SERIES: TurnSeries[] = [
  { key: 'input', label: 'Input', color: SERIES_COLORS[0], estimated: true },
  { key: 'output', label: 'Output', color: SERIES_COLORS[1], estimated: true },
  { key: 'replay', label: 'Re-read context', color: SERIES_COLORS[2], estimated: true },
];

/** How a chat grew, turn by turn. Only meaningful from the second turn on. */
export function TurnGrowthCard({
  turns,
  tokens,
  basis,
  timezone,
  listedMessages,
  truncated,
  className,
}: {
  turns: Turn[];
  tokens: TokenTotals;
  basis: TokenBasis;
  timezone: string;
  /** How many messages the turns were built from, and whether the conversation has more. */
  listedMessages: number;
  truncated: boolean;
  className?: string;
}) {
  const series = useMemo(
    () => TURN_SERIES.filter((s) => (basis === 'processed' || s.key !== 'replay') && turns.some((t) => t[s.key] > 0)),
    [turns, basis],
  );
  const showShare = basis === 'processed' && tokens.replay > 0 && tokens.total > 0;

  return (
    <ChartCard
      className={className}
      title="How this conversation grew"
      description={
        basis === 'processed'
          ? 'Estimated tokens per turn. A turn is a message from you and Claude’s reply to it. Every reply re-reads everything said before it, so re-read context grows with the length of the conversation.'
          : 'Estimated new tokens per turn: what you sent and what Claude wrote. Re-read context is not part of new tokens; switch the token basis to Processed to see how it grows.'
      }
      legend={<ChartLegend series={series} />}
      footer={
        showShare || truncated ? (
          <>
            {showShare ? (
              <p>
                Re-read context makes up <span className="tabular text-ink">{formatShare(tokens.replay / tokens.total)}</span> of the tokens estimated for this
                conversation. It is modelled from the order of the messages, not measured.
              </p>
            ) : null}
            {truncated ? <p className={showShare ? 'mt-1' : undefined}>Only the first {formatInt(listedMessages)} messages are charted.</p> : null}
          </>
        ) : undefined
      }
    >
      {(view) =>
        view === 'chart' ? (
          <TurnChart
            turns={turns}
            series={series}
            timezone={timezone}
            ariaLabel={`Estimated tokens per turn over ${plural(turns.length, 'turn')}: ${series.map((s) => s.label.toLowerCase()).join(', ')}`}
          />
        ) : (
          <TurnTable turns={turns} series={series} timezone={timezone} />
        )
      }
    </ChartCard>
  );
}

const STORAGE_NOTE =
  'Claude Code logs meter every model request. This app stores them as totals per quarter hour, model and price tier, so there are no per-message figures and no message list for a session.';

/**
 * The models behind a conversation that has no message rows. A Claude Code session is
 * filed under the model that processed most of its tokens; others may have assisted,
 * and each one's usage is priced at its own rate.
 */
function ModelSplit({ models, scenario }: { models: ModelUsage[]; scenario: CostScenario }) {
  const total = models.reduce((sum, m) => sum + m.total, 0);
  return (
    <TableFrame>
      <Table>
        <THead>
          <tr>
            <Th>Model</Th>
            <Th align="right">Tokens</Th>
            <Th align="right">Share</Th>
            <Th align="right">Requests</Th>
            <Th align="right">Equivalent API value</Th>
          </tr>
        </THead>
        <tbody>
          {models.map((m) => {
            const priced = m.value.pricedTokens > 0;
            return (
              <Tr key={m.modelKey ?? 'unknown'}>
                <Td>
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    <Swatch series={{ color: familyColor(m.modelKey === null ? 'unknown' : m.family) }} />
                    <span className={m.modelKey === null ? 'text-ink-2' : undefined}>{m.displayName}</span>
                  </span>
                </Td>
                <Td numeric title={`${formatInt(m.total)} tokens`}>
                  {formatTokens(m.total)}
                </Td>
                <Td numeric>{total > 0 ? formatShare(m.total / total) : '–'}</Td>
                <Td numeric>{formatInt(m.requests)}</Td>
                <Td
                  numeric
                  className={priced ? undefined : 'text-ink-3'}
                  title={priced ? undefined : m.modelKey === null ? 'Not priced: the source does not name the model.' : 'Not priced: no published price is on file for this model.'}
                >
                  {priced ? formatUsd(scenario === 'cached' ? m.value.totalCachedUsd : m.value.totalStandardUsd) : '–'}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableFrame>
  );
}

/**
 * Usage of a conversation whose source meters it over time instead of listing messages
 * (Claude Code): by calendar period when it spans several, and by model.
 */
export function MeteredUsageCard({
  usage,
  models,
  session,
  scenario,
  className,
}: {
  usage: UsageOverTime;
  models: ModelUsage[];
  session: boolean;
  scenario: CostScenario;
  className?: string;
}) {
  const { granularity } = usage;
  const chart = useMemo(() => {
    const pivoted = pivot(usage.points, granularity, (p) => p.tokens, { groups: ['exact', 'estimated'] });
    const defs: ChartSeries[] = [
      { key: 'exact', label: 'Exact', color: SERIES_COLORS[0] },
      { key: 'estimated', label: 'Estimated', color: SERIES_COLORS[0], estimated: true },
    ];
    return { rows: pivoted.rows, series: defs.filter((s) => pivoted.totals[s.key] > 0) };
  }, [usage.points, granularity]);
  const noun = session ? 'session' : 'conversation';
  const several = models.length > 1;
  const storageNote = session ? <p className="text-xs text-ink-3">{STORAGE_NOTE}</p> : null;

  // One bucket is one number: a bar chart of it would only restate the total above.
  if (chart.rows.length <= 1) {
    const day = chart.rows[0]?.bucket ?? null;
    const byModel = several
      ? `This is how that day splits across the ${models.length} models that worked on it.`
      : models.length === 1
        ? `One model, ${models[0].displayName}, handled all of it.`
        : '';
    return (
      <Card className={className}>
        <CardHeader
          title={`Usage in this ${noun}`}
          description={
            day
              ? `All of its recorded usage falls on one day, ${formatDay(day, 'weekday')}, so there is no trend over time to chart. ${byModel}`
              : `No usage is recorded for this ${noun}.`
          }
        />
        <CardBody className="space-y-3">
          {several ? <ModelSplit models={models} scenario={scenario} /> : null}
          {storageNote}
        </CardBody>
      </Card>
    );
  }

  return (
    <div className={className}>
      <ChartCard
        title={`Usage over this ${noun}`}
        description={`Tokens per ${granularity} from the first to the last recorded ${granularity}. ${
          chart.series.length > 1
            ? 'Solid bars are metered; hatched bars are reconstructed from text.'
            : chart.series[0]?.estimated
              ? 'All of it is reconstructed from text.'
              : 'All of it is metered by the source.'
        }`}
        legend={<ChartLegend series={chart.series} />}
        footer={session ? <span className="text-xs text-ink-3">{STORAGE_NOTE}</span> : undefined}
      >
        {(view) =>
          view === 'chart' ? (
            <SeriesChart rows={chart.rows} series={chart.series} granularity={granularity} ariaLabel={`Tokens per ${granularity} for this ${noun}`} />
          ) : (
            <SeriesTable rows={chart.rows} series={chart.series} granularity={granularity} formatValue={formatInt} />
          )
        }
      </ChartCard>
      {several ? (
        <Card className="mt-4">
          <CardHeader title={`Models in this ${noun}`} description={`Its usage split across the ${models.length} models that worked on it.`} />
          <CardBody>
            <ModelSplit models={models} scenario={scenario} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
