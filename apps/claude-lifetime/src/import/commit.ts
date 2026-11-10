import { ImportError, type ParsedImport } from '@/core/types';
import { toIso, toNumber, type SqlDriver, type SqlExecutor } from '@/db/driver';
import { refreshStatistics } from '@/db/maintenance';
import { dayInZone } from '@/lib/format';
import { stagingToken } from './staging';

/**
 * Preview and commit of a staged import (see staging.ts).
 *
 * Deduplication rules, by kind of record:
 *  - conversations      one row per (user, dedup_key); a later import of the same
 *                       conversation updates its title and dates and adds new messages
 *  - messages           unique per (conversation, external_id); already-known messages
 *                       are skipped, so importing a file twice adds nothing
 *  - usage / cost rows  unique per (user, dedup_key)
 *  - restated reports   (ParsedImport.replaceRanges) replace the same source's rows
 *                       inside the reported time ranges instead of adding to them.
 *  - a file read again  A custom CSV or JSON file has no ids of its own for rows, so a
 *                       row is known by what was read from it. The same file imported
 *                       into the same source again, with other columns or settings,
 *                       replaces what its earlier import stored instead of adding to it.
 *                       Rows the new report states exactly as stored stay where they
 *                       are; a stored total that reaches beyond the range cannot be
 *                       replaced in part, and the import is refused
 *  - Claude Code        requests are deduplicated by 64-bit request hash before
 *                       staging; the hashes are stored on the batch that counted them
 */

