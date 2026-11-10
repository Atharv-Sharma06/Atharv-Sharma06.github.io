'use client';

import { Search, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { NO_PLAN, UNKNOWN_MODEL_LABEL } from '@/analytics/base';
import { listConversationModels, listConversations, type ConversationRow, type ConversationSort } from '@/analytics/conversations';
import { planLabel } from '@/analytics/subscriptions';
import { confidenceOf } from '@/components/data/confidence';
import { NoDataYet } from '@/components/data/no-data';
import { SOURCE_KIND_LABEL } from '@/components/shell/coverage-indicator';
import { PageHeader } from '@/components/shell/page-header';
import { Button, buttonClass } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/controls';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { InfoTip } from '@/components/ui/overlay';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import type { SourceKind } from '@/core/types';
import { cn } from '@/lib/cn';
import { formatDayRange, formatInstant, formatInt, formatTokens } from '@/lib/format';
import { rangeKey, useApp, useData } from '@/state/app';
import { useCoverage, usePeriods } from '@/state/queries';
import { ConfidenceMark } from './confidence-mark';
import { isPlainClick, onOpenClick, openConversation, takePendingFocus } from './navigation';
import { ensurePlannerStatistics } from './planner-statistics';
import { KindIcon, shortProject, UNTITLED } from './shared';
import {
  clearFilters,
  detailHref,
  explorerParams,
  hasFilters,
  pageWindow,
  toggleSort,
  toQuery,
  UNKNOWN_MODEL,
  withChange,
  type ExplorerState,
} from './url-state';

/** "Every value" in a filter. Radix Select has no empty value, and no model, source or plan key looks like this. */
const ALL = '__all__';
const SEARCH_DELAY_MS = 250;

/**
 * Writes the list state to the query string. The History API changes the URL in place:
 * nothing is requested and nothing reloads, and Next keeps useSearchParams in step.
 */
function writeState(next: ExplorerState) {
  const query = explorerParams(next).toString();
  window.history.replaceState(null, '', query === '' ? window.location.pathname : `?${query}`);
}

function SearchBox({ committed, onCommit }: { committed: string; onCommit: (value: string) => void }) {
  const [text, setText] = useState(committed);
  // `seen` is the search last found in the URL; `sent` holds what this box has written
  // that the URL does not show yet. When the URL changes to something this box did not
  // send (Clear filters, the back button), the text follows it. When it is our own
  // write arriving, the text is left alone: the user may already have typed more.
  const [sync, setSync] = useState<{ seen: string; sent: string[] }>({ seen: committed, sent: [] });
  if (committed !== sync.seen) {
    const arrived = sync.sent.indexOf(committed);
    setSync({ seen: committed, sent: arrived >= 0 ? sync.sent.slice(arrived + 1) : [] });
    if (arrived < 0) setText(committed);
  }
  const latest = sync.sent.length > 0 ? sync.sent[sync.sent.length - 1] : sync.seen;

  useEffect(() => {
    const value = text.trim();
    if (value === latest) return;
    const timer = window.setTimeout(() => {
      setSync((s) => ({ seen: s.seen, sent: [...s.sent, value] }));
      onCommit(value);
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, latest, onCommit]);

  return (
    <div className="relative col-span-2 min-w-0 sm:flex-[1_1_15rem]">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search by title or project"
        aria-label="Search conversations by title or project"
        role="searchbox"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        className="pl-9 pr-9"
      />
      {text !== '' ? (
        <button
          type="button"
          onClick={() => setText('')}
          aria-label="Clear search"
          className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 hover:bg-raised hover:text-ink"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function ConversationTableRow({ row, state, timezone, onOpen }: { row: ConversationRow; state: ExplorerState; timezone: string; onOpen: (event: MouseEvent<HTMLTableRowElement>, id: number) => void }) {
  const level = confidenceOf(row.exact, row.estimated);
  const title = row.title?.trim() ?? '';
  return (
    <Tr className="group cursor-pointer hover:bg-raised" onClick={(event) => onOpen(event, row.id)}>
      {/* A full-width cell whose own content counts for 11rem: the column takes whatever the others leave, never less, and truncates inside. */}
      <Td className="sticky left-0 z-[1] w-full min-w-[11rem] max-w-[11rem] bg-surface group-hover:bg-raised">
        <div className="flex min-w-0 items-center gap-2">
          <KindIcon kind={row.kind} />
          <Link
            href={detailHref(row.id, state)}
            prefetch={false}
            onClick={(event) => onOpenClick(event, row.id, state)}
            data-conversation={row.id}
            title={title || undefined}
            className={cn('min-w-0 truncate underline-offset-4 hover:underline', title ? 'text-ink' : 'text-ink-3')}
          >
            {title || UNTITLED}
          </Link>
          {row.projectLabel ? (
            <span title={`Project: ${row.projectLabel}`} className="hidden shrink-0 rounded-[5px] border border-line bg-raised px-1.5 text-xs leading-5 text-ink-2 sm:inline">
              {shortProject(row.projectLabel)}
            </span>
          ) : null}
        </div>
      </Td>
      <Td className="whitespace-nowrap text-ink-2" title={row.createdAt ? formatInstant(row.createdAt, timezone, 'datetime') : 'The source records no creation time.'}>
        {formatInstant(row.createdAt, timezone)}
      </Td>
      <Td className="whitespace-nowrap text-ink-2" title={row.updatedAt ? formatInstant(row.updatedAt, timezone, 'datetime') : 'The source records no time of last activity.'}>
        {formatInstant(row.updatedAt, timezone)}
      </Td>
      <Td className={cn('whitespace-nowrap', row.modelKey === null && 'text-ink-3')} title={row.modelKey === null ? 'The source does not name the model, and none is guessed.' : undefined}>
        {row.modelName}
      </Td>
      <Td numeric>{formatInt(row.messageCount)}</Td>
      {level === 'unavailable' ? (
        <Td numeric className="text-ink-3" title="No token counts are recorded for this conversation.">
          –
        </Td>
      ) : (
        <Td numeric title={`${formatInt(row.tokens)} tokens`}>
          {formatTokens(row.tokens)}
        </Td>
      )}
      <Td>
        <ConfidenceMark
          level={level}
          title={
            level === 'estimated' && row.exact > 0
              ? `${formatTokens(row.exact)} metered, ${formatTokens(row.estimated)} estimated`
              : level === 'estimated'
                ? 'Reconstructed from the conversation’s text'
                : level === 'exact'
                  ? 'Metered by the source'
                  : 'No token counts are recorded'
          }
        />
      </Td>
      <Td className="whitespace-nowrap text-ink-2" title={row.sourceLabel}>
        {SOURCE_KIND_LABEL[row.sourceKind] ?? row.sourceKind}
      </Td>
      <Td className={cn('whitespace-nowrap', row.planKey === NO_PLAN ? 'text-ink-3' : 'text-ink-2')}>{planLabel(row.planKey, row.planLabel)}</Td>
    </Tr>
  );
}

function TableSkeleton() {
  return (
    <div aria-busy="true" className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
      <Skeleton className="h-8 w-full" />
      <div className="mt-3 space-y-2.5">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}

export function Explorer({ state }: { state: ExplorerState }) {
  const app = useApp();
  const { resolved, settings } = app;
  const scoped = resolved.from !== null || resolved.to !== null;
  const rangeLabel = formatDayRange(resolved.from, resolved.to);
  const frame = useRef<HTMLDivElement>(null);

  const coverage = useCoverage();
  const periods = usePeriods();
  const models = useData(['conversation-models'], (a) => listConversationModels(a.db, a.userId));
  // Each row shows the conversation's whole size, so the token figures are lifetime
  // figures; the date range selects conversations by the day they were created.
  const page = useData(
    ['conversations', rangeKey(app), state.search, state.model, state.source, state.plan, state.sort, state.direction, state.page],
    (a) => ensurePlannerStatistics(a.db, a.dataVersion).then(() => listConversations(a.db, a.lifetime, toQuery(state, a.resolved))),
  );

  // The latest state for callbacks that must not change identity on every keystroke.
  const current = useRef(state);
  useEffect(() => {
    current.current = state;
  }, [state]);

  const commitSearch = useCallback((search: string) => writeState(withChange(current.current, { search })), []);

  const shown = pageWindow(state.page, page.data?.total ?? 0);

  // A page beyond the end (a stale link, or rows removed by a deleted import) falls back to the last page.
  const outOfRange = page.data !== undefined && !page.isPlaceholderData && page.data.total > 0 && page.data.rows.length === 0;
  useEffect(() => {
    if (outOfRange) writeState({ ...current.current, page: shown.pages });
  }, [outOfRange, shown.pages]);

  const modelOptions = useMemo(() => {
    const named = (models.data ?? []).filter((m) => m.modelKey !== null).map((m) => ({ value: m.modelKey as string, label: m.displayName }));
    const options = [{ value: ALL, label: 'All models' }, ...named];
    if ((models.data ?? []).some((m) => m.modelKey === null) || state.model === UNKNOWN_MODEL) options.push({ value: UNKNOWN_MODEL, label: UNKNOWN_MODEL_LABEL });
    if (state.model && !options.some((o) => o.value === state.model)) options.push({ value: state.model, label: state.model });
    return options;
  }, [models.data, state.model]);

  const sourceOptions = useMemo(() => {
    const kinds: SourceKind[] = [];
    for (const s of coverage.data?.sources ?? []) {
      if (s.includeInTotals && s.conversations > 0 && !kinds.includes(s.kind)) kinds.push(s.kind);
    }
    if (state.source && !kinds.includes(state.source)) kinds.push(state.source);
    return [{ value: ALL, label: 'All sources' }, ...kinds.map((k) => ({ value: k as string, label: SOURCE_KIND_LABEL[k] ?? k }))];
  }, [coverage.data, state.source]);

  const planOptions = useMemo(() => {
    const keys: string[] = [];
    for (const p of periods.data ?? []) if (!keys.includes(p.planKey)) keys.push(p.planKey);
    if (state.plan && state.plan !== NO_PLAN && !keys.includes(state.plan)) keys.push(state.plan);
    return [{ value: ALL, label: 'All plans' }, ...keys.map((k) => ({ value: k, label: planLabel(k) })), { value: NO_PLAN, label: planLabel(NO_PLAN) }];
  }, [periods.data, state.plan]);

  const filtered = hasFilters(state);
  const labelOf = (options: Array<{ value: string; label: string }>, value: string | null) => options.find((o) => o.value === value)?.label ?? value ?? '';
  const activeFilters = [
    state.search.trim() !== '' ? `title or project containing “${state.search.trim()}”` : null,
    state.model ? `model ${labelOf(modelOptions, state.model)}` : null,
    state.source ? `source ${labelOf(sourceOptions, state.source)}` : null,
    state.plan ? `plan ${labelOf(planOptions, state.plan)}` : null,
    scoped ? `created ${rangeLabel}` : null,
  ].filter((v): v is string => v !== null);

  const sortProps = (sort: ConversationSort) => ({
    sort: state.sort === sort ? state.direction : null,
    onSort: () => writeState(toggleSort(state, sort)),
  });

  const openRow = (event: MouseEvent<HTMLTableRowElement>, id: number) => {
    // The title is the real link. The rest of the row is a larger target for a plain
    // click on it; modified clicks and text selection are left to the browser.
    if (!isPlainClick(event) || (event.target as HTMLElement).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    openConversation(id, state);
  };

  // Back from a conversation: keyboard focus returns to the row it was opened from.
  const listed = page.data?.rows;
  useEffect(() => {
    if (!listed) return;
    const target = takePendingFocus('list');
    if (target) frame.current?.querySelector<HTMLAnchorElement>(`a[data-conversation="${target.id}"]`)?.focus();
  }, [listed]);

  const goToPage = (next: number) => {
    writeState({ ...state, page: next });
    // After "Next" at the bottom of a long page, the top of the new page should be in view.
    const top = frame.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) frame.current?.scrollIntoView({ block: 'start' });
  };

  const failure = coverage.error ?? page.error ?? models.error ?? periods.error;
  const total = page.data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title="Conversations"
        description="Every chat and Claude Code session in your imports, with its size and where it came from. Only metadata is kept: message text is not stored."
        actions={
          coverage.data?.hasData && page.data ? (
            <p className="text-[13px] text-ink-2" aria-live="polite">
              <span className="tabular text-ink">{formatInt(total)}</span> {total === 1 ? 'conversation' : 'conversations'}
              {filtered || scoped ? (total === 1 ? ' matches' : ' match') : ''}
            </p>
          ) : null
        }
      />

      {failure ? (
        <ErrorNote title="The conversations could not be read from the local database" className="mb-6">
          {failure.message}
        </ErrorNote>
      ) : null}

      {!coverage.data ? (
        failure ? null : (
          <TableSkeleton />
        )
      ) : !coverage.data.hasData ? (
        <NoDataYet what="No conversations to explore yet" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <SearchBox committed={state.search} onCommit={commitSearch} />
            <Select
              label="Model"
              value={state.model ?? ALL}
              onChange={(v) => writeState(withChange(state, { model: v === ALL ? null : v }))}
              options={modelOptions}
              className="w-full sm:w-[12.5rem]"
            />
            <Select
              label="Source"
              value={state.source ?? ALL}
              onChange={(v) => writeState(withChange(state, { source: v === ALL ? null : (v as SourceKind) }))}
              options={sourceOptions}
              className="w-full sm:w-[11rem]"
            />
            <Select
              label="Plan when the conversation started"
              value={state.plan ?? ALL}
              onChange={(v) => writeState(withChange(state, { plan: v === ALL ? null : v }))}
              options={planOptions}
              className="w-full sm:w-[13.5rem]"
            />
            {filtered ? (
              <Button variant="ghost" onClick={() => writeState(clearFilters(state))}>
                Clear filters
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-ink-3">
            {scoped
              ? `Showing conversations created ${rangeLabel}. The date range in the top bar filters by the day a conversation was created.`
              : 'The date range in the top bar filters by the day a conversation was created.'}
          </p>

          <div className="mt-4">
            {!page.data ? (
              failure ? null : (
                <TableSkeleton />
              )
            ) : total === 0 ? (
              filtered ? (
                <EmptyState
                  title="No conversations match these filters"
                  action={
                    <Button onClick={() => writeState(clearFilters(state))}>Clear filters</Button>
                  }
                >
                  <p>Nothing matches {new Intl.ListFormat('en', { type: 'conjunction' }).format(activeFilters)}.</p>
                  <p className="mt-1">Clear the filters, or change one of them, to see more.</p>
                </EmptyState>
              ) : scoped ? (
                <EmptyState
                  title="No conversations were created in this range"
                  action={<Button onClick={() => app.setRange({ preset: 'all', from: null, to: null })}>Show all time</Button>}
                >
                  No chat or Claude Code session in your imports started in this range ({rangeLabel}). Choose a wider date range in the top bar.
                </EmptyState>
              ) : (
                <EmptyState
                  title="Your imports contain no conversations"
                  action={
                    <Link href="/import/" className={buttonClass('secondary')}>
                      Import conversations
                    </Link>
                  }
                >
                  Usage reports record totals per day, not conversations. Import a claude.ai data export or Claude Code session logs to see conversations here.
                </EmptyState>
              )
            ) : (
              <div className={cn('transition-opacity', page.isPlaceholderData && 'opacity-70')} aria-busy={page.isPlaceholderData || undefined}>
                <div ref={frame} className="scroll-mt-20">
                <TableFrame className="rounded-[var(--radius-card)] bg-surface">
                  <Table>
                    <THead>
                      <tr>
                        <Th {...sortProps('title')} className="sticky left-0 z-[2] bg-raised">
                          Title
                        </Th>
                        <Th {...sortProps('created')}>Created</Th>
                        <Th {...sortProps('updated')}>Last activity</Th>
                        <Th>Model</Th>
                        <Th align="right" {...sortProps('messages')}>
                          Messages
                        </Th>
                        <Th align="right" {...sortProps('tokens')}>
                          Tokens
                        </Th>
                        <Th>
                          <span className="inline-flex items-center gap-1">
                            Confidence
                            <InfoTip label="What exact and estimated mean">
                              <p>
                                <strong className="font-medium text-ink">Exact</strong> token counts were metered by the source, as Claude Code logs and API usage reports
                                do.
                              </p>
                              <p>
                                <strong className="font-medium text-ink">Estimated</strong> counts are reconstructed from the conversation’s text, because a claude.ai
                                export contains no token counts. The real figure can differ.
                              </p>
                            </InfoTip>
                          </span>
                        </Th>
                        <Th>Source</Th>
                        <Th>Plan at start</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {page.data.rows.map((row) => (
                        <ConversationTableRow key={row.id} row={row} state={state} timezone={settings.timezone} onOpen={openRow} />
                      ))}
                    </tbody>
                  </Table>
                </TableFrame>
                </div>

                <nav aria-label="Pages of conversations" className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[13px] text-ink-2">
                  <p>
                    Showing{' '}
                    <span className="tabular text-ink">
                      {formatInt(shown.first)}–{formatInt(shown.last)}
                    </span>{' '}
                    of <span className="tabular text-ink">{formatInt(total)}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    {shown.pages > 1 ? (
                      <span className="tabular mr-1">
                        Page {formatInt(Math.min(state.page, shown.pages))} of {formatInt(shown.pages)}
                      </span>
                    ) : null}
                    <Button size="sm" disabled={state.page <= 1} onClick={() => goToPage(state.page - 1)}>
                      Previous
                    </Button>
                    <Button size="sm" disabled={state.page >= shown.pages} onClick={() => goToPage(state.page + 1)}>
                      Next
                    </Button>
                  </div>
                </nav>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
