'use client';

import { Calendar, Check, ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/controls';
import { Popover, Tooltip } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import { formatDayRange } from '@/lib/format';
import { RANGE_PRESETS, useApp } from '@/state/app';

/** The date range every chart and table on the page follows. */
export function DateRangePicker({ applies = true }: { applies?: boolean }) {
  const { range, setRange, resolved } = useApp();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(resolved.from ?? '');
  const [to, setTo] = useState(resolved.to ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFrom(resolved.from ?? '');
      setTo(resolved.to ?? '');
      setError(null);
    }
  }, [open, resolved.from, resolved.to]);

  const label = range.preset === 'custom' ? formatDayRange(range.from, range.to) : RANGE_PRESETS.find((p) => p.value === range.preset)?.label ?? 'All time';

  const applyCustom = () => {
    if (!from && !to) {
      setError('Choose a start date, an end date, or both.');
      return;
    }
    if (from && to && from > to) {
      setError('The start date is after the end date.');
      return;
    }
    setRange({ preset: 'custom', from: from || null, to: to || null });
    setOpen(false);
  };

  // Some pages always cover the whole history; there the control says so instead of pretending to filter.
  if (!applies) {
    return (
      <Tooltip content="This page always covers your whole history. The date range applies to Overview, Lifetime Usage, Conversations and Model Breakdown." side="bottom">
        <span tabIndex={0} className={buttonClass('secondary', 'md', 'max-w-full cursor-default justify-start opacity-60')} aria-label="Date range: not used on this page">
          <Calendar className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="truncate">Whole history</span>
        </span>
      </Tooltip>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[min(19rem,calc(100vw-1.5rem))] p-2"
      trigger={
        <Button variant="secondary" aria-label={`Date range: ${label}`} className="max-w-full justify-start">
          <Calendar className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
        </Button>
      }
    >
      <ul>
        {RANGE_PRESETS.map((p) => {
          const active = range.preset === p.value;
          return (
            <li key={p.value}>
              <button
                type="button"
                onClick={() => {
                  setRange({ preset: p.value, from: null, to: null });
                  setOpen(false);
                }}
                className={cn(
                  'flex h-8 w-full items-center justify-between rounded-md px-2.5 text-left text-sm text-ink hover:bg-hover',
                  active && 'bg-hover',
                )}
              >
                {p.label}
                {active ? <Check className="size-4 text-accent-soft" strokeWidth={2.5} aria-hidden="true" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="mt-2 border-t border-line px-1 pb-1 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          applyCustom();
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="px-2" />
          </Field>
          <Field label="To">
            <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="px-2" />
          </Field>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-[13px] text-critical">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant={range.preset === 'custom' ? 'primary' : 'secondary'} size="sm" className="mt-3 w-full">
          Apply custom range
        </Button>
      </form>
    </Popover>
  );
}
