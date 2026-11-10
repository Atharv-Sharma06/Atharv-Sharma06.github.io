import { decodeLimitations, type LimitationName } from '@/core/limitations';
import type { ConversationKind, SourceKind } from '@/core/types';
import { toIso, toNumber, type SqlExecutor } from '@/db/driver';
import { conversationShown, NO_PLAN, Params, tokenExpr, UNKNOWN_MODEL_LABEL, type AnalyticsFilter } from './base';

export type ConversationSort = 'tokens' | 'created' | 'updated' | 'messages' | 'title';

export interface ConversationQuery {
  search?: string;
  /** model_catalog.model_key, or 'unknown' for conversations whose source names no model. */
  model?: string | null;
  sourceKind?: SourceKind | null;
  /** A plan key, or 'none' for conversations started outside every entered period. */
  plan?: string | null;
  /** Inclusive local dates on the conversation's creation time. */
  from?: string | null;
  to?: string | null;
  sort?: ConversationSort;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ConversationRow {
  id: number;
  title: string | null;
  kind: ConversationKind;
  projectLabel: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Model named by the source, or null. */
  modelKey: string | null;
  modelName: string;
  messageCount: number;
  /** Under the filter's basis. */
  tokens: number;
  exact: number;
  estimated: number;
  sourceKind: SourceKind;
  sourceLabel: string;
  isSynthetic: boolean;
  /** Plan in effect when the conversation started (derived), or 'none'. */
  planKey: string;
  planLabel: string | null;
}

export interface ConversationPage {
  rows: ConversationRow[];
  total: number;
}

const SORTS: Record<ConversationSort, string> = {
  tokens: 'COALESCE(t.tokens, 0)',
  created: 'c.created_at',
  updated: 'c.updated_at',
  messages: 'c.message_count',
  title: `lower(COALESCE(c.title, ''))`,
};

export async function listConversations(db: SqlExecutor, filter: AnalyticsFilter, query: ConversationQuery = {}): Promise<ConversationPage> {
  const p = new Params();
  const user = p.add(filter.userId);
  const tok = tokenExpr(filter.basis);
  const where = [`c.user_id = ${user}`, conversationShown(), `c.kind IN ('chat', 'code_session')`];

  const search = query.search?.trim();
  if (search) {
    // escape LIKE wildcards so the text is matched literally
    const pattern = p.add(`%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(c.title ILIKE ${pattern} OR c.project_label ILIKE ${pattern})`);
  }
  if (query.model === 'unknown') where.push(`c.model_id IS NULL`);
  else if (query.model) where.push(`mc.model_key = ${p.add(query.model)}`);
  if (query.sourceKind) where.push(`s.kind = ${p.add(query.sourceKind)}::source_kind`);
  if (query.plan === NO_PLAN) where.push(`sp.id IS NULL`);
  else if (query.plan) where.push(`sp.plan_key = ${p.add(query.plan)}`);
  // parameters are only added when used: PostgreSQL rejects a statement with an unreferenced one
  if (query.from) where.push(`(c.created_at AT TIME ZONE ${p.add(filter.timezone)}::text)::date >= ${p.add(query.from)}::date`);
  if (query.to) where.push(`(c.created_at AT TIME ZONE ${p.add(filter.timezone)}::text)::date <= ${p.add(query.to)}::date`);

  // A conversation is filed under the plan that was active on the day it started.
  const createdDay = `(c.created_at AT TIME ZONE ${p.add(filter.timezone)}::text)::date`;
  const base = `
    FROM conversations c
    JOIN data_sources s ON s.id = c.source_id
    LEFT JOIN model_catalog mc ON mc.id = c.model_id
    LEFT JOIN subscription_periods sp
           ON sp.user_id = c.user_id AND ${createdDay} >= sp.start_date AND (sp.last_date IS NULL OR ${createdDay} <= sp.last_date)
   WHERE ${where.join(' AND ')}`;

  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n ${base}`, p.values)).rows[0].n;

  const sort = SORTS[query.sort ?? 'tokens'];
  const dir = query.direction === 'asc' ? 'ASC' : 'DESC';
  const limit = p.add(Math.min(Math.max(query.limit ?? 50, 1), 500));
  const offset = p.add(Math.max(query.offset ?? 0, 0));
  const { rows } = await db.query<Record<string, unknown>>(
    `WITH t AS (
       SELECT f.conversation_id, sum(${tok})::bigint AS tokens,
              COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
              COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated
         FROM usage_facts f JOIN data_sources fs ON fs.id = f.source_id
        WHERE f.user_id = ${user} AND f.conversation_id IS NOT NULL AND fs.include_in_totals GROUP BY 1)
     SELECT c.id, c.title, c.kind::text AS kind, c.project_label, c.created_at, c.updated_at, c.message_count,
            mc.model_key, mc.display_name AS model_name,
            COALESCE(t.tokens, 0) AS tokens, COALESCE(t.exact, 0) AS exact, COALESCE(t.estimated, 0) AS estimated,
            s.kind::text AS source_kind, s.label AS source_label, s.is_synthetic,
            sp.plan_key, sp.label AS plan_label
       ${base.replace('FROM conversations c', 'FROM conversations c LEFT JOIN t ON t.conversation_id = c.id')}
      ORDER BY ${sort} ${dir} NULLS LAST, c.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    p.values,
  );
  return {
    total,
    rows: rows.map((r) => ({
      id: toNumber(r.id),
      title: (r.title as string | null) ?? null,
      kind: r.kind as ConversationKind,
      projectLabel: (r.project_label as string | null) ?? null,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
      modelKey: (r.model_key as string | null) ?? null,
      modelName: (r.model_name as string | null) ?? UNKNOWN_MODEL_LABEL,
      messageCount: toNumber(r.message_count),
      tokens: toNumber(r.tokens),
      exact: toNumber(r.exact),
      estimated: toNumber(r.estimated),
      sourceKind: r.source_kind as SourceKind,
      sourceLabel: String(r.source_label),
      isSynthetic: r.is_synthetic === true,
      planKey: (r.plan_key as string | null) ?? NO_PLAN,
      planLabel: (r.plan_label as string | null) ?? null,
    })),
  };
}

