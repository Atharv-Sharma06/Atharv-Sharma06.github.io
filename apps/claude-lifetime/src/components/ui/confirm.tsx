'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './button';
import { Input } from './controls';
import { ErrorNote } from './feedback';
import { Dialog } from './overlay';

/**
 * Confirmation for an action that removes data. It names what will be removed, and
 * for the most destructive actions asks the user to type a word first.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  onConfirm,
  typeToConfirm,
  danger = true,
}: {
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
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
    }
  }, [open]);

  const blocked = typeToConfirm !== undefined && typed.trim().toLowerCase() !== typeToConfirm.toLowerCase();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={blocked}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
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
        <ErrorNote title="That did not work" className="mt-4">
          {error}
        </ErrorNote>
      ) : null}
    </Dialog>
  );
}
