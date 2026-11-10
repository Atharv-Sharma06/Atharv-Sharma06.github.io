import { formatInt, formatTokens } from '@/lib/format';

/** The exact and the estimated part of a token total, with the swatches the charts use for them. */
export function ExactEstimated({ exact, estimated }: { exact: number; estimated: number }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1">
      <div className="flex items-baseline gap-1.5">
        <dt className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-accent" aria-hidden="true" />
          Exact
        </dt>
        <dd className="tabular text-ink" title={`${formatInt(exact)} tokens`}>
          {formatTokens(exact)}
        </dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="inline-flex items-center gap-1.5">
          <span className="hatch-estimated size-2.5 rounded-[3px] bg-accent/45" aria-hidden="true" />
          Estimated
        </dt>
        <dd className="tabular text-ink" title={`${formatInt(estimated)} tokens`}>
          {formatTokens(estimated)}
        </dd>
      </div>
    </dl>
  );
}
