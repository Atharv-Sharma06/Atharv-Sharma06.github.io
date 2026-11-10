'use client';

import { useMemo } from 'react';
import type { Granularity, TokenBasis } from '@/analytics/base';
import type { ConversationDetail } from '@/analytics/conversations';
import type { ModelUsage } from '@/analytics/models';
import type { Overview, SeriesPoint } from '@/analytics/overview';
import { ChartCard } from '@/components/charts/chart-card';
import { ChartLegend, SeriesChart, SeriesTable, SERIES_COLORS, Swatch, type ChartSeries } from '@/components/charts/series-chart';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { formatDay, formatInt, formatShare, formatTokens, formatUsd, plural } from '@/lib/format';
import { familyColor } from '@/lib/palette';
import { pivot } from '@/lib/series';
import { turnsOf } from './growth';
import { TurnChart, TurnTable, type TurnSeries } from './turn-chart';

export interface UsageOverTime {
  granularity: Granularity;
  points: SeriesPoint[];
}

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

function Figures({ rows }: { rows: Array<{ label: string; value: string; title?: string }> }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
      {rows.map((r) => (
        <div key={r.label}>
          <dt className="text-xs text-ink-3">{r.label}</dt>
          <dd className="tabular mt-0.5 text-[15px] text-ink" title={r.title}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TurnGrowth({
  detail,
  overview,
  basis,
  timezone,
  className,
}: {
  detail: ConversationDetail;
  overview: Overview;
  basis: TokenBasis;
  timezone: string;
  className?: string;
}) {
  const turns = useMemo(() => turnsOf(detail.messages), [detail.messages]);
  const series = useMemo(
    () => TURN_SERIES.filter((s) => (basis === 'processed' || s.key !== 'replay') && turns.some((t) => t[s.key] > 0)),
    [turns, basis],
  );
  const truncated = detail.messagesTruncated ? `Only the first ${formatInt(detail.messages.length)} messages are charted.` : null;
  const tokens = overview.tokens;

  if (turns.length < 2 || series.length === 0) {
    const turn = turns[0];
    return (
      <Card className={className}>
        <CardHeader
          title="How this conversation grew"
          description="This conversation has a single turn: one message from you and one reply. Nothing was said before it, so there is no earlier context to re-read and no growth to chart."
        />
        <CardBody>
          <Figures
            rows={[
              { label: 'Input, estimated', value: formatInt(turn?.input ?? 0) },
              { label: 'Output, estimated', value: formatInt(turn?.output ?? 0) },
              { label: 'Model requests', value: formatInt(turn?.requests ?? 0) },
            ]}
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <ChartCard
      className={className}
      title="How this conversation grew"
      description={
        basis === 'processed'
          ? 'Estimated tokens per turn. A turn is a message from you and Claude’s reply to it. Every reply re-reads everything said before it, so re-read context grows with the length of the conversation.'
          : 'Estimated new tokens per turn: what you sent and what Claude wrote. Re-read context is not part of new tokens; switch the token basis to Processed in the top bar to see how it grows.'
      }
      legend={<ChartLegend series={series} />}
      footer={
        <>
          {basis === 'processed' && tokens.replay > 0 && tokens.total > 0 ? (
            <p>
              Re-read context makes up <span className="tabular text-ink">{formatShare(tokens.replay / tokens.total)}</span> of the tokens estimated for this conversation.
              It is modelled from the order of the messages, not measured.
            </p>
          ) : null}
          {truncated ? <p className="mt-1">{truncated}</p> : null}
        </>
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
function ModelSplit({ models, scenario }: { models: ModelUsage[]; scenario: 'standard' | 'cached' }) {
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
                  <span className="inline-flex items-center gap-2">
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

function UsageByPeriod({
  usage,
  models,
  session,
  scenario,
  className,
}: {
  usage: UsageOverTime;
  models: ModelUsage[];
  session: boolean;
  scenario: 'standard' | 'cached';
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
  const split =
    models.length === 0 ? null : (
      <>
        <ModelSplit models={models} scenario={scenario} />
        {session ? <p className="mt-3 text-xs text-ink-3">{STORAGE_NOTE}</p> : null}
      </>
    );

  // One bucket is one number: a bar chart of it would only restate the total above.
  if (chart.rows.length <= 1) {
    const day = chart.rows[0]?.bucket ?? null;
    return (
      <Card className={className}>
        <CardHeader
          title={`Usage in this ${noun}`}
          description={
            day
              ? `All of its recorded usage falls on one day, ${formatDay(day, 'weekday')}, so there is no trend over time to chart. ${
                  several ? `This is how that day splits across the ${models.length} models that worked on it.` : 'This is that day by model.'
                }`
              : `No usage is recorded for this ${noun}.`
          }
        />
        {split ? <CardBody>{split}</CardBody> : null}
      </Card>
    );
  }

  return (
    <div className={className}>
      <ChartCard
        title={`Usage over this ${noun}`}
        description={`Tokens per ${granularity} from the first to the last recorded ${granularity}. Solid bars are metered; hatched bars are reconstructed from text.`}
        legend={<ChartLegend series={chart.series} />}
      >
        {(view) =>
          view === 'chart' ? (
            <SeriesChart rows={chart.rows} series={chart.series} granularity={granularity} ariaLabel={`Tokens per ${granularity} for this ${noun}`} />
          ) : (
            <SeriesTable rows={chart.rows} series={chart.series} granularity={granularity} formatValue={formatInt} />
          )
        }
      </ChartCard>
      {split ? (
        <Card className="mt-4">
          <CardHeader title={`Models in this ${noun}`} description={several ? `Its usage split across the ${models.length} models that worked on it.` : undefined} />
          <CardBody>{split}</CardBody>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * How the conversation's usage built up: per turn where the source lists messages
 * (chats), per calendar period and model where it only meters usage (Claude Code).
 */
export function GrowthCard({
  detail,
  overview,
  usage,
  models,
  basis,
  scenario,
  timezone,
  className,
}: {
  detail: ConversationDetail;
  overview: Overview;
  usage: UsageOverTime | null;
  models: ModelUsage[] | null;
  basis: TokenBasis;
  scenario: 'standard' | 'cached';
  timezone: string;
  className?: string;
}) {
  if (detail.messages.length > 0) return <TurnGrowth detail={detail} overview={overview} basis={basis} timezone={timezone} className={className} />;
  return (
    <UsageByPeriod
      usage={usage ?? { granularity: 'day', points: [] }}
      models={models ?? []}
      session={detail.conversation.kind === 'code_session'}
      scenario={scenario}
      className={className}
    />
  );
}
