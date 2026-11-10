import { toIso, toNumber, type SqlExecutor } from '@/db/driver';
import { bucketExpr, factsFrom, NO_PLAN, Params, tokenExpr, UNKNOWN_MODEL_LABEL, type AnalyticsFilter, type Granularity } from './base';

export interface TokenTotals {
  /** Under the filter's basis. */
  total: number;
  exact: number;
  estimated: number;
  /** Ends of the uncertainty band of `total` (equal to it when everything is exact). */
  low: number;
  high: number;
  /** Categories, independent of the basis. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  replay: number;
}

export interface Overview {
  tokens: TokenTotals;
  conversations: { total: number; chats: number; codeSessions: number };
  messages: { user: number; assistant: number; total: number };
  requests: number;
  /** Messages per conversation, for conversations that have messages. */
  averageConversationLength: number | null;
  firstUsageAt: string | null;
  lastUsageAt: string | null;
  /**
   * First and last day with usage as local dates, by the same rule the charts use
   * (daily aggregates are UTC calendar days). Use these for display, not the instants:
   * converting a daily bucket's instant to a timezone west of UTC lands on the day before.
   */
  firstDay: string | null;
  lastDay: string | null;
  activeDays: number;
  mostActiveDay: {
    day: string;
    tokens: number;
    exact: number;
    estimated: number;
    conversationsActive: number;
    conversationsCreated: number;
    messages: number;
  } | null;
}

const TOTAL_COLUMNS = (tok: string) => `
  COALESCE(sum(${tok}), 0)::bigint AS total,
  COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
  COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
  COALESCE(round(sum(${tok} * f.low_factor)), 0)::bigint AS low,
  COALESCE(round(sum(${tok} * f.high_factor)), 0)::bigint AS high,
  COALESCE(sum(f.input_tokens), 0)::bigint AS input,
  COALESCE(sum(f.output_tokens), 0)::bigint AS output,
  COALESCE(sum(f.cache_read_tokens), 0)::bigint AS cache_read,
  COALESCE(sum(f.cache_write_5m_tokens + f.cache_write_1h_tokens), 0)::bigint AS cache_write,
  COALESCE(sum(f.replay_tokens), 0)::bigint AS replay`;

export function readTotals(row: Record<string, unknown>): TokenTotals {
  return {
    total: toNumber(row.total),
    exact: toNumber(row.exact),
    estimated: toNumber(row.estimated),
    low: toNumber(row.low),
    high: toNumber(row.high),
    input: toNumber(row.input),
    output: toNumber(row.output),
    cacheRead: toNumber(row.cache_read),
    cacheWrite: toNumber(row.cache_write),
    replay: toNumber(row.replay),
  };
}

export { TOTAL_COLUMNS };

