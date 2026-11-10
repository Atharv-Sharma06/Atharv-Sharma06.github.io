'use client';

import { CircleCheck, CircleDashed, CircleSlash, FlaskConical } from 'lucide-react';
import type { ReactNode } from 'react';
import { NO_PLAN } from '@/analytics/base';
import { ConfidenceBadge, type ConfidenceLevel } from '@/components/data/confidence';
import { Tooltip } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';
import { planColor } from '@/lib/palette';

/**
 * The colour of a plan next to its name. Time that no entered period covers gets an
 * empty, dashed square: nothing was recorded, so there is nothing to colour.
 */
export function PlanSwatch({ planKey, className }: { planKey: string; className?: string }) {
  if (planKey === NO_PLAN) {
    return <span aria-hidden="true" className={cn('inline-block size-2.5 shrink-0 rounded-[3px] border border-dashed border-ink-3', className)} />;
  }
  return <span aria-hidden="true" className={cn('inline-block size-2.5 shrink-0 rounded-[3px]', className)} style={{ backgroundColor: planColor(planKey) }} />;
}

/** Marks a period that came with the demo dataset rather than from the user. */
export function SyntheticTag() {
  return (
    <Tooltip content="This period belongs to the synthetic demo data and is removed with it. Editing it makes it one of your own.">
      <span tabIndex={0} className="inline-flex h-5 shrink-0 cursor-default items-center gap-1 rounded-full border border-line bg-raised pl-1.5 pr-2 text-xs text-ink-2">
        <FlaskConical className="size-3 text-warning" strokeWidth={2.25} aria-hidden="true" />
        Synthetic
      </span>
    </Tooltip>
  );
}

const MARK: Record<ConfidenceLevel, { icon: typeof CircleCheck; tone: string; label: string }> = {
  exact: { icon: CircleCheck, tone: 'text-good', label: 'Exact' },
  estimated: { icon: CircleDashed, tone: 'text-warning', label: 'Estimated' },
  unavailable: { icon: CircleSlash, tone: 'text-ink-3', label: 'Unavailable' },
};

/** The confidence of a figure as plain text with its icon, for places where a badge with its own tooltip cannot go. */
export function ConfidenceMark({ level, className }: { level: ConfidenceLevel; className?: string }) {
  const { icon: Icon, tone, label } = MARK[level];
  return (
    <span className={cn('inline-flex items-center gap-1 text-ink-2', className)}>
      <Icon className={cn('size-3.5', tone)} strokeWidth={2.25} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * A figure with its confidence badge. In a column of figures the badge sits in a slot
 * of fixed width, so the figures line up whatever the badge says.
 */
export function BadgedFigure({
  children,
  level,
  hint,
  title,
  column = false,
}: {
  children: ReactNode;
  level: ConfidenceLevel;
  hint?: string;
  /** Full-precision figure, shown as the native tooltip. */
  title?: string;
  column?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', column && 'justify-end')}>
      <span className="tabular whitespace-nowrap text-ink" title={title}>
        {children}
      </span>
      <span className={cn('inline-flex', column && 'w-[5.75rem]')}>
        <ConfidenceBadge level={level} hint={hint} />
      </span>
    </span>
  );
}

/** A value that is not available: a dash, and the reason in words. Never a zero in its place. */
export function Unavailable({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <>
      {/* The muted colour comes last so that it holds whatever size the caller asks for. */}
      <span className={cn(className, 'text-ink-3')}>
        <span aria-hidden="true">–</span>
        {children ? null : <span className="sr-only">Not available</span>}
      </span>
      {children ? <span className="mt-0.5 block text-xs text-ink-3">{children}</span> : null}
    </>
  );
}
