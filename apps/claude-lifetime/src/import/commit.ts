import { ImportError, type ParsedImport } from '@/core/types';
import { toIso, toNumber, type SqlDriver, type SqlExecutor } from '@/db/driver';

/**
 * Preview and commit of a staged import (see staging.ts).
 *
 * Deduplication rules, by kind of record:
 *  - conversations      one row per (user, dedup_key); a later import of the same
 *                       conversation updates its title and dates and adds new messages
 *  - messages           unique per (conversation, external_id); already-known messages
 *                       are skipped, so importing a file twice adds nothing
 *  - usage / cost rows  unique per (user, dedup_key)
 *  - restated reports   (ParsedImport.replaceRange) replace the same source's rows
 *                       inside the reported time range instead of adding to them
 *  - Claude Code        requests are deduplicated by 64-bit request hash before
 *                       staging; the hashes are stored on the batch that counted them
 */

export interface ImportPreview {
  format: string;
  formatLabel: string;
  source: ParsedImport['source'];
  fileName: string;
  fileSize: number;
  /** Set when a file with the same SHA-256 was imported before. */
  previousImport: { batchId: number; importedAt: string } | null;
  recordsSeen: number;
  recordsSkipped: number;
  conversations: { total: number; new: number; existing: number };
  messages: { total: number; new: number; duplicate: number; withoutModel: number; withoutTimestamp: number };
  usageRows: { total: number; new: number; duplicate: number; withoutModel: number };
  costRows: { total: number; new: number; duplicate: number };
  /** Claude Code API requests: newly counted vs already counted by an earlier import. */
  requests: { new: number; duplicate: number } | null;
  /** Existing rows that will be replaced because the input restates their time range. */
  replaced: { usageRows: number; costRows: number; tokens: number } | null;
  /** Tokens this import would add (processed basis). */
  tokens: { exact: number; estimated: number };
  dateRange: { start: string | null; end: string | null };
  /** Share of new rows that carry the metadata the dashboard relies on. */
  coverage: { hasExactUsage: boolean; hasModel: boolean; modelShare: number | null; hasTimestamps: boolean };
  models: string[];
  missingFields: string[];
  warnings: ParsedImport['warnings'];
  /** Real data would replace the synthetic demo dataset. */
  willRemoveDemoData: boolean;
  nothingNew: boolean;
}

export interface CommitResult {
  batchId: number | null;
  sourceId: number | null;
  inserted: { conversations: number; messages: number; usageRows: number; costRows: number };
  duplicates: { messages: number; usageRows: number; costRows: number };
  replaced: { usageRows: number; costRows: number };
  removedDemoData: boolean;
  nothingNew: boolean;
}

const one = async <T>(db: SqlExecutor, sql: string, params: unknown[] = []): Promise<T> => {
  const { rows } = await db.query<T>(sql, params);
  return rows[0];
};

async function sourceIdFor(db: SqlExecutor, userId: number, parsed: ParsedImport): Promise<number | null> {
  const row = await one<{ id: number } | undefined>(
    db,
    `SELECT id FROM data_sources WHERE user_id = $1 AND kind = $2::source_kind AND external_ref = $3`,
    [userId, parsed.source.kind, parsed.source.externalRef],
  );
  return row?.id ?? null;
}

async function assertStagingValid(db: SqlExecutor) {
  const bad = await db.query<{ method_key: string }>(
    `SELECT DISTINCT method_key FROM stg_messages WHERE method_key NOT IN (SELECT method_key FROM estimation_methods) LIMIT 3`,
  );
  if (bad.rows.length > 0) {
    throw new ImportError(
      `The import refers to an unknown estimation method (${bad.rows.map((r) => r.method_key).join(', ')}).`,
      'unknown_estimation_method',
    );
  }
}

