-- Hand-written migration: the parts of the schema that the Prisma schema language
-- cannot express (check constraints, an exclusion constraint and the analytics view).

-- ── Integrity ───────────────────────────────────────────────────────────────

-- Token counts are never negative.
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_non_negative" CHECK (
  "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0
  AND "cache_write_5m_tokens" >= 0 AND "cache_write_1h_tokens" >= 0
  AND "request_count" >= 0 AND "bucket_seconds" >= 0
);
ALTER TABLE "token_estimates" ADD CONSTRAINT "token_estimates_non_negative" CHECK (
  "input_base" >= 0 AND "output_base" >= 0 AND "replay_base" >= 0
  AND "replay_cached_base" >= 0 AND "replay_cached_base" <= "replay_base"
);
ALTER TABLE "estimation_methods" ADD CONSTRAINT "estimation_methods_band" CHECK (
  "central_factor" > 0 AND "low_factor" > 0 AND "low_factor" <= 1 AND "high_factor" >= 1
);
ALTER TABLE "pricing_history" ADD CONSTRAINT "pricing_history_non_negative" CHECK (
  "input_usd_per_mtok" >= 0 AND "output_usd_per_mtok" >= 0
  AND ("effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" > "effective_from")
);

-- A subscription period must end after it starts ...
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_range" CHECK (
  "ended_at" IS NULL OR "ended_at" > "started_at"
);
-- ... and two periods of the same user may never overlap. Both columns are compared
-- as ranges so the constraint needs no extension: equal user ids overlap as
-- single-point ranges, and the time ranges are half-open [start, end).
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_no_overlap"
  EXCLUDE USING gist (
    int4range("user_id", "user_id", '[]') WITH &&,
    tstzrange("started_at", "ended_at", '[)') WITH &&
  );

-- ── Analytics view ──────────────────────────────────────────────────────────
-- One row shape for every usage fact, exact or estimated. Every dashboard number
-- is computed from this view, so each one can be traced to a source, an import
-- batch and a confidence classification.
--
-- Token categories (documented in docs/METHODOLOGY.md):
--   input_tokens           uncached input (exact) / new input content (estimated)
--   output_tokens          generated output
--   cache_write_*_tokens   input written to the prompt cache (exact sources only)
--   cache_read_tokens      input served from the prompt cache (exact sources only)
--   replay_tokens          earlier context re-sent with each request (estimated sources
--                          only; modelled, see token_estimates)
-- "New tokens"       = input + output + cache writes
-- "Processed tokens" = new tokens + cache reads + replay
-- A category is counted in exactly one column, so sums never double count.
CREATE VIEW "usage_facts" AS
SELECT
  u."user_id", u."source_id", u."batch_id", u."conversation_id", u."model_id",
  u."occurred_at", u."bucket_seconds", u."price_tier", u."confidence",
  NULL::integer AS "method_id",
  u."input_tokens", u."output_tokens",
  u."cache_read_tokens", u."cache_write_5m_tokens", u."cache_write_1h_tokens",
  0::bigint AS "replay_tokens", 0::bigint AS "replay_cached_tokens",
  -- exact counts have no uncertainty band
  1::numeric AS "low_factor", 1::numeric AS "high_factor",
  u."request_count", u."user_message_count", u."assistant_message_count",
  u."web_search_requests"
FROM "usage_records" u
UNION ALL
SELECT
  e."user_id", e."source_id", e."batch_id", e."conversation_id", e."model_id",
  e."occurred_at", 0 AS "bucket_seconds", 'standard' AS "price_tier",
  'estimated'::"confidence" AS "confidence",
  e."method_id",
  -- base units -> tokens for the tokenizer generation the method assumes
  round(e."input_base" * m."central_factor")::bigint,
  round(e."output_base" * m."central_factor")::bigint,
  0::bigint, 0::bigint, 0::bigint,
  round(e."replay_base" * m."central_factor")::bigint,
  round(e."replay_cached_base" * m."central_factor")::bigint,
  m."low_factor", m."high_factor",
  e."request_count"::integer,
  (e."role" = 'user')::integer, (e."role" = 'assistant')::integer,
  0
FROM "token_estimates" e
JOIN "estimation_methods" m ON m."id" = e."method_id";

COMMENT ON VIEW "usage_facts" IS
  'usage_records and token_estimates in one shape, with the confidence of every row.';
COMMENT ON TABLE "usage_records" IS
  'Token counts a source states, aggregated into time buckets. The confidence column says whether they were metered (exact) or are stated without being declared exact (estimated).';
COMMENT ON TABLE "token_estimates" IS
  'Token counts estimated from message text. Never an official Anthropic accounting figure.';
COMMENT ON TABLE "reported_costs" IS
  'Actual spend from Anthropic cost reports. Distinct from equivalent API value.';
