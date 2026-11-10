'use client';

import { CircleCheck, CircleSlash, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConfidenceBadge } from '@/components/data/confidence';
import { cn } from '@/lib/cn';
import { formatBytes, formatInstant, formatInt, formatShare, formatTokens, plural } from '@/lib/format';
import type { ImportPreview } from '@/import/commit';
import { FORMATS } from '@/import/formats';
import type { PreparedImport } from '@/import/session';

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warning'; children: ReactNode }) {
  const Icon = tone === 'warning' ? TriangleAlert : Info;
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-[var(--radius-control)] border px-3.5 py-2.5 text-[13px]',
        tone === 'warning' ? 'border-warning/35 bg-warning/[0.07]' : 'border-line bg-raised',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'warning' ? 'text-warning' : 'text-ink-3')} aria-hidden="true" />
      <div className="min-w-0 text-ink-2">{children}</div>
    </div>
  );
}

function Count({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-line px-3.5 py-3">
      <dt className="text-xs text-ink-2">{label}</dt>
      <dd className="tabular mt-1 text-xl font-medium leading-none text-ink">{value}</dd>
      {detail ? <p className="mt-1.5 text-xs text-ink-3">{detail}</p> : null}
    </div>
  );
}

function Fact({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? CircleCheck : CircleSlash;
  return (
    <li className="flex items-start gap-2">
      <Icon className={cn('mt-0.5 size-4 shrink-0', ok ? 'text-good' : 'text-ink-3')} strokeWidth={2.25} aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

function notices(p: ImportPreview, timezone: string): ReactNode[] {
  const out: ReactNode[] = [];
  if (p.nothingNew) {
    out.push(
      <Notice key="nothing" tone="warning">
        <strong className="font-medium text-ink">Everything in this file is already imported.</strong> Saving it would add nothing, so there is nothing to
        confirm.
      </Notice>,
    );
  } else if (p.previousImport) {
    out.push(
      <Notice key="previous">
        This exact file was imported before, on {formatInstant(p.previousImport.importedAt, timezone, 'datetime')}. Records that are already stored are
        skipped; only what is new will be added.
      </Notice>,
    );
  }
  if (p.replaced && (p.replaced.usageRows > 0 || p.replaced.costRows > 0)) {
    out.push(
      <Notice key="replaced">
        This report restates a period that is already stored. {plural(p.replaced.usageRows + p.replaced.costRows, 'existing row')} for the same period
        will be replaced by the rows in this file, not added to them.
      </Notice>,
    );
  }
  if (p.willRemoveDemoData) {
    out.push(
      <Notice key="demo" tone="warning">
        Saving this import removes the synthetic demo data. Real and invented figures are never mixed.
      </Notice>,
    );
  }
  return out;
}

/** Step 3 to 6 of an import: what was found, what is new, what is missing, before anything is saved. */
export function ImportPreviewView({ prepared, timezone }: { prepared: PreparedImport; timezone: string }) {
  const p = prepared.preview;
  const info = FORMATS[prepared.detected.parser];
  const tokens = p.tokens.exact + p.tokens.estimated;
  // Model and token counts have their own lines below; this list is for everything else a format lacks.
  const otherMissing = p.missingFields.filter((f) => f !== 'model' && f !== 'token counts');
  const range =
    p.dateRange.start && p.dateRange.end ? `${formatInstant(p.dateRange.start, timezone)} – ${formatInstant(p.dateRange.end, timezone)}` : 'No dated records';

  return (
    <div className="space-y-5">
      <div>
        <p className="text-ink">
          <span className="font-medium">{p.fileName}</span>
          {p.fileSize > 0 ? <span className="text-ink-3"> ({formatBytes(p.fileSize)})</span> : null}
        </p>
        <p className="mt-0.5 text-[13px] text-ink-2">
          Recognised as {info.label}: {prepared.detected.recognisedAs}. Will be stored under the source “{p.source.label}”.
        </p>
      </div>

      {notices(p, timezone).length > 0 ? <div className="space-y-2">{notices(p, timezone)}</div> : null}

      <section aria-label="What this import adds">
        <h3 className="text-sm font-medium text-ink">What saving will add</h3>
        <dl className="mt-2.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {p.conversations.total > 0 ? (
            <Count
              label="Conversations"
              value={formatInt(p.conversations.new)}
              detail={p.conversations.existing > 0 ? `${formatInt(p.conversations.existing)} more are already stored and will be updated` : 'all new'}
            />
          ) : null}
          {p.messages.total > 0 ? (
            <Count
              label="Messages"
              value={formatInt(p.messages.new)}
              detail={p.messages.duplicate > 0 ? `${formatInt(p.messages.duplicate)} duplicates skipped` : 'no duplicates'}
            />
          ) : null}
          {p.requests ? (
            <Count
              label="Model requests"
              value={formatInt(p.requests.new)}
              detail={p.requests.duplicate > 0 ? `${formatInt(p.requests.duplicate)} already counted and skipped` : 'none counted before'}
            />
          ) : p.usageRows.total > 0 ? (
            <Count
              label="Usage rows"
              value={formatInt(p.usageRows.new)}
              detail={p.usageRows.duplicate > 0 ? `${formatInt(p.usageRows.duplicate)} duplicates skipped` : 'no duplicates'}
            />
          ) : null}
          {p.costRows.total > 0 ? (
            <Count
              label="Cost rows"
              value={formatInt(p.costRows.new)}
              detail={p.costRows.duplicate > 0 ? `${formatInt(p.costRows.duplicate)} duplicates skipped` : 'actual billed amounts'}
            />
          ) : null}
          <div className="rounded-[var(--radius-control)] border border-line px-3.5 py-3">
            <dt className="flex items-center justify-between gap-2 text-xs text-ink-2">
              Tokens
              {tokens > 0 ? <ConfidenceBadge level={p.tokens.estimated > 0 ? 'estimated' : 'exact'} /> : null}
            </dt>
            <dd className="tabular mt-1 text-xl font-medium leading-none text-ink" title={`${formatInt(tokens)} tokens`}>
              {tokens > 0 ? formatTokens(tokens) : '–'}
            </dd>
            <p className="mt-1.5 text-xs text-ink-3">
              {tokens === 0
                ? 'this file carries no token counts'
                : p.tokens.exact > 0 && p.tokens.estimated > 0
                  ? `${formatTokens(p.tokens.exact)} exact, ${formatTokens(p.tokens.estimated)} estimated`
                  : p.tokens.estimated > 0
                    ? 'reconstructed from message text'
                    : 'metered by the source'}
            </p>
          </div>
          <Count label="Covers" value={p.dateRange.start ? formatInstant(p.dateRange.start, timezone) : '–'} detail={range} />
        </dl>
      </section>

      <section aria-label="What this file can tell">
        <h3 className="text-sm font-medium text-ink">What this file can and cannot tell</h3>
        <ul className="mt-2.5 space-y-1.5 text-[13px] text-ink-2">
          <Fact ok={p.coverage.hasExactUsage}>
            {p.coverage.hasExactUsage
              ? 'Token counts are metered by the source: these figures are exact.'
              : 'No token counts in the file. Tokens are estimated from the text and labelled as estimates everywhere.'}
          </Fact>
          <Fact ok={p.coverage.hasModel}>
            {p.coverage.hasModel
              ? p.coverage.modelShare !== null && p.coverage.modelShare < 1
                ? `The model is named for ${formatShare(p.coverage.modelShare)} of the new records${p.models.length ? ` (${p.models.slice(0, 4).join(', ')}${p.models.length > 4 ? ', and more' : ''})` : ''}. The rest stay “Unknown model”.`
                : `Every record names its model${p.models.length ? ` (${p.models.slice(0, 5).join(', ')}${p.models.length > 5 ? ', and more' : ''})` : ''}.`
              : 'The model is not recorded. These records appear as “Unknown model”; no model is guessed and they are not priced.'}
          </Fact>
          <Fact ok={p.coverage.hasTimestamps}>
            {p.coverage.hasTimestamps
              ? p.messages.withoutTimestamp > 0
                ? `Records are dated, except ${plural(p.messages.withoutTimestamp, 'message')} whose time was taken from a neighbouring message.`
                : 'Every record is dated.'
              : 'Records carry no usable dates.'}
          </Fact>
          {otherMissing.length > 0 ? <Fact ok={false}>Not part of this file: {otherMissing.join(', ')}.</Fact> : null}
          {p.recordsSkipped > 0 ? (
            <Fact ok={false}>
              {plural(p.recordsSkipped, 'record')} of {formatInt(p.recordsSeen)} could not be used and {p.recordsSkipped === 1 ? 'was' : 'were'} skipped.
              See the notes below.
            </Fact>
          ) : null}
        </ul>
        <p className="mt-2 text-xs text-ink-3">{info.reads}</p>
      </section>

      {p.warnings.length > 0 ? (
        <section aria-label="Notes from reading the file">
          <h3 className="text-sm font-medium text-ink">Notes from reading the file</h3>
          <ul className="mt-2.5 divide-y divide-line rounded-[var(--radius-control)] border border-line text-[13px]">
            {p.warnings.map((w) => (
              <li key={w.code} className="flex items-start gap-3 px-3.5 py-2.5">
                <span className="tabular mt-px min-w-[2.5rem] shrink-0 rounded bg-raised px-1.5 py-0.5 text-center text-xs text-ink-2">
                  {formatInt(w.count)}
                </span>
                <span className="min-w-0 text-ink-2">
                  {w.message}
                  {w.sample ? <span className="mt-0.5 block break-words text-xs text-ink-3">Example: {w.sample}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
