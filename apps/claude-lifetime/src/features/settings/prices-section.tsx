'use client';

import { ArrowUpRight, Plus, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { deleteUserPrice, listPrices, saveUserPrice, type CatalogModelRow, type PriceRow, type UserPriceInput } from '@/analytics/settings';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/controls';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { Dialog, InfoTip } from '@/components/ui/overlay';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { RETRIEVED_ON, SOURCES, WEB_SEARCH_USD_PER_1000 } from '@/core/catalog';
import { cn } from '@/lib/cn';
import { formatDay, formatInt, plural } from '@/lib/format';
import { useApp } from '@/state/app';
import { useCatalogModels } from '@/state/queries';
import {
  checkPriceForm,
  effectiveLabel,
  EMPTY_PRICE_FORM,
  filterPrices,
  formatPrice,
  PRICE_TIERS,
  replacedByUserPrices,
  sortPrices,
  sourceHost,
  tierLabel,
  type PriceFormErrors,
  type PriceFormValues,
  type Replacement,
} from './logic';
import { SaveNote, SettingsSection, Tag, useSaveState } from './parts';
import { usePrices } from './queries';

const EXTERNAL_LINK = 'inline-flex items-center gap-0.5 text-accent-soft underline-offset-4 hover:underline';

function replacementText(replacement: Replacement): string {
  if (replacement.scope === 'all') return 'replaced by your price';
  return replacement.from ? `replaced from ${formatDay(replacement.from)}` : 'partly replaced by your price';
}

// ── Add a price ─────────────────────────────────────────────────────────────────

function AddPriceDialog({
  models,
  prices,
  onClose,
  onSaved,
}: {
  models: CatalogModelRow[];
  prices: PriceRow[];
  onClose: () => void;
  onSaved: (input: UserPriceInput) => Promise<void>;
}) {
  const app = useApp();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<PriceFormValues>(EMPTY_PRICE_FORM);
  const [errors, setErrors] = useState<PriceFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof PriceFormValues) => (value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const onFile = values.modelKey === '' ? [] : prices.filter((p) => p.modelKey === values.modelKey && p.priceTier === values.priceTier);

  const submit = async () => {
    const check = checkPriceForm(values);
    setErrors(check.errors);
    setFailure(null);
    if (!check.input) {
      // Take the user to the first field that needs attention.
      window.requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      await saveUserPrice(app.db, check.input);
      await onSaved(check.input);
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const priceField = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h', label: string, placeholder: string) => (
    <Field label={label} error={errors[key]}>
      <Input
        value={values[key]}
        onChange={(e) => set(key)(e.target.value)}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        aria-invalid={errors[key] ? true : undefined}
        className="tabular"
      />
    </Field>
  );

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Add a price"
      description="A price you looked up yourself, in US dollars per million tokens. It takes precedence over the built-in price for the same model and tier, from the date you give."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            Save price
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        noValidate
        className="grid gap-x-3 gap-y-4 sm:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Model" error={errors.modelKey} className="sm:col-span-4">
          <Select
            label="Model"
            placeholder="Choose a model"
            value={values.modelKey === '' ? undefined : values.modelKey}
            onChange={set('modelKey')}
            options={models.map((m) => ({ value: m.modelKey, label: m.displayName, hint: m.hasStandardPrice ? undefined : 'no price on file' }))}
          />
        </Field>
        <Field label="Tier" className="sm:col-span-2">
          <Select label="Price tier" value={values.priceTier} onChange={set('priceTier')} options={PRICE_TIERS} />
        </Field>

        {values.modelKey !== '' ? (
          <p className="-mt-1.5 text-[13px] text-ink-2 sm:col-span-6">
            {onFile.length === 0
              ? 'No price is on file for this model and tier yet.'
              : `On file for this model and tier: ${onFile
                  .map(
                    (p) =>
                      `${formatPrice(p.input)} input and ${formatPrice(p.output)} output (${p.isBuiltin ? 'built-in' : 'yours'}, ${effectiveLabel(p.effectiveFrom, p.effectiveTo).toLowerCase()})`,
                  )
                  .join('; ')}.`}
          </p>
        ) : null}

        <Field
          label="In effect from (optional)"
          hint="Leave empty if the price applies from the model’s launch."
          error={errors.effectiveFrom}
          className="sm:col-span-3"
        >
          <Input
            type="date"
            value={values.effectiveFrom}
            onChange={(e) => set('effectiveFrom')(e.target.value)}
            aria-invalid={errors.effectiveFrom ? true : undefined}
          />
        </Field>

        <fieldset className="grid gap-x-3 gap-y-3 sm:col-span-6 sm:grid-cols-6">
          <legend className="mb-2 text-[13px] font-medium text-ink">Price per million tokens, in US dollars</legend>
          <div className="sm:col-span-3">{priceField('input', 'Input', 'For example 3')}</div>
          <div className="sm:col-span-3">{priceField('output', 'Output', 'For example 15')}</div>
          <div className="sm:col-span-2">{priceField('cacheRead', 'Cache read (optional)', '0.30')}</div>
          <div className="sm:col-span-2">{priceField('cacheWrite5m', 'Cache write, 5 min (optional)', '3.75')}</div>
          <div className="sm:col-span-2">{priceField('cacheWrite1h', 'Cache write, 1 h (optional)', '6')}</div>
          <p className="text-xs text-ink-3 sm:col-span-6">A cache price you leave empty is charged at the input price.</p>
        </fieldset>

        <Field
          label="Source"
          hint="The web address where you found the price. It is shown next to it, so the figure stays traceable."
          error={errors.sourceUrl}
          className="sm:col-span-6"
        >
          <Input
            type="url"
            value={values.sourceUrl}
            onChange={(e) => set('sourceUrl')(e.target.value)}
            placeholder="https://"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.sourceUrl ? true : undefined}
          />
        </Field>
        <Field label="Note (optional)" className="sm:col-span-6">
          <Textarea
            value={values.sourceNote}
            onChange={(e) => set('sourceNote')(e.target.value)}
            maxLength={500}
            className="min-h-16"
            placeholder="For example: price after the change announced in March"
          />
        </Field>
      </form>
      {failure ? (
        <ErrorNote title="The price was not saved" className="mt-4">
          {failure}
        </ErrorNote>
      ) : null}
    </Dialog>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────────

// Header cells stay in view while the rows scroll; the inset line stands in for the row border, which does not travel with a sticky cell.
const HEAD = 'sticky top-0 z-[1] bg-raised px-2.5 align-bottom shadow-[inset_0_-1px_0_var(--color-line)]';
const CELL = 'whitespace-nowrap px-2.5 py-1.5';

function PriceTable({
  rows,
  replaced,
  highlight,
  onDelete,
  frameId,
}: {
  rows: PriceRow[];
  replaced: Map<number, Replacement>;
  highlight: number | null;
  onDelete: (row: PriceRow) => void;
  frameId: string;
}) {
  return (
    <TableFrame id={frameId} className="max-h-[30rem] overflow-y-auto" tabIndex={0} role="group" aria-label="Price table, scrollable">
      <Table className="min-w-[60rem]">
        <caption className="sr-only">Prices in US dollars per million tokens</caption>
        <THead>
          <tr>
            <Th className={HEAD}>Model</Th>
            <Th className={HEAD}>Tier</Th>
            <Th className={HEAD}>In effect</Th>
            <Th align="right" className={HEAD}>
              Input
            </Th>
            <Th align="right" className={HEAD}>
              Output
            </Th>
            <Th align="right" className={HEAD}>
              Cache read
            </Th>
            <Th align="right" className={HEAD}>
              Cache write
              <span className="block font-normal text-ink-3">5 minutes</span>
            </Th>
            <Th align="right" className={HEAD}>
              Cache write
              <span className="block font-normal text-ink-3">1 hour</span>
            </Th>
            <Th className={HEAD}>Source</Th>
            <Th className={HEAD}>Retrieved</Th>
            <Th className={HEAD}>Origin</Th>
          </tr>
        </THead>
        <tbody>
          {rows.map((p) => {
            const replacement = replaced.get(p.id);
            return (
              <Tr key={p.id} data-price-id={p.id} className={cn('transition-colors duration-700', highlight === p.id && 'bg-accent-wash')}>
                <th scope="row" className={cn(CELL, 'text-left font-normal text-ink')}>
                  {p.displayName}
                </th>
                <Td className={cn(CELL, 'text-ink-2')}>{tierLabel(p.priceTier)}</Td>
                <Td className={cn(CELL, 'text-ink-2')}>{effectiveLabel(p.effectiveFrom, p.effectiveTo)}</Td>
                <Td numeric className={CELL}>
                  {formatPrice(p.input)}
                </Td>
                <Td numeric className={CELL}>
                  {formatPrice(p.output)}
                </Td>
                <Td numeric className={cn(CELL, p.cacheRead === null && 'text-ink-3')}>
                  {formatPrice(p.cacheRead)}
                </Td>
                <Td numeric className={cn(CELL, p.cacheWrite5m === null && 'text-ink-3')}>
                  {formatPrice(p.cacheWrite5m)}
                </Td>
                <Td numeric className={cn(CELL, p.cacheWrite1h === null && 'text-ink-3')}>
                  {formatPrice(p.cacheWrite1h)}
                </Td>
                <Td className={cn(CELL, 'py-0')}>
                  <span className="inline-flex items-center gap-1">
                    <a href={p.sourceUrl} target="_blank" rel="noreferrer" title={p.sourceUrl} className={EXTERNAL_LINK}>
                      {sourceHost(p.sourceUrl)}
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </a>
                    {p.sourceNote ? (
                      <InfoTip label={`Note on the ${tierLabel(p.priceTier).toLowerCase()} price of ${p.displayName}`} align="end">
                        <p>{p.sourceNote}</p>
                      </InfoTip>
                    ) : null}
                  </span>
                </Td>
                <Td className={cn(CELL, 'tabular text-ink-2')}>{formatDay(p.sourceRetrievedOn)}</Td>
                <Td className={cn(CELL, p.isBuiltin ? 'text-ink-2' : 'py-0')}>
                  {p.isBuiltin ? (
                    <>
                      Built-in
                      {replacement ? <span className="block text-xs text-ink-3">{replacementText(replacement)}</span> : null}
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <Tag className="border-accent/40 text-ink">Yours</Tag>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2"
                        aria-label={`Delete your ${tierLabel(p.priceTier).toLowerCase()} price for ${p.displayName}`}
                        onClick={() => onDelete(p)}
                      >
                        Delete
                      </Button>
                    </span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableFrame>
  );
}

// ── Section ─────────────────────────────────────────────────────────────────────

export function PricesSection() {
  const app = useApp();
  const prices = usePrices();
  const models = useCatalogModels();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PriceRow | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [savedText, setSavedText] = useState('Saved');
  const note = useSaveState();
  const frameId = useId();

  const all = useMemo(() => sortPrices(prices.data ?? []), [prices.data]);
  const shown = useMemo(() => filterPrices(all, query), [all, query]);
  const replaced = useMemo(() => replacedByUserPrices(all), [all]);
  const own = all.filter((p) => !p.isBuiltin).length;
  const unpriced = (models.data ?? []).filter((m) => !m.hasStandardPrice);

  // A price that was just added is scrolled into view inside the table and marked for a moment.
  useEffect(() => {
    if (highlight === null) return;
    const frame = document.getElementById(frameId);
    const row = frame?.querySelector<HTMLElement>(`[data-price-id="${highlight}"]`);
    if (frame && row) frame.scrollTo({ top: row.offsetTop - (frame.clientHeight - row.offsetHeight) / 2, behavior: 'smooth' });
    const timer = window.setTimeout(() => setHighlight(null), 3200);
    return () => window.clearTimeout(timer);
  }, [highlight, shown, frameId]);

  const onSaved = async (input: UserPriceInput) => {
    const before = new Set(all.map((p) => p.id));
    const fresh = await listPrices(app.db);
    const created = fresh.find((p) => !p.isBuiltin && !before.has(p.id) && p.modelKey === input.modelKey);
    if (created) {
      if (filterPrices([created], query).length === 0) setQuery('');
      setHighlight(created.id);
    }
    app.notifyDataChanged();
    setSavedText('Price saved');
    note.markSaved();
  };

  return (
    <SettingsSection
      id="prices"
      title="Prices"
      description={
        <>
          <p>
            Equivalent API value is worked out from this table, in US dollars per million tokens. The built-in prices are Anthropic’s published API
            prices, read on {formatDay(RETRIEVED_ON)} from{' '}
            <a href={SOURCES.pricing} target="_blank" rel="noreferrer" className={EXTERNAL_LINK}>
              the pricing page
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
            ; prices of retired models come from their launch announcements.
          </p>
          <p>A price you enter takes precedence over a built-in one for the same model, tier and date.</p>
        </>
      }
    >
      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by model"
              aria-label="Filter prices by model name"
              autoComplete="off"
              className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
            />
            {query !== '' ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear the filter"
                className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 hover:bg-raised hover:text-ink"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <p className="text-[13px] text-ink-2" aria-live="polite">
            {!prices.data
              ? null
              : query.trim() !== ''
                ? `${formatInt(shown.length)} of ${plural(all.length, 'price')}`
                : own > 0
                  ? `${plural(all.length, 'price')}, ${formatInt(own)} entered by you`
                  : `${plural(all.length, 'price')}, all built-in`}
          </p>
          <div className="ml-auto flex items-center gap-3">
            <SaveNote state={note.state} savedText={savedText} />
            <Button onClick={() => setAdding(true)} disabled={!models.data || !prices.data}>
              <Plus className="size-4" aria-hidden="true" />
              Add a price
            </Button>
          </div>
        </div>

        <div className="mt-3.5">
          {prices.error ? (
            <ErrorNote title="The price table could not be read from the local database">{prices.error.message}</ErrorNote>
          ) : !prices.data ? (
            <div aria-busy="true">
              <Skeleton className="h-72" />
            </div>
          ) : shown.length === 0 ? (
            <EmptyState
              title={`No model matches “${query.trim()}”`}
              action={
                <Button size="sm" onClick={() => setQuery('')}>
                  Clear the filter
                </Button>
              }
            >
              The filter looks at model names such as “Sonnet 4.5”. Clear it to see all {formatInt(all.length)} prices.
            </EmptyState>
          ) : (
            <div className={cn('transition-opacity', prices.isPlaceholderData && 'opacity-70')}>
              <PriceTable rows={shown} replaced={replaced} highlight={highlight} onDelete={setRemoving} frameId={frameId} />
            </div>
          )}
        </div>

        <div className="mt-3 space-y-1 text-xs text-ink-3">
          {unpriced.length > 0 ? (
            <p>
              No price is on file for {new Intl.ListFormat('en', { type: 'conjunction' }).format(unpriced.map((m) => m.displayName))}. Usage on{' '}
              {unpriced.length === 1 ? 'it' : 'them'} is shown as unpriced until you add one.
            </p>
          ) : null}
          <p>Web searches recorded by exact sources are valued separately, at ${WEB_SEARCH_USD_PER_1000} per 1,000 searches.</p>
        </div>
      </Card>

      {adding && models.data ? <AddPriceDialog models={models.data} prices={all} onClose={() => setAdding(false)} onSaved={onSaved} /> : null}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Delete this price?"
        confirmLabel="Delete price"
        onConfirm={async () => {
          if (!removing) return;
          await deleteUserPrice(app.db, removing.id);
          app.notifyDataChanged();
          setSavedText('Price deleted');
          note.markSaved();
        }}
      >
        {removing ? (
          <>
            <p>
              Your {tierLabel(removing.priceTier).toLowerCase()} price for {removing.displayName} ({effectiveLabel(removing.effectiveFrom, removing.effectiveTo).toLowerCase()},{' '}
              {formatPrice(removing.input)} input and {formatPrice(removing.output)} output) will be removed.
            </p>
            <p>Usage it applied to goes back to the built-in price for that model and tier, or becomes unpriced if there is none.</p>
          </>
        ) : null}
      </ConfirmDialog>
    </SettingsSection>
  );
}
