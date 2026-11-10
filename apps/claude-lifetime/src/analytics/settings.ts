import { resolveModel } from '@/core/models';
import type { Confidence, ParsedImport, StagedUsage } from '@/core/types';
import { toNumber, type SqlDriver, type SqlExecutor } from '@/db/driver';
import { commitImport } from '@/import/commit';
import { resetStaging, StagingWriter } from '@/import/staging';
import type { TokenBasis } from './base';

/** Preferences and accounting assumptions, stored in users.settings / users.timezone. */
export interface AppSettings {
  timezone: string;
  basis: TokenBasis;
  /**
   * Model whose prices stand in for usage with no recorded model, or null (default):
   * such usage is then reported as unpriced rather than priced on a guess.
   */
  assumedModelKey: string | null;
  /** Which cost scenario leads for estimated chat usage. */
  costScenario: 'standard' | 'cached';
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'timezone'> = {
  basis: 'processed',
  assumedModelKey: null,
  costScenario: 'standard',
};

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export async function getSettings(db: SqlExecutor, userId: number): Promise<AppSettings> {
  const { rows } = await db.query<{ timezone: string; settings: Record<string, unknown> | null }>(
    `SELECT timezone, settings FROM users WHERE id = $1`,
    [userId],
  );
  const s = rows[0]?.settings ?? {};
  return {
    timezone: rows[0]?.timezone ?? 'UTC',
    basis: s.basis === 'new' ? 'new' : DEFAULT_SETTINGS.basis,
    assumedModelKey: typeof s.assumedModelKey === 'string' && s.assumedModelKey !== '' ? s.assumedModelKey : null,
    costScenario: s.costScenario === 'cached' ? 'cached' : DEFAULT_SETTINGS.costScenario,
  };
}

export async function updateSettings(db: SqlDriver, userId: number, patch: Partial<AppSettings>): Promise<AppSettings> {
  if (patch.timezone !== undefined) {
    // Only names of the IANA database that PostgreSQL and the browser both know. Abbreviations ("PST")
    // and offsets ("UTC+5") are refused: the two read them differently, some with the opposite sign,
    // and day boundaries computed in SQL would then disagree with the dates shown on screen.
    const zone = patch.timezone.trim();
    const known = await db.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [zone]);
    let browserKnows = true;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      browserKnows = false;
    }
    if (known.rows.length === 0 || !browserKnows) {
      throw new SettingsError(`"${patch.timezone}" is not a timezone this app knows. Use an IANA name such as America/New_York or Asia/Kolkata.`);
    }
    await db.query(`UPDATE users SET timezone = $2, updated_at = now() WHERE id = $1`, [userId, zone]);
  }
  if (patch.assumedModelKey) {
    const { rows } = await db.query(`SELECT 1 FROM model_catalog WHERE model_key = $1`, [patch.assumedModelKey]);
    if (rows.length === 0) throw new SettingsError('Choose a model from the catalog.');
  }
  const json: Record<string, unknown> = {};
  if (patch.basis !== undefined) json.basis = patch.basis === 'new' ? 'new' : 'processed';
  if (patch.assumedModelKey !== undefined) json.assumedModelKey = patch.assumedModelKey;
  if (patch.costScenario !== undefined) json.costScenario = patch.costScenario === 'cached' ? 'cached' : 'standard';
  if (Object.keys(json).length > 0) {
    await db.query(`UPDATE users SET settings = settings || $2::jsonb, updated_at = now() WHERE id = $1`, [userId, JSON.stringify(json)]);
  }
  await db.flush();
  return getSettings(db, userId);
}

/** Lets the user leave a source out of all totals, e.g. when two sources report the same usage. */
export async function setSourceIncluded(db: SqlDriver, userId: number, sourceId: number, include: boolean, reason?: string): Promise<void> {
  await db.query(
    `UPDATE data_sources SET include_in_totals = $3, exclusion_reason = $4, updated_at = now() WHERE id = $1 AND user_id = $2`,
    [sourceId, userId, include, include ? null : (reason?.trim() || null)],
  );
  await db.flush();
}

// ── Catalog and prices ──────────────────────────────────────────────────────────

