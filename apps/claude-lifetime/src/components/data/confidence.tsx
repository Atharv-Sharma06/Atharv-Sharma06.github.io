'use client';

import { CircleCheck, CircleDashed, CircleSlash } from 'lucide-react';
import { Tooltip } from '@/components/ui/overlay';
import { cn } from '@/lib/cn';

/**
 * Every figure in the app carries one of three confidence levels.
 *
 *  exact        reported by a source that meters tokens (Claude Code transcripts,
 *               Anthropic usage reports)
 *  estimated    reconstructed from text with a tokenizer model (claude.ai exports),
 *               or a total that includes such a part
 *  unavailable  no source holds the information; nothing is shown in its place
 *
 * The level is always written out next to an icon; colour is never the only signal.
 */
export type ConfidenceLevel = 'exact' | 'estimated' | 'unavailable';

export function confidenceOf(exact: number, estimated: number): ConfidenceLevel {
  if (estimated > 0) return 'estimated';
  if (exact > 0) return 'exact';
  return 'unavailable';
}

const META: Record<ConfidenceLevel, { label: string; icon: typeof CircleCheck; tone: string; help: string }> = {
  exact: {
    label: 'Exact',
    icon: CircleCheck,
    tone: 'text-good',
    help: 'Token counts reported by a source that meters them, such as Claude Code transcripts or an Anthropic usage report.',
  },
  estimated: {
    label: 'Estimated',
    icon: CircleDashed,
    tone: 'text-warning',
    help: 'Reconstructed from the text of your conversations with a tokenizer model, or a total that includes such a part. The real figure can differ.',
  },
  unavailable: {
    label: 'Unavailable',
    icon: CircleSlash,
    tone: 'text-ink-3',
    help: 'None of your imported sources holds this information, so no number is shown.',
  },
};

export function ConfidenceBadge({ level, label, className, hint }: { level: ConfidenceLevel; label?: string; className?: string; hint?: string }) {
  const meta = META[level];
  const Icon = meta.icon;
  return (
    <Tooltip content={hint ?? meta.help}>
      <span
        tabIndex={0}
        className={cn(
          'inline-flex h-[22px] shrink-0 cursor-default items-center gap-1 rounded-full border border-line bg-raised pl-1.5 pr-2 text-xs text-ink-2',
          className,
        )}
      >
        <Icon className={cn('size-3.5', meta.tone)} strokeWidth={2.25} aria-hidden="true" />
        {label ?? meta.label}
      </span>
    </Tooltip>
  );
}

/** Small swatches that explain the exact / estimated encoding used by charts. */
export function ConfidenceLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2', className)}>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-accent" aria-hidden="true" />
        Exact
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="hatch-estimated size-2.5 rounded-[3px] bg-accent/45" aria-hidden="true" />
        Estimated
      </span>
    </div>
  );
}
