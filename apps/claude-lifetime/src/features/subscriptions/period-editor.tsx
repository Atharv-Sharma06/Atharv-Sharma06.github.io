'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { PLANS, planLabel, savePeriod, type SubscriptionError, type SubscriptionPeriod } from '@/analytics/subscriptions';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/controls';
import { ErrorNote } from '@/components/ui/feedback';
import { Dialog } from '@/components/ui/overlay';
import { formatDay, formatDayRange, todayInZone } from '@/lib/format';
import { useApp } from '@/state/app';
import {
  emptyPeriodForm, endDateResolvingOverlap, formToInput, periodToForm, periodToInput, validatePeriodForm, type PeriodFormField, type PeriodFormValues,
} from './logic';
import { outcomeUnknown } from '@/db/driver';

export type EditorTarget =
  | { kind: 'add'; dates?: { startDate: string; lastDate: string | null } }
  | { kind: 'edit'; period: SubscriptionPeriod };

interface Failure {
  message: string;
  /** The period the entered dates collide with, and the start date that was entered at the time. */
  conflict: SubscriptionPeriod | null;
  startDate: string;
}

/** Errors cross a worker-backed transaction on their way here, so they are recognised by name rather than by class. */
const isSubscriptionError = (error: unknown): error is SubscriptionError => error instanceof Error && error.name === 'SubscriptionError';

/**
 * Dialog for adding or changing one subscription period. Mount it only while it is
 * open, with a fresh `key` each time, so every visit starts from the stored values.
 */
