import { toIso, toNumber, type SqlDriver, type SqlExecutor } from '@/db/driver';
import { factsFrom, NO_PLAN, Params, tokenExpr, type AnalyticsFilter } from './base';
import { getApiValueBy, ZERO_FIGURES, type ValueFigures, type ValueOptions } from './value';

/**
 * Subscription history is entered by the user and stored on its own. Usage rows never
 * carry a plan: which plan a fact belongs to is derived here, at query time, from the
 * fact's timestamp. Editing a period therefore re-classifies all usage instantly.
 */
export interface SubscriptionPeriod {
  id: number;
  planKey: string;
  label: string | null;
  /** Instants (UTC). `endedAt` is exclusive; null while the plan is active. */
  startedAt: string;
  endedAt: string | null;
  /** The same in the user's timezone: first and last day on the plan. */
  startDate: string;
  lastDate: string | null;
  monthlyPrice: string | null;
  currency: string;
  notes: string | null;
  isSynthetic: boolean;
}

export interface PeriodInput {
  id?: number;
  planKey: string;
  label?: string | null;
  /** First day on the plan, local date `YYYY-MM-DD`. */
  startDate: string;
  /** Last day on the plan (inclusive). Empty while the plan is still active. */
  lastDate?: string | null;
  monthlyPrice?: string | null;
  currency?: string;
  notes?: string | null;
}

export const PLANS: Array<{ key: string; label: string; paid: boolean }> = [
  { key: 'free', label: 'Free', paid: false },
  { key: 'pro', label: 'Pro', paid: true },
  { key: 'max_5x', label: 'Max 5x', paid: true },
  { key: 'max_20x', label: 'Max 20x', paid: true },
  { key: 'max', label: 'Max', paid: true },
  { key: 'ultra', label: 'Ultra', paid: true },
  { key: 'team', label: 'Team', paid: true },
  { key: 'enterprise', label: 'Enterprise', paid: true },
  { key: 'other', label: 'Other', paid: true },
];

export function planLabel(planKey: string, label?: string | null): string {
  if (label && label.trim() !== '') return label.trim();
  if (planKey === NO_PLAN) return 'No subscription recorded';
  return PLANS.find((p) => p.key === planKey)?.label ?? planKey;
}

export function isPaidPlan(planKey: string): boolean {
  return planKey !== NO_PLAN && planKey !== 'free';
}

export class SubscriptionError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'overlap' | 'not_found',
    readonly conflict?: SubscriptionPeriod,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

const SELECT_PERIOD = (tz: string) => `
  sp.id, sp.plan_key, sp.label, sp.started_at, sp.ended_at,
  (sp.started_at AT TIME ZONE ${tz})::date::text AS start_date,
  ((sp.ended_at AT TIME ZONE ${tz}) - interval '1 microsecond')::date::text AS last_date,
  sp.monthly_price::text AS monthly_price, sp.currency, sp.notes, sp.is_synthetic`;

function readPeriod(r: Record<string, unknown>): SubscriptionPeriod {
  return {
    id: toNumber(r.id),
    planKey: String(r.plan_key),
    label: (r.label as string | null) ?? null,
    startedAt: toIso(r.started_at)!,
    endedAt: toIso(r.ended_at),
    startDate: String(r.start_date),
    lastDate: (r.last_date as string | null) ?? null,
    monthlyPrice: (r.monthly_price as string | null) ?? null,
    currency: String(r.currency),
    notes: (r.notes as string | null) ?? null,
    isSynthetic: r.is_synthetic === true,
  };
}

