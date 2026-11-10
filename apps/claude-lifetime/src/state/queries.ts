'use client';

import { getCoverage, listImports } from '@/analytics/coverage';
import { listModels } from '@/analytics/settings';
import { listPeriods } from '@/analytics/subscriptions';
import { useAppState, useData } from './app';

/**
 * Queries shared by several pages. Each is read once and reused.
 *
 * Coverage: token figures follow the selected basis, so that they agree with the totals on the same
 * screen. useData already keys every query by the basis; it is named here as well because
 * this result depends on it.
 */
export function useCoverage() {
  const state = useAppState();
  const basis = state.status === 'ready' ? state.app.settings.basis : null;
  return useData(['coverage', basis], (app) => getCoverage(app.db, app.userId, app.settings.timezone, app.settings.basis));
}

export function useImports() {
  return useData(['imports'], (app) => listImports(app.db, app.userId));
}

export function usePeriods() {
  return useData(['periods'], (app) => listPeriods(app.db, app.userId, app.settings.timezone));
}

export function useCatalogModels() {
  return useData(['catalog-models'], (app) => listModels(app.db));
}
