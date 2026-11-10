import type { ModelUsage } from '@/analytics/models';
import { Decimal } from '@/core/decimal';
import { FAMILY_ORDER, familyColor, familyLabel } from '@/lib/palette';

/**
 * Shaping of the model breakdown for the family chart and the comparison table.
 * Everything here is arithmetic on rows the query returned; nothing is inferred.
 */
export type FamilyKey = (typeof FAMILY_ORDER)[number];

export interface FamilySlice {
  family: FamilyKey;
  label: string;
  color: string;
  /** Under the breakdown's token basis. */
  tokens: number;
  exact: number;
  estimated: number;
  /** Share of the total of all slices, 0..1. */
  share: number;
  /** Rows of the breakdown that belong to the family. */
  models: number;
}

export interface FamilyBreakdown {
  slices: FamilySlice[];
  total: number;
  exact: number;
  estimated: number;
}

const NAMED_FAMILIES = new Set<string>(FAMILY_ORDER.filter((f) => f !== 'unknown'));

/**
 * The family a row is charted under. Usage without a recorded model is always
 * "unknown" and never joins a real family. A named model whose family is not one of
 * the palette's slots is charted as "other": it has an identity, just no slot of its own.
 */
export function familyOf(row: Pick<ModelUsage, 'modelKey' | 'family'>): FamilyKey {
  if (row.modelKey === null) return 'unknown';
  return NAMED_FAMILIES.has(row.family) ? (row.family as FamilyKey) : 'other';
}

/** Tokens per model family in the palette's fixed order. Families without tokens are left out. */
export function familySlices(rows: readonly ModelUsage[]): FamilyBreakdown {
  const byFamily = new Map<FamilyKey, { tokens: number; exact: number; estimated: number; models: number }>();
  for (const row of rows) {
    const key = familyOf(row);
    const entry = byFamily.get(key) ?? { tokens: 0, exact: 0, estimated: 0, models: 0 };
    entry.tokens += row.total;
    entry.exact += row.exact;
    entry.estimated += row.estimated;
    entry.models += 1;
    byFamily.set(key, entry);
  }
  let total = 0;
  let exact = 0;
  let estimated = 0;
  for (const entry of byFamily.values()) {
    total += entry.tokens;
    exact += entry.exact;
    estimated += entry.estimated;
  }
  const slices: FamilySlice[] = [];
  for (const family of FAMILY_ORDER) {
    const entry = byFamily.get(family);
    if (!entry || entry.tokens <= 0) continue;
    slices.push({
      family,
      label: familyLabel(family),
      color: familyColor(family),
      tokens: entry.tokens,
      exact: entry.exact,
      estimated: entry.estimated,
      share: total > 0 ? entry.tokens / total : 0,
      models: entry.models,
    });
  }
  return { slices, total, exact, estimated };
}

export interface Arc {
  /** Radians, clockwise from twelve o'clock. */
  start: number;
  end: number;
}

const TURN = Math.PI * 2;

/**
 * Lays values out around a ring. Each value gets an angle in proportion to its size,
 * neighbours are separated by `gap`, and a value too small to see is widened to
 * `minimum` so it does not vanish from the chart (its real figure is in the legend).
 * A lone value takes the whole ring.
 */