export async function previewImport(db: SqlExecutor, userId: number, parsed: ParsedImport): Promise<ImportPreview> {
  await assertStagingValid(db);
  const sourceId = await sourceIdFor(db, userId, parsed);

  const conv = await one<{ total: number; fresh: number }>(
    db,
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.id IS NULL)::int AS fresh
       FROM stg_conversations s LEFT JOIN conversations c ON c.user_id = $1 AND c.dedup_key = s.dedup_key`,
    [userId],
  );

  const msg = await one<Record<string, unknown>>(
    db,
    `WITH d AS (SELECT DISTINCT ON (conversation_key, external_id) * FROM stg_messages ORDER BY conversation_key, external_id, ordinal)
     SELECT (SELECT count(*) FROM stg_messages)::int AS staged,
            count(*)::int AS total,
            count(*) FILTER (WHERE m.id IS NULL)::int AS fresh,
            count(*) FILTER (WHERE m.id IS NULL AND d.model_key IS NULL)::int AS without_model,
            count(*) FILTER (WHERE m.id IS NULL AND d.created_at IS NULL)::int AS without_timestamp,
            -- rounded per category, exactly as the usage_facts view does, so the preview matches the dashboard
            COALESCE(sum(round(d.input_base * em.central_factor) + round(d.output_base * em.central_factor) + round(d.replay_base * em.central_factor))
                     FILTER (WHERE m.id IS NULL), 0)::bigint AS tokens,
            min(d.occurred_at) FILTER (WHERE m.id IS NULL) AS first_at,
            max(d.occurred_at) FILTER (WHERE m.id IS NULL) AS last_at
       FROM d
       JOIN estimation_methods em ON em.method_key = d.method_key
       LEFT JOIN conversations c ON c.user_id = $1 AND c.dedup_key = d.conversation_key
       LEFT JOIN messages m ON m.conversation_id = c.id AND m.external_id = d.external_id`,
    [userId],
  );

  const replacing = parsed.replaceRange && sourceId !== null;
  const use = await one<Record<string, unknown>>(
    db,
    `WITH d AS (SELECT DISTINCT ON (dedup_key) * FROM stg_usage ORDER BY dedup_key)
     SELECT (SELECT count(*) FROM stg_usage)::int AS staged,
            count(*)::int AS total,
            count(*) FILTER (WHERE $2 OR u.id IS NULL)::int AS fresh,
            count(*) FILTER (WHERE ($2 OR u.id IS NULL) AND d.model_key IS NULL)::int AS without_model,
            COALESCE(sum(d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_5m_tokens + d.cache_write_1h_tokens)
                     FILTER (WHERE ($2 OR u.id IS NULL) AND d.confidence = 'exact'), 0)::bigint AS exact_tokens,
            COALESCE(sum(d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_5m_tokens + d.cache_write_1h_tokens)
                     FILTER (WHERE ($2 OR u.id IS NULL) AND d.confidence <> 'exact'), 0)::bigint AS estimated_tokens,
            min(d.occurred_at) FILTER (WHERE $2 OR u.id IS NULL) AS first_at,
            max(d.occurred_at) FILTER (WHERE $2 OR u.id IS NULL) AS last_at
       FROM d LEFT JOIN usage_records u ON u.user_id = $1 AND u.dedup_key = d.dedup_key`,
    [userId, Boolean(replacing)],
  );

  const cost = await one<{ staged: number; total: number; fresh: number }>(
    db,
    `WITH d AS (SELECT DISTINCT ON (dedup_key) * FROM stg_costs ORDER BY dedup_key)
     SELECT (SELECT count(*) FROM stg_costs)::int AS staged, count(*)::int AS total,
            count(*) FILTER (WHERE $2 OR r.id IS NULL)::int AS fresh
       FROM d LEFT JOIN reported_costs r ON r.user_id = $1 AND r.dedup_key = d.dedup_key`,
    [userId, Boolean(replacing)],
  );

  let replaced: ImportPreview['replaced'] = null;
  if (replacing && parsed.replaceRange) {
    const r = await one<{ usage_rows: number; tokens: unknown; cost_rows: number }>(
      db,
      `SELECT (SELECT count(*) FROM usage_records WHERE source_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz)::int AS usage_rows,
              (SELECT COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens), 0)
                 FROM usage_records WHERE source_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz)::bigint AS tokens,
              (SELECT count(*) FROM reported_costs WHERE source_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz)::int AS cost_rows`,
      [sourceId, parsed.replaceRange.start, parsed.replaceRange.end],
    );
    replaced = { usageRows: r.usage_rows, costRows: r.cost_rows, tokens: toNumber(r.tokens) };
  }

  const previous = parsed.contentHash
    ? await one<{ id: number; created_at: Date } | undefined>(
        db,
        `SELECT id, created_at FROM import_batches WHERE user_id = $1 AND content_hash = $2 ORDER BY created_at DESC LIMIT 1`,
        [userId, parsed.contentHash],
      )
    : undefined;

  const models = await db.query<{ k: string }>(
    `SELECT DISTINCT k FROM (SELECT model_key AS k FROM stg_messages UNION SELECT model_key FROM stg_usage UNION SELECT model_key FROM stg_conversations) x
      WHERE k IS NOT NULL ORDER BY k LIMIT 50`,
  );

  const demo = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM data_sources WHERE user_id = $1 AND is_synthetic`, [userId]);

  const newMessages = toNumber(msg.fresh);
  const newUsage = toNumber(use.fresh);
  const newCost = cost.fresh;
  const rowsWithModelBase = newMessages + newUsage;
  const rowsWithoutModel = toNumber(msg.without_model) + toNumber(use.without_model);
  const starts = [toIso(msg.first_at), toIso(use.first_at), parsed.replaceRange?.start ?? null].filter(Boolean) as string[];
  const ends = [toIso(msg.last_at), toIso(use.last_at)].filter(Boolean) as string[];

  return {
    format: parsed.format,
    formatLabel: parsed.formatLabel,
    source: parsed.source,
    fileName: parsed.fileName,
    fileSize: parsed.fileSize,
    previousImport: previous ? { batchId: previous.id, importedAt: toIso(previous.created_at)! } : null,
    recordsSeen: parsed.recordsSeen,
    recordsSkipped: parsed.recordsSkipped,
    conversations: { total: conv.total, new: conv.fresh, existing: conv.total - conv.fresh },
    messages: {
      total: toNumber(msg.staged),
      new: newMessages,
      duplicate: toNumber(msg.staged) - newMessages,
      withoutModel: toNumber(msg.without_model),
      withoutTimestamp: toNumber(msg.without_timestamp),
    },
    usageRows: {
      total: toNumber(use.staged),
      new: newUsage,
      duplicate: toNumber(use.staged) - newUsage,
      withoutModel: toNumber(use.without_model),
    },
    costRows: { total: cost.staged, new: newCost, duplicate: cost.staged - newCost },
    requests:
      parsed.requestKeys || parsed.duplicateRequests !== undefined
        ? { new: parsed.requestKeys?.length ?? 0, duplicate: parsed.duplicateRequests ?? 0 }
        : null,
    replaced,
    tokens: { exact: toNumber(use.exact_tokens), estimated: toNumber(msg.tokens) + toNumber(use.estimated_tokens) },
    dateRange: {
      start: starts.length ? starts.sort()[0] : null,
      end: ends.length ? ends.sort()[ends.length - 1] : null,
    },
    coverage: {
      hasExactUsage: toNumber(use.exact_tokens) > 0,
      hasModel: rowsWithModelBase > 0 && rowsWithoutModel < rowsWithModelBase,
      modelShare: rowsWithModelBase > 0 ? 1 - rowsWithoutModel / rowsWithModelBase : null,
      hasTimestamps: toNumber(msg.without_timestamp) === 0,
    },
    models: models.rows.map((r) => r.k),
    missingFields: parsed.missingFields,
    warnings: parsed.warnings,
    willRemoveDemoData: !parsed.source.isSynthetic && demo.n > 0,
    nothingNew: newMessages === 0 && newUsage === 0 && newCost === 0,
  };
}

