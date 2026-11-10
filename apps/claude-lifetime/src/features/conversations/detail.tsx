'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { NO_PLAN, type TokenBasis } from '@/analytics/base';
import { getConversationDetail, type ConversationDetail } from '@/analytics/conversations';
import { getModelBreakdown, type ModelUsage } from '@/analytics/models';
import { getOverview, getTimeSeries, type Overview, type TokenTotals } from '@/analytics/overview';
import { planLabel } from '@/analytics/subscriptions';
import { getApiValue, type ApiValue } from '@/analytics/value';
import { confidenceOf } from '@/components/data/confidence';
import { MetricCard } from '@/components/data/metric-card';
import { SOURCE_KIND_LABEL } from '@/components/shell/coverage-indicator';
import { PageHeader } from '@/components/shell/page-header';
import { buttonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { dayInZone, formatInstant, formatInt, formatTokens, formatUsd, plural } from '@/lib/format';
import { autoGranularity, spanOf } from '@/lib/series';
import { useApp, useData, type AppReady } from '@/state/app';
import { GrowthCard, type UsageOverTime } from './growth-card';
import { MessageTable } from './message-table';
import { EstimateNotes, Provenance } from './provenance';
import { KindIcon, kindLabel, UNTITLED } from './shared';
import { listHref, type ExplorerState } from './url-state';

interface Loaded {
  /** The conversation these results belong to. */
  id: number;
  detail: ConversationDetail | null;
  overview: Overview | null;
  value: ApiValue | null;
  /** Usage over time and by model, read only for sources without per-message rows. */
  usage: UsageOverTime | null;
  models: ModelUsage[] | null;
}

/**
 * Everything the page shows, read together so the page never mixes figures of two
 * conversations. A conversation's figures are lifetime figures: the date range in the
 * top bar selects which conversations are listed, not how much of one is counted.
 */
async function loadConversation(a: AppReady, id: number): Promise<Loaded> {
  const detail = await getConversationDetail(a.db, a.lifetime, id);
  if (!detail) return { id, detail: null, overview: null, value: null, usage: null, models: null };
  const filter = { ...a.lifetime, conversationId: id };
  const valueOptions = { assumedModelKey: a.settings.assumedModelKey };
  const overview = await getOverview(a.db, filter);
  const value = await getApiValue(a.db, filter, valueOptions);
  let usage: UsageOverTime | null = null;
  let models: ModelUsage[] | null = null;
  if (detail.messages.length === 0 && overview.firstUsageAt && overview.lastUsageAt) {
    const tz = a.settings.timezone;
    const granularity = autoGranularity(spanOf(dayInZone(overview.firstUsageAt, tz), dayInZone(overview.lastUsageAt, tz)));
    usage = { granularity, points: await getTimeSeries(a.db, filter, granularity, 'confidence') };
    models = await getModelBreakdown(a.db, filter, valueOptions);
  }
  return { id, detail, overview, value, usage, models };
}

function BackLink({ listState }: { listState: ExplorerState }) {
  return (
    <Link href={listHref(listState)} className="mb-4 inline-flex h-8 items-center gap-1.5 rounded-md text-[13px] text-ink-2 hover:text-ink">
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to conversations
    </Link>
  );
}

function Fact({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-ink">
        {children}
        {note ? <span className="block text-xs text-ink-3">{note}</span> : null}
      </dd>
    </div>
  );
}

function Composition({ tokens, basis, className }: { tokens: TokenTotals; basis: TokenBasis; className?: string }) {
  // Only categories this conversation has. A chat export knows nothing about the prompt
  // cache, so a row "Cache reads 0" would state as fact what is really unknown.
  const rows = [
    { label: 'Input', value: tokens.input, hint: 'New content given to the model', always: true },
    { label: 'Output', value: tokens.output, hint: 'What the model wrote', always: true },
    { label: 'Cache writes', value: tokens.cacheWrite, hint: 'Input stored in the prompt cache', always: false },
    ...(basis === 'processed'
      ? [
          { label: 'Cache reads', value: tokens.cacheRead, hint: 'Context re-read from the prompt cache (metered)', always: false },
          { label: 'Re-read context', value: tokens.replay, hint: 'Context re-sent on later turns (modelled for chat exports)', always: false },
        ]
      : []),
  ].filter((r) => r.always || r.value > 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card className={className}>
      <CardHeader
        title="What the total is made of"
        description={basis === 'processed' ? 'Processed tokens of this conversation by category.' : 'New tokens of this conversation by category.'}
      />
      <CardBody>
        <dl className="space-y-3">
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-[7.5rem_minmax(0,1fr)_4rem] items-center gap-3 text-[13px]" title={`${r.hint}: ${formatInt(r.value)} tokens`}>
              <dt className="truncate text-ink-2">{r.label}</dt>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                <div className="h-full rounded-full bg-accent/80" style={{ width: `${r.value > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%` }} />
              </div>
              <dd className="tabular text-right text-ink">{formatTokens(r.value)}</dd>
            </div>
          ))}
        </dl>
        {basis === 'new' && tokens.cacheRead + tokens.replay > 0 ? (
          <p className="mt-4 text-xs text-ink-3">
            Context the model re-read ({formatTokens(tokens.cacheRead + tokens.replay)} tokens) is not part of new tokens. Switch the token basis to Processed to include
            it.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function TokensTile({ tokens, basis, methods }: { tokens: TokenTotals; basis: TokenBasis; methods: number }) {
  const level = confidenceOf(tokens.exact, tokens.estimated);
  return (
    <MetricCard
      label={basis === 'processed' ? 'Processed tokens' : 'New tokens'}
      value={formatTokens(tokens.total)}
      title={`${formatInt(tokens.total)} tokens`}
      confidence={level}
      confidenceHint={
        level === 'unavailable'
          ? 'No token counts are recorded for this conversation.'
          : level === 'estimated'
            ? 'Reconstructed from the text of this conversation, because its source records no token counts.'
            : 'Token counts metered by the source.'
      }
    >
      {level === 'unavailable' ? (
        <p>No token counts are recorded for this conversation.</p>
      ) : tokens.estimated === 0 ? (
        <p>All of it was metered by the source.</p>
      ) : tokens.exact === 0 ? (
        <p>All of it is reconstructed from the conversation’s text.</p>
      ) : (
        <p>
          <span className="tabular text-ink">{formatTokens(tokens.exact)}</span> metered by the source,{' '}
          <span className="tabular text-ink">{formatTokens(tokens.estimated)}</span> estimated from text.
        </p>
      )}
      {tokens.estimated > 0 && tokens.low !== tokens.high ? (
        <p>
          Likely between <span className="tabular text-ink">{formatTokens(tokens.low)}</span> and <span className="tabular text-ink">{formatTokens(tokens.high)}</span>
          {methods > 1 ? `, combining the margins of ${methods} estimation methods` : ''}.
        </p>
      ) : null}
    </MetricCard>
  );
}

function ValueTile({ value, scenario }: { value: ApiValue; scenario: 'standard' | 'cached' }) {
  const settingsLink = (label: string) => (
    <Link href="/settings/" className="text-[13px] text-accent-soft underline-offset-4 hover:underline">
      {label}
    </Link>
  );

  if (value.pricedTokens === 0) {
    const noModel = value.unpriced.some((u) => u.reason === 'unknown_model');
    const noPrice = value.unpriced.filter((u) => u.reason === 'no_price');
    const names = [...new Set(noPrice.map((u) => u.displayName ?? u.modelKey ?? 'this model'))];
    return (
      <MetricCard
        label="Equivalent API value"
        value={null}
        confidence="unavailable"
        confidenceHint="Nothing in this conversation can be priced, so no value is shown."
        action={value.unpriced.length > 0 ? settingsLink(noModel ? 'Choose a pricing assumption' : 'Add a price in Settings') : undefined}
      >
        {value.unpriced.length === 0 ? (
          <p>There is no token usage to price.</p>
        ) : noModel ? (
          <p>The source does not name the model that answered, so no list price applies. No model is guessed.</p>
        ) : (
          <p>No published price is on file for {new Intl.ListFormat('en', { type: 'conjunction' }).format(names)}.</p>
        )}
      </MetricCard>
    );
  }

  const leading = scenario === 'cached' ? value.totalCachedUsd : value.totalStandardUsd;
  const other = scenario === 'cached' ? value.totalStandardUsd : value.totalCachedUsd;
  const hasEstimate = Number(value.estimatedStandardUsd) > 0 || value.assumedTokens > 0;
  return (
    <MetricCard
      label="Equivalent API value"
      value={formatUsd(leading)}
      confidence={hasEstimate ? 'estimated' : 'exact'}
      confidenceHint={
        hasEstimate
          ? 'Includes estimated token counts or an assumed model, priced at Anthropic’s published API prices.'
          : 'Metered token counts multiplied by Anthropic’s published API prices.'
      }
      action={value.assumedTokens > 0 ? settingsLink('Change pricing assumptions') : undefined}
    >
      <p>What this conversation would cost at API list prices. It is not money you paid.</p>
      {leading !== other ? (
        <p>
          {scenario === 'cached' ? 'Without prompt caching' : 'With a 5-minute prompt cache assumed'}: <span className="tabular text-ink">{formatUsd(other)}</span>.
        </p>
      ) : null}
      {value.assumedModel && value.assumedTokens > 0 ? (
        <p>Priced as {value.assumedModel.displayName}, the model you chose in Settings for usage with no recorded model. That is an assumption.</p>
      ) : null}
      {value.unpricedTokens > 0 ? (
        <p>
          <span className="tabular text-ink">{formatTokens(value.unpricedTokens)}</span> processed tokens are not priced.
        </p>
      ) : null}
    </MetricCard>
  );
}

function NotFound({ listState }: { listState: ExplorerState }) {
  return (
    <div>
      <BackLink listState={listState} />
      <EmptyState
        title="This conversation is not in your data"
        action={
          <Link href={listHref(listState)} className={buttonClass('secondary')}>
            Back to conversations
          </Link>
        }
      >
        The link may be mistyped, or the conversation was removed when its import was deleted. Conversations are numbered inside this browser’s database, so a link
        copied from another device does not work here.
      </EmptyState>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-7 w-80 max-w-full" />
      <Skeleton className="mt-4 h-14 w-full" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
      <Skeleton className="mt-4 h-80" />
    </div>
  );
}

export function ConversationDetailView({ id, listState }: { id: number | null; listState: ExplorerState }) {
  const app = useApp();
  const { settings } = app;
  const query = useData(['conversation', id, settings.assumedModelKey], (a) => (id === null ? Promise.resolve(null) : loadConversation(a, id)));

  if (id === null) return <NotFound listState={listState} />;
  if (query.error) {
    return (
      <div>
        <BackLink listState={listState} />
        <ErrorNote title="This conversation could not be read from the local database">{query.error.message}</ErrorNote>
      </div>
    );
  }
  // While another conversation's result is still on screen from a previous view, show the loading state rather than its figures.
  const loaded = query.data && query.data.id === id ? query.data : null;
  if (!loaded) {
    return (
      <div>
        <BackLink listState={listState} />
        <DetailSkeleton />
      </div>
    );
  }
  const { detail, overview, value, usage, models } = loaded;
  if (!detail || !overview || !value) return <NotFound listState={listState} />;

  const c = detail.conversation;
  const tz = settings.timezone;
  const title = c.title?.trim() ?? '';
  const tokens = overview.tokens;
  const requestLevel = overview.requests === 0 ? 'unavailable' : confidenceOf(tokens.exact, tokens.estimated);
  const otherMessages = Math.max(0, c.messageCount - c.userMessages - c.assistantMessages);
  const estimated = c.estimated > 0;
  const otherModels = (models ?? []).filter((m) => m.modelKey !== c.modelKey && m.total > 0).length;

  return (
    <div className={cn('transition-opacity', query.isPlaceholderData && 'opacity-70')}>
      <BackLink listState={listState} />
      <PageHeader title={title ? title : <span className="text-ink-3">{UNTITLED}</span>} className="mb-4" />

      <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-line py-3.5 sm:grid-cols-3 lg:flex lg:flex-wrap lg:gap-x-10">
        <Fact label="Kind">
          <span className="inline-flex items-center gap-1.5">
            <KindIcon kind={c.kind} />
            {kindLabel(c.kind)}
          </span>
        </Fact>
        {c.projectLabel ? (
          <Fact label="Project">
            <span className="break-all">{c.projectLabel}</span>
          </Fact>
        ) : null}
        <Fact label="Source">{SOURCE_KIND_LABEL[c.sourceKind] ?? c.sourceKind}</Fact>
        <Fact label="Created" note={c.createdAt ? undefined : 'Not recorded by the source'}>
          {formatInstant(c.createdAt, tz, 'datetime')}
        </Fact>
        <Fact label="Last activity" note={c.updatedAt ? undefined : 'Not recorded by the source'}>
          {formatInstant(c.updatedAt, tz, 'datetime')}
        </Fact>
        <Fact
          label="Model"
          note={
            c.modelKey === null
              ? 'The source does not name it'
              : otherModels > 0
                ? `Processed most of its tokens; ${plural(otherModels, 'other model')} assisted`
                : undefined
          }
        >
          {c.modelName}
        </Fact>
        <Fact label="Plan at start">
          <span className={cn(c.planKey === NO_PLAN && 'text-ink-2')}>{planLabel(c.planKey, c.planLabel)}</span>
        </Fact>
      </dl>

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <TokensTile tokens={tokens} basis={settings.basis} methods={detail.methods.length} />
          <MetricCard
            label="Messages"
            value={formatInt(c.messageCount)}
            confidence={c.messageCount > 0 ? 'exact' : 'unavailable'}
            confidenceHint={c.messageCount > 0 ? 'Counted from the imported records.' : 'The source records no messages for this conversation.'}
          >
            {c.messageCount > 0 ? (
              <p>
                <span className="tabular text-ink">{formatInt(c.userMessages)}</span> from you, <span className="tabular text-ink">{formatInt(c.assistantMessages)}</span>{' '}
                from Claude{otherMessages > 0 ? `, ${formatInt(otherMessages)} other` : ''}.
              </p>
            ) : (
              <p>The source records no messages for this conversation.</p>
            )}
          </MetricCard>
          <MetricCard
            label="Model requests"
            value={formatInt(overview.requests)}
            confidence={requestLevel}
            confidenceHint={
              requestLevel === 'unavailable'
                ? 'The source records no request count.'
                : requestLevel === 'estimated'
                  ? 'Counted from the structure of the conversation: one request per reply, plus one for each round of tool use. The export does not record requests.'
                  : 'Requests recorded by the source.'
            }
          >
            {requestLevel === 'unavailable' ? (
              <p>The source records no request count for this conversation.</p>
            ) : (
              <>
                <p>{requestLevel === 'estimated' ? 'One per reply, plus one for each round of tool use.' : 'Calls to the model, as recorded by the source.'}</p>
                {tokens.total > 0 ? (
                  <p>
                    <span className="tabular text-ink" title={`${formatInt(tokens.total / overview.requests)} tokens`}>
                      {formatTokens(tokens.total / overview.requests)}
                    </span>{' '}
                    tokens per request on average.
                  </p>
                ) : null}
              </>
            )}
          </MetricCard>
          <ValueTile value={value} scenario={settings.costScenario} />
        </div>

        {/* Two columns on wide screens: what the total is and where it came from on the left, how it built up on the right. */}
        <div className="grid gap-4 lg:grid-cols-3 lg:grid-rows-[auto_1fr]">
          <Composition tokens={tokens} basis={settings.basis} className="lg:col-start-1 lg:row-start-1" />
          <div className="flex flex-col gap-4 lg:col-span-2 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <GrowthCard
              detail={detail}
              overview={overview}
              usage={usage}
              models={models}
              basis={settings.basis}
              scenario={settings.costScenario}
              timezone={tz}
              className={detail.messages.length > 0 ? 'flex-1' : undefined}
            />
            {estimated ? null : <EstimateNotes detail={detail} />}
          </div>
          <Provenance detail={detail} timezone={tz} className="lg:col-start-1 lg:row-start-2" />
        </div>

        {detail.messages.length > 0 ? <MessageTable detail={detail} basis={settings.basis} timezone={tz} /> : null}

        {estimated ? <EstimateNotes detail={detail} /> : null}
      </div>
    </div>
  );
}
