'use client';

import { Button } from '@/components/ui/button';
import { ErrorNote, Skeleton, Spinner } from '@/components/ui/feedback';
import type { BootPhase } from '@/db/client';
import { NewerSchemaError } from '@/db/migrate';

const PHASE_TEXT: Record<BootPhase, string> = {
  starting: 'Opening the database stored in this browser…',
  migrating: 'Preparing the database…',
  ready: 'Reading your data…',
};

export function BootScreen({ phase }: { phase: BootPhase }) {
  return (
    <div aria-busy="true">
      <p className="flex items-center gap-2 text-[13px] text-ink-2" role="status">
        <Spinner className="size-3.5" />
        {PHASE_TEXT[phase]}
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-3" aria-hidden="true">
        <Skeleton className="h-40 md:col-span-2" />
        <Skeleton className="h-40" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="mt-4 h-72" />
    </div>
  );
}

/**
 * Shown when the stored data was already upgraded by a newer version of the app than
 * the one this page is running, typically a copy of the page the browser had kept.
 * Trying again with the same code cannot help, so the only action is to load the page
 * anew, which fetches the current version.
 */
function NewerVersionNeeded({ error }: { error: Error }) {
  return (
    <div className="max-w-[68ch]">
      <h1 className="text-xl font-medium">This page is running an older version of the app</h1>
      <p className="mt-2 text-ink-2" role="alert">
        This data was last opened by a newer version of the app. Reload the page to get that version.
      </p>
      <p className="mt-2 text-ink-2">
        Nothing was changed, and your data is still stored in this browser. If you see this again after reloading, wait a few minutes and reload once
        more.
      </p>
      <Button variant="primary" className="mt-5" onClick={() => window.location.reload()}>
        Reload the page
      </Button>
      <p className="mt-5 text-[13px] text-ink-3">
        Technical detail: <code className="break-words">{error.message}</code>
      </p>
    </div>
  );
}

export function BootError({ error, retry }: { error: Error; retry(): void }) {
  if (error instanceof NewerSchemaError) return <NewerVersionNeeded error={error} />;
  return (
    <div className="max-w-[68ch]">
      <h1 className="text-xl font-medium">The local database could not be opened</h1>
      <p className="mt-2 text-ink-2">
        Claude Lifetime keeps all of your data in this browser, in a PostgreSQL database stored with IndexedDB. Opening it failed, so nothing can be
        shown yet.
      </p>
      <ul className="mt-4 list-disc space-y-1.5 pl-5 text-ink-2">
        <li>Private or incognito windows often block site storage. Open the page in a regular window.</li>
        <li>Check that this site is allowed to store data, and that the device has free disk space.</li>
        <li>Use a current version of Chrome, Edge, Firefox or Safari. WebAssembly and IndexedDB are required.</li>
      </ul>
      <ErrorNote title="Technical detail" className="mt-5">
        <code className="break-words text-[13px]">{error.message || String(error)}</code>
      </ErrorNote>
      <Button variant="primary" className="mt-5" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

/** Shown in a tab while another tab erases the database. The tab reloads by itself when that is done. */
export function Paused() {
  return (
    <div className="max-w-[68ch]" role="status">
      <h1 className="text-xl font-medium">Your data is being erased in another tab</h1>
      <p className="mt-2 text-ink-2">
        This tab has closed its connection to the database so that the other one can finish. It reloads by itself when that is done.
      </p>
      <Button className="mt-5" onClick={() => window.location.reload()}>
        Reload now
      </Button>
    </div>
  );
}
