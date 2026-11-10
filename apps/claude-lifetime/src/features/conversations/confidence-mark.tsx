import { CircleCheck, CircleDashed, CircleSlash } from 'lucide-react';
import type { ConfidenceLevel } from '@/components/data/confidence';
import { cn } from '@/lib/cn';

const META: Record<ConfidenceLevel, { label: string; icon: typeof CircleCheck; tone: string }> = {
  exact: { label: 'Exact', icon: CircleCheck, tone: 'text-good' },
  estimated: { label: 'Estimated', icon: CircleDashed, tone: 'text-warning' },
  unavailable: { label: 'Unavailable', icon: CircleSlash, tone: 'text-ink-3' },
};

/**
 * The confidence of a figure inside a table row: the icon and word of ConfidenceBadge
 * without the pill and without a tab stop. A page of fifty rows stays quiet, and
 * keyboard users are not walked through fifty tooltips; the column header explains
 * the levels once.
 *
 * `compact` keeps only the icon on screen, for tables with no room for a column of
 * words. The two icons differ in shape, the word stays available to screen readers
 * and as a tooltip, and the table must then show a key that spells the levels out.
 */
export function ConfidenceMark({ level, title, compact = false, className }: { level: ConfidenceLevel; title?: string; compact?: boolean; className?: string }) {
  const meta = META[level];
  const Icon = meta.icon;
  return (
    <span title={title ?? (compact ? meta.label : undefined)} className={cn('inline-flex items-center gap-1 whitespace-nowrap align-middle text-xs text-ink-2', className)}>
      <Icon className={cn('size-3.5 shrink-0', meta.tone)} strokeWidth={2.25} aria-hidden="true" />
      <span className={compact ? 'sr-only' : undefined}>{meta.label}</span>
    </span>
  );
}
