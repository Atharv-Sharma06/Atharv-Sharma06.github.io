/**
 * Built-in model catalog and published API prices.
 *
 * Every price below was read from an Anthropic page on the date in `retrievedOn`.
 * Nothing here is inferred: a model without a verified published price simply has
 * no row, and usage on it is shown as "unpriced" until the user adds a price.
 *
 * To update: edit this file, bump CATALOG_VERSION, and the app upserts the built-in
 * rows on next start (rows a user added or edited are never overwritten).
 */
import { Decimal } from './decimal';

export const CATALOG_VERSION = 1;

export const SOURCES = {
  pricing: 'https://platform.claude.com/docs/en/about-claude/pricing',
  deprecations: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
  releaseNotes: 'https://platform.claude.com/docs/en/release-notes/overview',
  glossary: 'https://platform.claude.com/docs/en/about-claude/glossary',
  tokenCounting: 'https://platform.claude.com/docs/en/build-with-claude/token-counting',
  claude3: 'https://www.anthropic.com/news/claude-3-family',
  claude35Sonnet: 'https://www.anthropic.com/news/claude-3-5-sonnet',
  claude35Haiku: 'https://www.anthropic.com/news/3-5-models-and-computer-use',
  claude37Sonnet: 'https://www.anthropic.com/news/claude-3-7-sonnet',
} as const;

/** Date the pages above were read while building this catalog. */
export const RETRIEVED_ON = '2026-11-10';

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos' | 'claude-2' | 'claude-instant' | 'other';

/**
 * Claude models do not all share a tokenizer.
 *  - claude2:  Claude 2.x and earlier (Anthropic's published legacy tokenizer is exact for these)
 *  - claude3:  Claude 3 up to Opus 4.6 / Sonnet 4.6 / Haiku 4.5 ("the previous tokenizer")
 *  - claude47: Opus 4.7 and later, Sonnet 5+, Haiku 5.5, Fable, Mythos (~30% more tokens for the same text)
 */
export type TokenizerFamily = 'claude2' | 'claude3' | 'claude47' | 'unknown';

/** First day a model with the newer tokenizer was generally available (Claude Opus 4.7). */
export const NEW_TOKENIZER_FROM = '2026-04-16';
/** First day a Claude 3 model was available (Claude 3 Opus and Sonnet). */
export const CLAUDE3_FROM = '2024-03-04';

export interface CatalogModel {
  key: string;
  displayName: string;
  family: ModelFamily;
  tokenizer: TokenizerFamily;
  /** ISO date from the API release notes or the launch announcement. */
  releasedOn?: string;
  retiredOn?: string;
  contextWindow?: number;
  aliases: string[];
  sourceUrl: string;
}

const M = (
  key: string,
  displayName: string,
  family: ModelFamily,
  tokenizer: TokenizerFamily,
  extra: Partial<CatalogModel> = {},
): CatalogModel => ({ key, displayName, family, tokenizer, aliases: [], sourceUrl: SOURCES.releaseNotes, ...extra });