export async function listPeriods(db: SqlExecutor, userId: number, timezone: string): Promise<SubscriptionPeriod[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${SELECT_PERIOD('$2::text')} FROM subscription_periods sp WHERE sp.user_id = $1 ORDER BY sp.started_at`,
    [userId, timezone],
  );
  return rows.map(readPeriod);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Creates or updates a period. Rejects invalid input and overlaps with a message the user can act on. */
export async function savePeriod(db: SqlDriver, userId: number, timezone: string, input: PeriodInput): Promise<SubscriptionPeriod> {
  const planKey = input.planKey?.trim();
  if (!planKey) throw new SubscriptionError('Choose a plan.', 'invalid');
  if (!validDate(input.startDate)) throw new SubscriptionError('Enter a valid start date.', 'invalid');
  const lastDate = input.lastDate && input.lastDate.trim() !== '' ? input.lastDate.trim() : null;
  if (lastDate !== null) {
    if (!validDate(lastDate)) throw new SubscriptionError('Enter a valid end date, or leave it empty if the plan is still active.', 'invalid');
    if (lastDate < input.startDate) throw new SubscriptionError('The end date is before the start date.', 'invalid');
  }
  let price: string | null = null;
  if (input.monthlyPrice !== undefined && input.monthlyPrice !== null && String(input.monthlyPrice).trim() !== '') {
    const text = String(input.monthlyPrice).trim();
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new SubscriptionError('Enter the monthly price as a number, for example 20 or 19.99.', 'invalid');
    price = text;
  }
  const currency = (input.currency ?? 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new SubscriptionError('Use a three-letter currency code such as USD.', 'invalid');

  const saved = await db.transaction(async (tx) => {
    const bounds = (
      await tx.query<{ s: Date; e: Date | null }>(
        `SELECT ($1::date)::timestamp AT TIME ZONE $3::text AS s,
                CASE WHEN $2::date IS NULL THEN NULL ELSE (($2::date + 1))::timestamp AT TIME ZONE $3::text END AS e`,
        [input.startDate, lastDate, timezone],
      )
    ).rows[0];

    const conflict = (
      await tx.query<Record<string, unknown>>(
        `SELECT ${SELECT_PERIOD('$5::text')} FROM subscription_periods sp
          WHERE sp.user_id = $1 AND sp.id <> COALESCE($2::int, -1)
            AND tstzrange(sp.started_at, sp.ended_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
          ORDER BY sp.started_at LIMIT 1`,
        [userId, input.id ?? null, bounds.s, bounds.e, timezone],
      )
    ).rows[0];
    if (conflict) {
      const c = readPeriod(conflict);
      throw new SubscriptionError(
        `These dates overlap your ${planLabel(c.planKey, c.label)} period (${fmt(c.startDate)} – ${c.lastDate ? fmt(c.lastDate) : 'today'}). ` +
          'Two plans cannot be active on the same day: adjust the dates, or end the other period first.',
        'overlap',
        c,
      );
    }

    const values = [userId, planKey, input.label?.trim() || null, bounds.s, bounds.e, price, currency, input.notes?.trim() || null];
    if (input.id) {
      const res = await tx.query<{ id: number }>(
        `UPDATE subscription_periods SET plan_key = $2, label = $3, started_at = $4, ended_at = $5, monthly_price = $6::numeric,
                currency = $7, notes = $8, is_synthetic = false, updated_at = now()
          WHERE user_id = $1 AND id = $9 RETURNING id`,
        [...values, input.id],
      );
      if (res.rows.length === 0) throw new SubscriptionError('That period no longer exists.', 'not_found');
      return res.rows[0].id;
    }
    const res = await tx.query<{ id: number }>(
      `INSERT INTO subscription_periods (user_id, plan_key, label, started_at, ended_at, monthly_price, currency, notes)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8) RETURNING id`,
      values,
    );
    return res.rows[0].id;
  });
  await db.flush();
  const all = await listPeriods(db, userId, timezone);
  return all.find((p) => p.id === saved)!;
}

export async function deletePeriod(db: SqlDriver, userId: number, id: number): Promise<boolean> {
  const res = await db.query(`DELETE FROM subscription_periods WHERE user_id = $1 AND id = $2`, [userId, id]);
  await db.flush();
  return (res.affectedRows ?? 0) > 0;
}

// ── Timeline segments ───────────────────────────────────────────────────────────

export interface SegmentRange {
  kind: 'period' | 'gap';
  periodId: number | null;
  planKey: string;
  label: string;
  /** ISO instants; `end` is exclusive and null when the segment is still running. */
  start: string;
  end: string | null;
}

/**
 * The entered periods in order, with the uncovered time between them made explicit.
 * Nothing is assumed about uncovered time: it is labelled "No subscription recorded".
 * A leading gap is only added when imported usage starts before the first period.
 */
export function buildSegments(periods: SubscriptionPeriod[], firstUsageAt: string | null, nowIso: string): SegmentRange[] {
  const sorted = [...periods].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (sorted.length === 0) return [];
  const out: SegmentRange[] = [];
  const gap = (start: string, end: string | null): SegmentRange => ({ kind: 'gap', periodId: null, planKey: NO_PLAN, label: planLabel(NO_PLAN), start, end });
  if (firstUsageAt && firstUsageAt < sorted[0].startedAt) out.push(gap(firstUsageAt, sorted[0].startedAt));
  sorted.forEach((p, i) => {
    out.push({ kind: 'period', periodId: p.id, planKey: p.planKey, label: planLabel(p.planKey, p.label), start: p.startedAt, end: p.endedAt });
    const next = sorted[i + 1];
    if (p.endedAt === null) return;
    if (next && p.endedAt < next.startedAt) out.push(gap(p.endedAt, next.startedAt));
    if (!next && p.endedAt < nowIso) out.push(gap(p.endedAt, null));
  });
  return out;
}

export interface SegmentStats extends SegmentRange {
  /** Length of the segment in days (up to now for a running segment). */
  days: number;
  tokens: number;
  exact: number;
  estimated: number;
  conversations: number;
  messages: number;
  activeDays: number;
  /** Tokens divided by the length of the segment in days. */
  averageDailyTokens: number | null;
  value: ValueFigures;
}

const DAY_MS = 86_400_000;

async function aggregateRanges(
  db: SqlExecutor,
  filter: AnalyticsFilter,
  ranges: Array<{ start: string | null; end: string | null }>,
  options: ValueOptions,
) {
  const tok = tokenExpr(filter.basis);
  const p = new Params();
  const f = factsFrom(filter, p);
  const join = (starts: string, ends: string) =>
    `JOIN unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) WITH ORDINALITY AS seg(s, e, idx)
       ON f.occurred_at >= COALESCE(seg.s, '-infinity') AND f.occurred_at < COALESCE(seg.e, 'infinity')`;
  const starts = ranges.map((r) => r.start);
  const ends = ranges.map((r) => r.end);
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT seg.idx::int AS idx, sum(${tok})::bigint AS tokens,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
            count(DISTINCT f.conversation_id)::int AS conversations,
            sum(f.user_message_count + f.assistant_message_count)::bigint AS messages,
            count(DISTINCT ${f.day})::int AS active_days,
            min(f.occurred_at) AS first_at, max(f.occurred_at) AS last_at
       FROM ${f.from} ${join(p.add(starts), p.add(ends))}
      WHERE ${f.where} GROUP BY 1`,
    p.values,
  );
  // The value query assembles its own parameter list, so the arrays are inlined as literals there.
  const lit = (values: Array<string | null>) =>
    `ARRAY[${values.map((v) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)).join(',')}]`;
  const values = await getApiValueBy(db, filter, `seg.idx`, join(lit(starts), lit(ends)), options);
  return { rows: new Map(rows.map((r) => [toNumber(r.idx), r])), values };
}

