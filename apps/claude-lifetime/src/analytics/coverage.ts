import { decodeLimitations, type LimitationName } from '@/core/limitations';
import type { SourceKind } from '@/core/types';
import { toIso, toNumber, type SqlExecutor } from '@/db/driver';
import { dayExpr } from './base';

/**
 * "What we know about your Claude history": where each number comes from and what is
 * missing. No percentage of "all-time history covered" is ever produced, because the
 * true total is not knowable from the available sources; coverage is described by
 * what was imported (sources, date range, gaps), not as a share of an unknown whole.
 */
export interface SourceCoverage {
  id: number;
  kind: SourceKind;
  label: string;
  isSynthetic: boolean;
  includeInTotals: boolean;
  exclusionReason: string | null;
  imports: number;
  lastImportAt: string | null;
  firstRecordAt: string | null;
  lastRecordAt: string | null;
  conversations: number;
  /** Processed tokens, split by confidence. */
  exactTokens: number;
  estimatedTokens: number;
}

export interface Coverage {
  hasData: boolean;
  /** True while the synthetic demo dataset is loaded. */
  hasSyntheticData: boolean;
  earliestRecordAt: string | null;
  latestRecordAt: string | null;
  sources: SourceCoverage[];
  importCount: number;
  /** Processed tokens of sources that count towards totals. */
  exactTokens: number;
  estimatedTokens: number;
  /** Tokens whose source names a model vs. tokens with no recorded model. */
  tokensWithModel: number;
  tokensWithoutModel: number;
  /** Stretches of at least `gapDays` days with no records between the first and last active day. */
  gaps: Array<{ from: string; to: string; days: number }>;
  gapDays: number;
  /** How many estimated messages each known limitation applies to. */
  limitations: Array<{ name: LimitationName; messages: number }>;
  estimatedMessages: number;
}

const PROCESSED = `(f.input_tokens + f.output_tokens + f.cache_write_5m_tokens + f.cache_write_1h_tokens + f.cache_read_tokens + f.replay_tokens)`;

export async function getCoverage(db: SqlExecutor, userId: number, timezone: string, gapDays = 14): Promise<Coverage> {
  const sources = (
    await db.query<Record<string, unknown>>(
      `SELECT s.id, s.kind::text AS kind, s.label, s.is_synthetic, s.include_in_totals, s.exclusion_reason,
              (SELECT count(*) FROM import_batches b WHERE b.source_id = s.id)::int AS imports,
              (SELECT max(b.created_at) FROM import_batches b WHERE b.source_id = s.id) AS last_import_at,
              (SELECT count(*) FROM conversations c WHERE c.source_id = s.id AND c.kind IN ('chat', 'code_session'))::int AS conversations,
              x.first_at, x.last_at, COALESCE(x.exact, 0) AS exact, COALESCE(x.estimated, 0) AS estimated
         FROM data_sources s
         LEFT JOIN LATERAL (
           SELECT min(f.occurred_at) AS first_at, max(f.occurred_at) AS last_at,
                  sum(${PROCESSED}) FILTER (WHERE f.confidence = 'exact')::bigint AS exact,
                  sum(${PROCESSED}) FILTER (WHERE f.confidence = 'estimated')::bigint AS estimated
             FROM usage_facts f WHERE f.source_id = s.id) x ON true
        WHERE s.user_id = $1
        ORDER BY s.created_at, s.id`,
      [userId],
    )
  ).rows;

  const totals = (
    await db.query<Record<string, unknown>>(
      `SELECT min(f.occurred_at) AS first_at, max(f.occurred_at) AS last_at,
              COALESCE(sum(${PROCESSED}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
              COALESCE(sum(${PROCESSED}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
              COALESCE(sum(${PROCESSED}) FILTER (WHERE f.model_id IS NOT NULL), 0)::bigint AS with_model,
              COALESCE(sum(${PROCESSED}) FILTER (WHERE f.model_id IS NULL), 0)::bigint AS without_model
         FROM usage_facts f JOIN data_sources s ON s.id = f.source_id
        WHERE f.user_id = $1 AND s.include_in_totals`,
      [userId],
    )
  ).rows[0];

  const day = dayExpr('$2::text');
  const gaps = (
    await db.query<{ from_day: string; to_day: string; days: number }>(
      `WITH days AS (
         SELECT DISTINCT ${day} AS d FROM usage_facts f JOIN data_sources s ON s.id = f.source_id
          WHERE f.user_id = $1 AND s.include_in_totals),
       g AS (SELECT d, lead(d) OVER (ORDER BY d) AS next FROM days)
       SELECT (d + 1)::text AS from_day, (next - 1)::text AS to_day, (next - d - 1)::int AS days
         FROM g WHERE next - d - 1 >= $3 ORDER BY days DESC, d LIMIT 12`,
      [userId, timezone, gapDays],
    )
  ).rows;

  const flagRows = (
    await db.query<{ limitation_flags: number; n: number }>(
      `SELECT e.limitation_flags, count(*)::int AS n
         FROM token_estimates e JOIN data_sources s ON s.id = e.source_id
        WHERE e.user_id = $1 AND s.include_in_totals GROUP BY 1`,
      [userId],
    )
  ).rows;
  const tally = new Map<LimitationName, number>();
  let estimatedMessages = 0;
  for (const r of flagRows) {
    estimatedMessages += r.n;
    for (const name of decodeLimitations(r.limitation_flags)) tally.set(name, (tally.get(name) ?? 0) + r.n);
  }

  const mapped: SourceCoverage[] = sources.map((r) => ({
    id: toNumber(r.id),
    kind: r.kind as SourceKind,
    label: String(r.label),
    isSynthetic: r.is_synthetic === true,
    includeInTotals: r.include_in_totals === true,
    exclusionReason: (r.exclusion_reason as string | null) ?? null,
    imports: toNumber(r.imports),
    lastImportAt: toIso(r.last_import_at),
    firstRecordAt: toIso(r.first_at),
    lastRecordAt: toIso(r.last_at),
    conversations: toNumber(r.conversations),
    exactTokens: toNumber(r.exact),
    estimatedTokens: toNumber(r.estimated),
  }));

  return {
    hasData: mapped.length > 0,
    hasSyntheticData: mapped.some((s) => s.isSynthetic),
    earliestRecordAt: toIso(totals.first_at),
    latestRecordAt: toIso(totals.last_at),
    sources: mapped,
    importCount: mapped.reduce((s, r) => s + r.imports, 0),
    exactTokens: toNumber(totals.exact),
    estimatedTokens: toNumber(totals.estimated),
    tokensWithModel: toNumber(totals.with_model),
    tokensWithoutModel: toNumber(totals.without_model),
    gaps: gaps.map((g) => ({ from: g.from_day, to: g.to_day, days: g.days })),
    gapDays,
    limitations: [...tally.entries()].map(([name, messages]) => ({ name, messages })).sort((a, b) => b.messages - a.messages),
    estimatedMessages,
  };
}

