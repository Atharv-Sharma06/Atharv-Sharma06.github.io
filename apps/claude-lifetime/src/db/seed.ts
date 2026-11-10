import { CATALOG_VERSION, METHODS, MODELS, PRICES } from '@/core/catalog';
import type { SqlDriver, SqlExecutor } from './driver';

/**
 * Makes sure the single local user exists and that the built-in catalog (models,
 * prices, estimation methods) matches the version shipped with this build.
 * Rows the user added or edited (is_builtin = false) and calibrated estimation
 * factors are never overwritten.
 */
export async function ensureSeeded(db: SqlDriver, defaults: { timezone?: string } = {}): Promise<number> {
  await db.query(
    `INSERT INTO "users" ("timezone") SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM "users")`,
    [defaults.timezone ?? 'UTC'],
  );
  const { rows } = await db.query<{ id: number; settings: { catalogVersion?: number } | null }>(
    `SELECT "id", "settings" FROM "users" ORDER BY "id" LIMIT 1`,
  );
  const userId = rows[0].id;
  if ((rows[0].settings?.catalogVersion ?? 0) >= CATALOG_VERSION) return userId;

  await db.transaction(async (tx) => {
    await upsertMethods(tx);
    // The buckets hold tokens with the methods' factors applied, so new factors mean new buckets.
    await tx.query(`SELECT refresh_estimate_buckets()`);
    await upsertModels(tx);
    await replaceBuiltinPrices(tx);
    await tx.query(
      `UPDATE "users" SET "settings" = "settings" || jsonb_build_object('catalogVersion', $2::int), "updated_at" = now() WHERE "id" = $1`,
      [userId, CATALOG_VERSION],
    );
  });
  return userId;
}

async function upsertMethods(tx: SqlExecutor) {
  for (const m of METHODS) {
    await tx.query(
      `INSERT INTO "estimation_methods" ("method_key", "tokenizer_basis", "central_factor", "low_factor", "high_factor", "description", "source_url")
       VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6, $7)
       ON CONFLICT ("method_key") DO UPDATE SET
         "tokenizer_basis" = EXCLUDED."tokenizer_basis",
         "description" = EXCLUDED."description",
         "source_url" = EXCLUDED."source_url",
         -- keep a factor the user calibrated against the token counting API
         "central_factor" = CASE WHEN "estimation_methods"."calibrated_at" IS NULL THEN EXCLUDED."central_factor" ELSE "estimation_methods"."central_factor" END,
         "low_factor" = CASE WHEN "estimation_methods"."calibrated_at" IS NULL THEN EXCLUDED."low_factor" ELSE "estimation_methods"."low_factor" END,
         "high_factor" = CASE WHEN "estimation_methods"."calibrated_at" IS NULL THEN EXCLUDED."high_factor" ELSE "estimation_methods"."high_factor" END`,
      [m.key, m.basis, m.centralFactor, m.lowFactor, m.highFactor, m.description, m.sourceUrl],
    );
  }
}

async function upsertModels(tx: SqlExecutor) {
  for (const m of MODELS) {
    await tx.query(
      `INSERT INTO "model_catalog" ("model_key", "display_name", "family", "tokenizer_family", "released_on", "retired_on", "context_window", "aliases", "is_builtin", "source_url")
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8::text[], true, $9)
       ON CONFLICT ("model_key") DO UPDATE SET
         "display_name" = EXCLUDED."display_name",
         "family" = EXCLUDED."family",
         "tokenizer_family" = EXCLUDED."tokenizer_family",
         "released_on" = EXCLUDED."released_on",
         "retired_on" = EXCLUDED."retired_on",
         "context_window" = EXCLUDED."context_window",
         "aliases" = EXCLUDED."aliases",
         "is_builtin" = true,
         "source_url" = EXCLUDED."source_url"`,
      [m.key, m.displayName, m.family, m.tokenizer, m.releasedOn ?? null, m.retiredOn ?? null, m.contextWindow ?? null, m.aliases, m.sourceUrl],
    );
  }
}

async function replaceBuiltinPrices(tx: SqlExecutor) {
  await tx.query(`DELETE FROM "pricing_history" WHERE "is_builtin"`);
  for (const p of PRICES) {
    await tx.query(
      `INSERT INTO "pricing_history" ("model_id", "price_tier", "effective_from", "effective_to",
         "input_usd_per_mtok", "output_usd_per_mtok", "cache_read_usd_per_mtok", "cache_write_5m_usd_per_mtok", "cache_write_1h_usd_per_mtok",
         "source_url", "source_retrieved_on", "source_note", "is_builtin")
       SELECT m."id", $2, $3::date, $4::date, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10, $11::date, $12, true
         FROM "model_catalog" m WHERE m."model_key" = $1`,
      [p.model, p.tier, p.effectiveFrom ?? null, p.effectiveTo ?? null, p.input, p.output, p.cacheRead, p.cacheWrite5m, p.cacheWrite1h, p.sourceUrl, p.retrievedOn, p.note ?? null],
    );
  }
}