export interface CatalogModelRow {
  modelKey: string;
  displayName: string;
  family: string;
  tokenizerFamily: string;
  releasedOn: string | null;
  retiredOn: string | null;
  isBuiltin: boolean;
  hasStandardPrice: boolean;
}

export async function listModels(db: SqlExecutor): Promise<CatalogModelRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT m.model_key, m.display_name, m.family, m.tokenizer_family, m.released_on::text AS released_on, m.retired_on::text AS retired_on, m.is_builtin,
            EXISTS (SELECT 1 FROM pricing_history p WHERE p.model_id = m.id AND p.price_tier = 'standard') AS has_price
       FROM model_catalog m ORDER BY m.released_on DESC NULLS LAST, m.display_name`,
  );
  return rows.map((r) => ({
    modelKey: String(r.model_key),
    displayName: String(r.display_name),
    family: String(r.family),
    tokenizerFamily: String(r.tokenizer_family),
    releasedOn: (r.released_on as string | null) ?? null,
    retiredOn: (r.retired_on as string | null) ?? null,
    isBuiltin: r.is_builtin === true,
    hasStandardPrice: r.has_price === true,
  }));
}

export interface PriceRow {
  id: number;
  modelKey: string;
  displayName: string;
  priceTier: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  input: string;
  output: string;
  cacheRead: string | null;
  cacheWrite5m: string | null;
  cacheWrite1h: string | null;
  sourceUrl: string;
  sourceRetrievedOn: string;
  sourceNote: string | null;
  isBuiltin: boolean;
}

export async function listPrices(db: SqlExecutor): Promise<PriceRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT p.id, m.model_key, m.display_name, p.price_tier, p.effective_from::text AS effective_from, p.effective_to::text AS effective_to,
            p.input_usd_per_mtok::text AS input, p.output_usd_per_mtok::text AS output, p.cache_read_usd_per_mtok::text AS cache_read,
            p.cache_write_5m_usd_per_mtok::text AS cw5, p.cache_write_1h_usd_per_mtok::text AS cw1,
            p.source_url, p.source_retrieved_on::text AS retrieved_on, p.source_note, p.is_builtin
       FROM pricing_history p JOIN model_catalog m ON m.id = p.model_id
      ORDER BY m.released_on DESC NULLS LAST, m.display_name, p.price_tier, p.effective_from NULLS FIRST`,
  );
  const trim = (v: unknown) => (v === null || v === undefined ? null : String(v).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, ''));
  return rows.map((r) => ({
    id: toNumber(r.id),
    modelKey: String(r.model_key),
    displayName: String(r.display_name),
    priceTier: String(r.price_tier),
    effectiveFrom: (r.effective_from as string | null) ?? null,
    effectiveTo: (r.effective_to as string | null) ?? null,
    input: trim(r.input)!,
    output: trim(r.output)!,
    cacheRead: trim(r.cache_read),
    cacheWrite5m: trim(r.cw5),
    cacheWrite1h: trim(r.cw1),
    sourceUrl: String(r.source_url),
    sourceRetrievedOn: String(r.retrieved_on),
    sourceNote: (r.source_note as string | null) ?? null,
    isBuiltin: r.is_builtin === true,
  }));
}

export interface UserPriceInput {
  modelKey: string;
  priceTier?: string;
  effectiveFrom?: string | null;
  input: string;
  output: string;
  cacheRead?: string | null;
  cacheWrite5m?: string | null;
  cacheWrite1h?: string | null;
  sourceUrl: string;
  sourceNote?: string | null;
}

const PRICE = /^\d{1,6}(\.\d{1,6})?$/;

