'use client';

import { useState } from 'react';
import { addManualUsage, MANUAL_ENTRY_FIRST_DAY, manualEntryLastDay, SettingsError, type ManualUsageResult } from '@/analytics/settings';
import { Button } from '@/components/ui/button';
import { Field, Input, Segmented } from '@/components/ui/controls';
import { ErrorNote } from '@/components/ui/feedback';
import { Dialog } from '@/components/ui/overlay';
import { todayInZone } from '@/lib/format';
import { useApp } from '@/state/app';
import { useCatalogModels, useCoverage } from '@/state/queries';
import { Notice } from './preview';
import { outcomeUnknown } from '@/db/driver';

const tokens = (text: string): number | undefined => {
  const clean = text.replace(/[,\s_]/g, '');
  if (clean === '') return undefined;
  return /^\d+$/.test(clean) ? Number(clean) : Number.NaN;
};

/**
 * One day of usage typed in by hand, for figures the user has from somewhere else.
 * `onSaved` is told how the save went once the entry is stored, so the page can say what
 * the closed dialog no longer can: that the demo data went, or that the device's storage refused the change.
 */
export function ManualEntryDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (result: ManualUsageResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title="Add usage by hand"
      description="For a figure you have from somewhere else, such as a usage page you can read but not export. It is stored as its own import, so you can delete it again."
      size="lg"
    >
      {/* The form only exists while the dialog is open, so it starts empty every time. */}
      <ManualEntryForm busy={busy} setBusy={setBusy} close={() => onOpenChange(false)} onSaved={onSaved} />
    </Dialog>
  );
}

function ManualEntryForm({
  busy,
  setBusy,
  close,
  onSaved,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  close: () => void;
  onSaved?: (result: ManualUsageResult) => void;
}) {
  const app = useApp();
  const models = useCatalogModels();
  const coverage = useCoverage();
  const [date, setDate] = useState(() => todayInZone(app.settings.timezone));
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cacheRead, setCacheRead] = useState('');
  const [cacheWrite, setCacheWrite] = useState('');
  const [confidence, setConfidence] = useState<'exact' | 'estimated'>('estimated');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await addManualUsage(app.db, app.userId, {
        date,
        model: model.trim() || null,
        inputTokens: tokens(input),
        outputTokens: tokens(output),
        cacheReadTokens: tokens(cacheRead),
        cacheWriteTokens: tokens(cacheWrite),
        confidence,
        note: note.trim() || null,
      });
      // The entry is stored, whatever the result says about the device's storage: the dialog closes, so
      // that the same entry cannot be sent a second time, and the page reports what there is to report.
      app.notifyDataChanged();
      setBusy(false);
      close();
      onSaved?.(result);
    } catch (e) {
      setBusy(false);
      setError(e instanceof SettingsError || e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Day">
          <Input type="date" value={date} min={MANUAL_ENTRY_FIRST_DAY} max={manualEntryLastDay(app.settings.timezone)} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Model" hint="Leave empty if you do not know it. Unknown models are counted but not priced.">
          <Input value={model} onChange={(e) => setModel(e.target.value)} list="manual-entry-models" placeholder="claude-sonnet-4-5" autoComplete="off" spellCheck={false} />
          <datalist id="manual-entry-models">
            {(models.data ?? []).map((m) => (
              <option key={m.modelKey} value={m.modelKey}>
                {m.displayName}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Input tokens">
          <Input inputMode="numeric" value={input} onChange={(e) => setInput(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Output tokens">
          <Input inputMode="numeric" value={output} onChange={(e) => setOutput(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Cache read tokens">
          <Input inputMode="numeric" value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Cache write tokens">
          <Input inputMode="numeric" value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} placeholder="0" />
        </Field>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-[13px] text-ink-2">Where do these numbers come from?</span>
          <Segmented
            label="Confidence"
            value={confidence}
            onChange={setConfidence}
            options={[
              { value: 'estimated', label: 'My own estimate' },
              { value: 'exact', label: 'Copied from an official report' },
            ]}
            className="self-start"
          />
          <span className="text-xs text-ink-3">An entry marked as copied from a report counts as exact everywhere. Mark anything else as an estimate.</span>
        </div>
        <Field label="Note" hint="Optional. Shown in the import history." className="sm:col-span-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Where the figure is from" />
        </Field>
      </div>
      {coverage.data?.hasSyntheticData ? (
        <div className="mt-4">
          <Notice tone="warning">Saving this entry removes the synthetic demo data. Real and invented figures are never mixed.</Notice>
        </div>
      ) : null}
      {error ? (
        <ErrorNote title={outcomeUnknown(error) ? 'The entry may not have been saved' : 'The entry was not saved'} className="mt-4">
          {error}
        </ErrorNote>
      ) : null}
      <div className="-mx-5 -mb-4 mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Save entry
        </Button>
      </div>
    </form>
  );
}
