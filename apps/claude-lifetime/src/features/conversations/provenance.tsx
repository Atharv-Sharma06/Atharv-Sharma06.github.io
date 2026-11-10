import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import type { ConversationDetail } from '@/analytics/conversations';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { LIMITATION_TEXT } from '@/core/limitations';
import { formatInstant, formatInt, plural } from '@/lib/format';
import { formatBand } from './growth';

/**
 * Why the token figures of a conversation are estimates: the limitations recorded on
 * its estimates and the method that produced them. For a conversation whose counts
 * were all metered there is nothing to qualify, and the card says so instead.
 */
export function EstimateNotes({ detail, className }: { detail: ConversationDetail; className?: string }) {
  const { conversation, limitations, methods } = detail;

  if (conversation.estimated === 0) {
    return (
      <Card className={className}>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <CircleCheck className="size-4 text-good" strokeWidth={2.25} aria-hidden="true" />
              Metered by the source
            </span>
          }
        />
        <CardBody className="space-y-2 text-[13px] text-ink-2">
          {conversation.exact > 0 ? (
            <p>
              {conversation.sourceKind === 'claude_code'
                ? 'Claude Code records the token counts of every model request in its session log. The figures on this page are those counts added up: nothing here is estimated.'
                : 'This source reports token counts directly. The figures on this page are those counts added up: nothing here is estimated.'}
            </p>
          ) : (
            <p>No token counts are recorded for this conversation, so there is nothing to estimate or to add up.</p>
          )}
        </CardBody>
      </Card>
    );
  }

  const estimatedMessages = methods.reduce((sum, m) => sum + m.messages, 0);
  return (
    <Card className={className}>
      <CardHeader
        title="Why this is an estimate"
        description="The source of this conversation records its text but no token counts, so the counts are reconstructed from the text. These are the known reasons the real figures can differ."
      />
      <CardBody className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {limitations.length > 0 ? (
          <section>
            <h3 className="text-[13px] font-medium text-ink">What the estimate leaves out or assumes</h3>
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {limitations.map((l) => (
                <li key={l.name} className="py-2.5">
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="text-[13px] text-ink">{LIMITATION_TEXT[l.name].short}</p>
                    <p className="tabular shrink-0 text-xs text-ink-3">
                      {estimatedMessages > 0 ? `${formatInt(l.messages)} of ${plural(estimatedMessages, 'message')}` : plural(l.messages, 'message')}
                    </p>
                  </div>
                  <p className="mt-0.5 text-[13px] text-ink-2">{LIMITATION_TEXT[l.name].detail}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section>
          <h3 className="text-[13px] font-medium text-ink">How the text was counted</h3>
          {methods.length > 0 ? (
            <ul className="mt-2 space-y-4">
              {methods.map((m) => (
                <li key={m.methodKey} className="text-[13px] text-ink-2">
                  <p>{m.description}</p>
                  <dl className="mt-2 space-y-1">
                    <div className="flex justify-between gap-4">
                      <dt>Margin of the estimate</dt>
                      <dd className="tabular text-ink">{formatBand(m.lowFactor, m.highFactor)}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt>Applied to</dt>
                      <dd className="tabular text-ink">{plural(m.messages, 'message')}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt>Method</dt>
                      <dd className="break-all text-ink">{m.methodKey}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13px] text-ink-2">
              The source marks these counts as estimates. They were imported as given: no estimation method of this app was applied, so no margin is known.
            </p>
          )}
          <p className="mt-4 text-[13px]">
            <Link href="/methodology/" className="text-accent-soft underline-offset-4 hover:underline">
              How the numbers are made
            </Link>
          </p>
        </section>
      </CardBody>
    </Card>
  );
}

/** The imports that contributed records to the conversation: every figure traces back to a file. */
export function Provenance({ detail, timezone, className }: { detail: ConversationDetail; timezone: string; className?: string }) {
  const { conversation, imports } = detail;
  return (
    <Card className={className}>
      <CardHeader
        title="Where this came from"
        description={
          imports.length === 0
            ? undefined
            : imports.length === 1
              ? 'The import that contributed the records of this conversation.'
              : `The ${imports.length} imports that contributed records to this conversation.`
        }
      />
      <CardBody>
        {imports.length === 0 ? (
          <p className="text-[13px] text-ink-2">No import is recorded for this conversation.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {imports.map((i) => (
              <li key={i.batchId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
                <div className="min-w-0">
                  <p className="break-words text-[13px] text-ink">{i.fileName}</p>
                  <p className="text-xs text-ink-3">Format {i.format}</p>
                </div>
                <p className="shrink-0 text-xs text-ink-2">Imported {formatInstant(i.importedAt, timezone, 'datetime')}</p>
              </li>
            ))}
          </ul>
        )}
        <dl className="mt-3 space-y-1.5 text-[13px]">
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt className="text-ink-2">Source</dt>
            <dd className="text-ink">{conversation.sourceLabel}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt className="text-ink-2">Identifier in the source</dt>
            <dd className="break-all text-ink">{conversation.externalId}</dd>
          </div>
        </dl>
        <p className="mt-4 text-[13px]">
          <Link href="/import/" className="text-accent-soft underline-offset-4 hover:underline">
            Manage imports
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
