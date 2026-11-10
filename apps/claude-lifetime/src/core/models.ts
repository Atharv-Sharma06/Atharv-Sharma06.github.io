import { MODELS, type CatalogModel, type ModelFamily, type TokenizerFamily } from './catalog';

/**
 * Model identifiers arrive in many spellings: dated snapshots
 * (claude-sonnet-4-5-20250929), cloud-provider ids (us.anthropic.claude-opus-4-1-20250805-v1:0,
 * claude-opus-4-5@20251101), "-latest" aliases and Claude Code's "[1m]" suffix.
 * normaliseModelId reduces them to one canonical key. It never guesses: an identifier
 * that is not in the catalog is kept verbatim (minus the decorations above), and a
 * missing identifier stays null — the "Unknown model" bucket.
 */
const NOT_A_MODEL = new Set(['', '<synthetic>', 'unknown', 'null', 'undefined', 'none', 'n/a']);

export function normaliseModelId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let id = String(raw).trim().toLowerCase();
  if (NOT_A_MODEL.has(id)) return null;
  id = id
    .replace(/^(?:models|anthropic|vertex_ai|bedrock)\//, '')
    .replace(/^(?:[a-z-]{2,10}\.)?anthropic\./, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@/g, '-')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-latest$/, '')
    .replace(/-20\d{6}$/, '')
    // Vertex AI puts the version before the date (claude-3-5-sonnet-v2@20241022), Bedrock after it.
    .replace(/-v\d+$/, '');
  return id === '' ? null : id;
}

const BY_KEY = new Map<string, CatalogModel>();
for (const m of MODELS) {
  BY_KEY.set(m.key, m);
  for (const alias of m.aliases) {
    const n = normaliseModelId(alias);
    if (n && !BY_KEY.has(n)) BY_KEY.set(n, m);
  }
}

export interface ResolvedModel {
  /** Canonical key to store in model_catalog.model_key. */
  key: string;
  /** False when the identifier is not in the built-in catalog. */
  known: boolean;
  model: CatalogModel;
}

/** Family as spelled in the identifier itself. This reads the name; it does not infer a model. */
export function familyFromId(id: string): ModelFamily {
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('fable')) return 'fable';
  if (id.includes('mythos')) return 'mythos';
  if (id.includes('instant')) return 'claude-instant';
  if (/^claude-2(\b|\.)/.test(id)) return 'claude-2';
  return 'other';
}

export function resolveModel(raw: string | null | undefined): ResolvedModel | null {
  const id = normaliseModelId(raw);
  if (id === null) return null;
  const hit = BY_KEY.get(id);
  if (hit) return { key: hit.key, known: true, model: hit };
  return {
    key: id,
    known: false,
    model: {
      key: id,
      displayName: String(raw).trim(),
      family: familyFromId(id),
      tokenizer: 'unknown',
      aliases: [],
      sourceUrl: '',
    },
  };
}

export function tokenizerOf(raw: string | null | undefined): TokenizerFamily {
  return resolveModel(raw)?.model.tokenizer ?? 'unknown';
}

export const FAMILY_LABEL: Record<ModelFamily, string> = {
  opus: 'Claude Opus',
  sonnet: 'Claude Sonnet',
  haiku: 'Claude Haiku',
  fable: 'Claude Fable',
  mythos: 'Claude Mythos',
  'claude-2': 'Claude 2',
  'claude-instant': 'Claude Instant',
  other: 'Other model',
};
