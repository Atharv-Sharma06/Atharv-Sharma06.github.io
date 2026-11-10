import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BeforeAfter, SegmentStats, SideStats, SubscriptionPeriod } from '@/analytics/subscriptions';
import { ZERO_FIGURES, type ActualSpend, type ApiValue, type ValueFigures } from '@/analytics/value';
import { TooltipProvider } from '@/components/ui/overlay';
import { BeforeAfterCard } from '@/features/subscriptions/before-after';
import { MoneyCard } from '@/features/subscriptions/money';
import { PeriodsTable, StoredPeriodsTable } from '@/features/subscriptions/periods-table';
import { SegmentDetails } from '@/features/subscriptions/timeline';

/**
 * The parts of the Subscription History page, rendered to HTML: what they say and which
 * dates they show, for the findings of the page's review.
 */
const noop = () => undefined;
const render = (element: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, element));
/** The text of an HTML fragment, with tags removed and spaces collapsed. */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const rows = (html: string) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]));
const labels = (html: string, pattern: RegExp) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1].replace(/&#x27;/g, "'")).filter((l) => pattern.test(l));

const TODAY = '2026-11-10';

const period = (over: Partial<SubscriptionPeriod>): SubscriptionPeriod => ({
  id: 1, planKey: 'pro', label: null, startDate: '2026-09-01', lastDate: null, startedAt: '', endedAt: null, monthlyPrice: '20.00', currency: 'USD', notes: null, isSynthetic: false,
  ...over,
});

const segment = (over: Partial<SegmentStats>): SegmentStats => ({
  kind: 'period', periodId: 1, planKey: 'pro', label: 'Pro', startDate: '2026-09-01', endDate: null, start: '2026-09-01T00:00:00.000Z', end: null,
  days: 1, elapsedDays: 1, recordedDays: 0, tokens: 0, exact: 0, estimated: 0, conversations: 0, messages: 0, activeDays: 0, averageDailyTokens: null, value: ZERO_FIGURES,
  ...over,
});

/**
 * Free 1 Sep – 15 Oct 2026, nothing recorded until Pro 25 Oct – 4 Nov, then Max 5x from 6 Nov, as
 * entered in Casablanca. The instants are those the database derived with timezone data that
 * disagrees with the browser's by an hour: each lies an hour before local midnight, so read back
 * in the browser every date would come out a day early (or, for the exclusive ends, a day late).
 */
const at = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 3_600_000).toISOString();
const mismatched: SegmentStats[] = [
  segment({ periodId: 1, planKey: 'free', label: 'Free', startDate: '2026-09-01', endDate: '2026-10-16', start: at('2026-09-01'), end: at('2026-10-16'), days: 45, elapsedDays: 45 }),
  segment({ kind: 'gap', periodId: null, planKey: 'none', label: 'No subscription recorded', startDate: '2026-10-16', endDate: '2026-10-25', start: at('2026-10-16'), end: at('2026-10-25'), days: 9, elapsedDays: 9 }),
  segment({ periodId: 2, planKey: 'pro', label: 'Pro', startDate: '2026-10-25', endDate: '2026-11-05', start: at('2026-10-25'), end: at('2026-11-05'), days: 11, elapsedDays: 11 }),
  segment({ kind: 'gap', periodId: null, planKey: 'none', label: 'No subscription recorded', startDate: '2026-11-05', endDate: '2026-11-06', start: at('2026-11-05'), end: at('2026-11-06'), days: 1, elapsedDays: 1 }),
  segment({ periodId: 3, planKey: 'max_5x', label: 'Max 5x', startDate: '2026-11-06', endDate: null, start: at('2026-11-06'), end: null, days: 5, elapsedDays: 5 }),
];
const mismatchedPeriods = [
  period({ id: 1, planKey: 'free', startDate: '2026-09-01', lastDate: '2026-10-15', monthlyPrice: null }),
  period({ id: 2, planKey: 'pro', startDate: '2026-10-25', lastDate: '2026-11-04' }),
  period({ id: 3, planKey: 'max_5x', startDate: '2026-11-06', monthlyPrice: '100.00' }),
];

