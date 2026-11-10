import { toNumber, type SqlExecutor } from '@/db/driver';
import { factsFrom, Params, tokenExpr, UNKNOWN_MODEL_LABEL, type AnalyticsFilter } from './base';
import { STATES_CACHE } from './overview';
import { getApiValueBy, ZERO_FIGURES, type ValueFigures, type ValueOptions } from './value';

/**
 * Whether a row's records hold a count for a category, so that the table shows the figure
 * and keeps a dash for a category none of them records. The rule is the one the overview
 * uses for its token totals (TOTAL_COLUMNS in overview.ts): Claude Code logs and API usage
 * reports state cache tokens on every record, so a zero there is a real zero; a CSV or JSON
 * table or a manual entry may have no such column, so it counts as stating a category only
 * where a record has a value in it. Re-read context is modelled only for estimates made from
 * chat text, the only facts with an estimation method.
 */
const RECORDED_COLUMNS = `
  COALESCE(bool_or(${STATES_CACHE} OR f.cache_read_tokens > 0), false) AS records_cache_read,
  COALESCE(bool_or(${STATES_CACHE} OR f.cache_write_5m_tokens + f.cache_write_1h_tokens > 0), false) AS records_cache_write,
  COALESCE(bool_or(f.method_id IS NOT NULL OR f.replay_tokens > 0), false) AS records_replay`;

export interface ModelUsage {
  /** null = the source did not identify a model. No model is ever inferred. */
  modelKey: string | null;
  displayName: string;
  family: string;
  inCatalog: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  replay: number;
  /** Under the filter's basis. */
  total: number;
  exact: number;
  estimated: number;
  /** Share of all recorded usage under the filter's basis, 0..1. */
  share: number;
  conversations: number;
  requests: number;
  value: ValueFigures;
  /**
   * Which categories at least one record of the row has a count for. A category no record
   * states is unknown for the row, not zero; a category that is part of the total is always stated.
   */
  recorded: { cacheRead: boolean; cacheWrite: boolean; replay: boolean };
}

export async function getModelBreakdown(db: SqlExecutor, filter: AnalyticsFilter, options: ValueOptions = {}): Promise<ModelUsage[]> {
  const tok = tokenExpr(filter.basis);
  const p = new Params();
  const f = factsFrom(filter, p);
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT f.model_id, mc.model_key, mc.display_name, mc.family, mc.is_builtin,
            sum(f.input_tokens)::bigint AS input, sum(f.output_tokens)::bigint AS output,
            sum(f.cache_read_tokens)::bigint AS cache_read,
            sum(f.cache_write_5m_tokens)::bigint AS cw5, sum(f.cache_write_1h_tokens)::bigint AS cw1,
            sum(f.replay_tokens)::bigint AS replay,
            sum(${tok})::bigint AS total,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
            count(DISTINCT ${f.conversationId})::int AS conversations,
            sum(f.request_count)::bigint AS requests,
            ${RECORDED_COLUMNS}
       FROM ${f.from} LEFT JOIN model_catalog mc ON mc.id = f.model_id ${f.conversationJoin}
      WHERE ${f.where}
      GROUP BY 1, 2, 3, 4, 5
     HAVING sum(${tok}) > 0 OR sum(f.request_count) > 0
      ORDER BY sum(${tok}) DESC`,
    p.values,
  );
  const values = await getApiValueBy(db, filter, `f.model_id`, '', options);
  const grand = rows.reduce((s, r) => s + toNumber(r.total), 0);
  return rows.map((r) => {
    const total = toNumber(r.total);
    return {
      modelKey: (r.model_key as string | null) ?? null,
      displayName: (r.display_name as string | null) ?? UNKNOWN_MODEL_LABEL,
      family: (r.family as string | null) ?? 'unknown',
      inCatalog: r.is_builtin === true,
      input: toNumber(r.input),
      output: toNumber(r.output),
      cacheRead: toNumber(r.cache_read),
      cacheWrite5m: toNumber(r.cw5),
      cacheWrite1h: toNumber(r.cw1),
      replay: toNumber(r.replay),
      total,
      exact: toNumber(r.exact),
      estimated: toNumber(r.estimated),
      share: grand > 0 ? total / grand : 0,
      conversations: toNumber(r.conversations),
      requests: toNumber(r.requests),
      value: values.get(r.model_id === null ? '' : String(r.model_id)) ?? ZERO_FIGURES,
      recorded: { cacheRead: r.records_cache_read === true, cacheWrite: r.records_cache_write === true, replay: r.records_replay === true },
    };
  });
}