export interface ImportPreview {
  format: string;
  formatLabel: string;
  source: ParsedImport['source'];
  fileName: string;
  fileSize: number;
  /** Set when a file with the same SHA-256 was imported before, with the source it was filed under. */
  previousImport: { batchId: number; importedAt: string; sourceLabel: string; sameSource: boolean } | null;
  recordsSeen: number;
  recordsSkipped: number;
  conversations: { total: number; new: number; existing: number };
  messages: { total: number; new: number; duplicate: number; withoutModel: number; withoutTimestamp: number };
  usageRows: { total: number; new: number; duplicate: number; withoutModel: number };
  costRows: { total: number; new: number; duplicate: number };
  /** Claude Code model requests (responses and advisor calls): newly counted vs already counted by an earlier import. */
  requests: { new: number; duplicate: number } | null;
  /** Prompts the person sent in Claude Code, counted the same way. They are not model requests. */
  prompts: { new: number; duplicate: number } | null;
  /** Stored rows that will be replaced: the input restates their time range with other values, or reads the same file differently. */
  replaced: { usageRows: number; costRows: number; tokens: number } | null;
  /** The same file was imported into this source before and is read differently now; `replaced` counts the rows of that import that go. */
  rereadsEarlierImport: boolean;
  /** Tokens this import would add (processed basis). */
  tokens: { exact: number; estimated: number };
  dateRange: { start: string | null; end: string | null };
  /**
   * The same as calendar days, by the rule every chart uses: a record that only knows its day
   * (a daily report row, a dated table row, a manual entry) is that day everywhere, and a record
   * with a time of day falls on the day it has in the user's timezone.
   */
  coveredDays: { first: string | null; last: string | null };
  /** Share of new rows that carry the metadata the dashboard relies on. */
  coverage: { hasExactUsage: boolean; hasModel: boolean; modelShare: number | null; hasTimestamps: boolean };
  /**
   * What kind of figures the new records hold, so the preview can say how they were
   * obtained: token counts the source metered, token counts the file states but the user
   * did not declare exact, tokens estimated from message text, and amounts of money.
   */
  figures: { exactTokens: boolean; statedTokens: boolean; textEstimates: boolean; costs: boolean };
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
  /**
   * Set when the import is stored in the database but the browser refused to copy the change to
   * the device's storage (typically a full disk), with the reason. The import is saved for as long
   * as the app stays open; it is not a failed import, and must not be reported or retried as one.
   */
  notOnDevice?: string;
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

// ── Restated ranges ─────────────────────────────────────────────────────────────

/** A staged usage row (`s`) says exactly what a stored one (`u`) says: the stored row stays, nothing is replaced. */
const sameUsage = (s: string, u: string) => `(
  ${s}.dedup_key = ${u}.dedup_key AND ${s}.occurred_at = ${u}.occurred_at AND ${s}.bucket_seconds = ${u}.bucket_seconds
  AND ${s}.price_tier = ${u}.price_tier AND ${s}.input_tokens = ${u}.input_tokens AND ${s}.output_tokens = ${u}.output_tokens
  AND ${s}.cache_read_tokens = ${u}.cache_read_tokens AND ${s}.cache_write_5m_tokens = ${u}.cache_write_5m_tokens
  AND ${s}.cache_write_1h_tokens = ${u}.cache_write_1h_tokens AND ${s}.request_count = ${u}.request_count
  AND ${s}.user_message_count = ${u}.user_message_count AND ${s}.assistant_message_count = ${u}.assistant_message_count
  AND ${s}.web_search_requests = ${u}.web_search_requests AND ${s}.confidence = ${u}.confidence::text
  AND (SELECT mc.id FROM model_catalog mc WHERE mc.model_key = ${s}.model_key) IS NOT DISTINCT FROM ${u}.model_id)`;

const sameCost = (s: string, r: string) => `(
  ${s}.dedup_key = ${r}.dedup_key AND ${s}.occurred_at = ${r}.occurred_at AND ${s}.bucket_seconds = ${r}.bucket_seconds
  AND ${s}.amount_usd = ${r}.amount_usd AND ${s}.cost_type IS NOT DISTINCT FROM ${r}.cost_type
  AND ${s}.token_type IS NOT DISTINCT FROM ${r}.token_type AND ${s}.description IS NOT DISTINCT FROM ${r}.description
  AND (SELECT mc.id FROM model_catalog mc WHERE mc.model_key = ${s}.model_key) IS NOT DISTINCT FROM ${r}.model_id)`;

/**
 * A stored row covers [occurred_at, occurred_at + bucket_seconds); a width of 0 is a
 * point in time. `inside`: the row lies wholly in the half-open range. `reaches`: it
 * shares at least a moment with it.
 */
const inside = (x: string, start: string, end: string) =>
  `(${x}.occurred_at >= ${start} AND ${x}.occurred_at < ${end} AND ${x}.occurred_at + make_interval(secs => ${x}.bucket_seconds) <= ${end})`;
const reaches = (x: string, start: string, end: string) =>
  `(${x}.occurred_at < ${end} AND CASE WHEN ${x}.bucket_seconds = 0 THEN ${x}.occurred_at >= ${start}
                                        ELSE ${x}.occurred_at + make_interval(secs => ${x}.bucket_seconds) > ${start} END)`;

/** The same for a set of ranges, given as two parameters that hold their starts and their ends. */
const eachRange = (starts: string, ends: string) => `unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) AS rg(s, e)`;
const insideAny = (x: string, starts: string, ends: string) => `EXISTS (SELECT 1 FROM ${eachRange(starts, ends)} WHERE ${inside(x, 'rg.s', 'rg.e')})`;
const reachesAny = (x: string, starts: string, ends: string) => `EXISTS (SELECT 1 FROM ${eachRange(starts, ends)} WHERE ${reaches(x, 'rg.s', 'rg.e')})`;

/**
 * Kinds of source whose rows carry no identity of their own: a row is known by a hash of
 * what was read from it. The same file read with other columns, another price tier or
 * another declared exactness therefore yields other rows, which must take the place of
 * the earlier ones rather than stand next to them.
 */
const REREAD_KINDS = new Set(['generic_csv', 'generic_json']);

/** Imports of this very file (by its SHA-256) that the source already holds. */
async function earlierReadings(db: SqlExecutor, userId: number, sourceId: number | null, parsed: ParsedImport): Promise<number[]> {
  if (sourceId === null || parsed.contentHash === null || !REREAD_KINDS.has(parsed.source.kind)) return [];
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM import_batches WHERE user_id = $1 AND source_id = $2 AND content_hash = $3 ORDER BY id`,
    [userId, sourceId, parsed.contentHash],
  );
  return rows.map((r) => r.id);
}

/** The ranges an import restates, as the two parameters the helpers above take. Null when it restates none. */
function restatedRanges(parsed: ParsedImport): { starts: string[]; ends: string[] } | null {
  const ranges = parsed.replaceRanges ?? [];
  return ranges.length === 0 ? null : { starts: ranges.map((r) => r.start), ends: ranges.map((r) => r.end) };
}

function describeTotal(seconds: number, at: string): string {
  const day = at.slice(0, 10);
  if (seconds === 86_400) return `the daily total for ${day} (UTC)`;
  if (seconds === 3600) return `the hourly total that starts at ${at.slice(11, 16)} UTC on ${day}`;
  if (seconds % 86_400 === 0) return `the total for the ${seconds / 86_400} days from ${day} (UTC)`;
  return `a total that starts at ${at.slice(11, 16)} UTC on ${day}`;
}

/**
 * A restated range must not cut through a stored total. A day stored as one row cannot
 * be replaced for its afternoon only: keeping the row and adding the new rows counts
 * that time twice, and deleting it loses the morning. So such an import is refused,
 * with the row in the way named.
 */
async function assertRangesReplaceable(db: SqlExecutor, sourceId: number, ranges: { starts: string[]; ends: string[] }): Promise<void> {
  const args = [sourceId, ranges.starts, ranges.ends];
  const cut = (table: string) =>
    `SELECT x.occurred_at, x.bucket_seconds, b.file_name
       FROM ${table} x JOIN import_batches b ON b.id = x.batch_id
      WHERE x.source_id = $1 AND ${reachesAny('x', '$2', '$3')} AND NOT ${insideAny('x', '$2', '$3')}`;
  const row = await one<{ occurred_at: Date; bucket_seconds: number; file_name: string } | undefined>(
    db,
    `SELECT * FROM (${cut('usage_records')} UNION ALL ${cut('reported_costs')}) y ORDER BY occurred_at LIMIT 1`,
    args,
  );
  if (!row) return;
  throw new ImportError(
    `This report starts or ends in the middle of a period that an earlier import (“${row.file_name}”) stored as a single total: ` +
      `${describeTotal(row.bucket_seconds, toIso(row.occurred_at)!)}. A total cannot be replaced in part, and adding the new rows on top of it ` +
      'would count that time twice. Export the report so that it covers that period completely, or delete the earlier import first. Nothing was saved.',
    'range_conflict',
  );
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

/** First and last calendar day of a staged or stored row (see ImportPreview.coveredDays). `tz` is a parameter that holds the timezone. */
const firstDayOf = (x: string, tz: string) =>
  `(CASE WHEN ${x}.bucket_seconds >= 86400 THEN (${x}.occurred_at AT TIME ZONE 'UTC')::date ELSE (${x}.occurred_at AT TIME ZONE ${tz}::text)::date END)`;
const lastDayOf = (x: string, tz: string) =>
  `(CASE WHEN ${x}.bucket_seconds >= 86400 THEN ((${x}.occurred_at + make_interval(secs => ${x}.bucket_seconds - 1)) AT TIME ZONE 'UTC')::date
         ELSE (${x}.occurred_at AT TIME ZONE ${tz}::text)::date END)`;

/** The calendar days a restated range covers: its UTC days when it runs from midnight to midnight UTC, else its days in the timezone. */
function daysOfRange(range: { start: string; end: string }, timezone: string): { first: string; last: string } {
  const lastInstant = new Date(Date.parse(range.end) - 1).toISOString();
  const wholeDays = range.start.endsWith('T00:00:00.000Z') && range.end.endsWith('T00:00:00.000Z');
  return wholeDays ? { first: range.start.slice(0, 10), last: lastInstant.slice(0, 10) } : { first: dayInZone(range.start, timezone), last: dayInZone(lastInstant, timezone) };
}

export async function previewImport(db: SqlExecutor, userId: number, parsed: ParsedImport): Promise<ImportPreview> {
  await assertStagingValid(db);
  const sourceId = await sourceIdFor(db, userId, parsed);
  const timezone = (await one<{ timezone: string | null } | undefined>(db, `SELECT timezone FROM users WHERE id = $1`, [userId]))?.timezone ?? 'UTC';

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
            max(d.occurred_at) FILTER (WHERE m.id IS NULL) AS last_at,
            min((d.occurred_at AT TIME ZONE $2::text)::date) FILTER (WHERE m.id IS NULL)::text AS first_day,
            max((d.occurred_at AT TIME ZONE $2::text)::date) FILTER (WHERE m.id IS NULL)::text AS last_day
       FROM d
       JOIN estimation_methods em ON em.method_key = d.method_key
       LEFT JOIN conversations c ON c.user_id = $1 AND c.dedup_key = d.conversation_key
       LEFT JOIN messages m ON m.conversation_id = c.id AND m.external_id = d.external_id`,
    [userId, timezone],
  );

