'use client';

import { useId, useMemo, useState, type PointerEvent } from 'react';
import type { TokenBasis } from '@/analytics/base';
import type { ModelUsage } from '@/analytics/models';
import { Swatch } from '@/components/charts/series-chart';
import { ConfidenceBadge, ConfidenceLegend, confidenceOf } from '@/components/data/confidence';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatInt, formatShare, formatTokens, plural } from '@/lib/format';
import { familySlices, ringArcs, type Arc, type FamilyKey, type FamilySlice } from './families';

/**
 * Share of tokens by model family: a thin ring with the total in its centre, and a
 * legend that carries every figure as text. Within a family the estimated part keeps
 * the family's hue, lighter and hatched, as everywhere else in the app. Usage with no
 * recorded model is its own neutral slice and is never folded into a real family.
 */
const SIZE = 220;
const CENTER = SIZE / 2;
const OUTER = 106;
const THICKNESS = 22;
const INNER = OUTER - THICKNESS;
const MIDDLE = (OUTER + INNER) / 2;
/** Two pixels of surface between neighbours, and at least three pixels for the smallest slice. */
const GAP = 2 / MIDDLE;
const MINIMUM = 3 / MIDDLE;
const TURN = Math.PI * 2;

const point = (radius: number, angle: number) => `${(CENTER + radius * Math.sin(angle)).toFixed(3)} ${(CENTER - radius * Math.cos(angle)).toFixed(3)}`;

