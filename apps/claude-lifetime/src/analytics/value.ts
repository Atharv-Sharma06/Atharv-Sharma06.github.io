import { WEB_SEARCH_USD_PER_1000 } from '@/core/catalog';
import { Decimal } from '@/core/decimal';
import { toNumber, type SqlExecutor } from '@/db/driver';
import { factsFrom, Params, type AnalyticsFilter } from './base';

/**
 * Equivalent API value: what the recorded usage would have cost at Anthropic's
 * published API prices. It is a hypothetical figure — not money that was spent — and
 * is always shown apart from actual spend (reported_costs, subscription payments).
 *
 * How each kind of usage is priced (USD per million tokens, NUMERIC arithmetic in SQL):
 *
 *  exact usage         every category at its own published price:
 *                      input, output, cache reads, 5-minute and 1-hour cache writes
 *
 *  estimated usage     two scenarios, because the price of re-read context depends on
 *  (chat exports)      whether prompt caching is assumed:
 *    standard          no caching: (new input + re-read context) x input price
 *                      + output x output price
 *    cached            5-minute prompt cache: context a cache could have served is
 *                      priced as cache reads, the rest (including new input) as
 *                      5-minute cache writes, output at the output price
 *
 *  A fact is priced with the pricing_history row for its model and price tier that
 *  was in effect on its day; rows the user entered take precedence over built-in ones.
 *  Facts without a model, or whose model/tier has no price on file, are reported as
 *  unpriced — no model is guessed. The user may choose a reference model for
 *  unknown-model usage; the result is then labelled as an assumption.
 */
export interface ValueOptions {
  /** model_catalog.model_key whose prices stand in for usage with no recorded model. */
  assumedModelKey?: string | null;
}

export interface ValueFigures {
  /** Exact usage, priced per category. */
  exactUsd: string;
  /** Estimated usage without prompt caching. */
  estimatedStandardUsd: string;
  /** Estimated usage assuming a 5-minute prompt cache. */
  estimatedCachedUsd: string;
  webSearchUsd: string;
  /** exact + web search + estimated(standard) */
  totalStandardUsd: string;
  /** exact + web search + estimated(cached) */
  totalCachedUsd: string;
  /** Processed tokens that could be priced / could not. */
  pricedTokens: number;
  unpricedTokens: number;
  /** Priced tokens whose model was not recorded and that use the assumed model's price. */
  assumedTokens: number;
}

export interface UnpricedGroup {
  reason: 'unknown_model' | 'no_price';
  modelKey: string | null;
  displayName: string | null;
  priceTier: string;
  tokens: number;
}

export interface PriceSource {
  url: string;
  retrievedOn: string;
  /** Tokens priced with this source. */
  tokens: number;
  userEntered: boolean;
}

export interface ApiValue extends ValueFigures {
  unpriced: UnpricedGroup[];
  sources: PriceSource[];
  assumedModel: { modelKey: string; displayName: string } | null;
}

const ZERO_FIGURES: ValueFigures = {
  exactUsd: '0',
  estimatedStandardUsd: '0',
  estimatedCachedUsd: '0',
  webSearchUsd: '0',
  totalStandardUsd: '0',
  totalCachedUsd: '0',
  pricedTokens: 0,
  unpricedTokens: 0,
  assumedTokens: 0,
};

