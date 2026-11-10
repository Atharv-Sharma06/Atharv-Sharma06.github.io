import { CircleDashed } from 'lucide-react';
import type { TokenBasis } from '@/analytics/base';
import type { ConversationDetail } from '@/analytics/conversations';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { cn } from '@/lib/cn';
import { formatInt, plural } from '@/lib/format';
import { INFERRED_TIME_HINT, MessageTime } from './confidence-mark';

type MessageMeta = ConversationDetail['messages'][number];

const WHO: Record<string, string> = { user: 'You', assistant: 'Claude' };

/** A count where zero is a real value: shown, but quiet, so the non-zero figures stand out. */
function Count({ value, className }: { value: number; className?: string }) {
  return (
    <Td numeric className={cn(value === 0 && 'text-ink-3', className)}>
      {formatInt(value)}
    </Td>
  );
}

function GroupHeader({ span, children }: { span: number; children: string }) {
  return (
    <th scope="colgroup" colSpan={span} className="px-3 pb-0 pt-2 text-center font-medium">
      <span className="block border-b border-line-strong pb-1.5">{children}</span>
    </th>
  );
}

/**
 * Message metadata in order. The database holds no message text, so this is everything
 * there is: who wrote the message, when, how large it was, and what it is estimated to
 * have cost in tokens.
 */
export function MessageTable({ detail, basis, timezone }: { detail: ConversationDetail; basis: TokenBasis; timezone: string }) {
  const { messages } = detail;
  const processed = basis === 'processed';
  const sum = (pick: (m: MessageMeta) => number) => messages.reduce((total, m) => total + pick(m), 0);
  const inferred = messages.filter((m) => m.timeInferred).length;

  return (
    <Card>
      <CardHeader
        title="Messages"
        description="The size of each message and the tokens estimated for it. Message text is not stored in this app, so sizes and counts are all there is to show."
      />
      <CardBody>
        {detail.messagesTruncated ? (
          <p className="mb-3 text-[13px] text-ink-2">
            This conversation has {formatInt(detail.conversation.messageCount)} messages. Only the first {formatInt(messages.length)} are listed; the figures at the top
            of the page cover all of them.
          </p>
        ) : null}
        <TableFrame className="max-h-[32rem] overflow-y-auto">
          <Table className="min-w-[60rem]">
            <THead className="sticky top-0 z-[1]">
              <tr>
                <td colSpan={3} />
                <GroupHeader span={4}>Characters</GroupHeader>
                <td />
                <GroupHeader span={processed ? 3 : 2}>Estimated tokens</GroupHeader>
                <td />
              </tr>
              <tr>
                <Th align="right" className="w-12">
                  #
                </Th>
                <Th>Who</Th>
                <Th>Time</Th>
                <Th align="right">Text</Th>
                <Th align="right">Thinking</Th>
                <Th align="right">Tool calls</Th>
                <Th align="right">Attachments</Th>
                <Th align="right">Files</Th>
                <Th align="right">Input</Th>
                <Th align="right">Output</Th>
                {processed ? <Th align="right">Re-read context</Th> : null}
                <Th align="right">Requests</Th>
              </tr>
            </THead>
            <tbody>
              {messages.map((m, i) => (
                <Tr key={`${m.ordinal}-${i}`}>
                  <Td numeric className="text-ink-3">
                    {i + 1}
                  </Td>
                  <Td className="whitespace-nowrap">{WHO[m.role] ?? 'Other'}</Td>
                  <Td className="whitespace-nowrap text-ink-2" title={m.at ? undefined : 'The source gives no time for this message.'}>
                    <MessageTime at={m.at} inferred={m.timeInferred} timezone={timezone} />
                  </Td>
                  <Count value={m.textChars} />
                  <Count value={m.thinkingChars} />
                  <Count value={m.toolChars} />
                  <Count value={m.attachmentChars} />
                  <Count value={m.fileCount} />
                  <Count value={m.input} />
                  <Count value={m.output} />
                  {processed ? <Count value={m.replay} /> : null}
                  <Count value={m.requests} />
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <Tr className="border-line-strong bg-raised/60 font-medium">
                <Td colSpan={3} className="text-ink-2">
                  {detail.messagesTruncated ? `Total of the ${formatInt(messages.length)} listed` : 'Total'}
                </Td>
                <Count value={sum((m) => m.textChars)} />
                <Count value={sum((m) => m.thinkingChars)} />
                <Count value={sum((m) => m.toolChars)} />
                <Count value={sum((m) => m.attachmentChars)} />
                <Count value={sum((m) => m.fileCount)} />
                <Count value={sum((m) => m.input)} />
                <Count value={sum((m) => m.output)} />
                {processed ? <Count value={sum((m) => m.replay)} /> : null}
                <Count value={sum((m) => m.requests)} />
              </Tr>
            </tfoot>
          </Table>
        </TableFrame>
        <p className="mt-3 text-xs text-ink-3">
          Characters are counted from the export. Files are images and other uploads whose content, and therefore token cost, the export does not include.
          {processed ? '' : ' Re-read context is left out: under the New basis each piece of content is counted once.'}
        </p>
        {inferred > 0 ? (
          <p className="mt-1.5 flex items-start gap-1 text-xs text-ink-3">
            <CircleDashed className="mt-px size-3.5 shrink-0 text-warning" strokeWidth={2.25} aria-hidden="true" />
            <span>
              {inferred === messages.length ? 'Every time in this list is inferred' : `${plural(inferred, 'time')} in this list ${inferred === 1 ? 'is' : 'are'} inferred`}.{' '}
              {INFERRED_TIME_HINT.replace(/^Inferred: the source records no time for this message\. /, 'The source records no time for these messages. ')}
            </span>
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
