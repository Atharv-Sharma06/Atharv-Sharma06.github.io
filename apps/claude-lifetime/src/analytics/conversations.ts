import { decodeLimitations, type LimitationName } from '@/core/limitations';
import type { ConversationKind, SourceKind } from '@/core/types';
import { toIso, toNumber, type SqlExecutor } from '@/db/driver';
import { conversationShown, factsFrom, NO_PLAN, Params, tokenExpr, UNKNOWN_MODEL_LABEL, type AnalyticsFilter } from './base';
import { readTotals, TOTAL_COLUMNS } from './overview';

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

/** The kinds of `conversations` row that are conversations. The others are containers of report or table rows. */
const CONVERSATION_KINDS = `c.kind IN ('chat', 'code_session')`;

/**
 * The database's own collation is C, which orders text by code point: "Émile" after
 * "zebra", and every emoji after both. Titles are ordered with the root collation of
 * ICU instead, which puts an accented letter next to its base letter. PGlite ships it
 * as "und-x-icu".
 */
const SORTS: Record<ConversationSort, string> = {
  tokens: 'COALESCE(t.tokens, 0)',
  created: 'c.created_at',
  updated: 'c.updated_at',
  messages: 'c.message_count',
  title: `lower(COALESCE(c.title, '')) COLLATE "und-x-icu"`,
};

