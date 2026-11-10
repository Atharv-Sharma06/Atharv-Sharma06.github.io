import { toIso, toNumber, type SqlDriver, type SqlExecutor } from '@/db/driver';
import { addDays, dayInZone, daysBetween } from '@/lib/format';
import { factsFrom, NO_PLAN, Params, tokenExpr, type AnalyticsFilter } from './base';
import { getApiValueBy, ZERO_FIGURES, type ValueFigures, type ValueOptions } from './value';

/**
 * Subscription history is entered by the user and stored on its own. Usage rows never
 * carry a plan: which plan a fact belongs to is derived here, at query time, from the
 * fact's calendar day. Editing a period therefore re-classifies all usage instantly.
 *
 * A period is a range of calendar days, stored as the days that were entered. Usage is
 * matched to it by day, the same day every chart files that usage under, so a record
 * that only knows its date (a daily report bucket, a manual entry) lands in the plan
 * that was active on that date in every timezone.
 */
export interface SubscriptionPeriod {
  id: number;
  planKey: string;
  label: string | null;
  /** First and last day on the plan, as entered. `lastDate` is null while the plan is active. */
  startDate: string;
  lastDate: string | null;
  /**
   * The same as instants in the current timezone: the start of the first day, and the
   * start of the day after the last (exclusive). Derived for display, never stored.
   */
  startedAt: string;
  endedAt: string | null;
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
  sp.id, sp.plan_key, sp.label, sp.start_date::text AS start_date, sp.last_date::text AS last_date,
  (sp.start_date::timestamp AT TIME ZONE ${tz}) AS started_at,
  ((sp.last_date + 1)::timestamp AT TIME ZONE ${tz}) AS ended_at,
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
    `SELECT ${SELECT_PERIOD('$2::text')} FROM subscription_periods sp WHERE sp.user_id = $1 ORDER BY sp.start_date`,
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
    const conflict = (
      await tx.query<Record<string, unknown>>(
        `SELECT ${SELECT_PERIOD('$5::text')} FROM subscription_periods sp
          WHERE sp.user_id = $1 AND sp.id <> COALESCE($2::int, -1)
            AND daterange(sp.start_date, sp.last_date, '[]') && daterange($3::date, $4::date, '[]')
          ORDER BY sp.start_date LIMIT 1`,
        [userId, input.id ?? null, input.startDate, lastDate, timezone],
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

    const values = [userId, planKey, input.label?.trim() || null, input.startDate, lastDate, price, currency, input.notes?.trim() || null];
    if (input.id) {
      const res = await tx.query<{ id: number }>(
        `UPDATE subscription_periods SET plan_key = $2, label = $3, start_date = $4::date, last_date = $5::date, monthly_price = $6::numeric,
                currency = $7, notes = $8, is_synthetic = false, updated_at = now()
          WHERE user_id = $1 AND id = $9 RETURNING id`,
        [...values, input.id],
      );
      if (res.rows.length === 0) throw new SubscriptionError('That period no longer exists.', 'not_found');
      return res.rows[0].id;
    }
    const res = await tx.query<{ id: number }>(
      `INSERT INTO subscription_periods (user_id, plan_key, label, start_date, last_date, monthly_price, currency, notes)
       VALUES ($1, $2, $3, $4::date, $5::date, $6::numeric, $7, $8) RETURNING id`,
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
  /** First day of the segment and the day after its last (exclusive); `endDate` is null while the segment is running. */
  startDate: string;
  endDate: string | null;
  /** The same as instants in the current timezone, for placing the segment on a time axis. */
  start: string;
  end: string | null;
}

/**
 * The entered periods in order, with the uncovered days between them made explicit.
 * Nothing is assumed about uncovered time: it is labelled "No subscription recorded".
 * A leading gap is only added when imported usage starts before the first period;
 * `firstUsage` is the first day with a record and the instant that day begins.
 */
export function buildSegments(periods: SubscriptionPeriod[], firstUsage: { day: string; at: string } | null, today: string): SegmentRange[] {
  const sorted = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (sorted.length === 0) return [];
  const out: SegmentRange[] = [];
  const gap = (startDate: string, start: string, endDate: string | null, end: string | null): SegmentRange => ({
    kind: 'gap',
    periodId: null,
    planKey: NO_PLAN,
    label: planLabel(NO_PLAN),
    startDate,
    endDate,
    start,
    end,
  });
  if (firstUsage && firstUsage.day < sorted[0].startDate) out.push(gap(firstUsage.day, firstUsage.at, sorted[0].startDate, sorted[0].startedAt));
  sorted.forEach((p, i) => {
    const endDate = p.lastDate === null ? null : addDays(p.lastDate, 1);
    out.push({ kind: 'period', periodId: p.id, planKey: p.planKey, label: planLabel(p.planKey, p.label), startDate: p.startDate, endDate, start: p.startedAt, end: p.endedAt });
    const next = sorted[i + 1];
    if (endDate === null || p.endedAt === null || p.lastDate === null) return;
    if (next && endDate < next.startDate) out.push(gap(endDate, p.endedAt, next.startDate, next.startedAt));
    if (!next && p.lastDate < today) out.push(gap(endDate, p.endedAt, null, null));
  });
  return out;
}

export interface SegmentStats extends SegmentRange {
  /** Length of the segment in days as entered (up to today for a running segment). */
  days: number;
  /** Days of the segment that have already passed: less than `days` for a period that ends in the future, 0 before it starts. */
  elapsedDays: number;
  /**
   * Days of the segment that lie inside the recorded history (first to last imported
   * record). Nothing is known about the other days, so averages do not count them.
   */
  recordedDays: number;
  tokens: number;
  exact: number;
  estimated: number;
  conversations: number;
  messages: number;
  activeDays: number;
  /** Tokens divided by `recordedDays`. */
  averageDailyTokens: number | null;
  value: ValueFigures;
}

/** Number of days two inclusive ranges of days share. A null bound is open. */
function sharedDays(a: [string | null, string | null], b: [string | null, string | null]): number {
  const from = a[0] !== null && (b[0] === null || a[0] > b[0]) ? a[0] : b[0];
  const to = a[1] !== null && (b[1] === null || a[1] < b[1]) ? a[1] : b[1];
  if (from === null || to === null || from > to) return 0;
  return daysBetween(from, to);
}

/**
 * The recorded history under a filter: the first and last calendar day with any record
 * of the filter's sources, whatever date range is selected. Days outside it are days
 * nothing was imported for, which is not the same as days without usage.
 */
async function recordedHistory(db: SqlExecutor, filter: AnalyticsFilter): Promise<{ first: string; last: string; firstAt: string } | null> {
  const p = new Params();
  const f = factsFrom({ ...filter, from: null, to: null }, p);
  const row = (
    await db.query<{ first_day: string | null; last_day: string | null; first_at: unknown }>(
      `SELECT min(${f.day})::text AS first_day, max(${f.day})::text AS last_day,
              (min(${f.day})::timestamp AT TIME ZONE ${f.tz}) AS first_at
         FROM ${f.from} WHERE ${f.where}`,
      p.values,
    )
  ).rows[0];
  if (!row?.first_day || !row.last_day) return null;
  return { first: row.first_day, last: row.last_day, firstAt: toIso(row.first_at)! };
}

/** The part of the recorded history the filter's date range leaves in scope, as inclusive days. */
function scopeOf(history: { first: string; last: string }, filter: AnalyticsFilter): [string, string] {
  return [filter.from && filter.from > history.first ? filter.from : history.first, filter.to && filter.to < history.last ? filter.to : history.last];
}

async function aggregateRanges(
  db: SqlExecutor,
  filter: AnalyticsFilter,
  ranges: Array<{ startDate: string | null; endDate: string | null }>,
  options: ValueOptions,
) {
  const tok = tokenExpr(filter.basis);
  const p = new Params();
  const f = factsFrom(filter, p);
  // By calendar day, the day the fact is charted on. `e` is exclusive.
  const join = (day: string, starts: string, ends: string) =>
    `JOIN unnest(${starts}::date[], ${ends}::date[]) WITH ORDINALITY AS seg(s, e, idx)
       ON ${day} >= COALESCE(seg.s, '-infinity'::date) AND ${day} < COALESCE(seg.e, 'infinity'::date)`;
  const starts = ranges.map((r) => r.startDate);
  const ends = ranges.map((r) => r.endDate);
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT seg.idx::int AS idx, sum(${tok})::bigint AS tokens,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated,
            count(DISTINCT ${f.conversationId})::int AS conversations,
            sum(f.user_message_count + f.assistant_message_count)::bigint AS messages,
            count(DISTINCT ${f.day})::int AS active_days,
            min(f.occurred_at) AS first_at, max(f.occurred_at) AS last_at,
            min(${f.day})::text AS first_day, max(${f.day})::text AS last_day
       FROM ${f.from} ${join(f.day, p.add(starts), p.add(ends))} ${f.conversationJoin}
      WHERE ${f.where} GROUP BY 1`,
    p.values,
  );
  // The value query assembles its own parameter list, so the arrays are inlined as literals there.
  const lit = (values: Array<string | null>) =>
    `ARRAY[${values.map((v) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)).join(',')}]`;
  const values = await getApiValueBy(db, filter, `seg.idx`, (day) => join(day, lit(starts), lit(ends)), options);
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
  const history = await recordedHistory(db, filter);
  const today = dayInZone(now, filter.timezone);
  const segments = buildSegments(periods, history ? { day: history.first, at: history.firstAt } : null, today);
  const { rows, values } = await aggregateRanges(db, filter, segments, options);
  const scope = history ? scopeOf(history, filter) : null;
  return segments.map((seg, i) => {
    const r = rows.get(i + 1);
    const lastDay = seg.endDate === null ? null : addDays(seg.endDate, -1);
    const started = seg.startDate <= today;
    const days = Math.max(1, daysBetween(seg.startDate, lastDay ?? today));
    // Usage can only have accrued up to today, whatever end date was entered.
    const elapsedDays = started ? daysBetween(seg.startDate, lastDay !== null && lastDay < today ? lastDay : today) : 0;
    const recordedDays = scope ? sharedDays([seg.startDate, lastDay], scope) : 0;
    const tokens = toNumber(r?.tokens);
    return {
      ...seg,
      days,
      elapsedDays,
      recordedDays,
      tokens,
      exact: toNumber(r?.exact),
      estimated: toNumber(r?.estimated),
      conversations: toNumber(r?.conversations),
      messages: toNumber(r?.messages),
      activeDays: toNumber(r?.active_days),
      averageDailyTokens: tokens > 0 && recordedDays > 0 ? tokens / recordedDays : null,
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
  /** First and last local day with usage on this side (see Overview.firstDay). */
  firstDay: string | null;
  lastDay: string | null;
  /**
   * The days this side is averaged over, inclusive: its part of the recorded history
   * (first to last imported record) that the selected date range leaves in scope. The
   * split day belongs to the later side. Null when the side has no records in scope.
   */
  spanFrom: string | null;
  spanTo: string | null;
  /** Number of days from `spanFrom` to `spanTo`; 0 when the side has no records in scope. */
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
  const split = firstPaid.startDate;

  const { rows, values } = await aggregateRanges(
    db,
    filter,
    [
      { startDate: null, endDate: split },
      { startDate: split, endDate: null },
    ],
    options,
  );
  const history = await recordedHistory(db, filter);
  const scope = history ? scopeOf(history, filter) : null;
  const side = (idx: number): SideStats => {
    const r = rows.get(idx);
    // Each side reaches only as far as the imported records and the selected range do.
    let span: [string, string] | null = null;
    if (r && scope) {
      const from = idx === 1 ? scope[0] : scope[0] > split ? scope[0] : split;
      const dayBefore = addDays(split, -1);
      const to = idx === 1 ? (scope[1] < dayBefore ? scope[1] : dayBefore) : scope[1];
      if (from <= to) span = [from, to];
    }
    return {
      tokens: toNumber(r?.tokens),
      exact: toNumber(r?.exact),
      estimated: toNumber(r?.estimated),
      conversations: toNumber(r?.conversations),
      messages: toNumber(r?.messages),
      activeDays: toNumber(r?.active_days),
      firstAt: toIso(r?.first_at),
      lastAt: toIso(r?.last_at),
      firstDay: (r?.first_day as string | null) ?? null,
      lastDay: (r?.last_day as string | null) ?? null,
      spanFrom: span?.[0] ?? null,
      spanTo: span?.[1] ?? null,
      spanDays: span ? daysBetween(span[0], span[1]) : 0,
      value: values.get(String(idx)) ?? ZERO_FIGURES,
    };
  };
  return {
    split: { at: firstPaid.startedAt, date: split, planKey: firstPaid.planKey, label: planLabel(firstPaid.planKey, firstPaid.label) },
    before: side(1),
    after: side(2),
  };
}

// ── Usage that belongs to conversations, before vs. after ───────────────────────

export interface ConversationUsage {
  /** Chats and Claude Code sessions with usage on this side. */
  conversations: number;
  /** Tokens of those conversations on this side, under the filter's basis. */
  tokens: number;
  exact: number;
  estimated: number;
}

/**
 * The usage on each side of the first paid period that belongs to a chat or a Claude
 * Code session: the basis of "tokens per conversation". Aggregate usage that has no
 * conversation behind it (API usage reports, generic imports, manual entries) is left
 * out, because divided by a number of conversations it would describe conversations
 * that never took place. Returns null when no paid period has been entered.
 */
export async function getBeforeAfterConversationUsage(
  db: SqlExecutor,
  filter: AnalyticsFilter,
): Promise<{ before: ConversationUsage; after: ConversationUsage } | null> {
  const periods = await listPeriods(db, filter.userId, filter.timezone);
  const firstPaid = periods.find((p) => isPaidPlan(p.planKey));
  if (!firstPaid) return null;

  const tok = tokenExpr(filter.basis);
  const p = new Params();
  const f = factsFrom(filter, p);
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT (${f.day} >= ${p.add(firstPaid.startDate)}::date) AS is_after,
            count(DISTINCT f.conversation_id)::int AS conversations,
            COALESCE(sum(${tok}), 0)::bigint AS tokens,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'exact'), 0)::bigint AS exact,
            COALESCE(sum(${tok}) FILTER (WHERE f.confidence = 'estimated'), 0)::bigint AS estimated
       FROM ${f.from} JOIN conversations c ON c.id = f.conversation_id
      WHERE ${f.where} AND c.kind IN ('chat', 'code_session')
      GROUP BY 1`,
    p.values,
  );
  const side = (after: boolean): ConversationUsage => {
    const r = rows.find((row) => row.is_after === after);
    return { conversations: toNumber(r?.conversations), tokens: toNumber(r?.tokens), exact: toNumber(r?.exact), estimated: toNumber(r?.estimated) };
  };
  return { before: side(false), after: side(true) };
}
