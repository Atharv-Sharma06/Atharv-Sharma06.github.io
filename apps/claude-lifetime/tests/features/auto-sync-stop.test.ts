import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading the remembered Claude Code folder automatically is a standing instruction for
 * this device. The app itself switches it off in two cases, and says so: when Claude
 * Code usage was deleted, and when a backup was restored. In both, leaving it on would
 * change the data again on the next visit, without a preview.
 */
const store = new Map<string, unknown>();
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => store.get(key),
  kvSet: async (key: string, value: unknown) => void store.set(key, value),
  kvDelete: async (key: string) => void store.delete(key),
}));

import { autoStopNotice } from '@/features/import/import-page';
import {
  autoSyncEnabled,
  autoSyncStop,
  LAST_SYNC_KEY,
  setAutoSync,
  stopAutoSyncAfterDeletion,
  stopAutoSyncAfterRestore,
} from '@/features/import/local-files';

const FOLDER = 'claude-code-folder';

beforeEach(() => {
  store.clear();
  store.set(FOLDER, { kind: 'directory', name: 'projects' });
  store.set(LAST_SYNC_KEY, { at: 1, added: 14 });
});

describe('restoring a backup while the folder is read automatically', () => {
  it('switches automatic reading off and keeps the folder, so that the restored data stays as the backup has it', async () => {
    await setAutoSync(true);

    // Before the fix a restore left the switch on: the next visit added this computer's usage to the restored data.
    expect(await stopAutoSyncAfterRestore()).toBe(true);

    expect(await autoSyncEnabled()).toBe(false);
    expect(store.has(FOLDER)).toBe(true);
    expect(await autoSyncStop()).toMatchObject({ after: 'restore' });
    // What was on record about the last reading describes the data that was replaced.
    expect(store.has(LAST_SYNC_KEY)).toBe(false);
  });

  it('records no switching off when the switch was off, and still drops the record of the last reading', async () => {
    expect(await stopAutoSyncAfterRestore()).toBe(false);
    expect(await autoSyncStop()).toBeNull();
    expect(store.has(LAST_SYNC_KEY)).toBe(false);
  });

  it('is forgotten as soon as the person sets the switch', async () => {
    await setAutoSync(true);
    await stopAutoSyncAfterRestore();
    await setAutoSync(true);
    expect(await autoSyncEnabled()).toBe(true);
    expect(await autoSyncStop()).toBeNull();
  });
});

describe('why automatic reading is off', () => {
  it('is kept apart for a deletion and a restore, and a record from before the two were told apart counts as a deletion', async () => {
    await setAutoSync(true);
    await stopAutoSyncAfterDeletion();
    expect(await autoSyncStop()).toMatchObject({ after: 'deletion' });
    // A deletion leaves the record of the last reading alone.
    expect(store.has(LAST_SYNC_KEY)).toBe(true);

    store.set('claude-code-auto-sync-stopped', 1_794_300_000_000);
    expect(await autoSyncStop()).toEqual({ at: 1_794_300_000_000, after: 'deletion' });
  });

  it('is said in words that name the reason', () => {
    expect(autoStopNotice({ at: 0, after: 'restore' }, '2 hours ago')).toBe(
      'Automatic reading was switched off 2 hours ago, when a backup was restored. Left on, it would have added this computer’s Claude Code usage to the restored data the next time the app opened. Switch it back on whenever you want the folder read by itself again.',
    );
    expect(autoStopNotice({ at: 0, after: 'deletion' }, 'yesterday')).toBe(
      'Automatic reading was switched off yesterday, when Claude Code usage was deleted. Left on, it would have added the deleted usage again the next time the app opened. Switch it back on whenever you want the folder read by itself again.',
    );
  });
});