/** A segment of the ring between two angles, clockwise from twelve o'clock. */
function segmentPath(start: number, end: number): string {
  // An arc cannot start and end on the same point, so a full ring is drawn as two halves.
  if (end - start > TURN - 1e-6) return `${segmentPath(start, start + Math.PI)} ${segmentPath(start + Math.PI, start + TURN)}`;
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${point(OUTER, start)} A ${OUTER} ${OUTER} 0 ${large} 1 ${point(OUTER, end)} L ${point(INNER, end)} A ${INNER} ${INNER} 0 ${large} 0 ${point(INNER, start)} Z`;
}

interface Tip {
  family: FamilyKey;
  /** Position inside the ring's box, in pixels. */
  x: number;
  y: number;
}

function SliceTooltip({ slice, tip }: { slice: FamilySlice; tip: Tip }) {
  const below = tip.y < 96;
  // Kept inside the width of the ring so it can never leave the card or the screen.
  const x = Math.min(Math.max(tip.x, 92), SIZE - 92);
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-[11.5rem] rounded-[10px] border border-line-strong bg-raised px-3 py-2.5 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.5)]"
      style={{ left: x, top: tip.y, transform: below ? 'translate(-50%, 14px)' : 'translate(-50%, calc(-100% - 14px))' }}
    >
      <p className="flex items-center gap-1.5 font-medium text-ink">
        <Swatch series={{ color: slice.color, estimated: slice.exact === 0 }} />
        {slice.label}
      </p>
      <dl className="mt-1.5 space-y-1 text-ink-2">
        <div className="flex justify-between gap-4">
          <dt>Tokens</dt>
          <dd className="tabular text-ink">{formatTokens(slice.tokens)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>Share</dt>
          <dd className="tabular text-ink">{formatShare(slice.share)}</dd>
        </div>
        {slice.estimated > 0 ? (
          <div className="flex justify-between gap-4">
            <dt>Of it estimated</dt>
            <dd className="tabular text-ink">{slice.exact === 0 ? 'all' : formatTokens(slice.estimated)}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function sliceNote(slice: FamilySlice): string {
  const estimated = slice.estimated === 0 ? null : slice.exact === 0 ? 'estimated' : `${formatTokens(slice.estimated)} of it estimated`;
  const what = slice.family === 'unknown' ? 'The source names no model' : plural(slice.models, 'model');
  return estimated ? `${what}, ${estimated}` : what;
}

export function FamilyDonutCard({ rows, basis, rangeLabel, scoped }: { rows: ModelUsage[]; basis: TokenBasis; rangeLabel: string; scoped: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const breakdown = useMemo(() => familySlices(rows), [rows]);
  const arcs = useMemo<Arc[]>(() => ringArcs(breakdown.slices.map((s) => s.tokens), GAP, MINIMUM), [breakdown]);
  const [tip, setTip] = useState<Tip | null>(null);
  const [highlighted, setHighlighted] = useState<FamilyKey | null>(null);
  const active = tip?.family ?? highlighted;
  const level = confidenceOf(breakdown.exact, breakdown.estimated);
  const unit = basis === 'processed' ? 'processed tokens' : 'new tokens';
  const anyEstimated = breakdown.estimated > 0;

  const followPointer = (family: FamilyKey) => (event: PointerEvent<SVGGElement>) => {
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (box) setTip({ family, x: event.clientX - box.left, y: event.clientY - box.top });
  };
  // With the keyboard there is no pointer: the tooltip sits on the middle of the slice.
  const atSlice = (family: FamilyKey, arc: Arc) => () => {
    const angle = (arc.start + arc.end) / 2;
    setTip({ family, x: CENTER + MIDDLE * Math.sin(angle), y: CENTER - MIDDLE * Math.cos(angle) });
  };
  const tipSlice = tip ? breakdown.slices.find((s) => s.family === tip.family) : undefined;

  return (
    <Card>
      <CardHeader
        title="Share of tokens by model family"
        description={`${basis === 'processed' ? 'Processed' : 'New'} tokens${scoped ? `, ${rangeLabel}` : ', all time'}, grouped by the family of the model that the source names.`}
      />
      <CardBody className="grid items-center gap-x-12 gap-y-6 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="mx-auto">
          <div className="relative" style={{ width: SIZE, height: SIZE }}>
            <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="group" aria-label={`Share of ${unit} by model family. The legend lists every figure.`}>
              <defs>
                {breakdown.slices.map((s) =>
                  s.estimated > 0 ? (
                    <pattern key={s.family} id={`ring-hatch-${uid}-${s.family}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                      <rect width="6" height="6" fill={s.color} opacity={0.42} />
                      <rect width="1.5" height="6" fill={s.color} opacity={0.95} />
                    </pattern>
                  ) : null,
                )}
              </defs>
              {breakdown.slices.map((s, i) => {
                const arc = arcs[i];
                const split = arc.start + (arc.end - arc.start) * (s.tokens > 0 ? s.exact / s.tokens : 0);
                return (
                  <g
                    key={s.family}
                    tabIndex={0}
                    role="img"
                    aria-label={`${s.label}: ${formatInt(s.tokens)} tokens, ${formatShare(s.share)}${s.estimated > 0 ? (s.exact === 0 ? ', estimated' : `, ${formatInt(s.estimated)} of it estimated`) : ''}`}
                    className={cn('cursor-default transition-opacity duration-100', active !== null && active !== s.family && 'opacity-35')}
                    onPointerMove={followPointer(s.family)}
                    onPointerLeave={() => setTip(null)}
                    onFocus={atSlice(s.family, arc)}
                    onBlur={() => setTip(null)}
                  >
                    {s.exact > 0 ? <path d={segmentPath(arc.start, split)} fill={s.color} /> : null}
                    {s.estimated > 0 ? <path d={segmentPath(split, arc.end)} fill={`url(#ring-hatch-${uid}-${s.family})`} /> : null}
                    {/* A wider, invisible band: thin slices stay easy to point at. */}
                    <path d={segmentPath(arc.start - GAP / 2, arc.end + GAP / 2)} fill="transparent" stroke="transparent" strokeWidth={10} />
                  </g>
                );
              })}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <p className="text-[28px] font-medium leading-none tracking-[-0.02em] text-ink" title={`${formatInt(breakdown.total)} tokens`}>
                {formatTokens(breakdown.total)}
              </p>
              <p className="mt-1.5 text-xs text-ink-2">{unit}</p>
              <ConfidenceBadge
                level={level}
                className="pointer-events-auto mt-2.5"
                hint={level === 'estimated' ? 'This total includes tokens reconstructed from conversation text. Hatched parts of the ring are estimated.' : undefined}
              />
            </div>
            {tip && tipSlice ? <SliceTooltip slice={tipSlice} tip={tip} /> : null}
          </div>
          {anyEstimated ? <ConfidenceLegend className="mt-4 justify-center" /> : null}
        </div>

        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Tokens and share of the total for each model family</caption>
          <thead className="text-left text-xs text-ink-3">
            <tr>
              <th scope="col" className="pb-2 pr-3 font-normal">
                Family
              </th>
              <th scope="col" className="px-3 pb-2 text-right font-normal">
                Tokens
              </th>
              <th scope="col" className="pb-2 pl-3 text-right font-normal">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {breakdown.slices.map((s) => (
              <tr
                key={s.family}
                className={cn('border-t border-line transition-opacity duration-100', active !== null && active !== s.family && 'opacity-50')}
                onPointerEnter={() => setHighlighted(s.family)}
                onPointerLeave={() => setHighlighted(null)}
              >
                <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                  <span className="flex items-center gap-2 text-ink">
                    <Swatch series={{ color: s.color, estimated: s.exact === 0 }} />
                    {s.label}
                  </span>
                  <span className="mt-0.5 block pl-[18px] text-xs text-ink-3">{sliceNote(s)}</span>
                </th>
                <td className="tabular px-3 py-2.5 text-right align-top text-ink" title={`${formatInt(s.tokens)} tokens`}>
                  {formatTokens(s.tokens)}
                </td>
                <td className="tabular py-2.5 pl-3 text-right align-top text-ink">{formatShare(s.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}
