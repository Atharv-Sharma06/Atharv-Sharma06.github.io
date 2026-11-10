'use client';

import { Check } from 'lucide-react';
import { Checkbox as RCheckbox, RadioGroup } from 'radix-ui';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { outcomeUnknown } from '@/db/driver';

/** Space the sticky top bar and the section list take, so an anchor target is not hidden under them. */
const ANCHOR_OFFSET = 'scroll-mt-28';

export function SettingsSection({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={ANCHOR_OFFSET}>
      <div className="mb-3.5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-[17px] font-medium tracking-[-0.01em] text-ink">
            {title}
          </h2>
          {description ? <div className="mt-1 max-w-[76ch] space-y-1.5 text-[13px] text-ink-2">{description}</div> : null}
        </div>
        {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** One setting: what it is and what it changes on the left, the control on the right. */
export function SettingRow({ id, title, description, children }: { id: string; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <div id={id} className={cn('grid gap-x-10 gap-y-3.5 px-5 py-5 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]', ANCHOR_OFFSET)}>
      <div className="min-w-0">
        <h3 id={`${id}-label`} className="text-sm font-medium text-ink">
          {title}
        </h3>
        <div className="mt-1 space-y-2 text-[13px] text-ink-2">{description}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ── Focus ───────────────────────────────────────────────────────────────────────

/**
 * Gives keyboard focus back to the control that opened a dialog which is only rendered
 * while it is open. Such a dialog is removed rather than closed, so it cannot hand focus
 * back itself, and the focus trap it leaves behind puts focus on the page body. Call the
 * returned function just before opening; focus returns once `open` is false again. The
 * timer runs after the one the focus trap sets when it is removed, so it has the last word.
 */
export function useFocusReturn(open: boolean): () => void {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open || opener.current === null) return;
    const element = opener.current;
    opener.current = null;
    const timer = window.setTimeout(() => {
      if (element.isConnected) element.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);
  return useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
}

// ── Saving ──────────────────────────────────────────────────────────────────────

export type SaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'error'; message: string };

/**
 * Tracks one control that saves as soon as it changes. Only the latest change reports
 * back, and "Saved" steps aside again after a moment.
 */
export function useSaveState() {
  const [state, setState] = useState<SaveState>({ status: 'idle' });
  const latest = useRef(0);

  useEffect(() => {
    if (state.status !== 'saved') return;
    const timer = window.setTimeout(() => setState((s) => (s.status === 'saved' ? { status: 'idle' } : s)), 2600);
    return () => window.clearTimeout(timer);
  }, [state]);

  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    const ticket = ++latest.current;
    setState({ status: 'saving' });
    try {
      await action();
      if (latest.current === ticket) setState({ status: 'saved' });
      return true;
    } catch (error) {
      if (latest.current === ticket) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    latest.current++;
    setState({ status: 'idle' });
  }, []);

  /** For a change that was saved from a dialog, which reports its own failures. */
  const markSaved = useCallback(() => {
    latest.current++;
    setState({ status: 'saved' });
  }, []);

  return { state, run, reset, markSaved };
}

/** The quiet confirmation next to a control. Errors are shown separately, where the user can act on them. */
export function SaveNote({
  state,
  savedText = 'Saved',
  compact = false,
  className,
}: {
  state: SaveState;
  savedText?: string;
  /** On narrow screens only the mark is shown, for places with no room for the word. */
  compact?: boolean;
  className?: string;
}) {
  const word = compact ? 'max-sm:sr-only' : undefined;
  return (
    <span aria-live="polite" className={cn('inline-flex min-h-5 shrink-0 items-center gap-1.5 text-[13px] font-normal', className)}>
      {state.status === 'saving' ? (
        // Most saves finish before anyone could read "Saving"; it only appears when one takes a while.
        <span className="inline-flex animate-[fade-in_150ms_ease-out_350ms_both] items-center gap-1.5 text-ink-3">
          <Spinner className="size-3.5" />
          <span className={word}>Saving…</span>
        </span>
      ) : null}
      {state.status === 'saved' ? (
        <span className="inline-flex animate-[fade-in_150ms_ease-out] items-center gap-1 text-ink-2">
          <Check className="size-3.5 text-good" strokeWidth={2.5} aria-hidden="true" />
          <span className={word}>{savedText}</span>
        </span>
      ) : null}
    </span>
  );
}

export function SaveError({ state, prefix = 'This could not be saved.', className }: { state: SaveState; prefix?: string; className?: string }) {
  if (state.status !== 'error') return null;
  return (
    <p role="alert" className={cn('text-[13px] text-critical', className)}>
      {outcomeUnknown(state.message) ? 'This may not have been saved.' : prefix} {state.message}
    </p>
  );
}

// ── Controls the shared kit does not have ───────────────────────────────────────

/** Two or three mutually exclusive choices that each need a sentence of explanation. */
export function ChoiceCards<T extends string>({
  value,
  onChange,
  options,
  labelledBy,
  state,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; title: string; description: ReactNode }>;
  /** id of the element that names the group. */
  labelledBy: string;
  /** Shown in the corner of the chosen card, where the user has just clicked. */
  state?: SaveState;
}) {
  const base = useId();
  return (
    <RadioGroup.Root value={value} onValueChange={(v) => onChange(v as T)} aria-labelledby={labelledBy} className="grid gap-2.5 sm:grid-cols-2">
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          aria-labelledby={`${base}-${option.value}-title`}
          aria-describedby={`${base}-${option.value}-text`}
          className={cn(
            'group flex items-start gap-3 rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 text-left transition-colors',
            'hover:border-line-strong data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent-wash',
          )}
        >
          <span
            aria-hidden="true"
            className="mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong group-data-[state=checked]:border-accent"
          >
            <span className="size-2 rounded-full bg-accent opacity-0 group-data-[state=checked]:opacity-100" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-start justify-between gap-3">
              <span id={`${base}-${option.value}-title`} className="min-w-0 text-sm font-medium text-ink">
                {option.title}
              </span>
              {state && option.value === value ? <SaveNote state={state} compact /> : null}
            </span>
            <span id={`${base}-${option.value}-text`} className="mt-0.5 block text-[13px] text-ink-2">
              {option.description}
            </span>
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

export function CheckboxRow({
  checked,
  onChange,
  children,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <RCheckbox.Root
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        disabled={disabled}
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface transition-colors',
          'hover:border-ink-3 data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        <RCheckbox.Indicator>
          <Check className="size-3 text-[#0c0b14]" strokeWidth={3.5} aria-hidden="true" />
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      <label htmlFor={id} className={cn('min-w-0 text-sm text-ink', disabled && 'text-ink-3')}>
        {children}
        {hint ? <span className="block text-[13px] text-ink-2">{hint}</span> : null}
      </label>
    </div>
  );
}

/** A small label for a state that is worth a glance: synthetic, left out, entered by the user. */
export function Tag({ children, icon, className }: { children: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-2 text-xs text-ink-2', className)}>
      {icon}
      {children}
    </span>
  );
}