const table = (segments: SegmentStats[], periods: SubscriptionPeriod[], over: { hasUsage?: boolean; scenario?: 'standard' | 'cached' } = {}) =>
  render(
    createElement(PeriodsTable, {
      segments, periods, today: TODAY, scenario: over.scenario ?? 'standard', hasUsage: over.hasUsage ?? false, onEdit: noop, onDelete: noop, onAddPeriod: noop,
    }),
  );

describe('dates on the page are the stored days', () => {
  it('in the periods table, whatever the derived instants say', () => {
    const body = rows(table(mismatched, mismatchedPeriods)).slice(1);
    expect(body.map((row) => row.split(' Edit')[0].split(' Add period')[0])).toEqual([
      'Free Sep 1, 2026 Oct 15, 2026 45 days – Not entered',
      'No subscription recorded Oct 16, 2026 Oct 24, 2026 9 days',
      'Pro Oct 25, 2026 Nov 4, 2026 11 days $20.00',
      'No subscription recorded Nov 5, 2026 Nov 5, 2026 1 day',
      'Max 5x Nov 6, 2026 Active 5 days $100.00',
    ]);
  });

  it('in the buttons that fill a stretch, which pre-fill the days of the stretch', () => {
    const html = table(mismatched, mismatchedPeriods);
    expect(labels(html, /^Add period/)).toEqual(['Add period for Oct 16 – Oct 24, 2026', 'Add period for Nov 5, 2026']);
    expect(labels(html, /^Edit/)).toEqual(['Edit Free, Sep 1 – Oct 15, 2026', 'Edit Pro, Oct 25 – Nov 4, 2026', 'Edit Max 5x, Since Nov 6, 2026']);
  });

  it('decides on days whether a period has started', () => {
    // Max 20x from tomorrow; its instant lies before now, because of the mismatch above
    const upcoming = segment({ periodId: 4, planKey: 'max_20x', label: 'Max 20x', startDate: '2026-11-11', start: '2026-11-10T11:00:00.000Z', days: 1, elapsedDays: 0 });
    const body = rows(table([upcoming], [period({ id: 4, planKey: 'max_20x', startDate: '2026-11-11' })]))[1];
    expect(body).toMatch(/^Max 20x Nov 11, 2026 Not started – Not available/);
  });
});

