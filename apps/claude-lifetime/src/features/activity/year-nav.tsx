'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Segmented, Select } from '@/components/ui/controls';

/** More years than this do not fit side by side on a phone; a menu takes over. */
const MAX_YEAR_BUTTONS = 5;

/**
 * Moves the page between calendar years: one step at a time with the arrows, or
 * straight to any year. Each year carries its total for the chosen metric.
 */
export function YearNav({
  years,
  year,
  onChange,
  totalOf,
}: {
  years: number[];
  year: number;
  onChange: (year: number) => void;
  /** A year's total for the chosen metric, already formatted. */
  totalOf: (year: number) => string;
}) {
  const index = years.indexOf(year);
  const previous = years[index - 1];
  const next = years[index + 1];
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" aria-label="Previous year" disabled={previous === undefined} onClick={() => previous !== undefined && onChange(previous)} className="w-8 px-0">
        <ChevronLeft className="size-4" aria-hidden="true" />
      </Button>
      {years.length <= MAX_YEAR_BUTTONS ? (
        <Segmented
          label="Year"
          value={String(year)}
          onChange={(value) => onChange(Number(value))}
          options={years.map((y) => ({
            value: String(y),
            title: `${y}: ${totalOf(y)}`,
            label: (
              <span>
                {y}
                <span className="tabular ml-1.5 hidden text-ink-3 sm:inline">{totalOf(y)}</span>
              </span>
            ),
          }))}
        />
      ) : (
        <Select
          label="Year"
          value={String(year)}
          onChange={(value) => onChange(Number(value))}
          options={years.map((y) => ({ value: String(y), label: String(y), hint: totalOf(y) }))}
          className="h-8 w-28 text-[13px]"
        />
      )}
      <Button size="sm" aria-label="Next year" disabled={next === undefined} onClick={() => next !== undefined && onChange(next)} className="w-8 px-0">
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
