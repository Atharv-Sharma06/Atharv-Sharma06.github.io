-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "source_kind" AS ENUM ('claude_export', 'claude_code', 'api_usage_report', 'api_cost_report', 'generic_json', 'generic_csv', 'manual');

-- CreateEnum
CREATE TYPE "conversation_kind" AS ENUM ('chat', 'code_session', 'usage_bucket', 'manual');

-- CreateEnum
CREATE TYPE "message_role" AS ENUM ('user', 'assistant', 'other');

-- CreateEnum
CREATE TYPE "confidence" AS ENUM ('exact', 'estimated');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "display_name" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "kind" "source_kind" NOT NULL,
    "label" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL DEFAULT '',
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "include_in_totals" BOOLEAN NOT NULL DEFAULT true,
    "exclusion_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_id" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size" BIGINT NOT NULL DEFAULT 0,
    "content_hash" TEXT,
    "format" TEXT NOT NULL,
    "parser_version" TEXT NOT NULL,
    "coverage_start" TIMESTAMPTZ(3),
    "coverage_end" TIMESTAMPTZ(3),
    "records_seen" INTEGER NOT NULL DEFAULT 0,
    "records_inserted" INTEGER NOT NULL DEFAULT 0,
    "records_duplicate" INTEGER NOT NULL DEFAULT 0,
    "records_skipped" INTEGER NOT NULL DEFAULT 0,
    "missing_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "request_keys" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_id" INTEGER NOT NULL,
    "kind" "conversation_kind" NOT NULL,
    "external_id" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "title" TEXT,
    "project_label" TEXT,
    "model_id" INTEGER,
    "created_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3),
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "user_message_count" INTEGER NOT NULL DEFAULT 0,
    "assistant_message_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "parent_external_id" TEXT,
    "role" "message_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3),
    "ordinal" INTEGER NOT NULL,
    "model_id" INTEGER,
    "text_chars" INTEGER NOT NULL DEFAULT 0,
    "thinking_chars" INTEGER NOT NULL DEFAULT 0,
    "tool_chars" INTEGER NOT NULL DEFAULT 0,
    "attachment_chars" INTEGER NOT NULL DEFAULT 0,
    "attachment_count" SMALLINT NOT NULL DEFAULT 0,
    "file_count" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_id" INTEGER NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "conversation_id" INTEGER,
    "model_id" INTEGER,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "bucket_seconds" INTEGER NOT NULL DEFAULT 900,
    "price_tier" TEXT NOT NULL DEFAULT 'standard',
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_5m_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_1h_tokens" BIGINT NOT NULL DEFAULT 0,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "user_message_count" INTEGER NOT NULL DEFAULT 0,
    "assistant_message_count" INTEGER NOT NULL DEFAULT 0,
    "web_search_requests" INTEGER NOT NULL DEFAULT 0,
    "confidence" "confidence" NOT NULL DEFAULT 'exact',
    "dedup_key" TEXT NOT NULL,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_estimates" (
    "message_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_id" INTEGER NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "model_id" INTEGER,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "role" "message_role" NOT NULL,
    "input_base" INTEGER NOT NULL DEFAULT 0,
    "output_base" INTEGER NOT NULL DEFAULT 0,
    "replay_base" BIGINT NOT NULL DEFAULT 0,
    "replay_cached_base" BIGINT NOT NULL DEFAULT 0,
    "request_count" SMALLINT NOT NULL DEFAULT 0,
    "method_id" INTEGER NOT NULL,
    "limitation_flags" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "token_estimates_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "estimation_methods" (
    "id" SERIAL NOT NULL,
    "method_key" TEXT NOT NULL,
    "tokenizer_basis" TEXT NOT NULL,
    "central_factor" DECIMAL(8,4) NOT NULL,
    "low_factor" DECIMAL(6,4) NOT NULL,
    "high_factor" DECIMAL(6,4) NOT NULL,
    "description" TEXT NOT NULL,
    "source_url" TEXT,
    "calibrated_at" TIMESTAMPTZ(3),
    "calibration_note" TEXT,

    CONSTRAINT "estimation_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reported_costs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "source_id" INTEGER NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "model_id" INTEGER,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "bucket_seconds" INTEGER NOT NULL DEFAULT 86400,
    "cost_type" TEXT,
    "token_type" TEXT,
    "description" TEXT,
    "amount_usd" DECIMAL(18,6) NOT NULL,
    "dedup_key" TEXT NOT NULL,

    CONSTRAINT "reported_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_periods" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "plan_key" TEXT NOT NULL,
    "label" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "monthly_price" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "notes" TEXT,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_catalog" (
    "id" SERIAL NOT NULL,
    "model_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "tokenizer_family" TEXT NOT NULL DEFAULT 'unknown',
    "released_on" DATE,
    "retired_on" DATE,
    "context_window" INTEGER,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_builtin" BOOLEAN NOT NULL DEFAULT true,
    "source_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_history" (
    "id" SERIAL NOT NULL,
    "model_id" INTEGER NOT NULL,
    "price_tier" TEXT NOT NULL DEFAULT 'standard',
    "effective_from" DATE,
    "effective_to" DATE,
    "input_usd_per_mtok" DECIMAL(12,6) NOT NULL,
    "output_usd_per_mtok" DECIMAL(12,6) NOT NULL,
    "cache_read_usd_per_mtok" DECIMAL(12,6),
    "cache_write_5m_usd_per_mtok" DECIMAL(12,6),
    "cache_write_1h_usd_per_mtok" DECIMAL(12,6),
    "source_url" TEXT NOT NULL,
    "source_retrieved_on" DATE NOT NULL,
    "source_note" TEXT,
    "is_builtin" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "synced_files" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "last_modified" TIMESTAMPTZ(3) NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "synced_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_sources_user_id_kind_external_ref_key" ON "data_sources"("user_id", "kind", "external_ref");

-- CreateIndex
CREATE INDEX "import_batches_source_id_idx" ON "import_batches"("source_id");

-- CreateIndex
CREATE INDEX "import_batches_user_id_content_hash_idx" ON "import_batches"("user_id", "content_hash");

-- CreateIndex
CREATE INDEX "conversations_user_id_created_at_idx" ON "conversations"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "conversations_user_id_updated_at_idx" ON "conversations"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "conversations_source_id_idx" ON "conversations"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_user_id_dedup_key_key" ON "conversations"("user_id", "dedup_key");

-- CreateIndex
CREATE INDEX "messages_batch_id_idx" ON "messages"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_external_id_key" ON "messages"("conversation_id", "external_id");

-- CreateIndex
CREATE INDEX "usage_records_user_id_occurred_at_idx" ON "usage_records"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_records_conversation_id_idx" ON "usage_records"("conversation_id");

-- CreateIndex
CREATE INDEX "usage_records_batch_id_idx" ON "usage_records"("batch_id");

-- CreateIndex
CREATE INDEX "usage_records_source_id_occurred_at_idx" ON "usage_records"("source_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_user_id_dedup_key_key" ON "usage_records"("user_id", "dedup_key");

-- CreateIndex
CREATE INDEX "token_estimates_user_id_occurred_at_idx" ON "token_estimates"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "token_estimates_conversation_id_idx" ON "token_estimates"("conversation_id");

-- CreateIndex
CREATE INDEX "token_estimates_batch_id_idx" ON "token_estimates"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "estimation_methods_method_key_key" ON "estimation_methods"("method_key");

-- CreateIndex
CREATE INDEX "reported_costs_user_id_occurred_at_idx" ON "reported_costs"("user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "reported_costs_user_id_dedup_key_key" ON "reported_costs"("user_id", "dedup_key");

-- CreateIndex
CREATE INDEX "subscription_periods_user_id_started_at_idx" ON "subscription_periods"("user_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "model_catalog_model_key_key" ON "model_catalog"("model_key");

-- CreateIndex
CREATE INDEX "pricing_history_model_id_price_tier_effective_from_idx" ON "pricing_history"("model_id", "price_tier", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "synced_files_source_id_path_key" ON "synced_files"("source_id", "path");

-- AddForeignKey
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "model_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "model_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "model_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_estimates" ADD CONSTRAINT "token_estimates_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_estimates" ADD CONSTRAINT "token_estimates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_estimates" ADD CONSTRAINT "token_estimates_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_estimates" ADD CONSTRAINT "token_estimates_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_estimates" ADD CONSTRAINT "token_estimates_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_estimates" ADD CONSTRAINT "token_estimates_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "model_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_estimates" ADD CONSTRAINT "token_estimates_method_id_fkey" FOREIGN KEY ("method_id") REFERENCES "estimation_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_costs" ADD CONSTRAINT "reported_costs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_costs" ADD CONSTRAINT "reported_costs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_costs" ADD CONSTRAINT "reported_costs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_costs" ADD CONSTRAINT "reported_costs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "model_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_history" ADD CONSTRAINT "pricing_history_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "model_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synced_files" ADD CONSTRAINT "synced_files_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