  // A report that restates a range of its source: a staged row is new unless the source already
  // holds it value for value; stored rows inside the range that the report states differently, or
  // not at all, are replaced. Without a range, a row is new when its key is not stored yet.
  const range = sourceId !== null ? restatedRanges(parsed) : null;
  if (range && sourceId !== null) await assertRangesReplaceable(db, sourceId, range);
  // The same file read again: what its earlier imports stored is in question too.
  const reread = await earlierReadings(db, userId, sourceId, parsed);
  const rangeArgs = [sourceId ?? 0, range?.starts ?? [], range?.ends ?? [], reread];
  const restated = (x: string) => `((${x}.source_id = $2 AND ${insideAny(x, '$3', '$4')}) OR ${x}.batch_id = ANY($5::int[]))`;

  const use = await one<Record<string, unknown>>(
    db,
    `WITH d AS (SELECT DISTINCT ON (dedup_key) * FROM stg_usage ORDER BY dedup_key),
          j AS (SELECT d.*, (u.id IS NULL OR (${restated('u')} AND NOT ${sameUsage('d', 'u')})) AS fresh
                  FROM d LEFT JOIN usage_records u ON u.user_id = $1 AND u.dedup_key = d.dedup_key)
     SELECT (SELECT count(*) FROM stg_usage)::int AS staged,
            count(*)::int AS total,
            count(*) FILTER (WHERE fresh)::int AS fresh,
            count(*) FILTER (WHERE fresh AND model_key IS NULL)::int AS without_model,
            count(*) FILTER (WHERE fresh AND confidence = 'exact')::int AS exact_rows,
            count(*) FILTER (WHERE fresh AND confidence <> 'exact')::int AS stated_rows,
            COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)
                     FILTER (WHERE fresh AND confidence = 'exact'), 0)::bigint AS exact_tokens,
            COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)
                     FILTER (WHERE fresh AND confidence <> 'exact'), 0)::bigint AS estimated_tokens,
            min(occurred_at) FILTER (WHERE fresh) AS first_at,
            max(occurred_at) FILTER (WHERE fresh) AS last_at,
            min(${firstDayOf('j', '$6')}) FILTER (WHERE fresh)::text AS first_day,
            max(${lastDayOf('j', '$6')}) FILTER (WHERE fresh)::text AS last_day
       FROM j`,
    [userId, ...rangeArgs, timezone],
  );

