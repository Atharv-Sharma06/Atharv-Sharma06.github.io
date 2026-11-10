import { MessageSquare, SquareTerminal } from 'lucide-react';
import type { ConversationKind } from '@/core/types';
import { cn } from '@/lib/cn';

/** What a conversation is, in the user's words. */
export function kindLabel(kind: ConversationKind): string {
  return kind === 'code_session' ? 'Claude Code session' : kind === 'chat' ? 'Chat' : 'Usage record';
}

export function KindIcon({ kind, className }: { kind: ConversationKind; className?: string }) {
  const Icon = kind === 'code_session' ? SquareTerminal : MessageSquare;
  return (
    <span title={kindLabel(kind)} className="inline-flex shrink-0">
      <Icon className={cn('size-4 text-ink-3', className)} aria-hidden="true" />
      <span className="sr-only">{kindLabel(kind)}</span>
    </span>
  );
}

/**
 * Claude Code names a project by its folder path. The end of a path tells projects
 * apart, so a long label keeps its end; the full label stays in the tooltip.
 */
export function shortProject(label: string, max = 28): string {
  return label.length <= max ? label : `…${label.slice(label.length - max + 1)}`;
}

export const UNTITLED = 'Untitled conversation';
