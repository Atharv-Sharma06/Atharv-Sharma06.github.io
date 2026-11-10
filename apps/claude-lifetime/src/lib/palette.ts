import { NO_PLAN } from '@/analytics/base';
import { FAMILY_LABEL } from '@/core/models';

/**
 * Colour assignments. Colour follows the entity, never its rank: a plan or a model
 * family has the same colour on every page and under every filter. The values are the
 * slots of the validated categorical palette defined in globals.css.
 */
const SLOT = (n: number) => `var(--color-series-${n})`;
export const NEUTRAL = 'var(--color-series-none)';

const PLAN_COLORS: Record<string, string> = {
  pro: SLOT(1),
  max_5x: SLOT(2),
  free: SLOT(3),
  max: SLOT(4),
  max_20x: SLOT(5),
  enterprise: SLOT(6),
  team: SLOT(7),
  ultra: SLOT(8),
};

/** Time that no entered subscription period covers, and plans outside the list, are neutral. */
export function planColor(planKey: string): string {
  if (planKey === NO_PLAN) return NEUTRAL;
  return PLAN_COLORS[planKey] ?? '#8f8f9b';
}

const FAMILY_COLORS: Record<string, string> = {
  sonnet: SLOT(1),
  opus: SLOT(2),
  haiku: SLOT(3),
  fable: SLOT(4),
  mythos: SLOT(5),
  'claude-instant': SLOT(6),
  'claude-2': SLOT(7),
  other: SLOT(8),
};

/** `unknown` is usage whose source names no model: always the neutral colour, never a guess. */
export function familyColor(family: string): string {
  return FAMILY_COLORS[family] ?? NEUTRAL;
}

export const FAMILY_ORDER = ['sonnet', 'opus', 'haiku', 'fable', 'mythos', 'claude-instant', 'claude-2', 'other', 'unknown'] as const;

export function familyLabel(family: string): string {
  return (FAMILY_LABEL as Record<string, string>)[family] ?? 'Unknown model';
}
