import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        <h1 className="text-[22px] font-medium leading-tight tracking-[-0.01em] text-ink">{title}</h1>
        {description ? <p className="mt-1.5 max-w-[72ch] text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