export interface ConversationDetail {
  conversation: ConversationRow & { externalId: string; userMessages: number; assistantMessages: number };
  /** Imports that contributed records to this conversation. */
  imports: Array<{ batchId: number; fileName: string; format: string; importedAt: string }>;
  /** Why the estimate may be off: limitation → number of messages it applies to. */
  limitations: Array<{ name: LimitationName; messages: number }>;
  methods: Array<{ methodKey: string; tokenizerBasis: string; description: string; messages: number; lowFactor: number; highFactor: number }>;
  /** Message metadata in order (never text). Empty for sources without per-message rows. */
  messages: Array<{
    ordinal: number;
    role: string;
    at: string | null;
    textChars: number;
    thinkingChars: number;
    toolChars: number;
    attachmentChars: number;
    fileCount: number;
    input: number;
    output: number;
    replay: number;
    requests: number;
  }>;
  messagesTruncated: boolean;
}

export async function getConversationDetail(db: SqlExecutor, filter: AnalyticsFilter, id: number): Promise<ConversationDetail | null> {
  const page = await listConversationsById(db, filter, id);
  if (!page) return null;

  const counts = (
    await db.query<Record<string, unknown>>(
      `SELECT external_id, user_message_count, assistant_message_count FROM conversations WHERE id = $1 AND user_id = $2`,
      [id, filter.userId],
    )
  ).rows[0];

  const imports = (
    await db.query<Record<string, unknown>>(
      `SELECT b.id, b.file_name, b.format, b.created_at FROM import_batches b
        WHERE b.id IN (SELECT batch_id FROM messages WHERE conversation_id = $1
                       UNION SELECT batch_id FROM usage_records WHERE conversation_id = $1)
        ORDER BY b.created_at`,
      [id],
    )
  ).rows;

  const flagRows = (
    await db.query<{ limitation_flags: number; n: number }>(
      `SELECT limitation_flags, count(*)::int AS n FROM token_estimates WHERE conversation_id = $1 GROUP BY 1`,
      [id],
    )
  ).rows;
  const tally = new Map<LimitationName, number>();
  for (const r of flagRows) for (const name of decodeLimitations(r.limitation_flags)) tally.set(name, (tally.get(name) ?? 0) + r.n);

  const methods = (
    await db.query<Record<string, unknown>>(
      `SELECT m.method_key, m.tokenizer_basis, m.description, m.low_factor::float8 AS low_factor, m.high_factor::float8 AS high_factor, count(*)::int AS n
         FROM token_estimates e JOIN estimation_methods m ON m.id = e.method_id
        WHERE e.conversation_id = $1 GROUP BY 1, 2, 3, 4, 5 ORDER BY 6 DESC`,
      [id],
    )
  ).rows;

  const LIMIT = 400;
  const messages = (
    await db.query<Record<string, unknown>>(
      `SELECT m.ordinal, m.role::text AS role, COALESCE(m.created_at, e.occurred_at) AS at,
              m.text_chars, m.thinking_chars, m.tool_chars, m.attachment_chars, m.file_count,
              COALESCE(round(e.input_base * em.central_factor), 0)::bigint AS input,
              COALESCE(round(e.output_base * em.central_factor), 0)::bigint AS output,
              COALESCE(round(e.replay_base * em.central_factor), 0)::bigint AS replay,
              COALESCE(e.request_count, 0) AS requests
         FROM messages m
         LEFT JOIN token_estimates e ON e.message_id = m.id
         LEFT JOIN estimation_methods em ON em.id = e.method_id
        WHERE m.conversation_id = $1
        ORDER BY COALESCE(m.created_at, e.occurred_at), m.ordinal
        LIMIT ${LIMIT + 1}`,
      [id],
    )
  ).rows;

  return {
    conversation: {
      ...page,
      externalId: String(counts.external_id),
      userMessages: toNumber(counts.user_message_count),
      assistantMessages: toNumber(counts.assistant_message_count),
    },
    imports: imports.map((r) => ({ batchId: toNumber(r.id), fileName: String(r.file_name), format: String(r.format), importedAt: toIso(r.created_at)! })),
    limitations: [...tally.entries()].map(([name, messages]) => ({ name, messages })).sort((a, b) => b.messages - a.messages),
    methods: methods.map((r) => ({
      methodKey: String(r.method_key),
      tokenizerBasis: String(r.tokenizer_basis),
      description: String(r.description),
      messages: toNumber(r.n),
      lowFactor: Number(r.low_factor),
      highFactor: Number(r.high_factor),
    })),
    messages: messages.slice(0, LIMIT).map((r) => ({
      ordinal: toNumber(r.ordinal),
      role: String(r.role),
      at: toIso(r.at),
      textChars: toNumber(r.text_chars),
      thinkingChars: toNumber(r.thinking_chars),
      toolChars: toNumber(r.tool_chars),
      attachmentChars: toNumber(r.attachment_chars),
      fileCount: toNumber(r.file_count),
      input: toNumber(r.input),
      output: toNumber(r.output),
      replay: toNumber(r.replay),
      requests: toNumber(r.requests),
    })),
    messagesTruncated: messages.length > LIMIT,
  };
}

