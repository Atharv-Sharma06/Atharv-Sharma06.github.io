import { describe, expect, it } from 'vitest';
import type { ConversationUsage, SideStats, SubscriptionPeriod } from '@/analytics/subscriptions';
import { ZERO_FIGURES } from '@/analytics/value';
import {
  addPeriodLabel, assessComparability, averagedOverPartOnly, averagePerDay, blockLabelFit, boundaryX, DAY_MS, DAYS_PER_MONTH, dayStartInZone, defaultMode, describeDates,
  describeRatio, emptyPeriodForm, endDateResolvingOverlap, focusTargetAfterChange, formToInput, layoutTimeline, leadingUsd, lengthDays, noPaymentReason, otherUsd,
  paymentSpan, perConversation, periodToForm, periodToInput, placeAxisLabels, pricedShare, pricesEstimates, ratePer, rateRatio, segmentDays, segmentSpans, sideFigure,
  timelineTicks, timelineX, validatePeriodForm, valueHint, valueLevel,
  type AxisLabel, type Comparability,
} from '@/features/subscriptions/logic';

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

const side = (over: Partial<SideStats> = {}): SideStats => ({
  tokens: 0, exact: 0, estimated: 0, conversations: 0, messages: 0, activeDays: 0, firstAt: null, lastAt: null, firstDay: null, lastDay: null, spanFrom: null, spanTo: null, spanDays: 0, value: ZERO_FIGURES, ...over,
});

const NONE: Comparability = { lengths: null, measurement: null, firstRecord: null, short: [] };

describe('calendar days in a timezone', () => {
  it('finds the instant a local day begins, across daylight saving changes', () => {
    expect(new Date(dayStartInZone('2025-01-15', 'UTC')).toISOString()).toBe('2025-01-15T00:00:00.000Z');
    expect(new Date(dayStartInZone('2025-01-15', 'America/New_York')).toISOString()).toBe('2025-01-15T05:00:00.000Z');
    // clocks go forward on 9 March 2025 and back on 2 November 2025 in New York
    expect(new Date(dayStartInZone('2025-03-09', 'America/New_York')).toISOString()).toBe('2025-03-09T05:00:00.000Z');
    expect(new Date(dayStartInZone('2025-03-10', 'America/New_York')).toISOString()).toBe('2025-03-10T04:00:00.000Z');
    expect(new Date(dayStartInZone('2025-11-02', 'America/New_York')).toISOString()).toBe('2025-11-02T04:00:00.000Z');
    expect(new Date(dayStartInZone('2025-11-03', 'America/New_York')).toISOString()).toBe('2025-11-03T05:00:00.000Z');
    expect(new Date(dayStartInZone('2025-03-30', 'Europe/Berlin')).toISOString()).toBe('2025-03-29T23:00:00.000Z');
    expect(new Date(dayStartInZone('2025-03-31', 'Europe/Berlin')).toISOString()).toBe('2025-03-30T22:00:00.000Z');
    expect(new Date(dayStartInZone('2025-06-01', 'Asia/Kolkata')).toISOString()).toBe('2025-05-31T18:30:00.000Z');
  });

  it('falls back to UTC for a timezone it does not know', () => {
    expect(new Date(dayStartInZone('2025-06-01', 'Not/AZone')).toISOString()).toBe('2025-06-01T00:00:00.000Z');
  });

  it('gives the first and last day of a segment from its stored days, whose end is exclusive', () => {
    // a period entered as 1 Feb – 28 Feb
    expect(segmentDays({ startDate: '2025-02-01', endDate: '2025-03-01' })).toEqual({ startDate: '2025-02-01', lastDate: '2025-02-28' });
    // a running stretch has no last day
    expect(segmentDays({ startDate: '2025-01-10', endDate: null })).toEqual({ startDate: '2025-01-10', lastDate: null });
  });

  it('names the button that fills a stretch by its dates, and a running stretch by its first day', () => {
    expect(addPeriodLabel({ startDate: '2025-03-03', lastDate: '2025-05-31' })).toBe('Add period for Mar 3 – May 31, 2025');
    expect(addPeriodLabel({ startDate: '2026-02-01', lastDate: null })).toBe('Add period from Feb 1, 2026');
  });
});

