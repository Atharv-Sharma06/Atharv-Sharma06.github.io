'use client';

import { Segmented } from '@/components/ui/controls';
import { Tooltip } from '@/components/ui/overlay';
import { useApp } from '@/state/app';

const OPTIONS = [
  { value: 'processed', label: 'Processed' },
  { value: 'new', label: 'New' },
] as const;

/** The switch between processed and new tokens, as both places that offer it show it. */
function BasisSegmented({ className }: { className?: string }) {
  const { settings, saveSettings } = useApp();
  return (
    <Segmented
      label="Token basis"
      value={settings.basis}
      onChange={(basis) => void saveSettings({ basis })}
      options={[...OPTIONS]}
      className={className}
    />
  );
}

/** The switch in the top bar, explained on hover. */
export function BasisToggle() {
  return (
    <Tooltip
      content={
        <span>
          <strong className="font-medium">Processed</strong> counts everything the model read and wrote, including context that is re-read on every turn.{' '}
          <strong className="font-medium">New</strong> counts each piece of content once.
        </span>
      }
      side="bottom"
    >
      <span>
        <BasisSegmented />
      </span>
    </Tooltip>
  );
}

/**
 * The same switch in the menu, for screens too narrow to fit it in the top bar. A touch
 * screen has no hover, so the explanation the top bar keeps in a tooltip is written out.
 */
export function MenuBasisSwitch() {
  return (
    <div className="border-t border-line px-4 py-3">
      <p className="text-xs font-medium text-ink-2">Token basis</p>
      <BasisSegmented className="mt-1.5" />
      <p className="mt-2 text-xs text-ink-3">
        Processed counts everything the model read and wrote, including context that is re-read on every turn. New counts each piece of content
        once.
      </p>
    </div>
  );
}
