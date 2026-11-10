'use client';

import { keepPreviousData, QueryClient, QueryClientProvider, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AnalyticsFilter } from '@/analytics/base';
import { getSettings, updateSettings, type AppSettings } from '@/analytics/settings';
import { DATA_CHANNEL, openDatabase, releaseDatabase, TAB_ID, type BootPhase, type TabMessage } from '@/db/client';
import type { SqlDriver } from '@/db/driver';
import { addDays, addMonths, todayInZone } from '@/lib/format';

/**
 * Application state: the local database, the user's settings and the date range that
 * every chart and table on a page shares.
 *
 * All data lives in this browser. "Loading" below always means reading the local
 * PostgreSQL database, never a network request.
 */
export type RangePreset = 'all' | '30d' | '90d' | '12m' | 'ytd' | 'custom';

export interface DateRange {
  preset: RangePreset;
  /** Inclusive local dates, used when preset is `custom`. */
  from: string | null;
  to: string | null;
}

export const RANGE_PRESETS: Array<{ value: Exclude<RangePreset, 'custom'>; label: string }> = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'ytd', label: 'This year' },
];

export function resolveRange(range: DateRange, timezone: string): { from: string | null; to: string | null } {
  const today = todayInZone(timezone);
  switch (range.preset) {
    case 'all':
      return { from: null, to: null };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case '90d':
      return { from: addDays(today, -89), to: today };
    case '12m':
      return { from: addDays(addMonths(today, -12), 1), to: today };
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'custom':
      return { from: range.from, to: range.to };
  }
}

export interface AppReady {
  db: SqlDriver;
  userId: number;
  exportBackup(): Promise<Blob>;
  settings: AppSettings;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;
  range: DateRange;
  setRange(range: DateRange): void;
  /** The selected range as local dates. */
  resolved: { from: string | null; to: string | null };
  /** Filter for figures that follow the date range selector. */
  filter: AnalyticsFilter;
  /** Filter for lifetime figures, which ignore the date range. */
  lifetime: AnalyticsFilter;
  /** Changes whenever stored data changes, in this tab or another one. */
  dataVersion: number;
  /** Call after any write so every view re-reads the database. */
  notifyDataChanged(): void;
  lastRefreshedAt: number;
}

type AppState =
  | { status: 'booting'; phase: BootPhase }
  | { status: 'error'; error: Error; retry(): void }
  /** Another tab is erasing the database; this one has let go of it and reloads when told to. */
  | { status: 'paused' }
  | { status: 'ready'; app: AppReady };

const AppContext = createContext<AppState>({ status: 'booting', phase: 'starting' });

const RANGE_KEY = 'claude-lifetime:range';

const ALL_TIME: DateRange = { preset: 'all', from: null, to: null };

function loadRange(): DateRange {
  try {
    const raw = window.localStorage.getItem(RANGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<DateRange>;
      const presets: RangePreset[] = ['all', '30d', '90d', '12m', 'ytd', 'custom'];
      if (v && presets.includes(v.preset as RangePreset)) {
        const date = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
        return { preset: v.preset as RangePreset, from: date(v.from), to: date(v.to) };
      }
    }
  } catch {
    // storage can be unavailable (private windows); the default range is used
  }
  return ALL_TIME;
}

function AppStateProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<BootPhase>('starting');
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [core, setCore] = useState<{ db: SqlDriver; userId: number; exportBackup(): Promise<Blob> } | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Read once on the client. Nothing that depends on the range is rendered before the database is open, so the
  // server-rendered markup and the first client render still match.
  const [range, setRangeState] = useState<DateRange>(() => (typeof window === 'undefined' ? ALL_TIME : loadRange()));
  const [dataVersion, setDataVersion] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    let cancelled = false;
    openDatabase((p) => !cancelled && setPhase(p))
      .then(async (database) => {
        const s = await getSettings(database.db, database.userId);
        if (cancelled) return;
        setCore(database);
        setSettings(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Other tabs share the same database: when one of them writes, this one re-reads.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(DATA_CHANNEL);
    channel.current = bc;
    bc.onmessage = (event: MessageEvent<Partial<TabMessage>>) => {
      const message = event.data;
      // A channel also hears other channel objects of its own page (the database client posts through one).
      if (!message || message.from === TAB_ID) return;
      if (message.op === 'release') {
        // Another tab is erasing the database and needs every connection closed first.
        setPaused(true);
        void releaseDatabase();
      } else if (message.op === 'reload') {
        // The database was replaced or erased: whatever this tab shows is no longer what is stored.
        window.location.reload();
      } else {
        setDataVersion((v) => v + 1);
        setLastRefreshedAt(Date.now());
      }
    };
    return () => {
      channel.current = null;
      bc.close();
    };
  }, []);

  // Settings can change in another tab too.
  useEffect(() => {
    if (!core || dataVersion === 0) return;
    let cancelled = false;
    void getSettings(core.db, core.userId).then((s) => !cancelled && setSettings(s));
    return () => {
      cancelled = true;
    };
  }, [core, dataVersion]);

  const notifyDataChanged = useCallback(() => {
    setDataVersion((v) => v + 1);
    setLastRefreshedAt(Date.now());
    channel.current?.postMessage({ from: TAB_ID, op: 'changed' } satisfies TabMessage);
  }, []);

  const setRange = useCallback((next: DateRange) => {
    setRangeState(next);
    try {
      window.localStorage.setItem(RANGE_KEY, JSON.stringify(next));
    } catch {
      // not persisted; the range still applies to this visit
    }
  }, []);

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (!core) return;
      const next = await updateSettings(core.db, core.userId, patch);
      setSettings(next);
      notifyDataChanged();
    },
    [core, notifyDataChanged],
  );

  const state = useMemo<AppState>(() => {
    if (paused) return { status: 'paused' };
    if (error) {
      return {
        status: 'error',
        error,
        retry: () => {
          setError(null);
          setAttempt((n) => n + 1);
        },
      };
    }
    if (!core || !settings) return { status: 'booting', phase };
    const resolved = resolveRange(range, settings.timezone);
    const lifetime: AnalyticsFilter = { userId: core.userId, timezone: settings.timezone, basis: settings.basis };
    return {
      status: 'ready',
      app: {
        ...core,
        settings,
        saveSettings,
        range,
        setRange,
        resolved,
        filter: { ...lifetime, from: resolved.from, to: resolved.to },
        lifetime,
        dataVersion,
        notifyDataChanged,
        lastRefreshedAt,
      },
    };
  }, [core, settings, range, dataVersion, error, phase, paused, saveSettings, setRange, notifyDataChanged, lastRefreshedAt]);

  return <AppContext.Provider value={state}>{children}</AppContext.Provider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: Infinity, gcTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AppStateProvider>{children}</AppStateProvider>
    </QueryClientProvider>
  );
}

export function useAppState(): AppState {
  return useContext(AppContext);
}

/** The ready application. Only call below <AppGate>, which renders nothing else until the database is open. */
export function useApp(): AppReady {
  const state = useContext(AppContext);
  if (state.status !== 'ready') throw new Error('useApp() was called before the local database was ready.');
  return state.app;
}

/**
 * Reads from the local database. Results are keyed by the data version, so any write
 * refreshes every view; while a refresh runs the previous result stays on screen.
 */
export function useData<T>(key: readonly unknown[], read: (app: AppReady) => Promise<T>): UseQueryResult<T, Error> {
  const state = useContext(AppContext);
  const app = state.status === 'ready' ? state.app : null;
  return useQuery<T, Error>({
    queryKey: ['data', app?.dataVersion ?? -1, app?.settings.timezone, app?.settings.basis, ...key],
    queryFn: () => read(app!),
    enabled: app !== null,
    placeholderData: keepPreviousData,
  });
}

/** Key fragment for queries that follow the date range selector. */
export function rangeKey(app: AppReady): string {
  return `${app.resolved.from ?? ''}..${app.resolved.to ?? ''}`;
}