describe('the periods table', () => {
  it('counts the days of a period that ends in the future that have passed as the analytics do', () => {
    // Pro 1 – 30 November, read at 08:00 on 10 November: ten days have passed, counting today
    const pro = segment({ startDate: '2026-11-01', endDate: '2026-12-01', start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', days: 30, elapsedDays: 10 });
    expect(rows(table([pro], [period({ startDate: '2026-11-01', lastDate: '2026-11-30' })]))[1]).toContain('30 days 10 so far');
  });

  it('labels the equivalent API value with its confidence', () => {
    const value: ValueFigures = { ...ZERO_FIGURES, estimatedStandardUsd: '19.33', estimatedCachedUsd: '6.00', totalStandardUsd: '19.33', totalCachedUsd: '6.00', pricedTokens: 5_110_000 };
    const free = segment({ planKey: 'free', label: 'Free', days: 243, elapsedDays: 243, recordedDays: 243, tokens: 5_110_000, estimated: 5_110_000, activeDays: 100, conversations: 12, messages: 72, value });
    const html = table([free], [period({ planKey: 'free', monthlyPrice: null })], { hasUsage: true });
    expect(rows(html)[1]).toMatch(/\$19\.33 Estimated/);
    expect(rows(table([free], [period({ planKey: 'free', monthlyPrice: null })], { hasUsage: true, scenario: 'cached' }))[1]).toMatch(/\$6\.00 Estimated/);
    // and in the tooltip of the timeline, with the caching scenario it uses
    const details = text(render(createElement(SegmentDetails, { segment: free, datesText: 'Since Sep 1, 2026', today: TODAY, scenario: 'standard', hasUsage: true })));
    expect(details).toContain('Equivalent API value $19.33 Estimated Estimated chat usage priced without prompt caching');
  });

  it('says what the days an average is taken over are', () => {
    const pro = segment({ days: 243, elapsedDays: 243, recordedDays: 182, tokens: 23_400, estimated: 23_400, activeDays: 12, conversations: 12, messages: 72 });
    expect(rows(table([pro], [period({})], { hasUsage: true }))[1]).toContain('over the 182 days between your first and last record');
    const details = text(render(createElement(SegmentDetails, { segment: pro, datesText: 'Since Sep 1, 2026', today: TODAY, scenario: 'standard', hasUsage: true })));
    expect(details).toContain('over the 182 days between your first and last record');
    expect(details).not.toContain('with records');
  });

  it('names a running stretch’s button by its first day', () => {
    const gap = segment({ kind: 'gap', periodId: null, planKey: 'none', label: 'No subscription recorded', startDate: '2026-02-01', endDate: null, days: 283, elapsedDays: 283 });
    expect(labels(table([gap], []), /^Add period/)).toEqual(['Add period from Feb 1, 2026']);
  });
});

describe('the stored periods, when the figures cannot be read', () => {
  it('can still be edited and deleted, whatever their dates', () => {
    const html = render(
      createElement(StoredPeriodsTable, {
        periods: [period({ id: 1, planKey: 'max_5x', startDate: '2025-12-11', lastDate: '9999-12-31', monthlyPrice: '100.00' }), period({ id: 2, startDate: '0026-01-10' })],
        today: TODAY,
        onEdit: noop,
        onDelete: noop,
      }),
    );
    expect(rows(html).slice(1).map((row) => row)).toEqual(['Max 5x Dec 11, 2025 Dec 31, 9999 $100.00 Edit Delete', 'Pro Jan 10, 26 No end date $20.00 Edit Delete']);
    expect(labels(html, /^(Edit|Delete)/)).toHaveLength(4);
  });
});

// ── Before vs. after ────────────────────────────────────────────────────────────

const side = (over: Partial<SideStats>): SideStats => ({
  tokens: 0, exact: 0, estimated: 0, conversations: 0, messages: 0, activeDays: 0, firstAt: null, lastAt: null, firstDay: null, lastDay: null, spanFrom: null, spanTo: null, spanDays: 0,
  value: ZERO_FIGURES, ...over,
});
const beforeAfter = (data: BeforeAfter, historyStart: string | null = null) =>
  render(createElement(BeforeAfterCard, { data, inConversations: null, historyStart, scenario: 'standard', periodCount: 2, action: null }));

describe('the before and after card', () => {
  const split = { at: '2025-04-01T04:00:00.000Z', date: '2025-04-01', planKey: 'pro', label: 'Pro' };

  it('names the day the first record is filed under', () => {
    // a manual entry for 9 March, stored at 00:00 UTC, which is the evening of 8 March west of UTC
    const before = side({ tokens: 500, estimated: 500, spanDays: 23, firstAt: '2025-03-08T12:00:00.000Z', firstDay: '2025-03-09', spanFrom: '2025-03-09', spanTo: '2025-03-31' });
    const after = side({ tokens: 500, estimated: 500, spanDays: 20, firstDay: '2025-04-01', spanFrom: '2025-04-01', spanTo: '2025-04-20' });
    const html = text(beforeAfter({ split, before, after }));
    expect(html).toContain('Before Mar 9 – Mar 31, 2025');
    expect(html).toContain('That record is from Mar 9, 2025.');
    // the entered history is named by its first day
    expect(text(beforeAfter({ split, before, after }, '2024-12-01'))).toContain('The periods you entered start on Dec 1, 2024, but the earliest record is from Mar 9, 2025. Nothing is recorded for those 98 days');
  });

  it('withholds the ratio when one side is almost all estimated and the other metered', () => {
    const before = side({ tokens: 400_400, exact: 400, estimated: 400_000, spanDays: 40, firstDay: '2025-01-01', spanFrom: '2025-01-01', spanTo: '2025-02-09' });
    const after = side({ tokens: 200_000_000, exact: 200_000_000, spanDays: 40, firstDay: '2025-02-10', spanFrom: '2025-02-10', spanTo: '2025-03-21' });
    const html = text(beforeAfter({ split: { ...split, date: '2025-02-10' }, before, after }));
    expect(html).toContain('Measured differently. Before is >99% estimated from conversation text, while 100% of after is metered');
    expect(html).not.toMatch(/times as many/);
  });

  it('keeps every column in view: side by side only where the card is wide, the measure above its figures where the table is narrow', () => {
    const before = side({ tokens: 500, estimated: 500, spanDays: 40, firstDay: '2025-01-01', spanFrom: '2025-01-01', spanTo: '2025-02-09' });
    const html = beforeAfter({ split, before, after: before });
    // the two halves of the card go side by side by the card's width, not the window's
    expect(html).toMatch(/class="[^"]*@container[^"]*"[^>]*id="before-after"|id="before-after"[^>]*class="[^"]*@container/);
    expect(html).toContain('@min-[68rem]:grid-cols-');
    expect(html).not.toMatch(/\blg:grid-cols-/);
    // headings may wrap
    expect(html).not.toContain('sm:whitespace-nowrap');
    // on a narrow table each measure has a row of its own above its two figures, and its row header is only visually hidden
    expect(html.match(/<tr aria-hidden="true" class="hidden [^"]*@max-\[34rem\]:table-row">/g)).toHaveLength(6);
    expect(html.match(/<th scope="row" class="[^"]*@max-\[34rem\]:sr-only/g)).toHaveLength(6);
  });
});

// ── Money ───────────────────────────────────────────────────────────────────────

const spend = (over: Partial<ActualSpend> = {}): ActualSpend => ({ reportedApiUsd: null, reportedRange: null, subscriptions: null, ...over });
const apiValue: ApiValue = { ...ZERO_FIGURES, exactUsd: '1.5', totalStandardUsd: '1.5', totalCachedUsd: '1.5', pricedTokens: 1000, unpriced: [], sources: [], assumedModel: null };
const money = (props: { spend: ActualSpend; periods: SubscriptionPeriod[]; recorded?: { first: string; last: string } | null }) =>
  text(render(createElement(MoneyCard, { spend: props.spend, value: apiValue, scenario: 'standard', hasUsage: true, periods: props.periods, today: TODAY, recorded: props.recorded ?? null })));

describe('the money card', () => {
  it('says when the first priced period starts instead of denying that any has a price', () => {
    const html = money({ spend: spend(), periods: [period({ monthlyPrice: null, startDate: '2026-01-01', lastDate: '2026-11-30' }), period({ id: 2, startDate: '2026-12-01' })] });
    expect(html).toContain('Your first period with a monthly price starts on Dec 1, 2026.');
    expect(html).not.toContain('None of your periods has a monthly price');
    expect(money({ spend: spend(), periods: [period({ monthlyPrice: null })] })).toContain('None of your periods has a monthly price');
  });

  it('states the days the payments and the calculation each cover, and does not call worked-out payments actual money', () => {
    const html = money({
      spend: spend({ subscriptions: [{ currency: 'USD', amount: '600.00', cycles: 30 }] }),
      periods: [period({ startDate: '2024-06-01' })],
      recorded: { first: '2025-03-09', last: '2025-03-29' },
    });
    expect(html).not.toContain('the same usage');
    expect(html).not.toContain('Actual money');
    expect(html).toContain('Subscription payments From the prices you entered $600.00 30 monthly payments For your priced periods from Jun 1, 2024 to Nov 10, 2026.');
    expect(html).toContain('Your records from Mar 9, 2025 to Mar 29, 2025 at API list prices');
  });

  it('names the range of the cost reports it is given', () => {
    const html = money({ spend: spend({ reportedApiUsd: '1412.95', reportedRange: { first: '2026-09-01', last: '2026-09-30' } }), periods: [] });
    expect(html).toContain('API usage billed From your cost reports $1,412.95 The sum of the cost reports you imported, which cover Sep 1, 2026 to Sep 30, 2026.');
  });
});
