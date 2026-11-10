'use client';

import { Info, X } from 'lucide-react';
import { Dialog as RDialog, Popover as RPopover, Tooltip as RTooltip } from 'radix-ui';
import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  // The dialog is opened by state, not by a Radix trigger, so Radix does not know where focus came
  // from. Remember the element that had it and hand it back on close, as a trigger would.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 animate-[fade-in_120ms_ease-out] bg-black/60 backdrop-blur-[2px]" />
        <RDialog.Content
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected) {
              event.preventDefault();
              opener.current.focus();
            }
            opener.current = null;
          }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[min(88dvh,46rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'animate-[fade-in_140ms_ease-out] rounded-[var(--radius-card)] border border-line-strong bg-surface shadow-[0_24px_80px_rgb(0_0_0/0.6)]',
            size === 'lg' ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="min-w-0 pl-5 pr-12 pt-4">
            <RDialog.Title className="text-[15px] font-medium text-ink">{title}</RDialog.Title>
            {description ? <RDialog.Description className="mt-1 text-[13px] text-ink-2">{description}</RDialog.Description> : null}
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
          {/* Last in the document on purpose: focus starts on the first field or action of the content, not on "Close". */}
          <RDialog.Close className="absolute right-3.5 top-3 rounded-md p-1.5 text-ink-3 hover:bg-raised hover:text-ink" aria-label="Close">
            <X className="size-4" aria-hidden="true" />
          </RDialog.Close>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Popover({
  trigger,
  children,
  align = 'start',
  className,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className={cn(
            'z-50 w-[min(22rem,calc(100vw-1.5rem))] animate-[pop-in_120ms_ease-out] rounded-[12px] border border-line-strong bg-raised p-3 text-[13px] text-ink-2 shadow-[0_16px_48px_rgb(0_0_0/0.5)]',
            className,
          )}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export const PopoverClose = RPopover.Close;

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    // Tooltips here never hold interactive content, so the pointer need not be able to travel into
    // one. Leaving that on would suppress the tooltip of a neighbouring trigger on the way there.
    <RTooltip.Provider delayDuration={250} skipDelayDuration={150} disableHoverableContent>
      {children}
    </RTooltip.Provider>
  );
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-[18rem] animate-[fade-in_100ms_ease-out] rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-ink shadow-lg"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/** A small "i" that explains the figure or control next to it. Opens on click, so it works with touch and keyboard. */
export function InfoTip({ label = 'More information', children, align = 'center' }: { label?: string; children: ReactNode; align?: 'start' | 'center' | 'end' }) {
  return (
    <Popover
      align={align}
      trigger={
        <button type="button" aria-label={label} className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-raised hover:text-ink">
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      }
    >
      <div className="space-y-2">{children}</div>
    </Popover>
  );
}
