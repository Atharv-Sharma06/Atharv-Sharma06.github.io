import { ImportError } from '@/core/types';

/**
 * One import at a time, across every tab of the app.
 *
 * Parsed records wait in staging tables that belong to the single database session all
 * tabs share. Whoever writes to them must hold this lock for as long as the records
 * are there: from the first staged row until they are saved or thrown away. The lock
 * is a Web Lock, so it is released by the browser when its tab goes away.
 */
const LOCK_NAME = 'claude-lifetime:import';

/** Whether this page holds the lock. Covers environments without Web Locks, and saves asking when the answer is known. */
let heldHere = false;

/**
 * Takes the lock if it is free. Resolves to the function that releases it, or to null
 * when another import holds it, in this page or in another tab. Where Web Locks do not
 * exist (tests under Node) there are no other tabs, and only this page is considered.
 */
export function acquireImportLock(): Promise<(() => void) | null> {
  if (heldHere) return Promise.resolve(null);
  heldHere = true;
  let released = false;
  const releaseHere = () => {
    if (released) return;
    released = true;
    heldHere = false;
  };
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.request) return Promise.resolve(releaseHere);
  return new Promise((resolve) => {
    void locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        releaseHere();
        resolve(null);
        return undefined;
      }
      return new Promise<void>((release) =>
        resolve(() => {
          releaseHere();
          release();
        }),
      );
    });
  });
}

/**
 * Runs a short import (a manual entry, the demo dataset) as the only one. Refused with
 * code `import_in_progress` while another import is being prepared or is waiting at
 * its preview, here or in another tab: its staged records must not be touched.
 */
export async function asOnlyImport<T>(work: () => Promise<T>): Promise<T> {
  const release = await acquireImportLock();
  if (!release) {
    throw new ImportError(
      'Another import is being prepared or is waiting to be saved, in this tab or another one. Save or cancel it first, then try again.',
      'import_in_progress',
    );
  }
  try {
    return await work();
  } finally {
    release();
  }
}
