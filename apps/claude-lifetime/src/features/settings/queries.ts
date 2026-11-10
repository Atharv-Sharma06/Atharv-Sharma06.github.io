'use client';

import { listPrices } from '@/analytics/settings';
import { useData } from '@/state/app';

/** The price table, read once and shared by the sections that show or count prices. */
export function usePrices() {
  return useData(['settings', 'prices'], (app) => listPrices(app.db));
}
