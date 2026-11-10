import { useId, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { ConfidenceBadge, type ConfidenceLevel } from './confidence';

/**
 * A stat tile: one figure, what it is, how sure it is, and one or two lines of context.
 * When the figure is unavailable no number is shown at all — never a zero in its place.
 */
export function MetricCard({
  label,
  value,
  title,
  confidence,
  confidenceHint,
  children,
  action,
  className,
}: {
  label: string;
  /** The figure, already formatted. Ignored when `confidence` is `unavailable`. */
  value: ReactNode;
  /** Full-precision figure, shown as the native tooltip of the value. */
  title?: string;
  confidence: ConfidenceLevel;
  confidenceHint?: string;
  /** Supporting lines under the figure. */
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const unavailable = confidence === 'unavailable';
  const headingId = useId();
  return (
    // A labelled group: assistive technology announces which figure the content belongs to.
    <Card role="group" aria-labelledby={headingId} className={cn('flex flex-col px-5 py-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="text-[13px] text-ink-2">
          {label}
        </h2>
        <ConfidenceBadge level={confidence} hint={confidenceHint} />
      </div>
      <p
        title={unavailable ? undefined : title}
        className={cn('mt-2 text-[28px] font-medium leading-none tracking-[-0.02em]', unavailable ? 'text-ink-3' : 'text-ink')}
      >
        {unavailable ? '–' : value}
      </p>
      {children ? <div className="mt-2.5 space-y-1 text-[13px] text-ink-2">{children}</div> : null}
      {action ? <div className="mt-auto pt-3">{action}</div> : null}
    </Card>
  );
}
