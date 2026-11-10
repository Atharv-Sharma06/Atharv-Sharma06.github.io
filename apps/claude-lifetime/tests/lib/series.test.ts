import { describe, expect, it } from 'vitest';
import { bucketLabel, bucketPart, nextBucket, pivot } from '@/lib/series';

describe('chart buckets', () => {
  it('steps from one bucket to the next', () => {
    expect(nextBucket('2025-12-31', 'day')).toBe('2026-01-01');
    expect(nextBucket('2026-01-05', 'week')).toBe('2026-01-12');
    expect(nextBucket('2025-12-01', 'month')).toBe('2026-01-01');
    expect(nextBucket('2025-01-01', 'year')).toBe('2026-01-01');
  });

  it('keeps yearly buckets in text order for years below 1000', () => {
    // Buckets are compared as text. Unpadded, "227-01-01" sorts after "2025-01-01" and the chart ends after one bar.
    expect(nextBucket('0226-01-01', 'year')).toBe('0227-01-01');
    expect(nextBucket('0999-01-01', 'year')).toBe('1000-01-01');
    const points = [
      { bucket: '0226-01-01', group: 'a', tokens: 1 },
      { bucket: '0229-01-01', group: 'a', tokens: 2 },
    ];
    const { rows } = pivot(points as never, 'year', (p) => (p as unknown as { tokens: number }).tokens);
    expect(rows.map((r) => [r.bucket, r.a])).toEqual([
      ['0226-01-01', 1],
      ['0227-01-01', 0],
      ['0228-01-01', 0],
      ['0229-01-01', 2],
    ]);
  });
});

describe('the name of a bucket the selected range cuts into', () => {
  // A range from Wednesday 11 February to Thursday 30 April 2026.
  const cut = { from: '2026-02-11', to: '2026-04-30' };

  it('says which days of the week it holds, instead of naming the Monday it leaves out', () => {
    expect(bucketLabel('2026-02-09', 'week', cut)).toBe('Feb 11 – Feb 15, 2026, part of the week of Feb 9, 2026');
    expect(bucketPart('2026-02-09', 'week', cut)).toEqual({ from: '2026-02-11', to: '2026-02-15', partial: true });
    // The last week of the range ends on its Thursday.
    expect(bucketLabel('2026-04-27', 'week', cut)).toBe('Apr 27 – Apr 30, 2026, part of the week of Apr 27, 2026');
    // A week that lies wholly inside the range keeps its name.
    expect(bucketLabel('2026-02-16', 'week', cut)).toBe('Week of Feb 16, 2026');
    expect(bucketPart('2026-02-16', 'week', cut).partial).toBe(false);
  });

  it('does the same for a month and a year', () => {
    expect(bucketLabel('2026-02-01', 'month', cut)).toBe('Feb 11 – Feb 28, 2026, part of February 2026');
    expect(bucketLabel('2026-03-01', 'month', cut)).toBe('March 2026');
    expect(bucketLabel('2026-04-01', 'month', cut)).toBe('April 2026');
    expect(bucketLabel('2026-01-01', 'year', cut)).toBe('Feb 11 – Apr 30, 2026, part of 2026');
  });

  it('leaves days alone, and buckets when no edge of the range cuts into recorded usage', () => {
    expect(bucketLabel('2026-02-11', 'day', cut)).toBe(bucketLabel('2026-02-11', 'day'));
    expect(bucketLabel('2026-02-09', 'week')).toBe('Week of Feb 9, 2026');
    expect(bucketLabel('2026-02-09', 'week', { from: null, to: null })).toBe('Week of Feb 9, 2026');
    // Only the start is cut: the end of the range lies beyond the last record.
    expect(bucketLabel('2026-04-27', 'week', { from: '2026-02-11', to: null })).toBe('Week of Apr 27, 2026');
  });
});