/** Adds a price the user looked up. User-entered prices take precedence over built-in ones. */
export async function saveUserPrice(db: SqlDriver, input: UserPriceInput): Promise<void> {
  for (const [name, v] of Object.entries({ input: input.input, output: input.output })) {
    if (!PRICE.test(String(v).trim())) throw new SettingsError(`Enter the ${name} price as USD per million tokens, for example 3 or 0.25.`);
  }
  for (const v of [input.cacheRead, input.cacheWrite5m, input.cacheWrite1h]) {
    if (v !== undefined && v !== null && String(v).trim() !== '' && !PRICE.test(String(v).trim())) throw new SettingsError('Cache prices must be numbers in USD per million tokens.');
  }
  if (!/^https?:\/\/\S+$/.test(input.sourceUrl.trim())) throw new SettingsError('Add the web address where you found the price, so the figure stays traceable.');
  const opt = (v: string | null | undefined) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  const res = await db.query(
    `INSERT INTO pricing_history (model_id, price_tier, effective_from, input_usd_per_mtok, output_usd_per_mtok,
        cache_read_usd_per_mtok, cache_write_5m_usd_per_mtok, cache_write_1h_usd_per_mtok, source_url, source_retrieved_on, source_note, is_builtin)
     SELECT m.id, $2, $3::date, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, CURRENT_DATE, $10, false
       FROM model_catalog m WHERE m.model_key = $1`,
    [input.modelKey, input.priceTier?.trim() || 'standard', opt(input.effectiveFrom), input.input.trim(), input.output.trim(),
     opt(input.cacheRead), opt(input.cacheWrite5m), opt(input.cacheWrite1h), input.sourceUrl.trim(), opt(input.sourceNote)],
  );
  if ((res.affectedRows ?? 0) === 0) throw new SettingsError('That model is not in the catalog.');
  await db.flush();
}

export async function deleteUserPrice(db: SqlDriver, id: number): Promise<void> {
  await db.query(`DELETE FROM pricing_history WHERE id = $1 AND NOT is_builtin`, [id]);
  await db.flush();
}

// ── Manual usage records ────────────────────────────────────────────────────────

export interface ManualUsageInput {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Any model identifier, or empty when not known. */
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** `exact` when copied from an official report, `estimated` for the user's own estimate. */
  confidence: Confidence;
  note?: string | null;
}

/** Records one day of usage typed in by the user, as its own deletable import. */
export async function addManualUsage(db: SqlDriver, userId: number, input: ManualUsageInput): Promise<number | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) {
    throw new SettingsError('Enter a valid date.');
  }
  const n = (v: number | undefined, name: string) => {
    const x = v ?? 0;
    if (!Number.isFinite(x) || x < 0 || !Number.isInteger(x)) throw new SettingsError(`${name} must be a whole number of tokens, zero or more.`);
    return x;
  };
  const tokens = {
    inputTokens: n(input.inputTokens, 'Input tokens'),
    outputTokens: n(input.outputTokens, 'Output tokens'),
    cacheReadTokens: n(input.cacheReadTokens, 'Cache read tokens'),
    cacheWrite5mTokens: n(input.cacheWriteTokens, 'Cache write tokens'),
  };
  if (tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWrite5mTokens === 0) {
    throw new SettingsError('Enter at least one token count.');
  }
  const model = resolveModel(input.model);
  const note = input.note?.trim() || null;
  const key = `manual:${globalThis.crypto.randomUUID()}`;
  const usage: StagedUsage = {
    conversationKey: null,
    modelKey: model?.key ?? null,
    occurredAt: `${input.date}T00:00:00.000Z`,
    bucketSeconds: 86_400,
    priceTier: 'standard',
    ...tokens,
    cacheWrite1hTokens: 0,
    requestCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    webSearchRequests: 0,
    confidence: input.confidence === 'exact' ? 'exact' : 'estimated',
    dedupKey: key,
  };
  const parsed: ParsedImport = {
    format: 'manual/usage',
    formatLabel: 'Manual entry',
    parserVersion: 'manual-1',
    source: { kind: 'manual', label: 'Manual entries', externalRef: 'manual' },
    fileName: note ? `Manual entry: ${note.slice(0, 120)}` : `Manual entry for ${input.date}`,
    fileSize: 0,
    contentHash: null,
    recordsSeen: 1,
    recordsSkipped: 0,
    missingFields: model ? [] : ['model'],
    warnings: [],
    stats: { manual: true },
  };
  await resetStaging(db);
  const writer = new StagingWriter(db);
  if (model && !model.known) {
    await writer.model({ key: model.key, displayName: model.model.displayName, family: model.model.family, tokenizerFamily: model.model.tokenizer });
  }
  await writer.usage(usage);
  await writer.finish();
  const result = await commitImport(db, userId, parsed);
  return result.batchId;
}
