'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { BASE_PATH, destroyDatabase } from '@/db/client';
import { deleteAllData } from '@/import/delete';
import { formatInt, plural } from '@/lib/format';
import { useApp } from '@/state/app';
import { useCoverage, usePeriods } from '@/state/queries';
import { CheckboxRow, SaveNote, SettingRow, SettingsSection, useSaveState } from './parts';
import { usePrices } from './queries';

function Ledger({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[13px] text-ink-2 marker:text-ink-3">{children}</ul>
    </div>
  );
}

/**
 * What the app keeps outside the SQL database: the selected date range in localStorage
 * and the import page's small IndexedDB store (src/lib/kv.ts) with the folder it
 * remembers. Erasing must take these along, or the "first visit" would still know them.
 */
async function clearDeviceState(): Promise<void> {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('claude-lifetime:')) window.localStorage.removeItem(key);
    }
  } catch {
    // storage is blocked, so nothing was kept there either
  }
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase('claude-lifetime-local');
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

function DeleteImportedRow() {
  const app = useApp();
  const coverage = useCoverage();
  const periods = usePeriods();
  const prices = usePrices();
  const [open, setOpen] = useState(false);
  const [subscriptions, setSubscriptions] = useState(false);
  const [customPrices, setCustomPrices] = useState(false);
  const done = useSaveState();

  const sources = coverage.data?.sources ?? [];
  const conversations = sources.reduce((sum, s) => sum + s.conversations, 0);
  const ownPeriods = periods.data ? periods.data.filter((p) => !p.isSynthetic).length : null;
  const ownPrices = prices.data ? prices.data.filter((p) => !p.isBuiltin).length : null;

  return (
    <SettingRow
      id="delete-imported"
      title="Delete all imported data"
      description={<p>Clears out everything that came from a file you imported, and the demo data. The app itself stays set up as it is.</p>}
    >
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Ledger title="Removed">
          <li>Every source and all of its imports</li>
          <li>Conversations and their message records</li>
          <li>Usage records, token estimates and reported costs</li>
          <li>The demo data and its subscription periods, if loaded</li>
        </Ledger>
        <Ledger title="Kept">
          <li>Your settings</li>
          <li>The built-in models and prices</li>
          <li>Your subscription history, unless you tick it in the next step</li>
          <li>Prices you entered, unless you tick them in the next step</li>
        </Ledger>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="danger"
          onClick={() => {
            setSubscriptions(false);
            setCustomPrices(false);
            setOpen(true);
          }}
        >
          Delete all imported data
        </Button>
        <SaveNote state={done.state} savedText="Deleted" />
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete all imported data?"
        confirmLabel="Delete imported data"
        typeToConfirm="DELETE"
        onConfirm={async () => {
          await deleteAllData(app.db, app.userId, { subscriptions, customPrices });
          app.notifyDataChanged();
          done.markSaved();
        }}
      >
        <p>
          {sources.length > 0
            ? `This removes ${plural(sources.length, 'source')} with ${plural(coverage.data?.importCount ?? 0, 'import')}${
                conversations > 0 ? `, ${formatInt(conversations)} conversations` : ''
              } and all of their usage records from this device.`
            : 'Nothing is imported at the moment, so only what you tick below is removed.'}
        </p>
        <div>
          <CheckboxRow
            checked={subscriptions}
            onChange={setSubscriptions}
            hint={ownPeriods === null ? undefined : ownPeriods === 0 ? 'You have not entered any.' : `${plural(ownPeriods, 'period')} you entered.`}
          >
            Also delete my subscription history
          </CheckboxRow>
          <CheckboxRow
            checked={customPrices}
            onChange={setCustomPrices}
            hint={ownPrices === null ? undefined : ownPrices === 0 ? 'You have not entered any.' : `${plural(ownPrices, 'price')} you entered.`}
          >
            Also delete prices I entered
          </CheckboxRow>
        </div>
        <p>
          Your settings are kept
          {subscriptions && customPrices ? '.' : subscriptions ? ', and so are the prices you entered.' : customPrices ? ', and so is your subscription history.' : ', and so are your subscription history and the prices you entered.'}{' '}
          This cannot be undone; a backup downloaded beforehand is the only way back.
        </p>
      </ConfirmDialog>
    </SettingRow>
  );
}

function EraseRow() {
  const [open, setOpen] = useState(false);
  return (
    <SettingRow
      id="erase-database"
      title="Erase the local database"
      description={<p>Removes the whole database from this browser and starts the app again as on a first visit.</p>}
    >
      <p className="max-w-[68ch] text-[13px] text-ink-2">
        Everything goes: imported data, your subscription history, the prices you entered and all settings, along with what this browser remembers
        about the app, such as the selected date range and a connected folder. Other open tabs of the app reload.
      </p>
      <Button variant="danger" className="mt-4" onClick={() => setOpen(true)}>
        Erase the local database
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Erase the local database?"
        confirmLabel="Erase everything"
        typeToConfirm="ERASE"
        onConfirm={async () => {
          await destroyDatabase();
          await clearDeviceState();
          // A full page load on purpose: this page's database connection no longer exists, so a client-side navigation would keep a dead app running.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(`${BASE_PATH}/`);
          // The page is on its way out; the dialog stays busy until it is.
          await new Promise<never>(() => undefined);
        }}
      >
        <p>
          This removes everything Claude Lifetime has stored in this browser: all imported data, your subscription history, the prices you entered
          and every setting.
        </p>
        <p>
          The app then opens its start page as it would on a first visit. This cannot be undone. Only a backup you downloaded earlier can bring the
          data back.
        </p>
      </ConfirmDialog>
    </SettingRow>
  );
}

export function DangerSection() {
  return (
    <SettingsSection
      id="delete-data"
      title="Delete data"
      description="Both actions remove data from this device for good. There is no undo here; a backup downloaded beforehand is the only way back."
    >
      <Card className="divide-y divide-line border-critical/30">
        <DeleteImportedRow />
        <EraseRow />
      </Card>
    </SettingsSection>
  );
}
