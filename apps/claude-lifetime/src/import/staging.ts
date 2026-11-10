import type {
  ImportSink,
  StagedConversation,
  StagedCost,
  StagedMessage,
  StagedModel,
  StagedUsage,
} from '@/core/types';
import type { SqlExecutor } from '@/db/driver';

/**
 * Parsed records are first written to session-local TEMP tables. The preview is
 * computed from them with SQL (so "what is new, what is a duplicate" is answered by
 * the same database that holds the existing data), and the commit merges them into
 * the real tables in one transaction. Nothing touches real data before the user
 * confirms, memory use stays bounded for large files, and discarding an import is a
 * TRUNCATE.
 */
export const STAGING_DDL = `
CREATE TEMP TABLE IF NOT EXISTS stg_models (
  key text PRIMARY KEY, display_name text NOT NULL, family text NOT NULL, tokenizer_family text NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS stg_conversations (
  dedup_key text PRIMARY KEY, kind text NOT NULL, external_id text NOT NULL, title text, project_label text,
  model_key text, created_at timestamptz, updated_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TEMP TABLE IF NOT EXISTS stg_messages (
  conversation_key text NOT NULL, external_id text NOT NULL, parent_external_id text, role text NOT NULL,
  created_at timestamptz, occurred_at timestamptz NOT NULL, ordinal int NOT NULL, model_key text,
  text_chars int NOT NULL, thinking_chars int NOT NULL, tool_chars int NOT NULL, attachment_chars int NOT NULL,
  attachment_count int NOT NULL, file_count int NOT NULL,
  input_base int NOT NULL, output_base int NOT NULL, replay_base bigint NOT NULL, replay_cached_base bigint NOT NULL,
  request_count int NOT NULL, method_key text NOT NULL, limitation_flags int NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS stg_usage (
  conversation_key text, model_key text, occurred_at timestamptz NOT NULL, bucket_seconds int NOT NULL,
  price_tier text NOT NULL, input_tokens bigint NOT NULL, output_tokens bigint NOT NULL,
  cache_read_tokens bigint NOT NULL, cache_write_5m_tokens bigint NOT NULL, cache_write_1h_tokens bigint NOT NULL,
  request_count int NOT NULL, user_message_count int NOT NULL, assistant_message_count int NOT NULL,
  web_search_requests int NOT NULL, confidence text NOT NULL, dedup_key text NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS stg_costs (
  model_key text, occurred_at timestamptz NOT NULL, bucket_seconds int NOT NULL, cost_type text, token_type text,
  description text, amount_usd numeric(20,8) NOT NULL, dedup_key text NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS stg_owner (token text NOT NULL);`;

/**
 * Empties the staging tables and returns a token that stands for whatever is staged
 * from now on. Every reset makes a new one, so a commit that presents its token (see
 * commitImport) can tell whether the records it previewed are still the ones staged.
 */
export async function resetStaging(db: SqlExecutor): Promise<string> {
  // Hex digits and dashes only, so it can be written into the statement as it is.
  const token = globalThis.crypto.randomUUID();
  await db.exec(STAGING_DDL);
  await db.exec(`TRUNCATE stg_models, stg_conversations, stg_messages, stg_usage, stg_costs, stg_owner; INSERT INTO stg_owner (token) VALUES ('${token}');`);
  return token;
}

/** The token of the records that are staged right now, or null when nothing was ever staged in this session. */
export async function stagingToken(db: SqlExecutor): Promise<string | null> {
  // The tables are session-local: they are gone when the tab that hosted the database was closed and another took over.
  const present = await db.query<{ present: boolean }>(`SELECT to_regclass('pg_temp.stg_owner') IS NOT NULL AS present`);
  if (present.rows[0]?.present !== true) return null;
  const { rows } = await db.query<{ token: string }>(`SELECT token FROM stg_owner LIMIT 1`);
  return rows[0]?.token ?? null;
}

const BATCH = 4000;

/**
 * Buffers records and writes them to the staging tables in multi-row statements.
 * Implements ImportSink, so a parser can write straight into it (tests, Node) or a
 * worker can forward its batches to it (browser).
 */
export class StagingWriter implements ImportSink {
  private models: StagedModel[] = [];
  private conversations: StagedConversation[] = [];
  private messages: StagedMessage[] = [];
  private usages: StagedUsage[] = [];
  private costs: StagedCost[] = [];
  private chain: Promise<void> = Promise.resolve();
  readonly counts = { models: 0, conversations: 0, messages: 0, usage: 0, costs: 0 };

  constructor(private readonly db: SqlExecutor) {}