export const MODELS: CatalogModel[] = [
  // Fable / Mythos
  M('claude-fable-5-2', 'Claude Fable 5.2', 'fable', 'claude47', { releasedOn: '2026-11-09', contextWindow: 1_000_000 }),
  M('claude-mythos-5-2', 'Claude Mythos 5.2', 'mythos', 'claude47', { releasedOn: '2026-11-09', contextWindow: 1_000_000 }),
  M('claude-fable-5-1', 'Claude Fable 5.1', 'fable', 'claude47', { releasedOn: '2026-09-01', contextWindow: 1_000_000 }),
  M('claude-mythos-5-1', 'Claude Mythos 5.1', 'mythos', 'claude47', { releasedOn: '2026-09-01', contextWindow: 1_000_000 }),
  M('claude-fable-5', 'Claude Fable 5', 'fable', 'claude47', { releasedOn: '2026-06-09', contextWindow: 1_000_000 }),
  M('claude-mythos-5', 'Claude Mythos 5', 'mythos', 'claude47', { releasedOn: '2026-06-09', contextWindow: 1_000_000 }),
  M('claude-mythos-preview', 'Claude Mythos Preview', 'mythos', 'claude47', { contextWindow: 1_000_000, sourceUrl: SOURCES.deprecations }),
  // Opus
  M('claude-opus-5-5', 'Claude Opus 5.5', 'opus', 'claude47', { releasedOn: '2026-09-22', contextWindow: 1_000_000 }),
  M('claude-opus-5', 'Claude Opus 5', 'opus', 'claude47', { releasedOn: '2026-07-24', contextWindow: 1_000_000 }),
  M('claude-opus-4-8', 'Claude Opus 4.8', 'opus', 'claude47', { releasedOn: '2026-05-28', contextWindow: 1_000_000 }),
  M('claude-opus-4-7', 'Claude Opus 4.7', 'opus', 'claude47', { releasedOn: '2026-04-16', contextWindow: 1_000_000 }),
  M('claude-opus-4-6', 'Claude Opus 4.6', 'opus', 'claude3', { releasedOn: '2026-02-05', contextWindow: 1_000_000 }),
  M('claude-opus-4-5', 'Claude Opus 4.5', 'opus', 'claude3', {
    releasedOn: '2025-11-24',
    contextWindow: 200_000,
    aliases: ['claude-opus-4-5-20251101'],
  }),
  M('claude-opus-4-1', 'Claude Opus 4.1', 'opus', 'claude3', {
    releasedOn: '2025-08-05',
    retiredOn: '2026-08-05',
    contextWindow: 200_000,
    aliases: ['claude-opus-4-1-20250805'],
  }),
  M('claude-opus-4', 'Claude Opus 4', 'opus', 'claude3', {
    releasedOn: '2025-05-22',
    retiredOn: '2026-06-15',
    contextWindow: 200_000,
    aliases: ['claude-opus-4-20250514', 'claude-opus-4-0'],
  }),
  M('claude-3-opus', 'Claude Opus 3', 'opus', 'claude3', {
    releasedOn: '2024-03-04',
    retiredOn: '2026-01-05',
    contextWindow: 200_000,
    aliases: ['claude-3-opus-20240229'],
    sourceUrl: SOURCES.claude3,
  }),
  // Sonnet
  M('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'sonnet', 'claude47', { releasedOn: '2026-09-28', contextWindow: 1_000_000 }),
  M('claude-sonnet-5', 'Claude Sonnet 5', 'sonnet', 'claude47', { releasedOn: '2026-06-30', contextWindow: 1_000_000 }),
  M('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'sonnet', 'claude3', { releasedOn: '2026-02-17', contextWindow: 1_000_000 }),
  M('claude-sonnet-4-5', 'Claude Sonnet 4.5', 'sonnet', 'claude3', {
    releasedOn: '2025-09-29',
    retiredOn: '2026-11-30',
    contextWindow: 200_000,
    aliases: ['claude-sonnet-4-5-20250929'],
  }),
  M('claude-sonnet-4', 'Claude Sonnet 4', 'sonnet', 'claude3', {
    releasedOn: '2025-05-22',
    retiredOn: '2026-06-15',
    contextWindow: 200_000,
    aliases: ['claude-sonnet-4-20250514', 'claude-sonnet-4-0'],
  }),
  M('claude-3-7-sonnet', 'Claude Sonnet 3.7', 'sonnet', 'claude3', {
    releasedOn: '2025-02-24',
    retiredOn: '2026-02-19',
    contextWindow: 200_000,
    aliases: ['claude-3-7-sonnet-20250219'],
  }),
  M('claude-3-5-sonnet', 'Claude Sonnet 3.5', 'sonnet', 'claude3', {
    releasedOn: '2024-06-21',
    retiredOn: '2025-10-28',
    contextWindow: 200_000,
    aliases: ['claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022'],
    sourceUrl: SOURCES.claude35Sonnet,
  }),
  M('claude-3-sonnet', 'Claude Sonnet 3', 'sonnet', 'claude3', {
    releasedOn: '2024-03-04',
    retiredOn: '2025-07-21',
    contextWindow: 200_000,
    aliases: ['claude-3-sonnet-20240229'],
    sourceUrl: SOURCES.claude3,
  }),
  // Haiku
  M('claude-haiku-5-5', 'Claude Haiku 5.5', 'haiku', 'claude47', { releasedOn: '2026-10-07', contextWindow: 1_000_000 }),
  M('claude-haiku-4-5', 'Claude Haiku 4.5', 'haiku', 'claude3', {
    releasedOn: '2025-10-15',
    contextWindow: 200_000,
    aliases: ['claude-haiku-4-5-20251001'],
  }),
  M('claude-3-5-haiku', 'Claude Haiku 3.5', 'haiku', 'claude3', {
    retiredOn: '2026-02-19',
    contextWindow: 200_000,
    aliases: ['claude-3-5-haiku-20241022'],
    sourceUrl: SOURCES.claude35Haiku,
  }),
  M('claude-3-haiku', 'Claude Haiku 3', 'haiku', 'claude3', {
    retiredOn: '2026-04-20',
    contextWindow: 200_000,
    aliases: ['claude-3-haiku-20240307'],
    sourceUrl: SOURCES.claude3,
  }),
  // Pre-Claude-3 (retired; identifiers from the model deprecations page)
  M('claude-2.1', 'Claude 2.1', 'claude-2', 'claude2', { retiredOn: '2025-07-21', contextWindow: 200_000, sourceUrl: SOURCES.deprecations }),
  M('claude-2.0', 'Claude 2.0', 'claude-2', 'claude2', { retiredOn: '2025-07-21', contextWindow: 100_000, aliases: ['claude-2'], sourceUrl: SOURCES.deprecations }),
  M('claude-instant-1.2', 'Claude Instant 1.2', 'claude-instant', 'claude2', {
    retiredOn: '2024-11-06',
    contextWindow: 100_000,
    aliases: ['claude-instant-1', 'claude-instant-1.1', 'claude-instant-1.0'],
    sourceUrl: SOURCES.deprecations,
  }),
];

// ── Prices ────────────────────────────────────────────────────────────────────

/** standard | batch (Batch API) | fast (fast mode) | long_context (prompt over the model's threshold) */
export type BasePriceTier = 'standard' | 'batch' | 'fast' | 'long_context';
/** A base tier, or the same tier for requests that asked for US-only inference (`standard_us`, `batch_us`, ...). */
export type PriceTier = BasePriceTier | `${BasePriceTier}_us`;

/** Suffix of the tiers for requests served with `inference_geo: "us"`. */
export const US_INFERENCE_SUFFIX = '_us';
/** "specifying US-only inference through the inference_geo parameter incurs a 1.1x multiplier on all token pricing categories" (pricing page). */
export const US_INFERENCE_MULTIPLIER = '1.1';
/**
 * The multiplier is published for "Claude 4.6 and later models"; earlier models do not accept the
 * parameter. Claude Opus 4.6, released on this day, was the first of them.
 */
export const US_INFERENCE_FROM = '2026-02-05';

/** The tier a request is priced under when it asked for US-only inference. Any other geography leaves the tier as it is. */
export function tierForGeography(tier: string, inferenceGeo: string | null | undefined): string {
  return typeof inferenceGeo === 'string' && inferenceGeo.trim().toLowerCase() === 'us' ? `${tier}${US_INFERENCE_SUFFIX}` : tier;
}

const TIER_NAMES: Record<string, string> = {
  standard: 'Standard',
  batch: 'Batch API',
  fast: 'Fast mode',
  long_context: 'Long context',
  priority: 'Priority',
  flex: 'Flex',
};

/** A readable name for a price tier. Tiers the app has no name for (they come from imported files) are shown as written. */
export function tierLabel(tier: string): string {
  const { base, usOnly } = splitTier(tier);
  const words = base.replace(/[_-]+/g, ' ').trim();
  const name = TIER_NAMES[base] ?? (words === '' ? 'Standard' : words.charAt(0).toUpperCase() + words.slice(1));
  return usOnly ? `${name}, US-only inference` : name;
}

/** Splits a stored tier into its base tier and whether it is the US-only variant. */
export function splitTier(tier: string): { base: string; usOnly: boolean } {
  const usOnly = tier.length > US_INFERENCE_SUFFIX.length && tier.endsWith(US_INFERENCE_SUFFIX);
  return { base: usOnly ? tier.slice(0, -US_INFERENCE_SUFFIX.length) : tier, usOnly };
}

export interface CatalogPrice {
  model: string;
  tier: PriceTier;
  /** ISO date; undefined = since launch. */
  effectiveFrom?: string;
  effectiveTo?: string;
  /** USD per million tokens, as exact decimal strings. */
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite5m: string;
  cacheWrite1h: string;
  sourceUrl: string;
  retrievedOn: string;
  note?: string;
}

const d = (v: string | Decimal) => Decimal.from(v).toString(6);

/**
 * The pricing page states cache prices as multipliers of the base input price:
 * 5-minute write 1.25x, 1-hour write 2x, read 0.1x (0.05x and 0.025x on some models).
 */
function withCache(input: string, readMultiplier = '0.1') {
  const base = Decimal.from(input);
  return {
    cacheWrite5m: d(base.mul('1.25')),
    cacheWrite1h: d(base.mul('2')),
    cacheRead: d(base.mul(readMultiplier)),
  };
}

interface Listed {
  models: string[];
  input: string;
  output: string;
  /** Cache-read multiplier relative to base input (pricing page footnotes). */
  read?: string;
  /** Explicit cache-read price when the page lists one that is not input x multiplier. */
  cacheRead?: string;
}

/** "Model pricing" table, read on RETRIEVED_ON. */
const STANDARD: Listed[] = [
  { models: ['claude-fable-5-2', 'claude-mythos-5-2'], input: '8', output: '40', read: '0.025' },
  { models: ['claude-fable-5-1', 'claude-mythos-5-1'], input: '10', output: '50', read: '0.025' },
  { models: ['claude-fable-5', 'claude-mythos-5'], input: '10', output: '50' },
  { models: ['claude-opus-5-5'], input: '4', output: '20', read: '0.05' },
  { models: ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'], input: '5', output: '25' },
  { models: ['claude-opus-4-1', 'claude-opus-4'], input: '15', output: '75' },
  { models: ['claude-sonnet-5-5'], input: '2', output: '10', read: '0.05' },
  { models: ['claude-sonnet-5'], input: '2', output: '10' },
  { models: ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'], input: '3', output: '15' },
  { models: ['claude-haiku-5-5'], input: '0.10', output: '0.50' },
  { models: ['claude-haiku-4-5'], input: '1', output: '5' },
];

/** "Fast mode pricing" table. Cache multipliers apply on top of the fast-mode input price. */
const FAST: Listed[] = [
  { models: ['claude-fable-5-2', 'claude-mythos-5-2'], input: '16', output: '80', read: '0.025' },
  { models: ['claude-opus-5-5'], input: '8', output: '40', read: '0.05' },
  { models: ['claude-opus-5', 'claude-opus-4-8'], input: '10', output: '50' },
];

/** Claude Haiku 5.5 is priced higher when the prompt is over 100,000 tokens. */
const LONG_CONTEXT: Listed[] = [{ models: ['claude-haiku-5-5'], input: '0.50', output: '2.50' }];

/** Retired models: prices from Anthropic's launch announcements (no longer on the pricing page). */
const RETIRED: Array<Listed & { sourceUrl: string; note: string; effectiveFrom?: string }> = [
  { models: ['claude-3-opus'], input: '15', output: '75', sourceUrl: SOURCES.claude3, note: 'Launch announcement, 4 Mar 2024.' },
  { models: ['claude-3-sonnet'], input: '3', output: '15', sourceUrl: SOURCES.claude3, note: 'Launch announcement, 4 Mar 2024.' },
  { models: ['claude-3-haiku'], input: '0.25', output: '1.25', sourceUrl: SOURCES.claude3, note: 'Launch announcement, 4 Mar 2024.' },
  { models: ['claude-3-5-sonnet'], input: '3', output: '15', sourceUrl: SOURCES.claude35Sonnet, note: 'Launch announcement, Jun 2024.' },
  {
    models: ['claude-3-5-haiku'],
    input: '0.80',
    output: '4',
    sourceUrl: SOURCES.claude35Haiku,
    note: 'Price as revised on 3 Dec 2024. The earlier launch price is not on file, so this price is applied to all dates.',
  },
  { models: ['claude-3-7-sonnet'], input: '3', output: '15', sourceUrl: SOURCES.claude37Sonnet, note: 'Launch announcement, 24 Feb 2025.' },
];

const CACHE_NOTE = 'Cache prices use the multipliers published on the pricing page (5m write 1.25x, 1h write 2x, read per footnote).';

function expand(list: Listed[], tier: BasePriceTier, extra: Partial<CatalogPrice> = {}): CatalogPrice[] {
  return list.flatMap((row) =>
    row.models.map((model) => ({
      model,
      tier,
      input: d(row.input),
      output: d(row.output),
      ...withCache(row.input, row.read),
      ...(row.cacheRead ? { cacheRead: d(row.cacheRead) } : {}),
      sourceUrl: SOURCES.pricing,
      retrievedOn: RETRIEVED_ON,
      ...extra,
    })),
  );
}

/** The Batch API is a 50% discount on input and output; cache multipliers stack on top. */
function batchOf(prices: CatalogPrice[]): CatalogPrice[] {
  const half = (v: string) => d(Decimal.from(v).mul('0.5'));
  return prices.map((p) => ({
    ...p,
    tier: 'batch' as const,
    input: half(p.input),
    output: half(p.output),
    cacheRead: half(p.cacheRead),
    cacheWrite5m: half(p.cacheWrite5m),
    cacheWrite1h: half(p.cacheWrite1h),
    note: 'Batch API: 50% of the standard input and output price; cache multipliers stack.',
  }));
}

const standard = [
  ...expand(STANDARD, 'standard', { note: CACHE_NOTE }),
  ...RETIRED.flatMap((row) =>
    row.models.map(
      (model): CatalogPrice => ({
        model,
        tier: 'standard',
        input: d(row.input),
        output: d(row.output),
        ...withCache(row.input),
        sourceUrl: row.sourceUrl,
        retrievedOn: RETRIEVED_ON,
        note: `${row.note} ${CACHE_NOTE}`,
      }),
    ),
  ),
];

const global: CatalogPrice[] = [
  ...standard,
  ...batchOf(standard),
  ...expand(FAST, 'fast', { note: 'Fast mode price. Prompt caching multipliers apply on top of fast mode pricing.' }),
  ...expand(LONG_CONTEXT, 'long_context', { note: 'Applies to requests whose prompt is over 100,000 tokens.' }),
];

/**
 * US-only inference: every price of a model that accepts `inference_geo`, times 1.1. The pricing page
 * states that the multiplier stacks with the Batch API discount, applies on top of fast mode pricing and,
 * on Claude Haiku 5.5, to the higher prices for prompts over 100,000 tokens.
 */
function usOnlyOf(prices: CatalogPrice[]): CatalogPrice[] {
  const accepts = new Set(MODELS.filter((m) => m.releasedOn !== undefined && m.releasedOn >= US_INFERENCE_FROM).map((m) => m.key));
  const more = (v: string) => d(Decimal.from(v).mul(US_INFERENCE_MULTIPLIER));
  return prices
    .filter((p) => accepts.has(p.model))
    .map((p) => ({
      ...p,
      tier: `${p.tier}${US_INFERENCE_SUFFIX}` as PriceTier,
      input: more(p.input),
      output: more(p.output),
      cacheRead: more(p.cacheRead),
      cacheWrite5m: more(p.cacheWrite5m),
      cacheWrite1h: more(p.cacheWrite1h),
      note: `US-only inference (inference_geo "us"): ${US_INFERENCE_MULTIPLIER} times the ${p.tier === 'standard' ? 'standard' : p.tier.replace('_', ' ')} price in every token category, as published for Claude 4.6 and later models.`,
    }));
}

export const PRICES: CatalogPrice[] = [...global, ...usOnlyOf(global)];

/** Web search is billed per search on top of tokens. */
export const WEB_SEARCH_USD_PER_1000 = '10';

// ── Estimation methods ────────────────────────────────────────────────────────

export interface CatalogMethod {
  key: string;
  basis: 'claude2' | 'claude3' | 'claude47' | 'mixed';
  /** Tokens per base unit. A base unit is one token of Anthropic's published legacy tokenizer. */
  centralFactor: string;
  lowFactor: string;
  highFactor: string;
  description: string;
  sourceUrl: string;
}

export const ESTIMATOR_VERSION = 'heuristic-v1';

/**
 * How base units (legacy-tokenizer tokens) convert to tokens of each tokenizer generation.
 *
 * Anchors, all published by Anthropic:
 *  - Before Claude Opus 4.7, "a token represents approximately 3.5 English characters" (glossary).
 *  - Opus 4.7 and later "produces approximately 30 percent more tokens for the same text" (glossary, pricing).
 * The legacy tokenizer measures typical English at 3.9-4.7 characters per token (see
 * docs/TOKEN-ESTIMATION.md), which puts the pre-4.7 generation at roughly 1.10-1.40 tokens
 * per base unit; 1.25 is used as the central value.
 */
export const METHODS: CatalogMethod[] = [
  {
    key: `${ESTIMATOR_VERSION}/claude2`,
    basis: 'claude2',
    centralFactor: '1',
    lowFactor: '0.92',
    highFactor: '1.08',
    description:
      'Claude 2 and earlier. Text is counted with a character-class heuristic fitted to Anthropic\'s published legacy tokenizer, which is exact for these models.',
    sourceUrl: SOURCES.tokenCounting,
  },
  {
    key: `${ESTIMATOR_VERSION}/claude3`,
    basis: 'claude3',
    centralFactor: '1.25',
    lowFactor: '0.88',
    highFactor: '1.12',
    description:
      'Claude 3 through Opus 4.6 / Sonnet 4.6 / Haiku 4.5. Legacy-tokenizer count scaled so typical English is about 3.5 characters per token, the figure Anthropic publishes for these models.',
    sourceUrl: SOURCES.glossary,
  },
  {
    key: `${ESTIMATOR_VERSION}/claude47`,
    basis: 'claude47',
    centralFactor: '1.625',
    lowFactor: '0.68',
    highFactor: '1.16',
    description:
      'Opus 4.7 and later, Sonnet 5+, Haiku 5.5, Fable and Mythos. The pre-4.7 estimate plus the roughly 30% more tokens Anthropic documents for the newer tokenizer (the exact increase depends on content).',
    sourceUrl: SOURCES.glossary,
  },
  {
    key: `${ESTIMATOR_VERSION}/mixed`,
    basis: 'mixed',
    centralFactor: '1.4375',
    lowFactor: '0.77',
    highFactor: '1.31',
    description:
      'Model not recorded, message dated on or after the first release that uses the newer tokenizer (16 Apr 2026). The midpoint of the two tokenizer generations is used and the band covers both.',
    sourceUrl: SOURCES.glossary,
  },
];

export function methodKeyFor(basis: CatalogMethod['basis']): string {
  return `${ESTIMATOR_VERSION}/${basis}`;
}

/** Context window assumed for modelled replay when the model is not known. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Prompt cache lifetime used by the "with prompt caching" cost scenario. */
export const CACHE_TTL_SECONDS = 300;
