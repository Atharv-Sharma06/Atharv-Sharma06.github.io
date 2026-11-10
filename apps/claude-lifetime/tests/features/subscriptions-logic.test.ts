import { describe, expect, it } from 'vitest';
import type { ConversationUsage, SideStats, SubscriptionPeriod } from '@/analytics/subscriptions';
import { ZERO_FIGURES } from '@/analytics/value';
import {
  assessComparability, averagePerDay, blockLabelFit, boundaryX, DAY_MS, DAYS_PER_MONTH, dayStartInZone, defaultMode, describeDates, describeRatio, elapsedDays,
  emptyPeriodForm, endDateResolvingOverlap, formToInput, layoutTimeline, leadingUsd, lengthDays, otherUsd, perConversation, periodToForm, periodToInput,
  placeAxisLabels, pricedShare, ratePer, rateRatio, segmentDates, segmentSpans, sideFigure, timelineTicks, timelineX, validatePeriodForm, valueLevel,
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

  it('gives the first and last day of a segment, whose end is exclusive', () => {
    // a period entered as 1 Feb – 28 Feb in New York
    expect(segmentDates({ start: '2025-02-01T05:00:00.000Z', end: '2025-03-01T05:00:00.000Z' }, 'America/New_York')).toEqual({ startDate: '2025-02-01', lastDate: '2025-02-28' });
    // a gap that begins with the first imported record, in the middle of a day, and is still running
    expect(segmentDates({ start: '2025-01-10T15:00:00.000Z', end: null }, 'America/New_York')).toEqual({ startDate: '2025-01-10', lastDate: null });
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
  const NOW = Date.parse('2026-11-10T12:00:00Z');

  it('counts the days that have passed when a period is entered with a future end date', () => {
    const closed = { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', days: 30 };
    expect(elapsedDays(closed, NOW)).toBe(30);

    const running = { start: '2026-11-01T00:00:00.000Z', end: null, days: 10 };
    expect(elapsedDays(running, NOW)).toBe(10);

    // entered as 1 – 30 November; only nine and a half days of it have happened
    const endsLater = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', days: 30 };
    expect(elapsedDays(endsLater, NOW)).toBe(10);

    const notStarted = { start: '2026-12-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z', days: 31 };
    expect(elapsedDays(notStarted, NOW)).toBe(0);

    expect([closed, running, endsLater, notStarted].map((segment) => lengthDays(segment, NOW))).toEqual([30, 10, 30, 31]);
  });

  it('gives no length to a running period that has not started', () => {
    // entered as "from 1 December", with no end date, three weeks ahead of time
    const ahead = { start: '2026-12-01T00:00:00.000Z', end: null, days: 1 };
    expect(lengthDays(ahead, NOW)).toBeNull();
    expect(elapsedDays(ahead, NOW)).toBe(0);
  });

  it('averages over the days of a segment that the imported records cover', () => {
    // a whole month inside the recorded history
    expect(averagePerDay({ tokens: 3000, activeDays: 12, recordedDays: 30 })).toBe(100);
    // a plan that began a year before the first imported record: the unrecorded year is not divided in
    expect(averagePerDay({ tokens: 3000, activeDays: 4, recordedDays: 10 })).toBe(300);
    // nothing recorded inside the segment
    expect(averagePerDay({ tokens: 0, activeDays: 0, recordedDays: 0 })).toBeNull();
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
  const context = { timezone: 'UTC', historyStart: null };
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
    expect(assessComparability(estimated(100), metered, context).measurement).toEqual({ estimatedSide: 'before', meteredShare: 0.98 });
    expect(assessComparability(metered, estimated(100), context).measurement).toEqual({ estimatedSide: 'after', meteredShare: 0.98 });
    // both estimated, both metered, or an estimated side next to a mostly estimated one: the method is the same enough
    expect(assessComparability(estimated(100), estimated(100), context).measurement).toBeNull();
    expect(assessComparability(metered, metered, context).measurement).toBeNull();
    expect(assessComparability(estimated(100), side({ tokens: 1000, exact: 500, estimated: 500, spanDays: 100 }), context).measurement).toBeNull();
  });

  it('notes that the earlier side begins with the first imported record', () => {
    const before = side({ tokens: 500, estimated: 500, spanDays: 30, firstAt: '2024-05-14T13:05:09.000Z' });
    expect(assessComparability(before, estimated(30), context).firstRecord).toEqual({ day: '2024-05-14', unrecordedDays: 0 });
    // the entered history starts 74 days before anything was recorded
    expect(assessComparability(before, estimated(30), { timezone: 'UTC', historyStart: '2024-03-01T00:00:00.000Z' }).firstRecord).toEqual({ day: '2024-05-14', unrecordedDays: 74 });
    // records that begin before the first entered period leave nothing unrecorded
    expect(assessComparability(before, estimated(30), { timezone: 'UTC', historyStart: '2024-06-01T00:00:00.000Z' }).firstRecord).toEqual({ day: '2024-05-14', unrecordedDays: 0 });
    // the day is the local one
    expect(assessComparability(side({ tokens: 5, estimated: 5, spanDays: 3, firstAt: '2024-05-14T02:00:00.000Z' }), null, { timezone: 'America/New_York', historyStart: null }).firstRecord?.day).toBe('2024-05-13');
    expect(assessComparability(side(), estimated(30), context).firstRecord).toBeNull();
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
    expect(rateRatio('day', of(100), of(300), { measurement: { estimatedSide: 'before', meteredShare: 0.98 } })).toBeNull();
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
    expect(validatePeriodForm(valid)).toEqual({});
    expect(validatePeriodForm({ ...valid, lastDate: '2025-01-10', monthlyPrice: '19.99', currency: 'eur' })).toEqual({});
    expect(validatePeriodForm({ ...valid, planKey: '' })).toEqual({ planKey: 'Choose a plan.' });
    expect(validatePeriodForm({ ...valid, startDate: '' })).toEqual({ startDate: 'Enter a valid start date.' });
    expect(validatePeriodForm({ ...valid, startDate: '2025-02-30' })).toEqual({ startDate: 'Enter a valid start date.' });
    expect(validatePeriodForm({ ...valid, lastDate: '2025-13-01' })).toEqual({ lastDate: 'Enter a valid end date, or leave it empty if the plan is still active.' });
    expect(validatePeriodForm({ ...valid, lastDate: '2025-01-09' })).toEqual({ lastDate: 'The end date is before the start date.' });
    expect(validatePeriodForm({ ...valid, monthlyPrice: 'twenty' })).toEqual({ monthlyPrice: 'Enter the monthly price as a number, for example 20 or 19.99.' });
    expect(validatePeriodForm({ ...valid, monthlyPrice: '20.999' })).toHaveProperty('monthlyPrice');
    expect(validatePeriodForm({ ...valid, currency: 'dollars' })).toEqual({ currency: 'Use a three-letter currency code such as USD.' });
    expect(Object.keys(validatePeriodForm({ planKey: '', label: '', startDate: '', lastDate: 'x', monthlyPrice: '-1', currency: '', notes: '' })).sort()).toEqual(['currency', 'lastDate', 'monthlyPrice', 'planKey', 'startDate']);
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
