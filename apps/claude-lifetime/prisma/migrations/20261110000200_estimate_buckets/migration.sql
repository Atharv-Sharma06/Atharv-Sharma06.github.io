-- Pre-aggregated estimated usage. The table, indexes and foreign keys below are what
-- Prisma generates for the EstimateBucket model; the function and the view are
-- hand-written, like the view in the previous migration.

-- CreateTable
CREATE TABLE "estimate_buckets" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_id" INTEGER NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "model_id" INTEGER,
    "method_id" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "replay_tokens" BIGINT NOT NULL DEFAULT 0,
    "replay_cached_tokens" BIGINT NOT NULL DEFAULT 0,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "user_message_count" INTEGER NOT NULL DEFAULT 0,
    "assistant_message_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "estimate_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "estimate_buckets_user_id_occurred_at_idx" ON "estimate_buckets"("user_id", "occurred_at");
CREATE INDEX "estimate_buckets_conversation_id_idx" ON "estimate_buckets"("conversation_id");
CREATE INDEX "estimate_buckets_batch_id_idx" ON "estimate_buckets"("batch_id");

-- AddForeignKey
ALTER TABLE "estimate_buckets" ADD CONSTRAINT "estimate_buckets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "estimate_buckets" ADD CONSTRAINT "estimate_buckets_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "estimate_buckets" ADD CONSTRAINT "estimate_buckets_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "estimate_buckets" ADD CONSTRAINT "estimate_buckets_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "estimate_buckets" ADD CONSTRAINT "estimate_buckets_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "model_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "estimate_buckets" ADD CONSTRAINT "estimate_buckets_method_id_fkey" FOREIGN KEY ("method_id") REFERENCES "estimation_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fills estimate_buckets from token_estimates: for one import batch, or for every
-- batch when called without an argument. Each message is converted with its method's
-- factor and rounded first, and the rounded values are summed, so a bucket always
-- equals the sum of the per-message figures shown on the conversation page.
CREATE FUNCTION "refresh_estimate_buckets"("p_batch_id" integer DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  DELETE FROM "estimate_buckets" WHERE "p_batch_id" IS NULL OR "batch_id" = "p_batch_id";
  INSERT INTO "estimate_buckets" (
    "user_id", "source_id", "batch_id", "conversation_id", "model_id", "method_id", "occurred_at",
    "input_tokens", "output_tokens", "replay_tokens", "replay_cached_tokens",
    "request_count", "user_message_count", "assistant_message_count")
  SELECT e."user_id", e."source_id", e."batch_id", e."conversation_id", e."model_id", e."method_id",
         date_bin('15 minutes', e."occurred_at", TIMESTAMPTZ '2000-01-01 00:00:00+00'),
         sum(round(e."input_base" * m."central_factor"))::bigint,
         sum(round(e."output_base" * m."central_factor"))::bigint,
         sum(round(e."replay_base" * m."central_factor"))::bigint,
         sum(round(e."replay_cached_base" * m."central_factor"))::bigint,
         sum(e."request_count")::integer,
         count(*) FILTER (WHERE e."role" = 'user')::integer,
         count(*) FILTER (WHERE e."role" = 'assistant')::integer
    FROM "token_estimates" e
    JOIN "estimation_methods" m ON m."id" = e."method_id"
   WHERE "p_batch_id" IS NULL OR e."batch_id" = "p_batch_id"
   GROUP BY 1, 2, 3, 4, 5, 6, 7;
$$;

-- Estimates that were imported before this migration.
SELECT "refresh_estimate_buckets"();

-- The analytics view now reads estimated usage from the buckets. Its columns and
-- their meaning are unchanged; an estimated row is now a 15-minute bucket of a
-- conversation instead of a single message.
CREATE OR REPLACE VIEW "usage_facts" AS
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
  b."user_id", b."source_id", b."batch_id", b."conversation_id", b."model_id",
  b."occurred_at", 900 AS "bucket_seconds", 'standard' AS "price_tier",
  'estimated'::"confidence" AS "confidence",
  b."method_id",
  b."input_tokens", b."output_tokens",
  0::bigint, 0::bigint, 0::bigint,
  b."replay_tokens", b."replay_cached_tokens",
  m."low_factor", m."high_factor",
  b."request_count", b."user_message_count", b."assistant_message_count",
  0
FROM "estimate_buckets" b
JOIN "estimation_methods" m ON m."id" = b."method_id";

COMMENT ON TABLE "estimate_buckets" IS
  'Derived: token_estimates summed into 15-minute buckets per import, conversation and method. Rebuilt by refresh_estimate_buckets().';
