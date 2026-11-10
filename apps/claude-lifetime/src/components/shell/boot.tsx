'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorNote, Skeleton, Spinner } from '@/components/ui/feedback';
import { DatabaseBusyError, type BootPhase } from '@/db/client';
import { DatabaseMovedError } from '@/db/driver';
import { NewerSchemaError } from '@/db/migrate';

const PHASE_TEXT: Record<BootPhase, string> = {
  starting: 'Opening the database stored in this browser…',
  migrating: 'Preparing the database…',
  ready: 'Reading your data…',
};

/** After this long in one phase, the start-up screen says what the tab is probably waiting for. */
export const SLOW_START_MS = 8_000;

/** Whether `phase` has lasted longer than a start normally takes. */
function useSlowStart(phase: BootPhase): boolean {
  const [slowPhase, setSlowPhase] = useState<BootPhase | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSlowPhase(phase), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  return slowPhase === phase;
}

/**
 * What a start that takes long is probably waiting for. The database is shared by the
 * tabs of the app and does one thing at a time, so a tab that opens while another one
 * saves a large import waits for that, in either of the first two phases.
 */
const SLOW_TEXT: Record<BootPhase, string | null> = {
  starting:
    'This is taking longer than usual. Either the database engine (about 5.5 MB) is still being downloaded, or another tab of Claude Lifetime is in the middle of an import or a backup; this tab goes on when that is done.',
  migrating:
    'This tab is waiting for its turn at the database, which the tabs of Claude Lifetime share. Another tab is probably in the middle of an import or a backup; this one goes on when that is done.',
  ready: null,
};

export function BootScreen({ phase }: { phase: BootPhase }) {
  return <BootProgress phase={phase} slow={useSlowStart(phase)} />;
}

/** The start-up screen. `slow` is true once the phase has lasted longer than a start normally takes. */
export function BootProgress({ phase, slow }: { phase: BootPhase; slow: boolean }) {
  return (
    <div aria-busy="true">
      <div role="status">
        <p className="flex items-center gap-2 text-[13px] text-ink-2">
          <Spinner className="size-3.5" />
          {PHASE_TEXT[phase]}
        </p>
        {slow && SLOW_TEXT[phase] && <p className="mt-2 max-w-[68ch] text-[13px] text-ink-2">{SLOW_TEXT[phase]}</p>}
      </div>
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

/**
 * Shown when the database is there but this tab did not get to it: another tab holds it
 * and did not answer in time, or the tab that held it kept going away while this one was
 * starting. Storage, the browser and disk space have nothing to do with either.
 */
function HeldByAnotherTab({ error, retry }: { error: Error; retry(): void }) {
  const busy = error instanceof DatabaseBusyError;
  return (
    <div className="max-w-[68ch]">
      <h1 className="text-xl font-medium">{busy ? 'The database did not answer' : 'The database changed hands while this tab was starting'}</h1>
      <p className="mt-2 text-ink-2" role="alert">
        {busy
          ? 'The tabs of Claude Lifetime share one database in this browser and take turns at it. This tab waited for its turn and did not get one in time.'
          : 'The tabs of Claude Lifetime share one database in this browser. The tab that held it was closed or reloaded several times while this one was starting, so this tab stopped trying.'}
      </p>
      {busy && (
        <ul className="mt-4 list-disc space-y-1.5 pl-5 text-ink-2">
          <li>If another tab is in the middle of a large import or a backup, let it finish, then try again.</li>
          <li>Otherwise reload the other open tabs of Claude Lifetime, or close them, then try again.</li>
        </ul>
      )}
      <p className="mt-4 text-ink-2">Nothing was changed, and your data is still stored in this browser.</p>
      <Button variant="primary" className="mt-5" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

export function BootError({ error, retry }: { error: Error; retry(): void }) {
  if (error instanceof NewerSchemaError) return <NewerVersionNeeded error={error} />;
  if (error instanceof DatabaseBusyError || error instanceof DatabaseMovedError) return <HeldByAnotherTab error={error} retry={retry} />;
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