  const cost = await one<{
    staged: number; total: number; fresh: number; without_model: number;
    first_at: Date | null; last_at: Date | null; first_day: string | null; last_day: string | null;
  }>(
    db,
    `WITH d AS (SELECT DISTINCT ON (dedup_key) * FROM stg_costs ORDER BY dedup_key),
          j AS (SELECT d.*, (r.id IS NULL OR (${restated('r')} AND NOT ${sameCost('d', 'r')})) AS fresh
                  FROM d LEFT JOIN reported_costs r ON r.user_id = $1 AND r.dedup_key = d.dedup_key)
     SELECT (SELECT count(*) FROM stg_costs)::int AS staged, count(*)::int AS total,
            count(*) FILTER (WHERE fresh)::int AS fresh,
            count(*) FILTER (WHERE fresh AND model_key IS NULL)::int AS without_model,
            min(occurred_at) FILTER (WHERE fresh) AS first_at, max(occurred_at) FILTER (WHERE fresh) AS last_at,
            min(${firstDayOf('j', '$6')}) FILTER (WHERE fresh)::text AS first_day,
            max(${lastDayOf('j', '$6')}) FILTER (WHERE fresh)::text AS last_day
       FROM j`,
    [userId, ...rangeArgs, timezone],
  );

  let replaced: ImportPreview['replaced'] = null;
  if (range || reread.length > 0) {
    const inScope = (x: string) => `((${x}.source_id = $1 AND ${insideAny(x, '$2', '$3')}) OR ${x}.batch_id = ANY($4::int[]))`;
    const r = await one<{ usage_rows: number; tokens: unknown; cost_rows: number }>(
      db,
      `SELECT (SELECT count(*) FROM usage_records u WHERE ${inScope('u')}
                  AND NOT EXISTS (SELECT 1 FROM stg_usage s WHERE ${sameUsage('s', 'u')}))::int AS usage_rows,
              (SELECT COALESCE(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_5m_tokens + u.cache_write_1h_tokens), 0)
                 FROM usage_records u WHERE ${inScope('u')}
                  AND NOT EXISTS (SELECT 1 FROM stg_usage s WHERE ${sameUsage('s', 'u')}))::bigint AS tokens,
              (SELECT count(*) FROM reported_costs r WHERE ${inScope('r')}
                  AND NOT EXISTS (SELECT 1 FROM stg_costs s WHERE ${sameCost('s', 'r')}))::int AS cost_rows`,
      [sourceId, range?.starts ?? [], range?.ends ?? [], reread],
    );
    replaced = { usageRows: r.usage_rows, costRows: r.cost_rows, tokens: toNumber(r.tokens) };
  }