  model(m: StagedModel) {
    this.models.push(m);
    this.counts.models++;
    if (this.models.length >= BATCH) return this.flushModels();
  }

  conversation(c: StagedConversation) {
    this.conversations.push(c);
    this.counts.conversations++;
    if (this.conversations.length >= BATCH) return this.flushConversations();
  }

  message(m: StagedMessage) {
    this.messages.push(m);
    this.counts.messages++;
    if (this.messages.length >= BATCH) return this.flushMessages();
  }

  usage(u: StagedUsage) {
    this.usages.push(u);
    this.counts.usage++;
    if (this.usages.length >= BATCH) return this.flushUsage();
  }

  cost(c: StagedCost) {
    this.costs.push(c);
    this.counts.costs++;
    if (this.costs.length >= BATCH) return this.flushCosts();
  }

  /** Bulk entry points used when a worker hands over whole batches. */
  addBatch(batch: Partial<StagedBatch>): Promise<void> {
    for (const m of batch.models ?? []) this.models.push(m);
    for (const c of batch.conversations ?? []) this.conversations.push(c);
    for (const m of batch.messages ?? []) this.messages.push(m);
    for (const u of batch.usage ?? []) this.usages.push(u);
    for (const c of batch.costs ?? []) this.costs.push(c);
    this.counts.models += batch.models?.length ?? 0;
    this.counts.conversations += batch.conversations?.length ?? 0;
    this.counts.messages += batch.messages?.length ?? 0;
    this.counts.usage += batch.usage?.length ?? 0;
    this.counts.costs += batch.costs?.length ?? 0;
    return this.finish();
  }

  /** Writes everything still buffered. Must be awaited before previewing or committing. */
  async finish(): Promise<void> {
    void this.flushModels();
    void this.flushConversations();
    void this.flushMessages();
    void this.flushUsage();
    void this.flushCosts();
    await this.chain;
  }

  private enqueue(job: () => Promise<unknown>): Promise<void> {
    // Statements run strictly one after another; errors surface on the next await.
    this.chain = this.chain.then(() => job()).then(() => undefined);
    return this.chain;
  }

  private flushModels(): Promise<void> {
    const rows = this.models;
    if (rows.length === 0) return this.chain;
    this.models = [];
    return this.enqueue(() =>
      this.db.query(
        `INSERT INTO stg_models (key, display_name, family, tokenizer_family)
         SELECT DISTINCT ON (k) k, d, f, t FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(k, d, f, t)
         ON CONFLICT (key) DO NOTHING`,
        [rows.map((r) => r.key), rows.map((r) => r.displayName), rows.map((r) => r.family), rows.map((r) => r.tokenizerFamily)],
      ),
    );
  }

  private flushConversations(): Promise<void> {
    const rows = this.conversations;
    if (rows.length === 0) return this.chain;
    this.conversations = [];
    return this.enqueue(() =>
      this.db.query(
        `INSERT INTO stg_conversations (dedup_key, kind, external_id, title, project_label, model_key, created_at, updated_at, metadata)
         SELECT DISTINCT ON (k) k, kind, ext, title, proj, model, created::timestamptz, updated::timestamptz, meta::jsonb
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
             AS x(k, kind, ext, title, proj, model, created, updated, meta)
         ON CONFLICT (dedup_key) DO UPDATE SET
           title = COALESCE(EXCLUDED.title, stg_conversations.title),
           project_label = COALESCE(EXCLUDED.project_label, stg_conversations.project_label),
           model_key = COALESCE(stg_conversations.model_key, EXCLUDED.model_key),
           created_at = LEAST(stg_conversations.created_at, EXCLUDED.created_at),
           updated_at = GREATEST(stg_conversations.updated_at, EXCLUDED.updated_at),
           metadata = stg_conversations.metadata || EXCLUDED.metadata`,
        [
          rows.map((r) => r.dedupKey),
          rows.map((r) => r.kind),
          rows.map((r) => r.externalId),
          rows.map((r) => r.title),
          rows.map((r) => r.projectLabel),
          rows.map((r) => r.modelKey),
          rows.map((r) => r.createdAt),
          rows.map((r) => r.updatedAt),
          rows.map((r) => JSON.stringify(r.metadata ?? {})),
        ],
      ),
    );
  }

