import { resolveModel } from '@/core/models';
import type { Confidence, ParsedImport, StagedUsage } from '@/core/types';
import { toNumber, type SqlDriver, type SqlExecutor } from '@/db/driver';
import { commitImport } from '@/import/commit';
import { asOnlyImport } from '@/import/lock';
import { resetStaging, StagingWriter } from '@/import/staging';
import { dayInZone } from '@/lib/format';
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
    // A name typed in another letter case ("asia/kolkata") is stored under its proper spelling, the one
    // PostgreSQL lists; the exact spelling wins where two names differ only in case.
    const typed = patch.timezone.trim();
    const known = await db.query<{ name: string }>(
      `SELECT name FROM pg_timezone_names WHERE lower(name) = lower($1) ORDER BY (name = $1) DESC, name LIMIT 1`,
      [typed],
    );
    const zone = known.rows[0]?.name ?? typed;
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

/**
 * Adds a price the user looked up. User-entered prices take precedence over built-in
 * ones. A price for a model, tier and start date the user already entered one for
 * replaces it: entering the price again is how a typing mistake is corrected, and two
 * rows for the same thing would leave it open which one applies.
 */
export async function saveUserPrice(db: SqlDriver, input: UserPriceInput): Promise<void> {
  for (const [name, v] of Object.entries({ input: input.input, output: input.output })) {
    if (!PRICE.test(String(v).trim())) throw new SettingsError(`Enter the ${name} price as USD per million tokens, for example 3 or 0.25.`);
  }
  for (const v of [input.cacheRead, input.cacheWrite5m, input.cacheWrite1h]) {
    if (v !== undefined && v !== null && String(v).trim() !== '' && !PRICE.test(String(v).trim())) throw new SettingsError('Cache prices must be numbers in USD per million tokens.');
  }
  if (!/^https?:\/\/\S+$/.test(input.sourceUrl.trim())) throw new SettingsError('Add the web address where you found the price, so the figure stays traceable.');
  const opt = (v: string | null | undefined) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  const tier = input.priceTier?.trim() || 'standard';
  await db.transaction(async (tx) => {
    await tx.query(
      `DELETE FROM pricing_history ph USING model_catalog m
        WHERE m.id = ph.model_id AND m.model_key = $1 AND NOT ph.is_builtin
          AND ph.price_tier = $2 AND ph.effective_from IS NOT DISTINCT FROM $3::date`,
      [input.modelKey, tier, opt(input.effectiveFrom)],
    );
    const res = await tx.query(
      `INSERT INTO pricing_history (model_id, price_tier, effective_from, input_usd_per_mtok, output_usd_per_mtok,
          cache_read_usd_per_mtok, cache_write_5m_usd_per_mtok, cache_write_1h_usd_per_mtok, source_url, source_retrieved_on, source_note, is_builtin)
       SELECT m.id, $2, $3::date, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, CURRENT_DATE, $10, false
         FROM model_catalog m WHERE m.model_key = $1`,
      [input.modelKey, tier, opt(input.effectiveFrom), input.input.trim(), input.output.trim(),
       opt(input.cacheRead), opt(input.cacheWrite5m), opt(input.cacheWrite1h), input.sourceUrl.trim(), opt(input.sourceNote)],
    );
    // Nothing was inserted, so the transaction is rolled back and the delete above with it.
    if ((res.affectedRows ?? 0) === 0) throw new SettingsError('That model is not in the catalog.');
  });
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

export interface ManualUsageResult {
  batchId: number | null;
  /** The synthetic demo data was removed by this entry, as by any real import. */
  removedDemoData: boolean;
  /** Set when the entry is saved but could not be copied to the device's storage (see CommitResult.notOnDevice). */
  notOnDevice: string | null;
}

/** No Claude model was available before 2021; the importers refuse earlier dates for the same reason. */
export const MANUAL_ENTRY_FIRST_DAY = '2021-01-01';

/**
 * The latest day an entry can be for: today in `timezone`, the timezone the app shows
 * days in. An entry is filed under the day the person names, in that timezone.
 */
export function manualEntryLastDay(timezone: string, now: Date = new Date()): string {
  return dayInZone(now, timezone);
}

/**
 * The most tokens one count of an entry can be: far more than anybody uses in a day, and
 * far less than the largest number that is stored exactly. Without a limit, a slip of
 * the keyboard (a pasted number, a key held down) was stored rounded, or refused by the
 * database in its own words.
 */
export const MANUAL_ENTRY_MAX_TOKENS = 1_000_000_000_000;

/** Records one day of usage typed in by the user, as its own deletable import. */
export async function addManualUsage(db: SqlDriver, userId: number, input: ManualUsageInput, now: Date = new Date()): Promise<ManualUsageResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T00:00:00Z`))) {
    throw new SettingsError('Enter a valid date.');
  }
  // A year that is still being typed (0226 for 2026) is a valid date too, and one such entry stretches every chart over centuries.
  if (input.date < MANUAL_ENTRY_FIRST_DAY) throw new SettingsError('Enter a day in 2021 or later: no Claude usage can have happened before.');
  const { timezone } = await getSettings(db, userId);
  if (input.date > manualEntryLastDay(timezone, now)) throw new SettingsError('Enter a day that is not in the future.');
  const n = (v: number | undefined, name: string) => {
    const x = v ?? 0;
    // First: a run of digits too long for a number at all arrives here as Infinity, and is too many, not "no whole number".
    if (x > MANUAL_ENTRY_MAX_TOKENS) {
      throw new SettingsError(
        `Enter at most ${MANUAL_ENTRY_MAX_TOKENS.toLocaleString('en-US')} ${name.toLowerCase()}. That is already far more than a day of use.`,
      );
    }
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
  // A manual entry is saved through the staging tables like every import. They may hold another import
  // that is waiting at its preview, so the entry is only made while no other import is under way.
  return asOnlyImport(async () => {
    const staging = await resetStaging(db);
    const writer = new StagingWriter(db);
    if (model && !model.known) {
      await writer.model({ key: model.key, displayName: model.model.displayName, family: model.model.family, tokenizerFamily: model.model.tokenizer });
    }
    await writer.usage(usage);
    await writer.finish();
    try {
      const result = await commitImport(db, userId, parsed, { staging });
      return { batchId: result.batchId, removedDemoData: result.removedDemoData, notOnDevice: result.notOnDevice ?? null };
    } finally {
      await resetStaging(db).catch(() => undefined);
    }
  });
}