export async function getSegmentStats(
  db: SqlExecutor,
  filter: AnalyticsFilter,
  options: ValueOptions = {},
  now: Date = new Date(),
): Promise<SegmentStats[]> {
  const periods = await listPeriods(db, filter.userId, filter.timezone);
  if (periods.length === 0) return [];
  const first = (
    await db.query<{ first_at: Date | null }>(
      `SELECT min(f.occurred_at) AS first_at FROM usage_facts f JOIN data_sources s ON s.id = f.source_id WHERE f.user_id = $1 AND s.include_in_totals`,
      [filter.userId],
    )
  ).rows[0];
  const segments = buildSegments(periods, toIso(first?.first_at), now.toISOString());
  const { rows, values } = await aggregateRanges(db, filter, segments, options);
  return segments.map((seg, i) => {
    const r = rows.get(i + 1);
    const endMs = seg.end ? Date.parse(seg.end) : now.getTime();
    const days = Math.max(1, Math.round((endMs - Date.parse(seg.start)) / DAY_MS));
    const tokens = toNumber(r?.tokens);
    return {
      ...seg,
      days,
      tokens,
      exact: toNumber(r?.exact),
      estimated: toNumber(r?.estimated),
      conversations: toNumber(r?.conversations),
      messages: toNumber(r?.messages),
      activeDays: toNumber(r?.active_days),
      averageDailyTokens: tokens > 0 ? tokens / days : null,
      value: values.get(String(i + 1)) ?? ZERO_FIGURES,
    };
  });
}

// ── Before vs. after the first paid subscription ────────────────────────────────

export interface SideStats {
  tokens: number;
  exact: number;
  estimated: number;
  conversations: number;
  messages: number;
  activeDays: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Calendar days the side spans: first record to the split, or the split to the last record. */
  spanDays: number;
  value: ValueFigures;
}

export interface BeforeAfter {
  /** null when no paid period has been entered: there is nothing to compare against. */
  split: { at: string; date: string; planKey: string; label: string } | null;
  before: SideStats | null;
  after: SideStats | null;
}

export async function getBeforeAfter(db: SqlExecutor, filter: AnalyticsFilter, options: ValueOptions = {}): Promise<BeforeAfter> {
  const periods = await listPeriods(db, filter.userId, filter.timezone);
  const firstPaid = periods.find((p) => isPaidPlan(p.planKey));
  if (!firstPaid) return { split: null, before: null, after: null };

  const { rows, values } = await aggregateRanges(
    db,
    filter,
    [
      { start: null, end: firstPaid.startedAt },
      { start: firstPaid.startedAt, end: null },
    ],
    options,
  );
  const side = (idx: number): SideStats => {
    const r = rows.get(idx);
    const firstAt = toIso(r?.first_at);
    const lastAt = toIso(r?.last_at);
    const splitMs = Date.parse(firstPaid.startedAt);
    const spanMs = idx === 1 ? (firstAt ? splitMs - Date.parse(firstAt) : 0) : lastAt ? Date.parse(lastAt) - splitMs : 0;
    return {
      tokens: toNumber(r?.tokens),
      exact: toNumber(r?.exact),
      estimated: toNumber(r?.estimated),
      conversations: toNumber(r?.conversations),
      messages: toNumber(r?.messages),
      activeDays: toNumber(r?.active_days),
      firstAt,
      lastAt,
      spanDays: r ? Math.max(1, Math.ceil(spanMs / DAY_MS)) : 0,
      value: values.get(String(idx)) ?? ZERO_FIGURES,
    };
  };
  return {
    split: { at: firstPaid.startedAt, date: firstPaid.startDate, planKey: firstPaid.planKey, label: planLabel(firstPaid.planKey, firstPaid.label) },
    before: side(1),
    after: side(2),
  };
}