export async function listConversations(db: SqlExecutor, filter: AnalyticsFilter, query: ConversationQuery = {}): Promise<ConversationPage> {
  const p = new Params();
  const user = p.add(filter.userId);
  const tok = tokenExpr(filter.basis);
  const where = [`c.user_id = ${user}`, conversationShown(), CONVERSATION_KINDS];

  const search = query.search?.trim();
  const hasNul = (value: string | null | undefined) => value?.includes('\u0000') === true;
  // PostgreSQL text cannot hold a NUL character, so no title, project, model or plan contains one;
  // sent as a parameter it would only make the statement fail. Such a filter matches nothing.
  const impossible = hasNul(search) || hasNul(query.model) || hasNul(query.plan);
  if (impossible) where.push('false');
  else if (search) {
    // escape LIKE wildcards so the text is matched literally
    const pattern = p.add(`%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(c.title ILIKE ${pattern} OR c.project_label ILIKE ${pattern})`);
  }
  if (query.model === 'unknown') where.push(`c.model_id IS NULL`);
  else if (query.model && !impossible) where.push(`mc.model_key = ${p.add(query.model)}`);
  if (query.sourceKind) where.push(`s.kind = ${p.add(query.sourceKind)}::source_kind`);
  if (query.plan === NO_PLAN) where.push(`sp.id IS NULL`);
  else if (query.plan && !impossible) where.push(`sp.plan_key = ${p.add(query.plan)}`);
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

/** The token categories of a conversation, as in TokenTotals. */
export interface CategoryTokens {
  input: number;
  output: number;
  unsplit: number;
  cacheWrite: number;
  cacheRead: number;
  replay: number;
}

export interface ConversationDetail {
  conversation: ConversationRow & { externalId: string; userMessages: number; assistantMessages: number };
  /**
   * True when every source that holds records of this conversation is left out of
   * totals (see `conversationShown`). Its figures are then not counted anywhere, and
   * nothing else of the result is read: `imports`, `limitations`, `methods` and
   * `messages` are empty, the token figures of `conversation` are 0, and the page shows
   * that the conversation is left out instead of figures.
   */
  leftOutOfTotals: boolean;
  /** Labels of the sources that hold records of the conversation, when it is left out of totals. */
  leftOutSources: string[];
  /** Imports that contributed records to this conversation. */
  imports: Array<{ batchId: number; fileName: string; format: string; importedAt: string }>;
  /** Why the estimate may be off: limitation → number of messages it applies to. */
  limitations: Array<{ name: LimitationName; messages: number }>;
  methods: Array<{ methodKey: string; tokenizerBasis: string; description: string; messages: number; lowFactor: number; highFactor: number }>;
  /**
   * The estimated part of each token category (the rest is exact), so that the page can
   * draw estimates as estimates. Category totals are those of getOverview for the conversation.
   */
  estimatedParts: CategoryTokens;
  /** Message metadata in order (never text). Empty for sources without per-message rows. */
  messages: Array<{
    ordinal: number;
    role: string;
    /** When the message was written, or, when `timeInferred`, the time the import borrowed for it. */
    at: string | null;
    /**
     * The source records no time for this message. The import gave it the time of the
     * nearest dated message before it, else after it, else of the conversation, so that
     * it can be placed; that time is not a recorded one.
     */
    timeInferred: boolean;
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

/** The largest value of conversations.id, a PostgreSQL integer. */
export const MAX_ID = 2_147_483_647;

const NO_CATEGORIES: CategoryTokens = { input: 0, output: 0, unsplit: 0, cacheWrite: 0, cacheRead: 0, replay: 0 };

export async function getConversationDetail(db: SqlExecutor, filter: AnalyticsFilter, id: number): Promise<ConversationDetail | null> {
  // conversations.id is a 32-bit integer. A larger number cannot name a row, and sent as a parameter it would make the statement fail.
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ID) return null;
  const found = await listConversationsById(db, filter, id);
  if (!found) return null;
  const { row: page, shown } = found;

  const counts = (
    await db.query<Record<string, unknown>>(
      `SELECT external_id, user_message_count, assistant_message_count FROM conversations WHERE id = $1 AND user_id = $2`,
      [id, filter.userId],
    )
  ).rows[0];
  const conversation = {
    ...page,
    externalId: String(counts.external_id),
    userMessages: toNumber(counts.user_message_count),
    assistantMessages: toNumber(counts.assistant_message_count),
  };

  if (!shown) {
    // Every source of the conversation is left out of totals. Its records are not counted
    // in any figure, so none is read for it: figures that leave its usage out would
    // contradict the per-message estimates, which are stored all the same.
    const sources = (
      await db.query<{ label: string }>(
        `SELECT s.label FROM data_sources s
          WHERE s.id IN (SELECT source_id FROM conversations WHERE id = $1
                         UNION SELECT source_id FROM usage_records WHERE conversation_id = $1
                         UNION SELECT b.source_id FROM messages m JOIN import_batches b ON b.id = m.batch_id WHERE m.conversation_id = $1)
          ORDER BY s.id`,
        [id],
      )
    ).rows;
    return {
      conversation,
      leftOutOfTotals: true,
      leftOutSources: sources.map((r) => r.label),
      imports: [],
      limitations: [],
      methods: [],
      estimatedParts: NO_CATEGORIES,
      messages: [],
      messagesTruncated: false,
    };
  }

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
      // Only records of sources that count: a conversation two sources added to keeps its figures in step
      // with the totals above when one of the sources is left out.
      `SELECT e.limitation_flags, count(*)::int AS n
         FROM token_estimates e JOIN data_sources es ON es.id = e.source_id
        WHERE e.conversation_id = $1 AND es.include_in_totals GROUP BY 1`,
      [id],
    )
  ).rows;
  const tally = new Map<LimitationName, number>();
  for (const r of flagRows) for (const name of decodeLimitations(r.limitation_flags)) tally.set(name, (tally.get(name) ?? 0) + r.n);

  const methods = (
    await db.query<Record<string, unknown>>(
      `SELECT m.method_key, m.tokenizer_basis, m.description, m.low_factor::float8 AS low_factor, m.high_factor::float8 AS high_factor, count(*)::int AS n
         FROM token_estimates e JOIN estimation_methods m ON m.id = e.method_id JOIN data_sources es ON es.id = e.source_id
        WHERE e.conversation_id = $1 AND es.include_in_totals GROUP BY 1, 2, 3, 4, 5 ORDER BY 6 DESC`,
      [id],
    )
  ).rows;

  // The same facts and categories as getOverview for the conversation, split by confidence.
  const p = new Params();
  const f = factsFrom({ ...filter, from: null, to: null, conversationId: id }, p);
  const estimatedRow = (
    await db.query<Record<string, unknown>>(`SELECT ${TOTAL_COLUMNS(tokenExpr(filter.basis))} FROM ${f.from} WHERE ${f.where} AND f.confidence = 'estimated'`, p.values)
  ).rows[0];
  const estimated = readTotals(estimatedRow);

  const LIMIT = 400;
  const messages = (
    await db.query<Record<string, unknown>>(
      `SELECT m.ordinal, m.role::text AS role, COALESCE(m.created_at, e.occurred_at) AS at,
              (m.created_at IS NULL AND e.occurred_at IS NOT NULL) AS time_inferred,
              m.text_chars, m.thinking_chars, m.tool_chars, m.attachment_chars, m.file_count,
              COALESCE(round(e.input_base * em.central_factor), 0)::bigint AS input,
              COALESCE(round(e.output_base * em.central_factor), 0)::bigint AS output,
              COALESCE(round(e.replay_base * em.central_factor), 0)::bigint AS replay,
              COALESCE(e.request_count, 0) AS requests
         FROM messages m
         JOIN import_batches mb ON mb.id = m.batch_id
         JOIN data_sources ms ON ms.id = mb.source_id
         LEFT JOIN token_estimates e ON e.message_id = m.id
         LEFT JOIN estimation_methods em ON em.id = e.method_id
        WHERE m.conversation_id = $1 AND ms.include_in_totals
        ORDER BY COALESCE(m.created_at, e.occurred_at), m.ordinal
        LIMIT ${LIMIT + 1}`,
      [id],
    )
  ).rows;

  return {
    conversation,
    leftOutOfTotals: false,
    leftOutSources: [],
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
    estimatedParts: {
      input: estimated.input,
      output: estimated.output,
      unsplit: estimated.unsplit,
      cacheWrite: estimated.cacheWrite,
      cacheRead: estimated.cacheRead,
      replay: estimated.replay,
    },
    messages: messages.slice(0, LIMIT).map((r) => ({
      ordinal: toNumber(r.ordinal),
      role: String(r.role),
      at: toIso(r.at),
      timeInferred: r.time_inferred === true,
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

async function listConversationsById(db: SqlExecutor, filter: AnalyticsFilter, id: number): Promise<{ row: ConversationRow; shown: boolean } | null> {
  const tok = tokenExpr(filter.basis);
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT c.id, c.title, c.kind::text AS kind, c.project_label, c.created_at, c.updated_at, c.message_count,
            mc.model_key, mc.display_name AS model_name,
            COALESCE(t.tokens, 0) AS tokens, COALESCE(t.exact, 0) AS exact, COALESCE(t.estimated, 0) AS estimated,
            s.kind::text AS source_kind, s.label AS source_label, s.is_synthetic, sp.plan_key, sp.label AS plan_label,
            ${conversationShown()} AS shown
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
      WHERE c.id = $1 AND c.user_id = $2 AND ${CONVERSATION_KINDS}`,
    [id, filter.userId, filter.timezone],
  );
  const r = rows[0];
  if (!r) return null;
  const row: ConversationRow = {
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
  return { row, shown: r.shown === true };
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
      WHERE c.user_id = $1 AND ${conversationShown()} AND ${CONVERSATION_KINDS}
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
