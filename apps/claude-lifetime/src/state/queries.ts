'use client';

import { getCoverage, listImports } from '@/analytics/coverage';
import { listModels } from '@/analytics/settings';
import { listPeriods } from '@/analytics/subscriptions';
import { useData } from './app';

/** Queries shared by several pages. Each is read once and reused. */
export function useCoverage() {
  return useData(['coverage'], (app) => getCoverage(app.db, app.userId, app.settings.timezone));
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
