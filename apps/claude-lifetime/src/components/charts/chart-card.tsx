'use client';

import { ChartColumn, Table } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Segmented } from '@/components/ui/controls';

export type ChartView = 'chart' | 'table';

/**
 * Frame shared by every chart: a title that says what is plotted, the controls that
 * change it, and a switch to the same numbers as a table.
 */
export function ChartCard({
  title,
  description,
  controls,
  legend,
  children,
  footer,
  id,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Filters and mode switches, shown in one row above the plot. */
  controls?: ReactNode;
  legend?: ReactNode;
  children: (view: ChartView) => ReactNode;
  footer?: ReactNode;
  id?: string;
  className?: string;
}) {
  const [view, setView] = useState<ChartView>('chart');
  return (
    <Card id={id} className={className}>
      <CardHeader
        title={title}
        description={description}
        action={
          <Segmented
            label="View"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              {
                value: 'chart',
                title: 'Chart',
                label: (
                  <span className="inline-flex items-center gap-1">
                    <ChartColumn className="size-3.5" aria-hidden="true" />
                    Chart
                  </span>
                ),
              },
              {
                value: 'table',
                title: 'Table',
                label: (
                  <span className="inline-flex items-center gap-1">
                    <Table className="size-3.5" aria-hidden="true" />
                    Table
                  </span>
                ),
              },
            ]}
          />
        }
      />
      <CardBody>
        {controls ? <div className="mb-4 flex flex-wrap items-center gap-2">{controls}</div> : null}
        {legend && view === 'chart' ? <div className="mb-3">{legend}</div> : null}
        {children(view)}
        {footer ? <div className="mt-4 text-[13px] text-ink-2">{footer}</div> : null}
      </CardBody>
    </Card>
  );
}