export async function getOverview(db: SqlExecutor, filter: AnalyticsFilter): Promise<Overview> {
  const tok = tokenExpr(filter.basis);

  const p = new Params();
  const f = factsFrom(filter, p);
  const totals = (
    await db.query<Record<string, unknown>>(
      `SELECT ${TOTAL_COLUMNS(tok)},
              COALESCE(sum(f.user_message_count), 0)::bigint AS user_messages,
              COALESCE(sum(f.assistant_message_count), 0)::bigint AS assistant_messages,
              COALESCE(sum(f.request_count), 0)::bigint AS requests,
              min(f.occurred_at) AS first_at, max(f.occurred_at) AS last_at,
              min(${f.day})::text AS first_day, max(${f.day})::text AS last_day,
              count(DISTINCT ${f.day})::int AS active_days
         FROM ${f.from} WHERE ${f.where}`,
      p.values,
    )
  ).rows[0];

  // Conversations that have at least one fact under the filter. Containers for aggregate
  // usage (API reports, generic imports) are not conversations and are left out.
  const pc = new Params();
  const fc = factsFrom(filter, pc);
  const conv = (
    await db.query<{ kind: string; n: number; with_messages: number; messages: unknown }>(
      `SELECT c.kind::text AS kind, count(*)::int AS n,
              count(*) FILTER (WHERE x.messages > 0)::int AS with_messages,
              COALESCE(sum(x.messages), 0)::bigint AS messages
         FROM (SELECT f.conversation_id, sum(f.user_message_count + f.assistant_message_count) AS messages
                 FROM ${fc.from} WHERE ${fc.where} AND f.conversation_id IS NOT NULL GROUP BY 1) x
         JOIN conversations c ON c.id = x.conversation_id
        WHERE c.kind IN ('chat', 'code_session')
        GROUP BY 1`,
      pc.values,
    )
  ).rows;
  const chats = conv.find((r) => r.kind === 'chat')?.n ?? 0;
  const codeSessions = conv.find((r) => r.kind === 'code_session')?.n ?? 0;
  const withMessages = conv.reduce((s, r) => s + r.with_messages, 0);
  const conversationMessages = conv.reduce((s, r) => s + toNumber(r.messages), 0);

  const pd = new Params();
  const fd = factsFrom(filter, pd);
  const top = (
    await db.query<Record<string, unknown>>(
      `SELECT ${fd.day}::text AS day, sum(${tok})::bigint AS tokens,
              COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
              COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
              count(DISTINCT ${fd.conversationId})::int AS conversations,
              sum(f.user_message_count + f.assistant_message_count)::bigint AS messages
         FROM ${fd.from} ${fd.conversationJoin} WHERE ${fd.where}
        GROUP BY 1 HAVING sum(${tok}) > 0 ORDER BY 2 DESC, 1 DESC LIMIT 1`,
      pd.values,
    )
  ).rows[0];

  let mostActiveDay: Overview['mostActiveDay'] = null;
  if (top) {
    const created = (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM conversations c JOIN data_sources s ON s.id = c.source_id
          WHERE c.user_id = $1 AND s.include_in_totals AND c.kind IN ('chat', 'code_session')
            AND (c.created_at AT TIME ZONE $2::text)::date = $3::date`,
        [filter.userId, filter.timezone, top.day],
      )
    ).rows[0];
    mostActiveDay = {
      day: String(top.day),
      tokens: toNumber(top.tokens),
      exact: toNumber(top.exact),
      estimated: toNumber(top.estimated),
      conversationsActive: toNumber(top.conversations),
      conversationsCreated: created.n,
      messages: toNumber(top.messages),
    };
  }

  const user = toNumber(totals.user_messages);
  const assistant = toNumber(totals.assistant_messages);
  return {
    tokens: readTotals(totals),
    conversations: { total: chats + codeSessions, chats, codeSessions },
    messages: { user, assistant, total: user + assistant },
    requests: toNumber(totals.requests),
    averageConversationLength: withMessages > 0 ? conversationMessages / withMessages : null,
    firstUsageAt: toIso(totals.first_at),
    lastUsageAt: toIso(totals.last_at),
    firstDay: (totals.first_day as string | null) ?? null,
    lastDay: (totals.last_day as string | null) ?? null,
    activeDays: toNumber(totals.active_days),
    mostActiveDay,
  };
}

// ── Time series ─────────────────────────────────────────────────────────────────

export type SeriesGroup = 'none' | 'confidence' | 'source' | 'model' | 'family' | 'plan';

export interface SeriesPoint {
  /** First local day of the bucket, `YYYY-MM-DD`. */
  bucket: string;
  /** Group key ('' when not grouped). */
  group: string;
  tokens: number;
  exact: number;
  estimated: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  replay: number;
  messages: number;
  conversations: number;
  requests: number;
}

const GROUPS: Record<SeriesGroup, { expr: string; join: string }> = {
  none: { expr: `''`, join: '' },
  confidence: { expr: `f.confidence::text`, join: '' },
  source: { expr: `s.kind::text`, join: '' },
  model: {
    expr: `COALESCE(mc.display_name, '${UNKNOWN_MODEL_LABEL}')`,
    join: `LEFT JOIN model_catalog mc ON mc.id = f.model_id`,
  },
  family: {
    expr: `COALESCE(mc.family, 'unknown')`,
    join: `LEFT JOIN model_catalog mc ON mc.id = f.model_id`,
  },
  // The plan of a fact is derived from its timestamp; it is never stored on the fact.
  plan: {
    expr: `COALESCE(sp.plan_key, '${NO_PLAN}')`,
    join: `LEFT JOIN subscription_periods sp ON sp.user_id = f.user_id AND f.occurred_at >= sp.started_at AND (sp.ended_at IS NULL OR f.occurred_at < sp.ended_at)`,
  },
};

export async function getTimeSeries(
  db: SqlExecutor,
  filter: AnalyticsFilter,
  granularity: Granularity,
  group: SeriesGroup = 'none',
): Promise<SeriesPoint[]> {
  const tok = tokenExpr(filter.basis);
  const p = new Params();
  const f = factsFrom(filter, p);
  const g = GROUPS[group];
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${bucketExpr(f.day, granularity)}::text AS bucket, ${g.expr} AS grp,
            sum(${tok})::bigint AS tokens,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
            sum(f.input_tokens)::bigint AS input, sum(f.output_tokens)::bigint AS output,
            sum(f.cache_read_tokens)::bigint AS cache_read,
            sum(f.cache_write_5m_tokens + f.cache_write_1h_tokens)::bigint AS cache_write,
            sum(f.replay_tokens)::bigint AS replay,
            sum(f.user_message_count + f.assistant_message_count)::bigint AS messages,
            count(DISTINCT ${f.conversationId})::int AS conversations,
            sum(f.request_count)::bigint AS requests
       FROM ${f.from} ${g.join} ${f.conversationJoin}
      WHERE ${f.where}
      GROUP BY 1, 2 ORDER BY 1, 2`,
    p.values,
  );
  return rows.map((r) => ({
    bucket: String(r.bucket),
    group: String(r.grp ?? ''),
    tokens: toNumber(r.tokens),
    exact: toNumber(r.exact),
    estimated: toNumber(r.estimated),
    input: toNumber(r.input),
    output: toNumber(r.output),
    cacheRead: toNumber(r.cache_read),
    cacheWrite: toNumber(r.cache_write),
    replay: toNumber(r.replay),
    messages: toNumber(r.messages),
    conversations: toNumber(r.conversations),
    requests: toNumber(r.requests),
  }));
}
