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
 */
export function ConfidenceMark({ level, title, className }: { level: ConfidenceLevel; title?: string; className?: string }) {
  const meta = META[level];
  const Icon = meta.icon;
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap align-middle text-xs text-ink-2', className)}>
      <Icon className={cn('size-3.5 shrink-0', meta.tone)} strokeWidth={2.25} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
