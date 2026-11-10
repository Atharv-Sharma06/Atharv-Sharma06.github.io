/**
 * Display formatting. Everything here is presentation only: values are stored and
 * computed exactly (integers for tokens, decimal strings for money, UTC instants for
 * time) and are shortened or localised at the last moment.
 */
const INT = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
const COMPACT_SHORT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 2 });

export function formatInt(n: number): string {
  return INT.format(Math.round(n));
}

/** 48.2M, 1.31B, 12.4K; small counts are written out. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '–';
  return Math.abs(n) < 10_000 ? INT.format(Math.round(n)) : COMPACT.format(n);
}

/** Axis ticks: at most two significant digits. */
export function formatAxis(n: number): string {
  if (n === 0) return '0';
  return Math.abs(n) < 1000 ? INT.format(Math.round(n)) : COMPACT_SHORT.format(n);
}

export function formatDecimal(n: number, digits = 1): string {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(n);
}

/** Money from an exact decimal string. Sub-cent amounts are never rounded to "$0.00". */
export function formatUsd(value: string | number | null | undefined, options: { cents?: boolean } = {}): string {
  if (value === null || value === undefined || value === '') return '–';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '–';
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return n > 0 ? '<$0.01' : '-<$0.01';
  const cents = options.cents ?? Math.abs(n) < 1000;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(n);
}

export function formatMoney(amount: string | number, currency: string): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${formatDecimal(n, 2)} ${currency}`;
  }
}

/** A share between 0 and 1. Shares that would round to 0% or 100% say so honestly. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share)) return '–';
  const pct = share * 100;
  if (pct === 0) return '0%';
  if (pct < 1) return '<1%';
  if (pct > 99 && pct < 100) return '>99%';
  return `${Math.round(pct)}%`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// ── Dates ───────────────────────────────────────────────────────────────────────

const dayOf = (day: string) => new Date(`${day}T00:00:00Z`);

/** A local calendar day `YYYY-MM-DD`, e.g. "Mar 4, 2025". */
export function formatDay(day: string | null | undefined, style: 'short' | 'long' | 'weekday' = 'short'): string {
  if (!day) return '–';
  const d = dayOf(day.slice(0, 10));
  if (Number.isNaN(d.getTime())) return '–';
  const options: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { day: 'numeric', month: 'long', year: 'numeric' }
      : style === 'weekday'
        ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
        : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

export function formatMonth(day: string): string {
  return dayOf(day.slice(0, 10)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatDayRange(from: string | null | undefined, to: string | null | undefined): string {
  if (!from && !to) return 'All time';
  if (from && to) {
    if (from === to) return formatDay(from);
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    const a = dayOf(from).toLocaleDateString('en-US', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
    return `${a} – ${formatDay(to)}`;
  }
  return from ? `From ${formatDay(from)}` : `Until ${formatDay(to)}`;
}

/** An instant shown in the user's timezone. */
export function formatInstant(iso: string | null | undefined, timezone: string, style: 'date' | 'datetime' = 'date'): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  const options: Intl.DateTimeFormatOptions =
    style === 'datetime'
      ? { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  try {
    return d.toLocaleString('en-US', { ...options, timeZone: timezone });
  } catch {
    return d.toLocaleString('en-US', { ...options, timeZone: 'UTC' });
  }
}

/** The local calendar day of an instant in a timezone, `YYYY-MM-DD`. */
export function dayInZone(iso: string | Date, timezone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function todayInZone(timezone: string): string {
  return dayInZone(new Date(), timezone);
}

export function addDays(day: string, days: number): string {
  const d = dayOf(day);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(day: string, months: number): string {
  const d = dayOf(day);
  const date = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(date, last));
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`), inclusive of both ends. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayOf(to).getTime() - dayOf(from).getTime()) / 86_400_000) + 1;
}

/** "2 years, 3 months", "5 months", "12 days". */
export function formatSpan(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '–';
  if (days < 60) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  const months = Math.round(days / 30.4375);
  if (months < 24) return `${months} months`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0 ? `${years} years` : `${years} years, ${rest} month${rest === 1 ? '' : 's'}`;
}

export function formatRelative(from: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}