  private flushMessages(): Promise<void> {
    const rows = this.messages;
    if (rows.length === 0) return this.chain;
    this.messages = [];
    return this.enqueue(() =>
      this.db.query(
        `INSERT INTO stg_messages (conversation_key, external_id, parent_external_id, role, created_at, occurred_at, ordinal, model_key,
            text_chars, thinking_chars, tool_chars, attachment_chars, attachment_count, file_count,
            input_base, output_base, replay_base, replay_cached_base, request_count, method_key, limitation_flags)
         SELECT ck, ext, parent, role, created::timestamptz, occurred::timestamptz, ord, model,
                tc, thc, toc, ac, an, fn, ib, ob, rb, rcb, rc, mk, lf
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[],
                       $9::int[], $10::int[], $11::int[], $12::int[], $13::int[], $14::int[],
                       $15::int[], $16::int[], $17::bigint[], $18::bigint[], $19::int[], $20::text[], $21::int[])
             AS x(ck, ext, parent, role, created, occurred, ord, model, tc, thc, toc, ac, an, fn, ib, ob, rb, rcb, rc, mk, lf)`,
        [
          rows.map((r) => r.conversationKey),
          rows.map((r) => r.externalId),
          rows.map((r) => r.parentExternalId),
          rows.map((r) => r.role),
          rows.map((r) => r.createdAt),
          rows.map((r) => r.occurredAt),
          rows.map((r) => r.ordinal),
          rows.map((r) => r.modelKey),
          rows.map((r) => r.textChars),
          rows.map((r) => r.thinkingChars),
          rows.map((r) => r.toolChars),
          rows.map((r) => r.attachmentChars),
          rows.map((r) => r.attachmentCount),
          rows.map((r) => r.fileCount),
          rows.map((r) => r.inputBase),
          rows.map((r) => r.outputBase),
          rows.map((r) => r.replayBase),
          rows.map((r) => r.replayCachedBase),
          rows.map((r) => r.requestCount),
          rows.map((r) => r.methodKey),
          rows.map((r) => r.limitationFlags),
        ],
      ),
    );
  }

  private flushUsage(): Promise<void> {
    const rows = this.usages;
    if (rows.length === 0) return this.chain;
    this.usages = [];
    return this.enqueue(() =>
      this.db.query(
        `INSERT INTO stg_usage (conversation_key, model_key, occurred_at, bucket_seconds, price_tier,
            input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
            request_count, user_message_count, assistant_message_count, web_search_requests, confidence, dedup_key)
         SELECT ck, model, occurred::timestamptz, bs, tier, i, o, cr, cw5, cw1, rc, um, am, ws, conf, dk
           FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[],
                       $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[],
                       $11::int[], $12::int[], $13::int[], $14::int[], $15::text[], $16::text[])
             AS x(ck, model, occurred, bs, tier, i, o, cr, cw5, cw1, rc, um, am, ws, conf, dk)`,
        [
          rows.map((r) => r.conversationKey),
          rows.map((r) => r.modelKey),
          rows.map((r) => r.occurredAt),
          rows.map((r) => r.bucketSeconds),
          rows.map((r) => r.priceTier),
          rows.map((r) => r.inputTokens),
          rows.map((r) => r.outputTokens),
          rows.map((r) => r.cacheReadTokens),
          rows.map((r) => r.cacheWrite5mTokens),
          rows.map((r) => r.cacheWrite1hTokens),
          rows.map((r) => r.requestCount),
          rows.map((r) => r.userMessageCount),
          rows.map((r) => r.assistantMessageCount),
          rows.map((r) => r.webSearchRequests),
          rows.map((r) => r.confidence),
          rows.map((r) => r.dedupKey),
        ],
      ),
    );
  }

  private flushCosts(): Promise<void> {
    const rows = this.costs;
    if (rows.length === 0) return this.chain;
    this.costs = [];
    return this.enqueue(() =>
      this.db.query(
        `INSERT INTO stg_costs (model_key, occurred_at, bucket_seconds, cost_type, token_type, description, amount_usd, dedup_key)
         SELECT model, occurred::timestamptz, bs, ct, tt, descr, amount::numeric, dk
           FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
             AS x(model, occurred, bs, ct, tt, descr, amount, dk)`,
        [
          rows.map((r) => r.modelKey),
          rows.map((r) => r.occurredAt),
          rows.map((r) => r.bucketSeconds),
          rows.map((r) => r.costType),
          rows.map((r) => r.tokenType),
          rows.map((r) => r.description),
          rows.map((r) => r.amountUsd),
          rows.map((r) => r.dedupKey),
        ],
      ),
    );
  }
}

/** A chunk of parsed records, as posted from the parser worker to the page. */
export interface StagedBatch {
  models: StagedModel[];
  conversations: StagedConversation[];
  messages: StagedMessage[];
  usage: StagedUsage[];
  costs: StagedCost[];
}
