import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { CACHE_TTL_SECONDS, CLAUDE3_FROM, DEFAULT_CONTEXT_WINDOW, METHODS, NEW_TOKENIZER_FROM, RETRIEVED_ON, SOURCES } from '@/core/catalog';
import { LIMITATION_TEXT, type LimitationName } from '@/core/limitations';
import { formatDay, formatInt } from '@/lib/format';

/**
 * "How it is counted": the definitions behind every figure in the app. The numbers
 * quoted here (factors, dates, windows) are read from the same constants the
 * calculations use, so the page cannot drift away from the code.
 */
const SECTIONS = [
  ['confidence', 'Exact, estimated, unavailable'],
  ['sources', 'What each source records'],
  ['tokens', 'Two ways to count tokens'],
  ['chat', 'How chat tokens are estimated'],
  ['claude-code', 'Claude Code usage'],
  ['reports', 'API reports'],
  ['duplicates', 'Counting nothing twice'],
  ['value', 'Equivalent API value'],
  ['plans', 'Subscription periods'],
  ['missing', 'What cannot be recovered'],
  ['privacy', 'Where your data lives'],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-20 border-t border-line py-8 first:border-t-0 first:pt-0">
      <h2 id={`${id}-heading`} className="text-[17px] font-medium text-ink">
        {title}
      </h2>
      <div className="mt-3 max-w-[74ch] space-y-3 text-ink-2 [&_strong]:font-medium [&_strong]:text-ink">{children}</div>
    </section>
  );
}

function DocTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="scrollbar-thin max-w-none overflow-x-auto rounded-[var(--radius-control)] border border-line">
      <table className="w-full min-w-[34rem] border-collapse text-[13px]">
        <thead className="bg-raised text-left text-xs text-ink-2">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-line align-top">
              {row.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row" className="px-3 py-2 text-left font-normal text-ink">
                    {cell}
                  </th>
                ) : (
                  <td key={j} className="px-3 py-2 text-ink-2">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-accent-soft underline-offset-4 hover:underline">
    {children}
  </a>
);

const METHOD_LABEL: Record<string, string> = {
  claude2: 'Claude 2 and earlier',
  claude3: 'Claude 3 up to Opus 4.6, Sonnet 4.6 and Haiku 4.5',
  claude47: 'Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5, Fable, Mythos',
  mixed: `Model not recorded, message dated ${formatDay(NEW_TOKENIZER_FROM)} or later`,
};

const percent = (factor: string) => {
  const delta = Math.round((Number(factor) - 1) * 100);
  return `${delta > 0 ? '+' : ''}${delta}%`;
};

