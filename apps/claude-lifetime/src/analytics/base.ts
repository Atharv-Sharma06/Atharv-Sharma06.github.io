import type { SourceKind } from '@/core/types';

/**
 * Shared building blocks of the analytics engine.
 *
 * Every dashboard number is computed in SQL from the `usage_facts` view, so exact and
 * estimated usage, the source of each fact and its import batch stay traceable all the
 * way to the UI.
 *
 * ── Which token categories each metric includes ────────────────────────────────
 *   new tokens        input + output + cache writes
 *                     (content given to or produced by the model, counted once)
 *   processed tokens  new tokens + cache reads + modelled context replay
 *                     (everything the model read and wrote; what the API meters)
 * Cache reads only exist for exact sources and context replay only for estimated
 * ones, so the two never overlap, and no category is counted in two columns.
 * "Exact" and "estimated" are partitions of either total by the confidence column.
 */
export type TokenBasis = 'processed' | 'new';

export interface AnalyticsFilter {
  userId: number;
  /** IANA timezone used for day boundaries. */
  timezone: string;
  basis: TokenBasis;
  /** Inclusive local dates, `YYYY-MM-DD`. */
  from?: string | null;
  to?: string | null;
  sourceKinds?: SourceKind[] | null;
  /** Restrict to one conversation (detail page). */
  conversationId?: number | null;
}

/** Collects positional parameters while a statement is assembled. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const NEW = `(f.input_tokens + f.output_tokens + f.cache_write_5m_tokens + f.cache_write_1h_tokens)`;
const PROCESSED = `(${NEW} + f.cache_read_tokens + f.replay_tokens)`;

/** SQL expression for the token total of a fact under the chosen basis (alias `f`). */
export function tokenExpr(basis: TokenBasis): string {
  return basis === 'new' ? NEW : PROCESSED;
}

/**
 * Local calendar day of a fact. Daily aggregates (API reports with one-day buckets)
 * are already calendar days in UTC and are not shifted into the user's timezone.
 */
export function dayExpr(tz: string): string {
  return `(CASE WHEN f.bucket_seconds >= 86400 THEN (f.occurred_at AT TIME ZONE 'UTC')::date ELSE (f.occurred_at AT TIME ZONE ${tz})::date END)`;
}

/**
 * Whether a conversation is shown. It belongs to the source that imported it first (`s`), but another
 * source can have added records to it. Its records are counted source by source, so it is shown when
 * its own source counts toward the totals or any source that has records in it does: a conversation
 * whose tokens are in the totals must not be missing from the list.
 */
export const conversationShown = (c = 'c', s = 's'): string => `(${s}.include_in_totals
    OR EXISTS (SELECT 1 FROM usage_records vu JOIN data_sources vs ON vs.id = vu.source_id
                WHERE vu.conversation_id = ${c}.id AND vs.include_in_totals)
    OR EXISTS (SELECT 1 FROM messages vm JOIN import_batches vb ON vb.id = vm.batch_id JOIN data_sources vs ON vs.id = vb.source_id
                WHERE vm.conversation_id = ${c}.id AND vs.include_in_totals))`;

/**
 * `FROM ... WHERE ...` for usage facts under a filter. Sources the user excluded from
 * totals (to avoid counting overlapping sources twice) are always left out.
 */
export function factsFrom(
  filter: AnalyticsFilter,
  p: Params,
): { from: string; where: string; tz: string; day: string; conversationJoin: string; conversationId: string } {
  // The cast lets PostgreSQL type the parameter wherever it is used (AT TIME ZONE takes text).
  const tz = `${p.add(filter.timezone)}::text`;
  const day = dayExpr(tz);
  // `tz IS NOT NULL` keeps the timezone parameter referenced in statements that do not
  // bucket by day; PostgreSQL rejects a statement with an unreferenced parameter.
  const conditions = [`f.user_id = ${p.add(filter.userId)}`, `s.include_in_totals`, `${tz} IS NOT NULL`];
  if (filter.from) conditions.push(`${day} >= ${p.add(filter.from)}::date`);
  if (filter.to) conditions.push(`${day} <= ${p.add(filter.to)}::date`);
  // Compared as text: the driver can only send a JavaScript array for a built-in array type, not for an enum's.
  if (filter.sourceKinds && filter.sourceKinds.length > 0) conditions.push(`s.kind::text = ANY(${p.add(filter.sourceKinds)}::text[])`);
  if (filter.conversationId) conditions.push(`f.conversation_id = ${p.add(filter.conversationId)}`);
  return {
    from: `usage_facts f JOIN data_sources s ON s.id = f.source_id`,
    where: conditions.join(' AND '),
    tz,
    day,
    // For counting conversations: add `conversationJoin` to the FROM clause and count DISTINCT
    // `conversationId`. Rows of API reports and generic imports hang off containers of kind
    // usage_bucket, which are not conversations and must not be counted as such.
    conversationJoin: `LEFT JOIN conversations cv ON cv.id = f.conversation_id AND cv.kind IN ('chat', 'code_session')`,
    conversationId: 'cv.id',
  };
}

export type Granularity = 'day' | 'week' | 'month' | 'year';

/** Start of the period containing a local day, as a date. Weeks start on Monday (ISO). */
export function bucketExpr(day: string, granularity: Granularity): string {
  return granularity === 'day' ? day : `date_trunc('${granularity}', ${day}::timestamp)::date`;
}

export const UNKNOWN_MODEL_LABEL = 'Unknown model';

/** Plan key of time that no entered subscription period covers. */
export const NO_PLAN = 'none';