export function ringArcs(values: readonly number[], gap: number, minimum: number): Arc[] {
  const shown = values.map((v) => Number.isFinite(v) && v > 0);
  const count = shown.filter(Boolean).length;
  if (count === 0) return values.map(() => ({ start: 0, end: 0 }));
  if (count === 1) return values.map((_, i) => (shown[i] ? { start: 0, end: TURN } : { start: 0, end: 0 }));

  const available = TURN - gap * count;
  // With more values than the ring has room for, the minimum shrinks to an even share.
  const floor = Math.min(minimum, available / count);

  // Values whose fair share is under the floor are pinned to it; the rest divide what is
  // left in proportion. Pinning one value shrinks the others, so repeat until stable.
  const pinned = values.map(() => false);
  const freeSpace = () => available - floor * pinned.filter(Boolean).length;
  const freeSum = () => values.reduce((s, v, i) => (shown[i] && !pinned[i] ? s + v : s), 0);
  for (let changed = true; changed; ) {
    changed = false;
    const space = freeSpace();
    const sum = freeSum();
    for (let i = 0; i < values.length; i++) {
      if (shown[i] && !pinned[i] && (values[i] / sum) * space < floor) {
        pinned[i] = true;
        changed = true;
      }
    }
  }

  const space = freeSpace();
  const sum = freeSum();
  const arcs: Arc[] = [];
  let at = gap / 2;
  for (let i = 0; i < values.length; i++) {
    if (!shown[i]) {
      arcs.push({ start: at, end: at });
      continue;
    }
    const angle = pinned[i] ? floor : (values[i] / sum) * space;
    arcs.push({ start: at, end: at + angle });
    at += angle + gap;
  }
  return arcs;
}

export type ModelSortKey = 'name' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'replay' | 'total' | 'share' | 'conversations' | 'requests' | 'value';

export type CostScenario = 'standard' | 'cached';

/** The leading scenario's total for a row, or null when none of the row's usage could be priced. */
export function rowValue(row: Pick<ModelUsage, 'value'>, scenario: CostScenario): string | null {
  if (row.value.pricedTokens <= 0) return null;
  return scenario === 'cached' ? row.value.totalCachedUsd : row.value.totalStandardUsd;
}

function sortNumber(row: ModelUsage, key: Exclude<ModelSortKey, 'name'>, scenario: CostScenario): number | null {
  switch (key) {
    case 'cacheWrite':
      return row.cacheWrite5m + row.cacheWrite1h;
    case 'value': {
      const value = rowValue(row, scenario);
      return value === null ? null : Number(value);
    }
    default:
      return row[key];
  }
}

/**
 * Sorts the comparison table. Rows without a value (nothing priced) stay at the end
 * in either direction, the way a database sorts NULLS LAST; ties keep the query's
 * order, which is by total.
 */
export function sortModels(rows: readonly ModelUsage[], key: ModelSortKey, direction: 'asc' | 'desc', scenario: CostScenario): ModelUsage[] {
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (key === 'name') {
        const byName = a.row.displayName.localeCompare(b.row.displayName, 'en', { numeric: true, sensitivity: 'base' });
        return byName !== 0 ? byName * sign : a.index - b.index;
      }
      const x = sortNumber(a.row, key, scenario);
      const y = sortNumber(b.row, key, scenario);
      if (x === null || y === null) return x === y ? a.index - b.index : x === null ? 1 : -1;
      return x !== y ? (x - y) * sign : a.index - b.index;
    })
    .map((entry) => entry.row);
}

export interface ModelTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  replay: number;
  total: number;
  exact: number;
  estimated: number;
  requests: number;
  /** Sum of the rows' values under each scenario, as exact decimal strings. */
  standardUsd: string;
  cachedUsd: string;
  pricedTokens: number;
}

/**
 * The totals row. Conversations are deliberately absent: a conversation that used two
 * models is counted under both, so the column does not add up to a number of conversations.
 */
export function modelTotals(rows: readonly ModelUsage[]): ModelTotals {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, replay: 0, total: 0, exact: 0, estimated: 0, requests: 0, pricedTokens: 0 };
  let standard = Decimal.zero;
  let cached = Decimal.zero;
  for (const row of rows) {
    totals.input += row.input;
    totals.output += row.output;
    totals.cacheRead += row.cacheRead;
    totals.cacheWrite5m += row.cacheWrite5m;
    totals.cacheWrite1h += row.cacheWrite1h;
    totals.replay += row.replay;
    totals.total += row.total;
    totals.exact += row.exact;
    totals.estimated += row.estimated;
    totals.requests += row.requests;
    totals.pricedTokens += row.value.pricedTokens;
    standard = standard.add(row.value.totalStandardUsd);
    cached = cached.add(row.value.totalCachedUsd);
  }
  return { ...totals, standardUsd: standard.toString(6), cachedUsd: cached.toString(6) };
}