export function MethodologyPage() {
  return (
    <div>
      <PageHeader
        title="How it is counted"
        description="Every figure in Claude Lifetime is computed from files you imported. This page says what each figure means, how estimates are made, and what no file can tell."
      />

      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <nav aria-label="On this page" className="mb-8 lg:mb-0">
          <ul className="space-y-1 text-[13px] lg:sticky lg:top-20">
            {SECTIONS.map(([id, title]) => (
              <li key={id}>
                <a href={`#${id}`} className="block rounded px-2 py-1 text-ink-2 hover:bg-raised hover:text-ink">
                  {title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          <Section id="confidence" title="Exact, estimated, unavailable">
            <p>Each figure carries one of three labels, and the label is part of the figure.</p>
            <p>
              <strong>Exact</strong> means a source metered the tokens itself and the app only adds them up: Claude Code transcripts, Anthropic usage
              reports, and manual entries you marked as copied from a report. Counts of conversations and messages are exact counts of what was imported.
            </p>
            <p>
              <strong>Estimated</strong> means the tokens were reconstructed from text, because the source holds no token counts. A total that includes
              any estimated part is itself labelled estimated, and the exact and estimated parts are always available separately.
            </p>
            <p>
              <strong>Unavailable</strong> means no imported source holds the information. The app then shows a dash and the reason. It never shows a
              zero or a guess in its place.
            </p>
            <p>
              None of these figures is an official Anthropic accounting of your account. Anthropic does not publish a lifetime token total for consumer
              accounts; this app reconstructs what your own files support.
            </p>
          </Section>

          <Section id="sources" title="What each source records">
            <DocTable
              head={['Source', 'Token counts', 'Model', 'What is read']}
              rows={[
                ['claude.ai data export', 'None. Estimated from text.', 'Not recorded', 'Conversations, messages, dates, attachments with extracted text, tool calls and results'],
                ['Claude Code transcripts', 'Exact, per model response', 'Recorded', 'Input, output, cache read and cache write tokens, session, project and time'],
                ['Anthropic API usage reports', 'Exact, per time bucket', 'Recorded when the report is grouped by model', 'Token counts by category, service tier and context window'],
                ['Anthropic API cost reports', 'None. Money only.', 'Sometimes', 'Billed amounts, kept as actual spend'],
                ['CSV or JSON table, manual entry', 'As you declare them', 'If the file names it', 'The columns you map'],
              ]}
            />
            <p>
              The claude.ai export contains neither token counts nor the name of the model that answered, and conversations deleted before the export
              are not in it. That is a property of the export, not a choice of this app.
            </p>
          </Section>

          <Section id="tokens" title="Two ways to count tokens">
            <p>The same usage gives two honest totals, depending on whether context that is read again counts again. The switch in the top bar chooses one.</p>
            <DocTable
              head={['Basis', 'Includes', 'Answers']}
              rows={[
                ['New tokens', 'Input + output + cache writes', 'How much content went to the model or came from it, each piece counted once'],
                ['Processed tokens', 'New tokens + cache reads + re-read context', 'How much the model read and wrote in total. This is the quantity the API meters.'],
              ]}
            />
            <p>
              A conversation is sent to the model again in full on every turn, so processed tokens grow much faster than new tokens in long conversations.
              Cache reads exist only in exact sources and re-read context only in estimated ones, so the two never overlap and no category is counted in
              two columns.
            </p>
          </Section>

          <Section id="chat" title="How chat tokens are estimated">
            <p>
              <strong>Counting text.</strong> Text is measured with a tokenizer model fitted to the tokenizer Anthropic published for Claude 2. Against
              that tokenizer it is within about 1% on pooled text and within about 3% for most kinds of content; the weakest cases are Korean prose and
              a few languages it was not fitted on (up to about 14% low). One token of that tokenizer is the app&rsquo;s base unit.
            </p>
            <p>
              <strong>Tokenizer generations.</strong> Claude models do not share a tokenizer, and Anthropic has not published the newer ones. The base
              count is therefore scaled by a factor per generation, anchored on what Anthropic does publish: about 3.5 English characters per token
              before Opus 4.7, and roughly 30% more tokens for the same text from Opus 4.7 on (
              <Ext href={SOURCES.glossary}>glossary</Ext>). Because an export does not name the model, the generation is taken from the date of the
              message alone: before {formatDay(CLAUDE3_FROM)} only the first generation existed, before {formatDay(NEW_TOKENIZER_FROM)} only the first
              two, and from then on the midpoint of the two current generations is used with a band that covers both.
            </p>
            <DocTable
              head={['Applies to', 'Tokens per base unit', 'Margin shown']}
              rows={METHODS.map((m) => [METHOD_LABEL[m.basis] ?? m.basis, m.centralFactor, `${percent(m.lowFactor)} to ${percent(m.highFactor)}`])}
            />
            <p>
              <strong>Reconstructing requests.</strong> An export lists messages, not requests. Every reply needed at least one model request whose input
              was the whole conversation so far, and each tool call adds another request that reads everything again. The app rebuilds that sequence:
              your text, attachment text and tool results count as input; replies, visible thinking and tool calls count as output; and the earlier
              conversation that was sent again counts as re-read context. Thinking is carried within a turn but not into later turns. Re-read context is
              capped at a {formatInt(DEFAULT_CONTEXT_WINDOW)}-token window, since a real request cannot exceed it. Exports that record which message
              each reply answered are followed branch by branch; older exports are treated as one thread.
            </p>
            <p>
              <strong>What an estimate leaves out.</strong> Each estimated message records which of these apply to it, and the conversation page lists
              them:
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              {(Object.keys(LIMITATION_TEXT) as LimitationName[]).map((name) => (
                <li key={name}>
                  <strong>{LIMITATION_TEXT[name].short}.</strong> {LIMITATION_TEXT[name].detail}
                </li>
              ))}
            </ul>
            <p>
              The margin shown next to a total covers the uncertainty of the tokenizer generation. It does not cover content that is missing from the
              export, which can only make the real figure higher.
            </p>
          </Section>

          <Section id="claude-code" title="Claude Code usage">
            <p>
              Claude Code writes one line per piece of a model response into its session transcripts, each carrying the usage the API reported for the
              whole response. The app counts every response once, identified by its message id and request id, across all files, including resumed
              sessions and subagent files. Usage is stored in 15-minute buckets per session and model; no conversation text is stored.
            </p>
            <p>
              Responses that are still being written when you import are left for the next import. Claude Code deletes transcripts after 30 days
              unless <code className="rounded bg-raised px-1 text-[12px] text-ink">cleanupPeriodDays</code> is raised in its settings, so usage older
              than that can only be recovered if it was collected in time. The collector script on the{' '}
              <Link href="/import/" className="text-accent-soft underline-offset-4 hover:underline">
                import page
              </Link>{' '}
              keeps a permanent ledger of the figures.
            </p>
            <p>
              Claude Code also keeps a summary file of its own (<code className="rounded bg-raised px-1 text-[12px] text-ink">stats-cache.json</code>).
              The app does not read it: its totals change definition between versions and include repeated counts, so they cannot be reconciled with the
              per-response records.
            </p>
          </Section>

          <Section id="reports" title="API reports">
            <p>
              Usage reports from the Admin API and CSV exports from the Claude Console state token counts per time bucket. A newer report for the same
              period replaces the rows of the older one; it is never added on top. Reports that were filtered differently (one workspace, one key) and
              cover the same period therefore replace each other: import unfiltered reports, or select the files together.
            </p>
            <p>
              Cost reports are stored as money that was actually billed. They are shown as spend and never mixed into token totals or into the
              hypothetical API value. The Admin API requires an organization admin key and is not available to individual accounts.
            </p>
          </Section>

          <Section id="duplicates" title="Counting nothing twice">
            <p>
              Importing the same file again adds nothing. Conversations are recognised by their id, messages by their id within the conversation, Claude
              Code responses by message and request id, report rows by period and dimensions. A later export of a conversation that has grown adds only
              the new messages.
            </p>
            <p>
              Two different sources can still describe the same usage, for example an API usage report and Claude Code transcripts when Claude Code ran
              on an API key. The app cannot detect that. In{' '}
              <Link href="/settings/" className="text-accent-soft underline-offset-4 hover:underline">
                Settings
              </Link>{' '}
              you can leave a source out of all totals without deleting it.
            </p>
          </Section>

          <Section id="value" title="Equivalent API value">
            <p>
              This is what the recorded usage would have cost at Anthropic&rsquo;s published API prices. It is a hypothetical figure for comparison. It
              is not money you paid, and it is always shown apart from actual spend.
            </p>
            <p>
              Each record is priced with the price of its model and price tier that was in effect on its day, per million tokens, with separate prices
              for input, output, cache reads and cache writes. Prices come from Anthropic&rsquo;s <Ext href={SOURCES.pricing}>pricing page</Ext>, read
              on {formatDay(RETRIEVED_ON)}; prices of retired models come from their launch announcements. You can add or correct prices in Settings,
              and yours take precedence. Web searches are priced per search.
            </p>
            <p>
              For estimated chat usage the price of re-read context depends on whether prompt caching is assumed, so two scenarios are computed: without
              caching, where re-read context costs the input price, and with a {Math.round(CACHE_TTL_SECONDS / 60)}-minute prompt cache, where the part
              a cache could have served costs the cache-read price. Exact usage is the same in both, because its cache tokens are known.
            </p>
            <p>
              Usage with no recorded model is <strong>not priced</strong>, and the unpriced amount is shown next to the value. You can choose a model
              to stand in for it in Settings; the result is then labelled as your assumption.
            </p>
          </Section>

          <Section id="plans" title="Subscription periods">
            <p>
              No export says when you were on Free, Pro or Max, so you enter those dates yourself. Usage is never stamped with a plan: the plan of any
              record is looked up from its date, which means editing a period re-classifies your whole history at once. Time outside every period is
              shown as “No subscription recorded”.
            </p>
            <p>
              “Before” and “after” split your usage at the start of your first paid period. The two sides usually differ in length and in how they were
              measured, so the comparison offers rates per day, week, month and conversation, and does not print a growth percentage for totals.
            </p>
          </Section>

          <Section id="missing" title="What cannot be recovered">
            <ul className="list-disc space-y-1.5 pl-5">
              <li>Conversations you deleted before exporting, and any usage in a source you have not imported.</li>
              <li>The model behind each chat message, and therefore a model-specific price for chat usage.</li>
              <li>System prompts, tool definitions, project knowledge, memory and styles, which are sent to the model but are not in an export.</li>
              <li>The token cost of images, PDFs and other files, of which an export keeps only the names.</li>
              <li>Claude Code sessions whose transcripts were already cleaned up.</li>
              <li>
                The share of your all-time usage that the imported files represent. No source knows the true total, so the app shows what was imported,
                over which dates and with which gaps, and no percentage.
              </li>
            </ul>
          </Section>

          <Section id="privacy" title="Where your data lives">
            <p>
              Everything is stored in a database inside this browser, on this device. Files are read locally; nothing is uploaded, the app makes no
              network requests with your data, and there is no account or analytics.
            </p>
            <p>
              The app stores titles, dates, sizes and token figures. It does not store the text of your messages: an export is read once to measure it,
              and the text is discarded. Deleting an import, a source or everything is possible at any time from the import page and Settings.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
