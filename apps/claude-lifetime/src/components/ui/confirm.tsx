'use client';

import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { Input } from './controls';
import { ErrorNote } from './feedback';
import { Dialog } from './overlay';
import { outcomeUnknown } from '@/db/driver';

interface ConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What exactly will happen, and what will be kept. */
  children: ReactNode;
  /** Names the action, e.g. "Delete import". */
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  /** When set, the user must type this word to enable the button. */
  typeToConfirm?: string;
  danger?: boolean;
}

/**
 * Confirmation for an action that removes data. It names what will be removed, and
 * for the most destructive actions asks the user to type a word first.
 */
export function ConfirmDialog(props: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={(next) => !busy && props.onOpenChange(next)} title={props.title}>
      {/* The dialog's content only exists while it is open, so this state starts fresh every time. */}
      <ConfirmBody {...props} busy={busy} setBusy={setBusy} />
    </Dialog>
  );
}

function ConfirmBody({
  onOpenChange,
  children,
  confirmLabel,
  onConfirm,
  typeToConfirm,
  danger = true,
  busy,
  setBusy,
}: ConfirmProps & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const blocked = typeToConfirm !== undefined && typed.trim().toLowerCase() !== typeToConfirm.toLowerCase();

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setBusy(false);
      onOpenChange(false);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="space-y-3 text-ink-2">{children}</div>
      {typeToConfirm !== undefined ? (
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-[13px] text-ink-2">
            Type <span className="font-medium text-ink">{typeToConfirm}</span> to confirm
          </span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      ) : null}
      {error ? (
        <ErrorNote title={outcomeUnknown(error) ? 'That may not have worked' : 'That did not work'} className="mt-4">
          {error}
        </ErrorNote>
      ) : null}
      <div className="-mx-5 -mb-4 mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={blocked} onClick={() => void confirm()}>
          {confirmLabel}
        </Button>
      </div>
    </>
  );
}
