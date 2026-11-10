'use client';

import { Check, ChevronDown } from 'lucide-react';
import { Select as RSelect, Switch as RSwitch, ToggleGroup } from 'radix-ui';
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A small set of mutually exclusive choices, shown side by side. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  /** Accessible name of the group. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={label}
      className={cn('inline-flex rounded-[var(--radius-control)] border border-line bg-surface p-0.5', className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          title={o.title}
          className={cn(
            'rounded-[6px] text-ink-2 transition-colors hover:text-ink data-[state=on]:bg-hover data-[state=on]:text-ink',
            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]',
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  placeholder,
  className,
}: {
  value: T | undefined;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RSelect.Trigger
        aria-label={label}
        className={cn(
          'inline-flex h-9 min-w-0 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm text-ink',
          'hover:border-line-strong data-[placeholder]:text-ink-3',
          className,
        )}
      >
        <span className="truncate">
          <RSelect.Value placeholder={placeholder} />
        </span>
        <RSelect.Icon>
          <ChevronDown className="size-4 text-ink-3" aria-hidden="true" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[10px] border border-line-strong bg-raised shadow-[0_16px_48px_rgb(0_0_0/0.5)]"
        >
          <RSelect.Viewport className="scrollbar-thin p-1">
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-8 pr-3 text-sm text-ink outline-none data-[highlighted]:bg-hover"
              >
                <RSelect.ItemIndicator className="absolute left-2">
                  <Check className="size-4" strokeWidth={2.5} aria-hidden="true" />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                {o.hint ? <span className="ml-auto pl-4 text-xs text-ink-3">{o.hint}</span> : null}
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-3',
        'hover:border-line-strong focus:border-accent focus:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-[13px] text-ink-2">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="text-[13px] text-critical">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-ink-3">{hint}</span>
      ) : null}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-5 w-9 shrink-0 rounded-full bg-hover transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-ink transition-transform data-[state=checked]:translate-x-[18px]" />
    </RSwitch.Root>
  );
}