export interface ImportRecord {
  batchId: number;
  sourceId: number;
  sourceKind: SourceKind;
  sourceLabel: string;
  isSynthetic: boolean;
  fileName: string;
  fileSize: number;
  format: string;
  importedAt: string;
  coverageStart: string | null;
  coverageEnd: string | null;
  recordsSeen: number;
  recordsInserted: number;
  recordsDuplicate: number;
  recordsSkipped: number;
  missingFields: string[];
  warnings: Array<{ code: string; message: string; count: number; sample?: string }>;
}

export async function listImports(db: SqlExecutor, userId: number): Promise<ImportRecord[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT b.id, b.source_id, s.kind::text AS kind, s.label, s.is_synthetic, b.file_name, b.file_size, b.format, b.created_at,
            b.coverage_start, b.coverage_end, b.records_seen, b.records_inserted, b.records_duplicate, b.records_skipped,
            b.missing_fields, b.warnings
       FROM import_batches b JOIN data_sources s ON s.id = b.source_id
      WHERE b.user_id = $1 ORDER BY b.created_at DESC, b.id DESC`,
    [userId],
  );
  return rows.map((r) => ({
    batchId: toNumber(r.id),
    sourceId: toNumber(r.source_id),
    sourceKind: r.kind as SourceKind,
    sourceLabel: String(r.label),
    isSynthetic: r.is_synthetic === true,
    fileName: String(r.file_name),
    fileSize: toNumber(r.file_size),
    format: String(r.format),
    importedAt: toIso(r.created_at)!,
    coverageStart: toIso(r.coverage_start),
    coverageEnd: toIso(r.coverage_end),
    recordsSeen: toNumber(r.records_seen),
    recordsInserted: toNumber(r.records_inserted),
    recordsDuplicate: toNumber(r.records_duplicate),
    recordsSkipped: toNumber(r.records_skipped),
    missingFields: (r.missing_fields as string[] | null) ?? [],
    warnings: (r.warnings as ImportRecord['warnings'] | null) ?? [],
  }));
}
