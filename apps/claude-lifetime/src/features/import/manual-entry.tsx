'use client';

import { useEffect, useState } from 'react';
import { addManualUsage, SettingsError } from '@/analytics/settings';
import { Button } from '@/components/ui/button';
import { Field, Input, Segmented } from '@/components/ui/controls';
import { ErrorNote } from '@/components/ui/feedback';
import { Dialog } from '@/components/ui/overlay';
import { todayInZone } from '@/lib/format';
import { useApp } from '@/state/app';
import { useCatalogModels } from '@/state/queries';

const tokens = (text: string): number | undefined => {
  const clean = text.replace(/[,\s_]/g, '');
  if (clean === '') return undefined;
  return /^\d+$/.test(clean) ? Number(clean) : Number.NaN;
};

/** One day of usage typed in by hand, for figures the user has from somewhere else. */
export function ManualEntryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const app = useApp();
  const models = useCatalogModels();
  const [date, setDate] = useState('');
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cacheRead, setCacheRead] = useState('');
  const [cacheWrite, setCacheWrite] = useState('');
  const [confidence, setConfidence] = useState<'exact' | 'estimated'>('estimated');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDate(todayInZone(app.settings.timezone));
    setModel('');
    setInput('');
    setOutput('');
    setCacheRead('');
    setCacheWrite('');
    setConfidence('estimated');
    setNote('');
    setError(null);
  }, [open, app.settings.timezone]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await addManualUsage(app.db, app.userId, {
        date,
        model: model.trim() || null,
        inputTokens: tokens(input),
        outputTokens: tokens(output),
        cacheReadTokens: tokens(cacheRead),
        cacheWriteTokens: tokens(cacheWrite),
        confidence,
        note: note.trim() || null,
      });
      app.notifyDataChanged();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof SettingsError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title="Add usage by hand"
      description="For a figure you have from somewhere else, such as a usage page you can read but not export. It is stored as its own import, so you can delete it again."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save entry
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Day">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
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
        {/* Lets Enter submit the form from any field. */}
        <button type="submit" hidden />
      </form>
      {error ? (
        <ErrorNote title="The entry was not saved" className="mt-4">
          {error}
        </ErrorNote>
      ) : null}
    </Dialog>
  );
}