  const previous = parsed.contentHash
    ? await one<{ id: number; created_at: Date; label: string; source_id: number } | undefined>(
        db,
        `SELECT b.id, b.created_at, s.label, b.source_id FROM import_batches b JOIN data_sources s ON s.id = b.source_id
          WHERE b.user_id = $1 AND b.content_hash = $2
          ORDER BY (b.source_id = $3) DESC, b.created_at DESC LIMIT 1`,
        [userId, parsed.contentHash, sourceId ?? 0],
      )
    : undefined;

  const models = await db.query<{ k: string }>(
    `SELECT DISTINCT k FROM (SELECT model_key AS k FROM stg_messages UNION SELECT model_key FROM stg_usage
                             UNION SELECT model_key FROM stg_conversations UNION SELECT model_key FROM stg_costs) x
      WHERE k IS NOT NULL ORDER BY k LIMIT 50`,
  );

  const demo = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM data_sources WHERE user_id = $1 AND is_synthetic`, [userId]);

  const newMessages = toNumber(msg.fresh);
  const newUsage = toNumber(use.fresh);
  const newCost = cost.fresh;
  // Cost rows name a model too, so a cost report is not described as recording none.
  const rowsWithModelBase = newMessages + newUsage + newCost;
  const rowsWithoutModel = toNumber(msg.without_model) + toNumber(use.without_model) + cost.without_model;
  // What the import covers: its new records, and for a restated report all the time it speaks for.
  const spoken = parsed.replaceRanges ?? [];
  const lastOfRange = spoken.length > 0 ? new Date(Date.parse(spoken[spoken.length - 1].end) - 1).toISOString() : null;
  const starts = [toIso(msg.first_at), toIso(use.first_at), toIso(cost.first_at), spoken[0]?.start ?? null].filter(Boolean) as string[];
  const ends = [toIso(msg.last_at), toIso(use.last_at), toIso(cost.last_at), lastOfRange].filter(Boolean) as string[];
  const spokenDays = spoken.map((range) => daysOfRange(range, timezone));
  const firstDays = [msg.first_day, use.first_day, cost.first_day, ...spokenDays.map((d) => d.first)].filter((d): d is string => typeof d === 'string');
  const lastDays = [msg.last_day, use.last_day, cost.last_day, ...spokenDays.map((d) => d.last)].filter((d): d is string => typeof d === 'string');
  const replacedRows = (replaced?.usageRows ?? 0) + (replaced?.costRows ?? 0);
  const stat = (name: string) => (typeof parsed.stats[name] === 'number' ? (parsed.stats[name] as number) : null);

  return {
    format: parsed.format,
    formatLabel: parsed.formatLabel,
    source: parsed.source,
    fileName: parsed.fileName,
    fileSize: parsed.fileSize,
    previousImport: previous
      ? { batchId: previous.id, importedAt: toIso(previous.created_at)!, sourceLabel: previous.label, sameSource: previous.source_id === sourceId }
      : null,
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
    // The keys of an import cover everything it counted: model responses, advisor calls and the prompts the
    // person sent. Only the first two are model requests, so the parser's own tallies are used where it has them.
    requests:
      parsed.requestKeys || parsed.duplicateRequests !== undefined
        ? stat('newResponses') !== null
          ? { new: stat('newResponses')! + (stat('newAdvisorRecords') ?? 0), duplicate: (stat('duplicateResponses') ?? 0) + (stat('duplicateAdvisorRecords') ?? 0) }
          : { new: parsed.requestKeys?.length ?? 0, duplicate: parsed.duplicateRequests ?? 0 }
        : null,
    prompts: stat('newHumanPrompts') !== null ? { new: stat('newHumanPrompts')!, duplicate: stat('duplicateHumanPrompts') ?? 0 } : null,
    replaced,
    rereadsEarlierImport: reread.length > 0 && replacedRows > 0,
    tokens: { exact: toNumber(use.exact_tokens), estimated: toNumber(msg.tokens) + toNumber(use.estimated_tokens) },
    dateRange: {
      start: starts.length ? starts.sort()[0] : null,
      end: ends.length ? ends.sort()[ends.length - 1] : null,
    },
    coveredDays: {
      first: firstDays.length ? firstDays.sort()[0] : null,
      last: lastDays.length ? lastDays.sort()[lastDays.length - 1] : null,
    },
    coverage: {
      hasExactUsage: toNumber(use.exact_tokens) > 0,
      hasModel: rowsWithModelBase > 0 && rowsWithoutModel < rowsWithModelBase,
      modelShare: rowsWithModelBase > 0 ? 1 - rowsWithoutModel / rowsWithModelBase : null,
      hasTimestamps: toNumber(msg.without_timestamp) === 0,
    },
    figures: {
      exactTokens: toNumber(use.exact_rows) > 0,
      statedTokens: toNumber(use.stated_rows) > 0,
      textEstimates: newMessages > 0,
      costs: newCost > 0,
    },
    models: models.rows.map((r) => r.k),
    missingFields: parsed.missingFields,
    warnings: parsed.warnings,
    willRemoveDemoData: !parsed.source.isSynthetic && demo.n > 0,
    nothingNew: newMessages === 0 && newUsage === 0 && newCost === 0 && replacedRows === 0,
  };
}

/**
 * Changes whenever an import is saved or deleted; lets a commit detect a stale preview.
 * Import ids only ever grow, so the newest id together with the number of imports
 * changes with every save (the id rises) and every deletion (the count falls). It can
 * only be the same again when the same imports are stored as before.
 */
export async function importGeneration(db: SqlExecutor, userId: number): Promise<number> {
  const row = await one<{ g: unknown }>(
    db,
    `SELECT (COALESCE(max(id), 0)::bigint * 1000003 + count(*))::bigint AS g FROM import_batches WHERE user_id = $1`,
    [userId],
  );
  return toNumber(row.g);
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
  /**
   * The token resetStaging() returned before the input was staged. When given, the commit
   * is refused if the staging tables were reset since: they would hold nothing, or another
   * import's records, and saving them would not be what the user confirmed.
   */
  staging?: string;
}

export async function commitImport(
  db: SqlDriver,
  userId: number,
  parsed: ParsedImport,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const result = await db.transaction(async (tx) => {
    if (options.staging !== undefined && (await stagingToken(tx)) !== options.staging) {
      throw new ImportError(
        'The records prepared for this import are no longer there: another import or a manual entry was made in the meantime, or the tab that held the database was closed. Nothing was saved. Run the import again.',
        'stale_preview',
      );
    }
    await assertStagingValid(tx);

    if (options.generation !== undefined && parsed.requestKeys !== undefined) {
      const now = await importGeneration(tx, userId);
      if (now !== options.generation) {
        throw new ImportError(
          'Other data was imported or deleted after this preview was prepared. Run the import again so that what is already stored is recognised correctly. Nothing was saved.',
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
    // Looked up before this import gets a batch of its own, which has the same file and source.
    const reread = await earlierReadings(tx, userId, existingSourceId, parsed);
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
    const supersededBatches = new Map<number, number>();
    const restated = existingSourceId !== null ? restatedRanges(parsed) : null;
    /** Conversations that lose rows here; they are tidied up once the new rows are in. */
    const emptied = new Set<number>();
    if (restated || reread.length > 0) {
      if (restated) await assertRangesReplaceable(tx, sourceId, restated);
      const scope = [sourceId, restated?.starts ?? [], restated?.ends ?? [], reread];
      const inScope = (x: string) => `((${x}.source_id = $1 AND ${insideAny(x, '$2', '$3')}) OR ${x}.batch_id = ANY($4::int[]))`;
      // Stored rows that the input states exactly as they are stay with the import that brought them.
      const u = await tx.query<{ batch_id: number; conversation_id: number | null }>(
        `DELETE FROM usage_records u WHERE ${inScope('u')}
            AND NOT EXISTS (SELECT 1 FROM stg_usage s WHERE ${sameUsage('s', 'u')}) RETURNING u.batch_id, u.conversation_id`,
        scope,
      );
      const c = await tx.query<{ batch_id: number }>(
        `DELETE FROM reported_costs r WHERE ${inScope('r')}
            AND NOT EXISTS (SELECT 1 FROM stg_costs s WHERE ${sameCost('s', 'r')}) RETURNING r.batch_id`,
        scope,
      );
      replaced.usageRows = u.rows.length;
      replaced.costRows = c.rows.length;
      for (const row of [...u.rows, ...c.rows]) supersededBatches.set(row.batch_id, (supersededBatches.get(row.batch_id) ?? 0) + 1);
      for (const row of u.rows) if (row.conversation_id !== null) emptied.add(row.conversation_id);
    }

    const conv = await tx.query<{ inserted: boolean }>(
      `INSERT INTO conversations (user_id, source_id, kind, external_id, dedup_key, title, project_label, model_id, created_at, updated_at, metadata)
       SELECT $1, $2, s.kind::conversation_kind, s.external_id, s.dedup_key, s.title, s.project_label, mc.id, s.created_at, s.updated_at, s.metadata
         FROM stg_conversations s LEFT JOIN model_catalog mc ON mc.model_key = s.model_key
       ON CONFLICT (user_id, dedup_key) DO UPDATE SET
         -- The newer state of a conversation names it: an older export imported later must not put an old title back.
         title = CASE WHEN EXCLUDED.title IS NULL THEN conversations.title
                      WHEN conversations.title IS NULL THEN EXCLUDED.title
                      WHEN COALESCE(EXCLUDED.updated_at, '-infinity') >= COALESCE(conversations.updated_at, '-infinity') THEN EXCLUDED.title
                      ELSE conversations.title END,
         project_label = CASE WHEN EXCLUDED.project_label IS NULL THEN conversations.project_label
                              WHEN conversations.project_label IS NULL THEN EXCLUDED.project_label
                              WHEN COALESCE(EXCLUDED.updated_at, '-infinity') >= COALESCE(conversations.updated_at, '-infinity') THEN EXCLUDED.project_label
                              ELSE conversations.project_label END,
         -- The model of a Claude Code session is recomputed from its stored usage below (refreshConversationCounters).
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
      // A path listed twice names two files; neither is remembered (and one statement cannot update a row twice).
      await tx.query(
        `INSERT INTO synced_files (source_id, path, size, last_modified)
         SELECT $1, p, min(s), to_timestamp(min(m) / 1000.0)
           FROM unnest($2::text[], $3::bigint[], $4::double precision[]) AS x(p, s, m)
          GROUP BY p HAVING count(*) = 1
         ON CONFLICT (source_id, path) DO UPDATE SET size = EXCLUDED.size, last_modified = EXCLUDED.last_modified, synced_at = now()`,
        [sourceId, parsed.syncedFiles.map((f) => f.path), parsed.syncedFiles.map((f) => f.size), parsed.syncedFiles.map((f) => f.lastModified)],
      );
    }

    // Earlier imports of the report that lost rows to this one say so in the history; one that has nothing
    // left is removed from it, so the history never lists an import whose records no longer exist.
    for (const [earlier, lost] of supersededBatches) {
      if (earlier === batchId) continue;
      const left = await one<{ n: number; first_at: Date | null; last_at: Date | null }>(
        tx,
        `SELECT count(*)::int AS n, min(occurred_at) AS first_at, max(occurred_at) AS last_at
           FROM (SELECT occurred_at FROM usage_records WHERE batch_id = $1
                 UNION ALL SELECT occurred_at FROM token_estimates WHERE batch_id = $1
                 UNION ALL SELECT occurred_at FROM reported_costs WHERE batch_id = $1) x`,
        [earlier],
      );
      if (left.n === 0) {
        await tx.query(`DELETE FROM import_batches WHERE id = $1 AND user_id = $2`, [earlier, userId]);
      } else {
        await tx.query(
          `UPDATE import_batches SET records_inserted = $2, coverage_start = $3, coverage_end = $4,
                  warnings = (SELECT COALESCE(jsonb_agg(w), '[]'::jsonb) FROM jsonb_array_elements(warnings) w WHERE w->>'code' <> 'superseded')
                             || jsonb_build_array(jsonb_build_object('code', 'superseded', 'count',
                                  $5::int + COALESCE((SELECT (w->>'count')::int FROM jsonb_array_elements(warnings) w WHERE w->>'code' = 'superseded' LIMIT 1), 0),
                                  'message', $6::text))
            WHERE id = $1 AND user_id = $7`,
          [earlier, left.n, left.first_at, left.last_at, lost,
           'records of this import were replaced by a later import: a report that states the same period differently, or the same file read with other settings. They are no longer stored under this import.', userId],
        );
      }
    }

    const nothingNew = insertedMessages === 0 && insertedUsage === 0 && insertedCosts === 0 && replaced.usageRows === 0 && replaced.costRows === 0;
    // A source this very import created and that received nothing is not kept, not even to remember which
    // files were read: a source without a single record would be listed as data that does not exist.
    const dropSource = nothingNew && existingSourceId === null;
    if (nothingNew) {
      await tx.query(`DELETE FROM import_batches WHERE id = $1`, [batchId]);
      if (dropSource) await tx.query(`DELETE FROM data_sources WHERE id = $1`, [sourceId]);
    } else {
      // A conversation that only the replaced rows belonged to is gone with them; the others are counted afresh.
      const touched = [...emptied].map((id) => Number(id));
      if (touched.length > 0) {
        await tx.query(
          `DELETE FROM conversations c
            WHERE c.user_id = $1 AND c.id = ANY($2::int[])
              AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.conversation_id = c.id)`,
          [userId, touched],
        );
      }
      await refreshConversationCounters(
        tx,
        userId,
        `(c.dedup_key IN (SELECT dedup_key FROM stg_conversations)${touched.length > 0 ? ` OR c.id IN (${touched.join(',')})` : ''})`,
      );
      const replacedRows = replaced.usageRows + replaced.costRows;
      await tx.query(
        `UPDATE import_batches b SET
           records_inserted = $2, records_duplicate = $3,
           coverage_start = r.first_at, coverage_end = r.last_at,
           -- Deleting this import does not bring back what it replaced; the history says so before it is deleted.
           warnings = CASE WHEN $4::int > 0
                           THEN b.warnings || jsonb_build_array(jsonb_build_object('code', 'replaced_earlier', 'count', $4::int, 'message', $5::text))
                           ELSE b.warnings END
          FROM (SELECT min(occurred_at) AS first_at, max(occurred_at) AS last_at
                  FROM (SELECT occurred_at FROM usage_records WHERE batch_id = $1
                        UNION ALL SELECT occurred_at FROM token_estimates WHERE batch_id = $1
                        UNION ALL SELECT occurred_at FROM reported_costs WHERE batch_id = $1) x) r
         WHERE b.id = $1`,
        [
          batchId,
          insertedMessages + insertedUsage + insertedCosts,
          stagedMessages.n - insertedMessages + (stagedUsage.n - insertedUsage) + (stagedCosts.n - insertedCosts) + (parsed.duplicateRequests ?? 0),
          replacedRows,
          'records that an earlier import had stored were replaced by this one. Deleting this import does not bring them back.',
        ],
      );
    }

    return {
      batchId: nothingNew ? null : batchId,
      sourceId: dropSource ? null : sourceId,
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
  // The browser database has no autovacuum; without fresh statistics the next queries can be far slower.
  if (!result.nothingNew || result.replaced.usageRows + result.replaced.costRows > 0) await refreshStatistics(db);
  // The transaction is committed. A failure from here on must not read as "nothing was saved": a second
  // attempt would then store a manual entry twice, and the pages would keep showing the old figures.
  try {
    await db.flush();
  } catch (error) {
    return { ...result, notOnDevice: error instanceof Error ? error.message : String(error) };
  }
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
       updated_at = GREATEST(c.updated_at, e.last_at, u.last_at),
       -- A Claude Code session is filed under the model that handled most of its tokens, over everything stored
       -- for it. An import only sees the files that changed, so it cannot decide this on its own.
       model_id = CASE WHEN c.kind = 'code_session' THEN COALESCE(d.model_id, c.model_id) ELSE c.model_id END
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
      LEFT JOIN LATERAL (
        SELECT model_id FROM usage_records
         WHERE conversation_id = t.id AND model_id IS NOT NULL
         GROUP BY model_id
         ORDER BY sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens) DESC, model_id
         LIMIT 1) d ON true
     WHERE c.id = t.id AND c.user_id = $1 AND ${where}`,
    [userId],
  );
}
