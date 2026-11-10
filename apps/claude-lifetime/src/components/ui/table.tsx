'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Table primitives. Wide tables scroll inside their own frame so the page itself
 * never scrolls sideways; figures are right-aligned with tabular digits.
 */
export function TableFrame({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('scrollbar-thin overflow-x-auto rounded-[var(--radius-control)] border border-line', className)} {...props}>
      {children}
    </div>
  );
}

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-[13px]', className)} {...props} />;
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-raised text-left text-xs text-ink-2', className)} {...props} />;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-t border-line', className)} {...props} />;
}

export type SortDirection = 'asc' | 'desc';

export function Th({
  children,
  align = 'left',
  sort,
  onSort,
  className,
  ...props
}: Omit<ThHTMLAttributes<HTMLTableCellElement>, 'align'> & {
  align?: 'left' | 'right';
  /** Current direction when this column is the sorted one, `null` when it is sortable but not active. Omit for unsortable columns. */
  sort?: SortDirection | null;
  onSort?: () => void;
  children?: ReactNode;
}) {
  const sortable = sort !== undefined && onSort;
  const Icon = sort === 'asc' ? ArrowUp : sort === 'desc' ? ArrowDown : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}
      className={cn('whitespace-nowrap px-3 py-2 font-medium', align === 'right' && 'text-right', className)}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn('inline-flex items-center gap-1 rounded hover:text-ink', align === 'right' && 'flex-row-reverse', sort && 'text-ink')}
        >
          {children}
          <Icon className={cn('size-3.5', sort ? 'text-accent-soft' : 'text-ink-3')} aria-hidden="true" />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({
  align = 'left',
  numeric = false,
  className,
  ...props
}: Omit<TdHTMLAttributes<HTMLTableCellElement>, 'align'> & { align?: 'left' | 'right'; numeric?: boolean }) {
  return <td className={cn('px-3 py-2 text-ink', (align === 'right' || numeric) && 'text-right', numeric && 'tabular', className)} {...props} />;
}
