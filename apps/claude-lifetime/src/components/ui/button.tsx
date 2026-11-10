import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './feedback';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-[#0c0b14] hover:bg-accent-soft font-medium',
  secondary: 'bg-raised text-ink border border-line hover:border-line-strong hover:bg-hover',
  ghost: 'text-ink-2 hover:text-ink hover:bg-raised',
  danger: 'bg-transparent text-critical border border-critical/40 hover:bg-critical/10',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export const buttonClass = (variant: Variant = 'secondary', size: Size = 'md', className?: string) =>
  cn(
    'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] transition-colors',
    'disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className,
  );

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, className, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)} {...props}>
      {loading ? <Spinner className="size-3.5" /> : null}
      {children}
    </button>
  );
});