/** Changes whenever any import is committed; lets a commit detect a stale preview. */
export async function importGeneration(db: SqlExecutor, userId: number): Promise<number> {
  const row = await one<{ g: number }>(db, `SELECT COALESCE(max(id), 0)::int AS g FROM import_batches WHERE user_id = $1`, [userId]);
  return row.g;
}

export async function loadKnownRequestKeys(db: SqlExecutor, userId: number): Promise<Set<bigint>> {
  const { rows } = await db.query<{ k: bigint | number | string }>(
    `SELECT unnest(request_keys) AS k FROM import_batches WHERE user_id = $1 AND cardinality(request_keys) > 0`,
    [userId],
  );
  const set = new Set<bigint>();
  for (const r of rows) set.add(BigInt(r.k));
  return set;
}

export interface CommitOptions {
  /** Value of importGeneration() when the input was parsed. Guards request-level deduplication. */
  generation?: number;
}

export async function commitImport(
  db: SqlDriver,
  userId: number,
  parsed: ParsedImport,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const result = await db.transaction(async (tx) => {
    await assertStagingValid(tx);

    if (options.generation !== undefined && parsed.requestKeys !== undefined) {
      const now = await importGeneration(tx, userId);
      if (now !== options.generation) {
        throw new ImportError(
          'Other data was imported after this preview was prepared. Run the import again so duplicates are detected correctly.',
          'stale_preview',
        );
      }
    }

    // Synthetic demo data and real data never live side by side.
    let removedDemoData = false;
    if (parsed.source.isSynthetic) {
      const real = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM data_sources WHERE user_id = $1 AND NOT is_synthetic`, [userId]);
      if (real.n > 0) {
        throw new ImportError(
          'The demo dataset can only be loaded into an empty workspace. Delete your imported data first, or keep working with your real data.',
          'demo_requires_empty_workspace',
        );
      }
    } else {
      const demo = await tx.query(`DELETE FROM data_sources WHERE user_id = $1 AND is_synthetic`, [userId]);
      await tx.query(`DELETE FROM subscription_periods WHERE user_id = $1 AND is_synthetic`, [userId]);
      removedDemoData = (demo.affectedRows ?? 0) > 0;
    }

    const existingSourceId = await sourceIdFor(tx, userId, parsed);
    const source = await one<{ id: number }>(
      tx,
      `INSERT INTO data_sources (user_id, kind, label, external_ref, is_synthetic)
       VALUES ($1, $2::source_kind, $3, $4, $5)
       ON CONFLICT (user_id, kind, external_ref) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
       RETURNING id`,
      [userId, parsed.source.kind, parsed.source.label, parsed.source.externalRef, parsed.source.isSynthetic ?? false],
    );
    const sourceId = source.id;

    const batch = await one<{ id: number }>(
      tx,
      `INSERT INTO import_batches (user_id, source_id, file_name, file_size, content_hash, format, parser_version,
                                   records_seen, records_skipped, missing_fields, warnings, stats, request_keys)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::jsonb, $12::jsonb, $13::bigint[])
       RETURNING id`,
      [
        userId, sourceId, parsed.fileName, parsed.fileSize, parsed.contentHash, parsed.format, parsed.parserVersion,
        parsed.recordsSeen, parsed.recordsSkipped, parsed.missingFields,
        JSON.stringify(parsed.warnings), JSON.stringify(parsed.stats), (parsed.requestKeys ?? []).map((k) => k.toString()),
      ],
    );
    const batchId = batch.id;

    // Model identifiers the catalog has not seen before are added verbatim.
    await tx.query(
      `INSERT INTO model_catalog (model_key, display_name, family, tokenizer_family, is_builtin)
       SELECT key, display_name, family, tokenizer_family, false FROM stg_models
       ON CONFLICT (model_key) DO NOTHING`,
    );

    const replaced = { usageRows: 0, costRows: 0 };
    if (parsed.replaceRange && existingSourceId !== null) {
      const range = [sourceId, parsed.replaceRange.start, parsed.replaceRange.end];
      const u = await tx.query(`DELETE FROM usage_records WHERE source_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`, range);
      const c = await tx.query(`DELETE FROM reported_costs WHERE source_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`, range);
      replaced.usageRows = u.affectedRows ?? 0;
      replaced.costRows = c.affectedRows ?? 0;
    }

    const conv = await tx.query<{ inserted: boolean }>(
      `INSERT INTO conversations (user_id, source_id, kind, external_id, dedup_key, title, project_label, model_id, created_at, updated_at, metadata)
       SELECT $1, $2, s.kind::conversation_kind, s.external_id, s.dedup_key, s.title, s.project_label, mc.id, s.created_at, s.updated_at, s.metadata
         FROM stg_conversations s LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
       ON CONFLICT (user_id, dedup_key) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, conversations.title),
         project_label = COALESCE(EXCLUDED.project_label, conversations.project_label),
         model_id = COALESCE(conversations.model_id, EXCLUDED.model_id),
         created_at = LEAST(conversations.created_at, EXCLUDED.created_at),
         updated_at = GREATEST(conversations.updated_at, EXCLUDED.updated_at),
         metadata = conversations.metadata || EXCLUDED.metadata
       RETURNING (xmax = 0) AS inserted`,
      [userId, sourceId],
    );
    const insertedConversations = conv.rows.filter((r) => r.inserted).length;

    const stagedMessages = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM stg_messages`);
    const msg = await tx.query(
      `INSERT INTO messages (conversation_id, batch_id, external_id, parent_external_id, role, created_at, ordinal, model_id,
                             text_chars, thinking_chars, tool_chars, attachment_chars, attachment_count, file_count)
       SELECT c.id, $2, s.external_id, s.parent_external_id, s.role::message_role, s.created_at, s.ordinal, mc.id,
              s.text_chars, s.thinking_chars, s.tool_chars, s.attachment_chars, s.attachment_count, s.file_count
         FROM stg_messages s
         JOIN conversations c ON c.user_id = $1 AND c.dedup_key = s.conversation_key
         LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
        ORDER BY s.conversation_key, s.ordinal
       ON CONFLICT (conversation_id, external_id) DO NOTHING`,
      [userId, batchId],
    );
    const insertedMessages = msg.affectedRows ?? 0;

    await tx.query(
      `INSERT INTO token_estimates (message_id, user_id, source_id, batch_id, conversation_id, model_id, occurred_at, role,
                                    input_base, output_base, replay_base, replay_cached_base, request_count, method_id, limitation_flags)
       SELECT DISTINCT ON (m.id) m.id, $1, $3, $2, c.id, mc.id, s.occurred_at, s.role::message_role,
              s.input_base, s.output_base, s.replay_base, s.replay_cached_base, s.request_count, em.id, s.limitation_flags
         FROM stg_messages s
         JOIN conversations c ON c.user_id = $1 AND c.dedup_key = s.conversation_key
         JOIN messages m ON m.conversation_id = c.id AND m.external_id = s.external_id AND m.batch_id = $2
         JOIN estimation_methods em ON em.method_key = s.method_key
         LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
        ORDER BY m.id, s.ordinal`,
      [userId, batchId, sourceId],
    );

    // Analytics read estimated usage from 15-minute buckets, not from one row per message.
    await tx.query(`SELECT refresh_estimate_buckets($1::int)`, [batchId]);

    const stagedUsage = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM stg_usage`);
    const use = await tx.query(
      `INSERT INTO usage_records (user_id, source_id, batch_id, conversation_id, model_id, occurred_at, bucket_seconds, price_tier,
                                  input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
                                  request_count, user_message_count, assistant_message_count, web_search_requests, confidence, dedup_key)
       SELECT $1, $3, $2, c.id, mc.id, s.occurred_at, s.bucket_seconds, s.price_tier,
              s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_5m_tokens, s.cache_write_1h_tokens,
              s.request_count, s.user_message_count, s.assistant_message_count, s.web_search_requests, s.confidence::confidence, s.dedup_key
         FROM stg_usage s
         LEFT JOIN conversations c ON c.user_id = $1 AND c.dedup_key = s.conversation_key
         LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
       ON CONFLICT (user_id, dedup_key) DO NOTHING`,
      [userId, batchId, sourceId],
    );
    const insertedUsage = use.affectedRows ?? 0;

    const stagedCosts = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM stg_costs`);
    const cost = await tx.query(
      `INSERT INTO reported_costs (user_id, source_id, batch_id, model_id, occurred_at, bucket_seconds, cost_type, token_type, description, amount_usd, dedup_key)
       SELECT $1, $3, $2, mc.id, s.occurred_at, s.bucket_seconds, s.cost_type, s.token_type, s.description, s.amount_usd, s.dedup_key
         FROM stg_costs s LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
       ON CONFLICT (user_id, dedup_key) DO NOTHING`,
      [userId, batchId, sourceId],
    );
    const insertedCosts = cost.affectedRows ?? 0;

    if (parsed.syncedFiles?.length) {
      await tx.query(
        `INSERT INTO synced_files (source_id, path, size, last_modified)
         SELECT $1, p, s, to_timestamp(m / 1000.0)
           FROM unnest($2::text[], $3::bigint[], $4::double precision[]) AS x(p, s, m)
         ON CONFLICT (source_id, path) DO UPDATE SET size = EXCLUDED.size, last_modified = EXCLUDED.last_modified, synced_at = now()`,
        [sourceId, parsed.syncedFiles.map((f) => f.path), parsed.syncedFiles.map((f) => f.size), parsed.syncedFiles.map((f) => f.lastModified)],
      );
    }

    const nothingNew = insertedMessages === 0 && insertedUsage === 0 && insertedCosts === 0 && replaced.usageRows === 0 && replaced.costRows === 0;
    if (nothingNew) {
      // Leave no empty batch (or empty, just-created source) behind.
      await tx.query(`DELETE FROM import_batches WHERE id = $1`, [batchId]);
      if (existingSourceId === null && !parsed.syncedFiles?.length) await tx.query(`DELETE FROM data_sources WHERE id = $1`, [sourceId]);
    } else {
      await refreshConversationCounters(tx, userId, `c.dedup_key IN (SELECT dedup_key FROM stg_conversations)`);
      await tx.query(
        `UPDATE import_batches b SET
           records_inserted = $2, records_duplicate = $3,
           coverage_start = r.first_at, coverage_end = r.last_at
          FROM (SELECT min(occurred_at) AS first_at, max(occurred_at) AS last_at
                  FROM (SELECT occurred_at FROM usage_records WHERE batch_id = $1
                        UNION ALL SELECT occurred_at FROM token_estimates WHERE batch_id = $1
                        UNION ALL SELECT occurred_at FROM reported_costs WHERE batch_id = $1) x) r
         WHERE b.id = $1`,
        [
          batchId,
          insertedMessages + insertedUsage + insertedCosts,
          stagedMessages.n - insertedMessages + (stagedUsage.n - insertedUsage) + (stagedCosts.n - insertedCosts) + (parsed.duplicateRequests ?? 0),
        ],
      );
    }

    return {
      batchId: nothingNew ? null : batchId,
      sourceId: nothingNew && existingSourceId === null && !parsed.syncedFiles?.length ? null : sourceId,
      inserted: { conversations: insertedConversations, messages: insertedMessages, usageRows: insertedUsage, costRows: insertedCosts },
      duplicates: {
        messages: stagedMessages.n - insertedMessages,
        usageRows: stagedUsage.n - insertedUsage,
        costRows: stagedCosts.n - insertedCosts,
      },
      replaced,
      removedDemoData,
      nothingNew,
    } satisfies CommitResult;
  });

  await db.exec('TRUNCATE stg_models, stg_conversations, stg_messages, stg_usage, stg_costs;');
  await db.flush();
  return result;
}