async function resolveAssumedModel(db: SqlExecutor, key: string | null | undefined) {
  if (!key) return null;
  const { rows } = await db.query<{ id: number; model_key: string; display_name: string }>(
    `SELECT id, model_key, display_name FROM model_catalog WHERE model_key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

/** CTEs `agg` and `priced`: facts aggregated by (group, model, tier, day) with the applicable price attached. */
function pricedCte(filter: AnalyticsFilter, p: Params, groupExpr: string, groupJoin: string, assumedModelId: number | null): string {
  const f = factsFrom(filter, p);
  const assumed = p.add(assumedModelId);
  return `
  agg AS (
    SELECT ${groupExpr} AS g,
           f.model_id AS raw_model_id,
           COALESCE(f.model_id, ${assumed}::int) AS model_id,
           f.price_tier, f.confidence, (f.method_id IS NOT NULL) AS modelled, ${f.day} AS day,
           sum(f.input_tokens) AS i, sum(f.output_tokens) AS o, sum(f.cache_read_tokens) AS cr,
           sum(f.cache_write_5m_tokens) AS cw5, sum(f.cache_write_1h_tokens) AS cw1,
           sum(f.replay_tokens) AS rp, sum(f.replay_cached_tokens) AS rpc,
           sum(f.web_search_requests) AS ws
      FROM ${f.from} ${groupJoin}
     WHERE ${f.where}
     GROUP BY 1, 2, 3, 4, 5, 6, 7
  ),
  priced AS (
    SELECT a.*, pr.id AS price_id, pr.is_builtin, pr.source_url, pr.source_retrieved_on,
           (a.i + a.o + a.cr + a.cw5 + a.cw1 + a.rp) AS tokens,
           -- every category at its own price; re-read context of estimates at the input price
           ((a.i + a.rp) * pr.input_usd_per_mtok + a.o * pr.output_usd_per_mtok
             + a.cr * COALESCE(pr.cache_read_usd_per_mtok, pr.input_usd_per_mtok)
             + a.cw5 * COALESCE(pr.cache_write_5m_usd_per_mtok, pr.input_usd_per_mtok)
             + a.cw1 * COALESCE(pr.cache_write_1h_usd_per_mtok, pr.input_usd_per_mtok)) / 1000000 AS cost_standard,
           -- modelled chat usage under a 5-minute prompt cache
           CASE WHEN a.modelled THEN
             ((a.i + a.rp - a.rpc) * COALESCE(pr.cache_write_5m_usd_per_mtok, pr.input_usd_per_mtok)
               + a.rpc * COALESCE(pr.cache_read_usd_per_mtok, pr.input_usd_per_mtok)
               + a.o * pr.output_usd_per_mtok) / 1000000
           ELSE
             (a.i * pr.input_usd_per_mtok + a.o * pr.output_usd_per_mtok
               + a.cr * COALESCE(pr.cache_read_usd_per_mtok, pr.input_usd_per_mtok)
               + a.cw5 * COALESCE(pr.cache_write_5m_usd_per_mtok, pr.input_usd_per_mtok)
               + a.cw1 * COALESCE(pr.cache_write_1h_usd_per_mtok, pr.input_usd_per_mtok)) / 1000000
           END AS cost_cached
      FROM agg a
      LEFT JOIN LATERAL (
        SELECT ph.* FROM pricing_history ph
         WHERE ph.model_id = a.model_id AND ph.price_tier = a.price_tier
           AND (ph.effective_from IS NULL OR ph.effective_from <= a.day)
           AND (ph.effective_to IS NULL OR a.day < ph.effective_to)
         ORDER BY ph.is_builtin ASC, ph.effective_from DESC NULLS LAST
         LIMIT 1) pr ON true
  )`;
}

const FIGURE_COLUMNS = `
  COALESCE(sum(cost_standard) FILTER (WHERE confidence = 'exact' AND price_id IS NOT NULL), 0)::text AS exact_usd,
  COALESCE(sum(cost_standard) FILTER (WHERE confidence = 'estimated' AND price_id IS NOT NULL), 0)::text AS est_standard_usd,
  COALESCE(sum(cost_cached) FILTER (WHERE confidence = 'estimated' AND price_id IS NOT NULL), 0)::text AS est_cached_usd,
  COALESCE(sum(ws), 0)::bigint AS web_searches,
  COALESCE(sum(tokens) FILTER (WHERE price_id IS NOT NULL), 0)::bigint AS priced_tokens,
  COALESCE(sum(tokens) FILTER (WHERE price_id IS NULL), 0)::bigint AS unpriced_tokens,
  COALESCE(sum(tokens) FILTER (WHERE price_id IS NOT NULL AND raw_model_id IS NULL), 0)::bigint AS assumed_tokens`;

function readFigures(row: Record<string, unknown>): ValueFigures {
  const exact = Decimal.from(String(row.exact_usd ?? '0'));
  const standard = Decimal.from(String(row.est_standard_usd ?? '0'));
  const cached = Decimal.from(String(row.est_cached_usd ?? '0'));
  const web = Decimal.from(toNumber(row.web_searches)).mul(WEB_SEARCH_USD_PER_1000).div(1000);
  return {
    exactUsd: exact.toString(6),
    estimatedStandardUsd: standard.toString(6),
    estimatedCachedUsd: cached.toString(6),
    webSearchUsd: web.toString(6),
    totalStandardUsd: exact.add(web).add(standard).toString(6),
    totalCachedUsd: exact.add(web).add(cached).toString(6),
    pricedTokens: toNumber(row.priced_tokens),
    unpricedTokens: toNumber(row.unpriced_tokens),
    assumedTokens: toNumber(row.assumed_tokens),
  };
}

export async function getApiValue(db: SqlExecutor, filter: AnalyticsFilter, options: ValueOptions = {}): Promise<ApiValue> {
  const assumed = await resolveAssumedModel(db, options.assumedModelKey);

  const p = new Params();
  const cte = pricedCte(filter, p, `1`, '', assumed?.id ?? null);
  const totals = (await db.query<Record<string, unknown>>(`WITH ${cte} SELECT ${FIGURE_COLUMNS} FROM priced`, p.values)).rows[0];

  const pu = new Params();
  const cteU = pricedCte(filter, pu, `1`, '', assumed?.id ?? null);
  const unpriced = (
    await db.query<Record<string, unknown>>(
      `WITH ${cteU}
       SELECT (x.model_id IS NULL) AS no_model, mc.model_key, mc.display_name, x.price_tier, sum(x.tokens)::bigint AS tokens
         FROM priced x LEFT JOIN model_catalog mc ON mc.id = x.model_id
        WHERE x.price_id IS NULL AND x.tokens > 0
        GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC LIMIT 50`,
      pu.values,
    )
  ).rows;

  const ps = new Params();
  const cteS = pricedCte(filter, ps, `1`, '', assumed?.id ?? null);
  const sources = (
    await db.query<Record<string, unknown>>(
      `WITH ${cteS}
       SELECT source_url, source_retrieved_on::text AS retrieved_on, bool_or(NOT is_builtin) AS user_entered, sum(tokens)::bigint AS tokens
         FROM priced WHERE price_id IS NOT NULL AND tokens > 0
        GROUP BY 1, 2 ORDER BY 4 DESC`,
      ps.values,
    )
  ).rows;

  return {
    ...readFigures(totals ?? {}),
    unpriced: unpriced.map((r) => ({
      reason: r.no_model ? 'unknown_model' : 'no_price',
      modelKey: (r.model_key as string | null) ?? null,
      displayName: (r.display_name as string | null) ?? null,
      priceTier: String(r.price_tier),
      tokens: toNumber(r.tokens),
    })),
    sources: sources.map((r) => ({
      url: String(r.source_url),
      retrievedOn: String(r.retrieved_on),
      tokens: toNumber(r.tokens),
      userEntered: Boolean(r.user_entered),
    })),
    assumedModel: assumed ? { modelKey: assumed.model_key, displayName: assumed.display_name } : null,
  };
}

/**
 * The same figures split by a grouping expression over alias `f` (plus optional joins).
 * `groupExpr` is trusted SQL written by this codebase, never user input.
 */
export async function getApiValueBy(
  db: SqlExecutor,
  filter: AnalyticsFilter,
  groupExpr: string,
  groupJoin = '',
  options: ValueOptions = {},
): Promise<Map<string, ValueFigures>> {
  const assumed = await resolveAssumedModel(db, options.assumedModelKey);
  const p = new Params();
  const cte = pricedCte(filter, p, groupExpr, groupJoin, assumed?.id ?? null);
  const { rows } = await db.query<Record<string, unknown>>(
    `WITH ${cte} SELECT g::text AS g, ${FIGURE_COLUMNS} FROM priced GROUP BY g`,
    p.values,
  );
  const out = new Map<string, ValueFigures>();
  for (const r of rows) out.set(r.g === null ? '' : String(r.g), readFigures(r));
  return out;
}

export { ZERO_FIGURES };

// ── Actual money ────────────────────────────────────────────────────────────────

export interface ActualSpend {
  /** Sum of imported Anthropic cost reports (API billing), or null when none were imported. */
  reportedApiUsd: string | null;
  reportedRange: { first: string; last: string } | null;
  /**
   * Subscription payments implied by the monthly prices the user entered: one payment
   * for every monthly cycle that started inside each period. Null when no prices were entered.
   */
  subscriptions: Array<{ currency: string; amount: string; cycles: number }> | null;
}

export async function getActualSpend(db: SqlExecutor, userId: number, now: Date = new Date()): Promise<ActualSpend> {
  const reported = (
    await db.query<{ total: string | null; first_at: string | null; last_at: string | null }>(
      `SELECT sum(rc.amount_usd)::text AS total, min(rc.occurred_at)::date::text AS first_at, max(rc.occurred_at)::date::text AS last_at
         FROM reported_costs rc JOIN data_sources s ON s.id = rc.source_id
        WHERE rc.user_id = $1 AND s.include_in_totals`,
      [userId],
    )
  ).rows[0];

  const subs = (
    await db.query<{ currency: string; amount: string; cycles: unknown }>(
      `SELECT currency, sum(monthly_price * cycles)::text AS amount, sum(cycles)::bigint AS cycles
         FROM (
           SELECT sp.currency, sp.monthly_price,
                  -- whole months elapsed, plus one for a cycle that has started but not finished
                  GREATEST(1,
                    (EXTRACT(YEAR FROM age(LEAST(COALESCE(sp.ended_at, $2::timestamptz), $2::timestamptz), sp.started_at)) * 12
                     + EXTRACT(MONTH FROM age(LEAST(COALESCE(sp.ended_at, $2::timestamptz), $2::timestamptz), sp.started_at)))::int
                    + CASE WHEN LEAST(COALESCE(sp.ended_at, $2::timestamptz), $2::timestamptz)
                                > sp.started_at + make_interval(months =>
                                    (EXTRACT(YEAR FROM age(LEAST(COALESCE(sp.ended_at, $2::timestamptz), $2::timestamptz), sp.started_at)) * 12
                                     + EXTRACT(MONTH FROM age(LEAST(COALESCE(sp.ended_at, $2::timestamptz), $2::timestamptz), sp.started_at)))::int)
                           THEN 1 ELSE 0 END) AS cycles
             FROM subscription_periods sp
            WHERE sp.user_id = $1 AND sp.monthly_price IS NOT NULL AND sp.monthly_price > 0 AND sp.started_at <= $2::timestamptz
         ) x
        GROUP BY currency ORDER BY currency`,
      [userId, now.toISOString()],
    )
  ).rows;

  return {
    reportedApiUsd: reported?.total ?? null,
    reportedRange: reported?.total != null && reported.first_at && reported.last_at ? { first: reported.first_at, last: reported.last_at } : null,
    subscriptions: subs.length > 0 ? subs.map((s) => ({ currency: s.currency, amount: Decimal.from(s.amount).toFixed(2), cycles: toNumber(s.cycles) })) : null,
  };
}
