import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-4 animate-[spin-slow_0.8s_linear_infinite]', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-raised', className)} aria-hidden="true" />;
}

/** An empty screen is an invitation to act: say what is missing and what to do about it. */
export function EmptyState({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-start gap-2 rounded-[var(--radius-card)] border border-dashed border-line-strong px-5 py-6', className)}>
      <p className="font-medium text-ink">{title}</p>
      {children ? <div className="max-w-[62ch] text-ink-2">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn('rounded-[var(--radius-control)] border border-critical/40 bg-critical/10 px-3.5 py-3', className)}>
      <p className="font-medium text-ink">{title}</p>
      {children ? <div className="mt-1 text-ink-2">{children}</div> : null}
    </div>
  );
}

export function Progress({ value, className, label }: { value: number | null; className?: string; label?: string }) {
  const pct = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === null ? undefined : Math.round(pct)}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-raised', className)}
    >
      <div
        className={cn('h-full rounded-full bg-accent transition-[width] duration-200', pct === null && 'w-1/3 animate-pulse')}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}