/**
 * Recomputes the denormalised counters and activity range of conversations from
 * their messages and usage rows. `where` is a trusted SQL predicate on alias `c`.
 */
export async function refreshConversationCounters(tx: SqlExecutor, userId: number, where: string): Promise<void> {
  await tx.query(
    `UPDATE conversations c SET
       message_count = COALESCE(m.n, 0) + COALESCE(u.um, 0) + COALESCE(u.am, 0),
       user_message_count = COALESCE(m.un, 0) + COALESCE(u.um, 0),
       assistant_message_count = COALESCE(m.an, 0) + COALESCE(u.am, 0),
       created_at = COALESCE(c.created_at, LEAST(e.first_at, u.first_at)),
       updated_at = GREATEST(c.updated_at, e.last_at, u.last_at)
      FROM conversations t
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n, count(*) FILTER (WHERE role = 'user')::int AS un, count(*) FILTER (WHERE role = 'assistant')::int AS an
          FROM messages WHERE conversation_id = t.id) m ON true
      LEFT JOIN LATERAL (
        SELECT min(occurred_at) AS first_at, max(occurred_at) AS last_at FROM token_estimates WHERE conversation_id = t.id) e ON true
      LEFT JOIN LATERAL (
        SELECT sum(user_message_count)::int AS um, sum(assistant_message_count)::int AS am,
               min(occurred_at) AS first_at, max(occurred_at) AS last_at
          FROM usage_records WHERE conversation_id = t.id) u ON true
     WHERE c.id = t.id AND c.user_id = $1 AND ${where}`,
    [userId],
  );
}