export function PeriodEditor({
  target,
  onClose,
  onSaved,
  onDelete,
}: {
  target: EditorTarget;
  onClose: () => void;
  onSaved: (period: SubscriptionPeriod) => void;
  /** Asks to delete the period being edited; the caller confirms it. */
  onDelete: (period: SubscriptionPeriod) => void;
}) {
  const app = useApp();
  const formId = useId();
  const editing = target.kind === 'edit' ? target.period : null;
  const [values, setValues] = useState<PeriodFormValues>(() => (target.kind === 'edit' ? periodToForm(target.period) : emptyPeriodForm(target.dates)));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PeriodFormField, string>>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const failureNote = useRef<HTMLDivElement | null>(null);
  const form = useRef<HTMLFormElement | null>(null);

  // The dialog puts the focus on its close button, the first control it contains. A form
  // is opened to be filled in, so the focus moves on to its first field once that has happened.
  useEffect(() => {
    const frame = requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('button, input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // On a small screen the note can appear below the visible part of the form.
  useEffect(() => {
    if (failure) failureNote.current?.scrollIntoView({ block: 'nearest' });
  }, [failure]);

  const set = (field: keyof PeriodFormValues, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    if (field in fieldErrors) setFieldErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  // After an overlap with a plan that is still running, offer the usual fix: end that plan the day before.
  const conflict = failure?.conflict ?? null;
  const endConflictOn = conflict && failure?.startDate === values.startDate ? endDateResolvingOverlap(conflict, values.startDate) : null;

  const save = async (endOtherPeriodFirst: boolean) => {
    const problems = validatePeriodForm(values, todayInZone(app.settings.timezone));
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    setFailure(null);
    let endedOther = false;
    try {
      if (endOtherPeriodFirst && conflict && endConflictOn) {
        // Only the end date of the other period changes. A demo period stays demo data, so
        // removing the demo data still removes it; only editing that period itself makes it one's own.
        await savePeriod(app.db, app.userId, app.settings.timezone, { ...periodToInput(conflict), lastDate: endConflictOn }, { keepSynthetic: true });
        endedOther = true;
      }
      onSaved(await savePeriod(app.db, app.userId, app.settings.timezone, formToInput(values, editing?.id)));
    } catch (error) {
      // The other period may already have been ended: every view has to re-read either way.
      if (endedOther) app.notifyDataChanged();
      setFailure({
        message: error instanceof Error ? error.message : String(error),
        conflict: isSubscriptionError(error) && error.code === 'overlap' ? (error.conflict ?? null) : null,
        startDate: values.startDate,
      });
    } finally {
      setBusy(false);
    }
  };

  const planOptions = PLANS.map((plan) => ({ value: plan.key, label: plan.label }));
  // A plan key that is not in the list (entered elsewhere) stays selectable instead of being silently replaced.
  if (values.planKey !== '' && !PLANS.some((plan) => plan.key === values.planKey)) planOptions.push({ value: values.planKey, label: planLabel(values.planKey) });
  const chosenPlan = values.planKey === '' ? 'Max 20x' : planLabel(values.planKey);

  const timezoneNote = `Days are calendar days in your timezone, ${app.settings.timezone}.`;
  const description =
    target.kind === 'edit'
      ? `Usage is matched to a plan by date, so changing the dates re-assigns the usage of those days at once. ${timezoneNote}`
      : target.dates
        ? `The dates are those of the stretch with no recorded plan${target.dates.lastDate ? `, ${formatDayRange(target.dates.startDate, target.dates.lastDate)}` : ''}. Change them if the plan covered only part of it. ${timezoneNote}`
        : `Usage is matched to this plan by date; nothing in your imported data is changed. ${timezoneNote}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={editing ? 'Edit period' : 'Add period'}
      description={description}
      size="lg"
      footer={
        <>
          {editing ? (
            <Button variant="danger" className="mr-auto" disabled={busy} onClick={() => onDelete(editing)}>
              Delete period
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            Save period
          </Button>
        </>
      }
    >
      <form
        ref={form}
        id={formId}
        noValidate
        className="grid gap-x-4 gap-y-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        {editing?.isSynthetic ? (
          <p className="rounded-[var(--radius-control)] border border-line bg-raised px-3 py-2 text-[13px] text-ink-2 sm:col-span-2">
            This period came with the synthetic demo data. Saving it makes it a period of your own: it then stays when the demo data is removed.
          </p>
        ) : null}

        <Field label="Plan" error={fieldErrors.planKey}>
          <Select label="Plan" value={values.planKey === '' ? undefined : values.planKey} onChange={(value) => set('planKey', value)} options={planOptions} placeholder="Choose a plan" className="w-full" />
        </Field>
        <Field label="Label (optional)" hint="Shown instead of the plan name.">
          <Input value={values.label} onChange={(event) => set('label', event.target.value)} placeholder={`${chosenPlan} (annual)`} maxLength={60} autoComplete="off" />
        </Field>

        <Field label="Start date" error={fieldErrors.startDate} hint="The first day on this plan.">
          <Input
            type="date"
            value={values.startDate}
            max={values.lastDate || undefined}
            onChange={(event) => set('startDate', event.target.value)}
            aria-invalid={fieldErrors.startDate || conflict ? true : undefined}
          />
        </Field>
        <Field label="End date (optional)" error={fieldErrors.lastDate} hint="The last day. Leave it empty while the plan is active.">
          <Input
            type="date"
            value={values.lastDate}
            min={values.startDate || undefined}
            onChange={(event) => set('lastDate', event.target.value)}
            aria-invalid={fieldErrors.lastDate || conflict ? true : undefined}
          />
        </Field>

        <Field label="Monthly price (optional)" error={fieldErrors.monthlyPrice} hint="Used to add up what your subscriptions cost.">
          <Input value={values.monthlyPrice} onChange={(event) => set('monthlyPrice', event.target.value)} inputMode="decimal" placeholder="20" autoComplete="off" />
        </Field>
        <Field label="Currency" error={fieldErrors.currency} hint="Three-letter code, such as USD or EUR.">
          <Input value={values.currency} onChange={(event) => set('currency', event.target.value.toUpperCase())} maxLength={3} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
        </Field>

        <Field label="Notes (optional)" className="sm:col-span-2">
          <Textarea value={values.notes} onChange={(event) => set('notes', event.target.value)} rows={2} maxLength={500} className="min-h-16" />
        </Field>

        {failure ? (
          <div ref={failureNote} className="sm:col-span-2">
            <ErrorNote title={outcomeUnknown(failure.message) ? 'The period may not have been saved' : 'The period was not saved'}>
              <p>{failure.message}</p>
              {conflict && endConflictOn ? (
                <Button size="sm" className="mt-3" loading={busy} onClick={() => void save(true)}>
                  End {planLabel(conflict.planKey, conflict.label)} on {formatDay(endConflictOn)} and save
                </Button>
              ) : null}
            </ErrorNote>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
