import { CircleCheck, CircleDashed, CircleSlash } from 'lucide-react';
import type { ConfidenceLevel } from '@/components/data/confidence';
import { cn } from '@/lib/cn';
import { formatInstant } from '@/lib/format';

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

/** Why a time is marked as inferred; the import's rule is in src/import/claude-export/parser.ts. */
export const INFERRED_TIME_HINT =
  'Inferred: the source records no time for this message. The time shown is borrowed from the nearest message before it that has one, else the nearest after it, else from the conversation itself, so that the message can be put in order.';

/**
 * The time of a message or turn. A time the source does not record, which the import
 * borrowed from a neighbour, is drawn like an estimate: lighter, with the dashed circle
 * of estimated figures, and a tooltip and screen reader text that say it is inferred.
 */
export function MessageTime({ at, inferred, timezone, hint = INFERRED_TIME_HINT }: { at: string | null; inferred: boolean; timezone: string; hint?: string }) {
  const shown = formatInstant(at, timezone, 'datetime');
  if (!inferred) return <>{shown}</>;
  return (
    <span title={hint} data-inferred="" className="inline-flex items-center gap-1 text-ink-3">
      <CircleDashed className="size-3.5 shrink-0 text-warning" strokeWidth={2.25} aria-hidden="true" />
      {shown}
      <span className="sr-only">, inferred: the source records no time</span>
    </span>
  );
}
