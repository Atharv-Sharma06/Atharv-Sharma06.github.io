'use client';

import { Button } from '@/components/ui/button';
import { ErrorNote, Skeleton, Spinner } from '@/components/ui/feedback';
import type { BootPhase } from '@/db/client';

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

export function BootError({ error, retry }: { error: Error; retry(): void }) {
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