describe('timeline layout', () => {
  const options = { minBlock: 12, gap: 2 };

  it('gives each block its share of the time', () => {
    const spans = [
      { startMs: day('2025-01-01'), endMs: day('2025-01-11') },
      { startMs: day('2025-01-11'), endMs: day('2025-01-31') },
      { startMs: day('2025-01-31'), endMs: day('2025-03-02') },
    ];
    const layout = layoutTimeline(spans, 604, options);
    expect(layout.width).toBe(604);
    expect(layout.blocks.map((b) => [b.x, b.width])).toEqual([[0, 100], [102, 200], [304, 300]]);
  });

  it('keeps a very short period visible and lets the others share the rest', () => {
    const spans = [
      { startMs: day('2025-01-01'), endMs: day('2025-01-02') },
      { startMs: day('2025-01-02'), endMs: day('2027-09-29') },
    ];
    const layout = layoutTimeline(spans, 500, options);
    expect(layout.blocks[0]).toMatchObject({ x: 0, width: 12 });
    expect(layout.blocks[1]).toMatchObject({ x: 14, width: 486 });
  });

  it('also widens a block that only falls below the minimum once others have been widened', () => {
    const d = (n: number) => day('2025-01-01') + n * DAY_MS;
    const spans = [
      { startMs: d(0), endMs: d(1) },
      { startMs: d(1), endMs: d(69) },
      { startMs: d(69), endMs: d(1069) },
      { startMs: d(1069), endMs: d(1070) },
    ];
    const layout = layoutTimeline(spans, 206, options);
    // 200px of room: the 68 days get 12.7px at first, and 11.2px once the two one-day blocks take 12px each
    expect(layout.blocks.map((b) => b.width)).toEqual([12, 12, 164, 12]);
    expect(layout.blocks[3].x + layout.blocks[3].width).toBe(206);
  });

  it('grows wider than the frame when the blocks cannot fit at their minimum width', () => {
    const spans = Array.from({ length: 30 }, (_, i) => ({ startMs: day('2025-01-01') + i * DAY_MS, endMs: day('2025-01-01') + (i + 1) * DAY_MS }));
    const layout = layoutTimeline(spans, 300, options);
    expect(layout.width).toBe(30 * 12 + 29 * 2);
    expect(layout.blocks.every((b) => b.width === 12)).toBe(true);
  });

  it('shares the room equally when no block has any length', () => {
    const at = day('2025-01-01');
    const layout = layoutTimeline([{ startMs: at, endMs: at }, { startMs: at, endMs: at }], 202, options);
    expect(layout.blocks.map((b) => [b.x, b.width])).toEqual([[0, 100], [102, 100]]);
    expect(layoutTimeline([], 300, options)).toEqual({ width: 300, blocks: [] });
    expect(layoutTimeline([{ startMs: at, endMs: at + DAY_MS }], 0, options).blocks).toEqual([]);
  });

  it('ends a running segment now, and never before it starts', () => {
    const now = day('2025-03-01');
    expect(segmentSpans([{ start: '2025-01-01T00:00:00.000Z', end: '2025-02-01T00:00:00.000Z' }, { start: '2025-02-01T00:00:00.000Z', end: null }], now)).toEqual([
      { startMs: day('2025-01-01'), endMs: day('2025-02-01') },
      { startMs: day('2025-02-01'), endMs: now },
    ]);
    // an open-ended period that starts next month has no length yet
    expect(segmentSpans([{ start: '2025-04-01T00:00:00.000Z', end: null }], now)).toEqual([{ startMs: day('2025-04-01'), endMs: day('2025-04-01') }]);
  });

  it('maps an instant to its position, linearly within each block', () => {
    // one day at the minimum width, then a hundred days at 5px a day
    const spans = [
      { startMs: day('2025-01-01'), endMs: day('2025-01-02') },
      { startMs: day('2025-01-02'), endMs: day('2025-04-12') },
    ];
    const layout = layoutTimeline(spans, 514, options);
    expect(layout.blocks.map((b) => [b.x, b.width])).toEqual([[0, 12], [14, 500]]);
    expect(timelineX(layout, day('2024-12-01'))).toBe(0);
    expect(timelineX(layout, day('2025-01-01') + DAY_MS / 2)).toBe(6);
    expect(timelineX(layout, day('2025-01-02'))).toBe(14);
    expect(timelineX(layout, day('2025-02-21'))).toBe(264);
    expect(timelineX(layout, day('2025-04-12'))).toBe(514);
    expect(timelineX(layout, day('2026-01-01'))).toBe(514);
    expect(boundaryX(layout, 0, 2)).toBe(0);
    expect(boundaryX(layout, 1, 2)).toBe(13);
  });
});