async function listConversationsById(db: SqlExecutor, filter: AnalyticsFilter, id: number): Promise<ConversationRow | null> {
  const tok = tokenExpr(filter.basis);
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT c.id, c.title, c.kind::text AS kind, c.project_label, c.created_at, c.updated_at, c.message_count,
            mc.model_key, mc.display_name AS model_name,
            COALESCE(t.tokens, 0) AS tokens, COALESCE(t.exact, 0) AS exact, COALESCE(t.estimated, 0) AS estimated,
            s.kind::text AS source_kind, s.label AS source_label, s.is_synthetic, sp.plan_key, sp.label AS plan_label
       FROM conversations c
       JOIN data_sources s ON s.id = c.source_id
       LEFT JOIN model_catalog mc ON mc.id = c.model_id
       LEFT JOIN subscription_periods sp
              ON sp.user_id = c.user_id AND (c.created_at AT TIME ZONE $3::text)::date >= sp.start_date
             AND (sp.last_date IS NULL OR (c.created_at AT TIME ZONE $3::text)::date <= sp.last_date)
       LEFT JOIN LATERAL (
         SELECT sum(${tok})::bigint AS tokens,
                COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
                COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated
           FROM usage_facts f JOIN data_sources fs ON fs.id = f.source_id
          WHERE f.conversation_id = c.id AND fs.include_in_totals) t ON true
      WHERE c.id = $1 AND c.user_id = $2`,
    [id, filter.userId, filter.timezone],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: toNumber(r.id),
    title: (r.title as string | null) ?? null,
    kind: r.kind as ConversationKind,
    projectLabel: (r.project_label as string | null) ?? null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    modelKey: (r.model_key as string | null) ?? null,
    modelName: (r.model_name as string | null) ?? UNKNOWN_MODEL_LABEL,
    messageCount: toNumber(r.message_count),
    tokens: toNumber(r.tokens),
    exact: toNumber(r.exact),
    estimated: toNumber(r.estimated),
    sourceKind: r.source_kind as SourceKind,
    sourceLabel: String(r.source_label),
    isSynthetic: r.is_synthetic === true,
    planKey: (r.plan_key as string | null) ?? NO_PLAN,
    planLabel: (r.plan_label as string | null) ?? null,
  };
}

export interface ConversationModelOption {
  /** model_catalog.model_key, or null for conversations whose source names no model. */
  modelKey: string | null;
  displayName: string;
  conversations: number;
}

/**
 * The models that conversations are filed under, for the explorer's model filter.
 *
 * A conversation carries one model: the one its source names (for a Claude Code session,
 * the model that processed most of its tokens). `ConversationQuery.model` matches that
 * model, so the filter's choices have to come from the same column. The model breakdown
 * cannot supply them: it also counts models that only assisted inside a session, and a
 * filter on one of those would match nothing.
 */
export async function listConversationModels(db: SqlExecutor, userId: number): Promise<ConversationModelOption[]> {
  const { rows } = await db.query<{ model_key: string | null; display_name: string | null; n: number }>(
    `SELECT mc.model_key, mc.display_name, count(*)::int AS n
       FROM conversations c
       JOIN data_sources s ON s.id = c.source_id
       LEFT JOIN model_catalog mc ON mc.id = c.model_id
      WHERE c.user_id = $1 AND ${conversationShown()} AND c.kind IN ('chat', 'code_session')
      GROUP BY 1, 2
      ORDER BY 3 DESC, 2`,
    [userId],
  );
  return rows.map((r) => ({
    modelKey: r.model_key ?? null,
    displayName: r.display_name ?? UNKNOWN_MODEL_LABEL,
    conversations: r.n,
  }));
}
