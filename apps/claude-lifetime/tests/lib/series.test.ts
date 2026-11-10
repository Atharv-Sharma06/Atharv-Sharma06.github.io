import { describe, expect, it } from 'vitest';
import { nextBucket, pivot } from '@/lib/series';

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