describe('time axis', () => {
  it('marks years on a long history', () => {
    const ticks = timelineTicks(Date.parse('2019-05-12T00:00:00Z'), Date.parse('2026-11-10T12:00:00Z'), 'UTC', 8);
    expect(ticks.map((t) => t.label)).toEqual(['2020', '2021', '2022', '2023', '2024', '2025', '2026']);
    expect(ticks.every((t) => t.major)).toBe(true);
    expect(new Date(ticks[0].ms).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('marks every few months when years alone would say too little', () => {
    const ticks = timelineTicks(Date.parse('2024-05-12T00:00:00Z'), Date.parse('2026-11-10T12:00:00Z'), 'UTC', 10);
    expect(ticks.map((t) => t.label)).toEqual(['Jul 2024', 'Oct', 'Jan 2025', 'Apr', 'Jul', 'Oct', 'Jan 2026', 'Apr', 'Jul', 'Oct']);
    expect(ticks.filter((t) => t.major).map((t) => t.label)).toEqual(['Jan 2025', 'Jan 2026']);
  });

  it('marks every month of a short history, at local midnight', () => {
    const ticks = timelineTicks(Date.parse('2025-01-20T12:00:00Z'), Date.parse('2025-04-10T12:00:00Z'), 'America/New_York', 12);
    expect(ticks.map((t) => [t.label, new Date(t.ms).toISOString()])).toEqual([
      ['Feb 2025', '2025-02-01T05:00:00.000Z'],
      ['Mar', '2025-03-01T05:00:00.000Z'],
      ['Apr', '2025-04-01T04:00:00.000Z'],
    ]);
  });

  it('has no ticks inside a span that crosses no month boundary', () => {
    expect(timelineTicks(Date.parse('2025-03-03T00:00:00Z'), Date.parse('2025-03-20T00:00:00Z'), 'UTC', 10)).toEqual([]);
    expect(timelineTicks(5, 5, 'UTC', 10)).toEqual([]);
  });

  it('never draws more ticks than asked for', () => {
    for (const max of [1, 2, 3, 5, 8, 13]) {
      expect(timelineTicks(Date.parse('2012-03-01T00:00:00Z'), Date.parse('2026-11-10T00:00:00Z'), 'UTC', max).length).toBeLessThanOrEqual(max);
    }
  });

  it('drops labels that would collide, most important first', () => {
    const label = (x: number, text: string, anchor: AxisLabel['anchor'] = 'middle'): AxisLabel => ({ x, text, anchor, major: false });
    const placed = placeAxisLabels(
      400,
      [label(400, 'Today', 'end'), label(0, 'May 12, 2024', 'start'), label(60, '2025'), label(200, '2026'), label(210, 'Jul'), label(380, '2027')],
      { charWidth: 7, spacing: 14 },
    );
    // "2025" would touch the start date, "Jul" comes after "2026" and collides with it, "2027" would touch "Today"
    expect(placed.map((l) => l.text)).toEqual(['Today', 'May 12, 2024', '2026']);
    // a label that would leave the axis is dropped as well
    expect(placeAxisLabels(100, [label(2, '2025'), label(50, '2026')]).map((l) => l.text)).toEqual(['2026']);
  });

  it('shows as much of a block label as fits, and nothing rather than a clipped one', () => {
    expect(blockLabelFit(200, 40, 150, 10)).toBe('full');
    expect(blockLabelFit(160, 40, 150, 10)).toBe('name');
    expect(blockLabelFit(60, 40, 150, 10)).toBe('name');
    expect(blockLabelFit(59, 40, 150, 10)).toBe('none');
    expect(blockLabelFit(200, undefined, undefined, 10)).toBe('none');
    expect(blockLabelFit(200, 40, undefined, 10)).toBe('name');
  });
});

describe('segments', () => {
  const TODAY = '2026-11-10';

  it('gives every period its length, decided on calendar days against today', () => {
    const closed = { startDate: '2026-09-01', endDate: '2026-10-01', days: 30 };
    const running = { startDate: '2026-11-01', endDate: null, days: 10 };
    const endsLater = { startDate: '2026-11-01', endDate: '2026-12-01', days: 30 };
    const notStarted = { startDate: '2026-12-01', endDate: '2027-01-01', days: 31 };
    expect([closed, running, endsLater, notStarted].map((segment) => lengthDays(segment, TODAY))).toEqual([30, 10, 30, 31]);
    // a plan that starts today has started
    expect(lengthDays({ startDate: TODAY, endDate: null, days: 1 }, TODAY)).toBe(1);
  });

  it('gives no length to a running period that has not started', () => {
    // entered as "from 1 December", with no end date, three weeks ahead of time
    expect(lengthDays({ startDate: '2026-12-01', endDate: null, days: 1 }, TODAY)).toBeNull();
    expect(lengthDays({ startDate: '2026-11-11', endDate: null, days: 1 }, TODAY)).toBeNull();
  });

  it('averages over the days of a segment that the imported records cover', () => {
    // a whole month inside the recorded history
    expect(averagePerDay({ tokens: 3000, activeDays: 12, recordedDays: 30 })).toBe(100);
    // a plan that began a year before the first imported record: the unrecorded year is not divided in
    expect(averagePerDay({ tokens: 3000, activeDays: 4, recordedDays: 10 })).toBe(300);
    // nothing recorded inside the segment
    expect(averagePerDay({ tokens: 0, activeDays: 0, recordedDays: 0 })).toBeNull();
  });

  it('explains an average only when a good part of the segment lies outside the records', () => {
    // a plan that began a year before the first import
    expect(averagedOverPartOnly({ recordedDays: 30, elapsedDays: 395 })).toBe(true);
    // the records start two days into the period, or today has no record yet
    expect(averagedOverPartOnly({ recordedDays: 241, elapsedDays: 243 })).toBe(false);
    expect(averagedOverPartOnly({ recordedDays: 334, elapsedDays: 335 })).toBe(false);
    expect(averagedOverPartOnly({ recordedDays: 100, elapsedDays: 100 })).toBe(false);
    expect(averagedOverPartOnly({ recordedDays: 0, elapsedDays: 100 })).toBe(false);
  });

  it('words the dates of a finished, a running and a coming stretch', () => {
    const today = '2026-11-10';
    expect(describeDates({ startDate: '2025-01-10', lastDate: '2025-12-10' }, today)).toBe('Jan 10 – Dec 10, 2025');
    expect(describeDates({ startDate: '2024-05-12', lastDate: '2025-01-09' }, today)).toBe('May 12, 2024 – Jan 9, 2025');
    expect(describeDates({ startDate: '2025-07-01', lastDate: '2025-07-01' }, today)).toBe('Jul 1, 2025');
    expect(describeDates({ startDate: '2025-12-11', lastDate: null }, today)).toBe('Since Dec 11, 2025');
    expect(describeDates({ startDate: '2026-11-10', lastDate: null }, today)).toBe('Since Nov 10, 2026');
    expect(describeDates({ startDate: '2026-12-01', lastDate: null }, today)).toBe('From Dec 1, 2026');
  });

  it('has no average for a segment without imported records, and a real zero for one whose records hold no tokens', () => {
    expect(averagePerDay({ tokens: 0, activeDays: 0, recordedDays: 30 })).toBeNull();
    expect(averagePerDay({ tokens: 0, activeDays: 2, recordedDays: 30 })).toBe(0);
  });
});

describe('equivalent API value', () => {
  const value = { ...ZERO_FIGURES, exactUsd: '10', estimatedStandardUsd: '4', estimatedCachedUsd: '1.5', totalStandardUsd: '14', totalCachedUsd: '11.5', pricedTokens: 900, unpricedTokens: 100 };

  it('leads with the scenario chosen in the settings', () => {
    expect(leadingUsd(value, 'standard')).toBe('14');
    expect(otherUsd(value, 'standard')).toBe('11.5');
    expect(leadingUsd(value, 'cached')).toBe('11.5');
    expect(otherUsd(value, 'cached')).toBe('14');
  });

  it('is unavailable when nothing could be priced, and estimated as soon as an estimate or an assumed model is in it', () => {
    expect(valueLevel(ZERO_FIGURES)).toBe('unavailable');
    expect(valueLevel({ ...ZERO_FIGURES, unpricedTokens: 5000 })).toBe('unavailable');
    expect(valueLevel({ ...ZERO_FIGURES, exactUsd: '3', totalStandardUsd: '3', totalCachedUsd: '3', pricedTokens: 10 })).toBe('exact');
    expect(valueLevel(value)).toBe('estimated');
    expect(valueLevel({ ...ZERO_FIGURES, exactUsd: '3', pricedTokens: 10, assumedTokens: 4 })).toBe('estimated');
  });

  it('says how much of the usage a price applied to', () => {
    expect(pricedShare(value)).toBe(0.9);
    expect(pricedShare(ZERO_FIGURES)).toBeNull();
    expect(pricedShare({ pricedTokens: 0, unpricedTokens: 10 })).toBe(0);
  });
});

describe('before vs. after: normalised figures', () => {
  const before = side({ tokens: 24_000, exact: 0, estimated: 24_000, conversations: 12, spanDays: 60, firstAt: '2025-01-01T09:00:00.000Z' });
  const after = side({ tokens: 900_000, exact: 800_000, estimated: 100_000, conversations: 50, spanDays: 300, lastAt: '2025-12-26T09:00:00.000Z' });
  const inConversations: ConversationUsage = { conversations: 40, tokens: 600_000, exact: 520_000, estimated: 80_000 };

  it('divides by the calendar span of each side: a week is 7 days, a month 30.4375', () => {
    expect(ratePer(24_000, 60, 1)).toBe(400);
    expect(ratePer(24_000, 60, 7)).toBe(2800);
    expect(ratePer(24_000, 60, DAYS_PER_MONTH)).toBe(12_175);
    expect(ratePer(24_000, 0, 1)).toBeNull();

    expect(sideFigure('total', before, null)).toEqual({ value: 24_000, exact: 0, estimated: 24_000 });
    expect(sideFigure('day', before, null)).toEqual({ value: 400, exact: 0, estimated: 400 });
    expect(sideFigure('week', before, null)).toEqual({ value: 2800, exact: 0, estimated: 2800 });
    expect(sideFigure('month', before, null)).toEqual({ value: 12_175, exact: 0, estimated: 12_175 });
    const perDay = sideFigure('day', after, null)!;
    expect(perDay.value).toBe(3000);
    expect(perDay.exact).toBeCloseTo(2666.6667, 4);
    expect(perDay.estimated).toBeCloseTo(333.3333, 4);
    const month = sideFigure('month', after, null)!;
    expect(month.value).toBeCloseTo(91_312.5, 6);
    expect(month.exact + month.estimated).toBeCloseTo(month.value, 6);
  });

  it('divides the tokens of conversations by the number of conversations', () => {
    expect(perConversation(600_000, 40)).toBe(15_000);
    expect(perConversation(600_000, 0)).toBeNull();
    // 300,000 of the 900,000 tokens belong to no conversation and stay out of the average
    expect(sideFigure('conversation', after, inConversations)).toEqual({ value: 15_000, exact: 13_000, estimated: 2000 });
    expect(sideFigure('conversation', after, { conversations: 0, tokens: 0, exact: 0, estimated: 0 })).toBeNull();
    expect(sideFigure('conversation', after, null)).toBeNull();
  });

  it('has no figure for a side without imported records', () => {
    for (const mode of ['total', 'day', 'week', 'month', 'conversation'] as const) {
      expect(sideFigure(mode, side(), inConversations)).toBeNull();
      expect(sideFigure(mode, null, inConversations)).toBeNull();
    }
  });
});

describe('before vs. after: when a comparison is not meaningful', () => {
  const context = { historyStart: null };
  const estimated = (spanDays: number, tokens = 10_000) => side({ tokens, exact: 0, estimated: tokens, spanDays, firstAt: '2025-01-01T09:00:00.000Z' });

  it('flags sides that cover very different lengths of time, and then opens on a daily average', () => {
    const different = assessComparability(estimated(100), estimated(200), context);
    expect(different.lengths).toEqual({ beforeDays: 100, afterDays: 200 });
    expect(defaultMode(different)).toBe('day');
    expect(assessComparability(estimated(500), estimated(100), context).lengths).toEqual({ beforeDays: 500, afterDays: 100 });

    const similar = assessComparability(estimated(100), estimated(199), context);
    expect(similar.lengths).toBeNull();
    expect(defaultMode(similar)).toBe('total');
    // nothing to compare lengths with while a side has no records
    expect(assessComparability(estimated(100), side(), context).lengths).toBeNull();
    expect(assessComparability(null, estimated(100), context).lengths).toBeNull();
  });

  it('flags a side estimated from text next to a side that is mostly metered', () => {
    const metered = side({ tokens: 1000, exact: 980, estimated: 20, spanDays: 100 });
    expect(assessComparability(estimated(100), metered, context).measurement).toEqual({ estimatedSide: 'before', estimatedShare: 1, meteredShare: 0.98 });
    expect(assessComparability(metered, estimated(100), context).measurement).toEqual({ estimatedSide: 'after', estimatedShare: 1, meteredShare: 0.98 });
    // both estimated, both metered, or an estimated side next to a mostly estimated one: the method is the same enough
    expect(assessComparability(estimated(100), estimated(100), context).measurement).toBeNull();
    expect(assessComparability(metered, metered, context).measurement).toBeNull();
    expect(assessComparability(estimated(100), side({ tokens: 1000, exact: 500, estimated: 500, spanDays: 100 }), context).measurement).toBeNull();
  });

  it('is not switched off by a single metered record on an estimated side', () => {
    // 400,000 tokens estimated from chat text and one metered record of 400 tokens, against 200 million metered tokens
    const before = side({ tokens: 400_400, exact: 400, estimated: 400_000, spanDays: 40 });
    const after = side({ tokens: 200_000_000, exact: 200_000_000, estimated: 0, spanDays: 40 });
    const comparability = assessComparability(before, after, context);
    expect(comparability.measurement).toEqual({ estimatedSide: 'before', estimatedShare: 400_000 / 400_400, meteredShare: 1 });
    // and no ratio is stated
    expect(rateRatio('day', { figure: sideFigure('day', before, null), spanDays: 40 }, { figure: sideFigure('day', after, null), spanDays: 40 }, comparability)).toBeNull();
  });

  it('is raised when the metered shares lie far apart, and not when one side is only a little more metered', () => {
    const at = (metered: number) => side({ tokens: 1000, exact: metered, estimated: 1000 - metered, spanDays: 100 });
    // 30% against 85% metered: neither side is almost all estimated, but the methods differ by more than half
    expect(assessComparability(at(300), at(850), context).measurement).toEqual({ estimatedSide: 'before', estimatedShare: 0.7, meteredShare: 0.85 });
    expect(assessComparability(at(850), at(300), context).measurement).toEqual({ estimatedSide: 'after', estimatedShare: 0.7, meteredShare: 0.85 });
    // 90% estimated next to 51% metered
    expect(assessComparability(at(100), at(510), context).measurement).toEqual({ estimatedSide: 'before', estimatedShare: 0.9, meteredShare: 0.51 });
    // 89% estimated next to 51% metered, 40 points apart: comparable enough
    expect(assessComparability(at(110), at(510), context).measurement).toBeNull();
    expect(assessComparability(at(400), at(800), context).measurement).toBeNull();
  });

  it('notes that the earlier side begins with the first imported record', () => {
    const before = side({ tokens: 500, estimated: 500, spanDays: 30, firstAt: '2024-05-14T13:05:09.000Z', firstDay: '2024-05-14' });
    expect(assessComparability(before, estimated(30), context).firstRecord).toEqual({ day: '2024-05-14', unrecordedDays: 0 });
    // the entered history starts 74 days before anything was recorded
    expect(assessComparability(before, estimated(30), { historyStart: '2024-03-01' }).firstRecord).toEqual({ day: '2024-05-14', unrecordedDays: 74 });
    // a history that starts the day before the first record leaves that one day unrecorded, and one that starts on it none
    expect(assessComparability(before, estimated(30), { historyStart: '2024-05-13' }).firstRecord).toEqual({ day: '2024-05-14', unrecordedDays: 1 });
    expect(assessComparability(before, estimated(30), { historyStart: '2024-05-14' }).firstRecord).toEqual({ day: '2024-05-14', unrecordedDays: 0 });
    // records that begin before the first entered period leave nothing unrecorded
    expect(assessComparability(before, estimated(30), { historyStart: '2024-06-01' }).firstRecord).toEqual({ day: '2024-05-14', unrecordedDays: 0 });
    expect(assessComparability(side(), estimated(30), context).firstRecord).toBeNull();
  });

  it('names the day the first record is filed under, as the column heading does', () => {
    // A daily report row or a manual entry for 9 March is stored at 00:00 UTC; west of UTC that
    // instant is the evening of 8 March, but the record belongs to 9 March everywhere.
    const before = side({ tokens: 500, estimated: 500, spanDays: 23, firstAt: '2025-03-09T00:00:00.000Z', firstDay: '2025-03-09', spanFrom: '2025-03-09' });
    expect(assessComparability(before, estimated(30), context).firstRecord?.day).toBe('2025-03-09');
    // the day comes from the analytics, whatever the instant says
    expect(assessComparability(side({ ...before, firstAt: '2025-03-08T12:00:00.000Z' }), estimated(30), context).firstRecord?.day).toBe('2025-03-09');
  });

  it('lists sides too short for a steady average', () => {
    expect(assessComparability(estimated(13), estimated(14), context).short).toEqual([{ side: 'before', days: 13 }]);
    expect(assessComparability(estimated(40), estimated(3), context).short).toEqual([{ side: 'after', days: 3 }]);
    expect(assessComparability(estimated(40), side(), context).short).toEqual([]);
  });
});

describe('before vs. after: the plain ratio', () => {
  const figure = (value: number) => ({ value, exact: 0, estimated: value });
  const of = (value: number | null, spanDays = 100) => ({ figure: value === null ? null : figure(value), spanDays });

  it('is stated for normalised rates only, never for totals', () => {
    expect(rateRatio('day', of(100), of(300), NONE)).toEqual({ direction: 'more', factor: 3 });
    expect(rateRatio('week', of(700), of(2100), NONE)).toEqual({ direction: 'more', factor: 3 });
    expect(rateRatio('conversation', of(100), of(300), NONE)).toEqual({ direction: 'more', factor: 3 });
    expect(rateRatio('total', of(100), of(300), NONE)).toBeNull();
  });

  it('needs at least 14 days and usage on both sides', () => {
    expect(rateRatio('day', of(100, 13), of(300, 400), NONE)).toBeNull();
    expect(rateRatio('day', of(100, 400), of(300, 13), NONE)).toBeNull();
    expect(rateRatio('day', of(100, 14), of(300, 14), NONE)).not.toBeNull();
    expect(rateRatio('day', of(0), of(300), NONE)).toBeNull();
    expect(rateRatio('day', of(100), of(0), NONE)).toBeNull();
    expect(rateRatio('day', of(null), of(300), NONE)).toBeNull();
  });

  it('is withheld when the two sides are measured differently', () => {
    expect(rateRatio('day', of(100), of(300), { measurement: { estimatedSide: 'before', estimatedShare: 1, meteredShare: 0.98 } })).toBeNull();
  });

  it('is rounded for reading and worded in the direction of the larger side', () => {
    expect(rateRatio('day', of(100), of(278), NONE)).toEqual({ direction: 'more', factor: 3 });
    expect(rateRatio('day', of(100), of(230), NONE)).toEqual({ direction: 'more', factor: 2.5 });
    expect(rateRatio('day', of(100), of(162), NONE)).toEqual({ direction: 'more', factor: 1.6 });
    expect(rateRatio('day', of(100), of(4260), NONE)).toEqual({ direction: 'more', factor: 43 });
    expect(rateRatio('day', of(100), of(29_860), NONE)).toEqual({ direction: 'more', factor: 300 });
    expect(rateRatio('day', of(300), of(100), NONE)).toEqual({ direction: 'fewer', factor: 3 });
    expect(rateRatio('day', of(100), of(110), NONE)).toEqual({ direction: 'same', factor: 1 });
    expect(rateRatio('day', of(110), of(100), NONE)).toEqual({ direction: 'same', factor: 1 });

    expect(describeRatio({ direction: 'more', factor: 3 }, 'tokens per day')).toBe('About 3 times as many tokens per day after your first paid plan as before.');
    expect(describeRatio({ direction: 'more', factor: 1200 }, 'tokens per week')).toBe('About 1,200 times as many tokens per week after your first paid plan as before.');
    expect(describeRatio({ direction: 'fewer', factor: 2.5 }, 'tokens per conversation')).toBe('About 2.5 times as many tokens per conversation before your first paid plan as after.');
    expect(describeRatio({ direction: 'same', factor: 1 }, 'tokens per month')).toBe('About the same number of tokens per month before and after your first paid plan.');
  });
});

describe('period form', () => {
  const TODAY = '2026-11-10';
  const period: SubscriptionPeriod = {
    id: 7, planKey: 'max_20x', label: 'Max 20x (annual)', startedAt: '2025-03-01T00:00:00.000Z', endedAt: null, startDate: '2025-03-01', lastDate: null,
    monthlyPrice: '200.00', currency: 'EUR', notes: 'Paid yearly', isSynthetic: false,
  };

  it('starts empty, in US dollars, or with the dates of the gap it was opened from', () => {
    expect(emptyPeriodForm()).toEqual({ planKey: '', label: '', startDate: '', lastDate: '', monthlyPrice: '', currency: 'USD', notes: '' });
    expect(emptyPeriodForm({ startDate: '2025-03-01', lastDate: '2025-03-08' })).toMatchObject({ startDate: '2025-03-01', lastDate: '2025-03-08' });
    expect(emptyPeriodForm({ startDate: '2025-03-01', lastDate: null })).toMatchObject({ startDate: '2025-03-01', lastDate: '' });
  });

  it('round-trips a stored period', () => {
    const form = periodToForm(period);
    expect(form).toEqual({ planKey: 'max_20x', label: 'Max 20x (annual)', startDate: '2025-03-01', lastDate: '', monthlyPrice: '200', currency: 'EUR', notes: 'Paid yearly' });
    expect(periodToForm({ ...period, monthlyPrice: '19.99' }).monthlyPrice).toBe('19.99');
    expect(periodToForm({ ...period, monthlyPrice: null, label: null, notes: null })).toMatchObject({ monthlyPrice: '', label: '', notes: '' });
    expect(formToInput(form, period.id)).toEqual({ id: 7, planKey: 'max_20x', label: 'Max 20x (annual)', startDate: '2025-03-01', lastDate: null, monthlyPrice: '200', currency: 'EUR', notes: 'Paid yearly' });
    expect(periodToInput(period)).toEqual({ id: 7, planKey: 'max_20x', label: 'Max 20x (annual)', startDate: '2025-03-01', lastDate: null, monthlyPrice: '200.00', currency: 'EUR', notes: 'Paid yearly' });
  });

  it('sends empty optional fields as "not entered" and tidies the rest', () => {
    const input = formToInput({ planKey: 'pro', label: '  ', startDate: '2025-01-10', lastDate: '', monthlyPrice: ' ', currency: ' usd ', notes: '' });
    expect(input).toEqual({ planKey: 'pro', label: null, startDate: '2025-01-10', lastDate: null, monthlyPrice: null, currency: 'USD', notes: null });
    expect('id' in input).toBe(false);
  });

  it('reports each problem next to its field, in the words savePeriod uses', () => {
    const valid = { planKey: 'pro', label: '', startDate: '2025-01-10', lastDate: '', monthlyPrice: '20', currency: 'USD', notes: '' };
    expect(validatePeriodForm(valid, TODAY)).toEqual({});
    expect(validatePeriodForm({ ...valid, lastDate: '2025-01-10', monthlyPrice: '19.99', currency: 'eur' }, TODAY)).toEqual({});
    expect(validatePeriodForm({ ...valid, planKey: '' }, TODAY)).toEqual({ planKey: 'Choose a plan.' });
    expect(validatePeriodForm({ ...valid, startDate: '' }, TODAY)).toEqual({ startDate: 'Enter a valid start date.' });
    expect(validatePeriodForm({ ...valid, startDate: '2025-02-30' }, TODAY)).toEqual({ startDate: 'Enter a valid start date.' });
    expect(validatePeriodForm({ ...valid, lastDate: '2025-13-01' }, TODAY)).toEqual({ lastDate: 'Enter a valid end date, or leave it empty if the plan is still active.' });
    expect(validatePeriodForm({ ...valid, lastDate: '2025-01-09' }, TODAY)).toEqual({ lastDate: 'The end date is before the start date.' });
    expect(validatePeriodForm({ ...valid, monthlyPrice: 'twenty' }, TODAY)).toEqual({ monthlyPrice: 'Enter the monthly price as a number, for example 20 or 19.99.' });
    expect(validatePeriodForm({ ...valid, monthlyPrice: '20.999' }, TODAY)).toHaveProperty('monthlyPrice');
    expect(validatePeriodForm({ ...valid, currency: 'dollars' }, TODAY)).toEqual({ currency: 'Use a three-letter currency code such as USD.' });
    expect(Object.keys(validatePeriodForm({ planKey: '', label: '', startDate: '', lastDate: 'x', monthlyPrice: '-1', currency: '', notes: '' }, TODAY)).sort()).toEqual(['currency', 'lastDate', 'monthlyPrice', 'planKey', 'startDate']);
  });

  it('refuses dates before 2021 and more than ten years ahead, next to the field', () => {
    const valid = { planKey: 'pro', label: '', startDate: '2025-01-10', lastDate: '', monthlyPrice: '20', currency: 'USD', notes: '' };
    // a date field turns the keystrokes 01/10/26 into the year 26
    expect(validatePeriodForm({ ...valid, startDate: '0026-01-10' }, TODAY)).toEqual({
      startDate: 'Enter a start date in 2021 or later. There was no Claude usage before then, so check the year.',
    });
    expect(validatePeriodForm({ ...valid, startDate: '2020-12-31' }, TODAY)).toHaveProperty('startDate');
    expect(validatePeriodForm({ ...valid, startDate: '2021-01-01' }, TODAY)).toEqual({});
    // 31 December 9999, a common way of writing "no end"
    expect(validatePeriodForm({ ...valid, lastDate: '9999-12-31' }, TODAY)).toEqual({
      lastDate: 'The end date is more than 10 years from today. Check the year, or leave the end date empty while the plan is active.',
    });
    expect(validatePeriodForm({ ...valid, lastDate: '2036-11-10' }, TODAY)).toEqual({});
    expect(validatePeriodForm({ ...valid, lastDate: '2036-11-11' }, TODAY)).toHaveProperty('lastDate');
    expect(validatePeriodForm({ ...valid, startDate: '2036-11-11' }, TODAY)).toEqual({ startDate: 'The start date is more than 10 years from today. Check the year.' });
    // on 29 February, ten years ahead ends on 28 February
    expect(validatePeriodForm({ ...valid, lastDate: '2034-02-28' }, '2024-02-29')).toEqual({});
    expect(validatePeriodForm({ ...valid, lastDate: '2034-03-01' }, '2024-02-29')).toHaveProperty('lastDate');
  });

  it('offers to end a running period the day before a new one starts, and only then', () => {
    expect(endDateResolvingOverlap({ startDate: '2024-05-12', lastDate: null }, '2025-01-10')).toBe('2025-01-09');
    expect(endDateResolvingOverlap({ startDate: '2024-05-12', lastDate: null }, '2025-03-01')).toBe('2025-02-28');
    // the other period already has an end date: ending it is not the fix
    expect(endDateResolvingOverlap({ startDate: '2024-05-12', lastDate: '2025-06-30' }, '2025-01-10')).toBeNull();
    // the new period starts on or before the running one
    expect(endDateResolvingOverlap({ startDate: '2025-01-10', lastDate: null }, '2025-01-10')).toBeNull();
    expect(endDateResolvingOverlap({ startDate: '2025-01-10', lastDate: null }, '2024-12-01')).toBeNull();
    expect(endDateResolvingOverlap({ startDate: '2025-01-10', lastDate: null }, '')).toBeNull();
  });
});

describe('money', () => {
  const period = (over: Partial<SubscriptionPeriod>): SubscriptionPeriod => ({
    id: 1, planKey: 'pro', label: null, startedAt: '', endedAt: null, startDate: '2025-01-01', lastDate: null, monthlyPrice: '20.00', currency: 'USD', notes: null, isSynthetic: false, ...over,
  });
  const TODAY = '2026-11-10';

  it('tells "no period has a price" apart from "the priced period has not started yet"', () => {
    expect(noPaymentReason([], TODAY)).toEqual({ kind: 'no_periods' });
    expect(noPaymentReason([period({ monthlyPrice: null })], TODAY)).toEqual({ kind: 'no_price' });
    expect(noPaymentReason([period({ monthlyPrice: '0.00' })], TODAY)).toEqual({ kind: 'no_price' });
    expect(noPaymentReason([period({ monthlyPrice: null, lastDate: '2026-11-30' }), period({ id: 2, startDate: '2026-12-01' })], TODAY)).toEqual({
      kind: 'not_started',
      startDate: '2026-12-01',
    });
  });

  it('states the days the payments are for', () => {
    expect(paymentSpan([period({ startDate: '2024-06-01' })], TODAY)).toEqual({ from: '2024-06-01', to: TODAY });
    expect(
      paymentSpan([period({ startDate: '2024-06-01', lastDate: '2024-12-31' }), period({ id: 2, startDate: '2025-02-01', lastDate: '2025-03-31' }), period({ id: 3, startDate: '2025-04-01', monthlyPrice: null })], TODAY),
    ).toEqual({ from: '2024-06-01', to: '2025-03-31' });
    // a period that ends after today counts up to today; one that has not started does not count
    expect(paymentSpan([period({ startDate: '2026-11-01', lastDate: '2026-11-30' }), period({ id: 2, startDate: '2026-12-01' })], TODAY)).toEqual({ from: '2026-11-01', to: TODAY });
    expect(paymentSpan([period({ startDate: '2026-12-01' })], TODAY)).toBeNull();
  });
});

describe('the confidence of an equivalent API value', () => {
  const value = (over: Partial<typeof ZERO_FIGURES>) => ({ ...ZERO_FIGURES, pricedTokens: 1000, totalStandardUsd: '1', ...over });

  it('names the caching scenario wherever estimated usage is priced', () => {
    const estimated = value({ estimatedStandardUsd: '0.5', estimatedCachedUsd: '0.2' });
    expect(pricesEstimates(estimated)).toBe(true);
    expect(valueHint(estimated, 'standard')).toBe('Includes token counts estimated from conversation text, priced without prompt caching. Not money you paid.');
    expect(valueHint(estimated, 'cached')).toBe('Includes token counts estimated from conversation text, priced with a 5-minute prompt cache assumed. Not money you paid.');
    // metered usage priced at an assumed model: estimated, but no scenario is involved
    const assumed = value({ exactUsd: '1', assumedTokens: 1000 });
    expect(pricesEstimates(assumed)).toBe(false);
    expect(valueLevel(assumed)).toBe('estimated');
    expect(valueHint(assumed, 'standard')).toBe('Usage with no recorded model is priced as the model you chose in Settings. Not money you paid.');
    expect(valueHint(value({ exactUsd: '1' }), 'cached')).toBe('Metered token counts multiplied by Anthropic’s published API prices. Not money you paid.');
  });
});

describe('the focus after a period was saved or deleted', () => {
  const element = (name: string, isConnected = true) => ({ name, isConnected });
  const find = { periodEditButton: (id: number) => (id === 5 ? element('edit 5') : null), main: () => element('main') };

  it('stays on what opened the dialog while that is still on the page', () => {
    expect(focusTargetAfterChange({ opener: element('Add period'), periodId: 5 }, find)?.name).toBe('Add period');
  });

  it('moves to the saved period’s row when what opened the dialog was replaced, and to the main content after a delete', () => {
    // a gap's "Add period" button is gone once the gap is filled
    expect(focusTargetAfterChange({ opener: element('Add period for Feb 1 – Feb 28, 2026', false), periodId: 5 }, find)?.name).toBe('edit 5');
    expect(focusTargetAfterChange({ opener: element('Delete Pro', false), periodId: null }, find)?.name).toBe('main');
    expect(focusTargetAfterChange({ opener: null, periodId: 9 }, find)?.name).toBe('main');
  });
});
