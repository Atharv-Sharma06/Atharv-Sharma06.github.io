import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading the remembered Claude Code folder runs unattended when the app opens. Whatever
 * the browser answers, it must end in an outcome the import page can show, never in an
 * error nobody catches.
 */
const store = new Map<string, unknown>();
vi.mock('@/lib/kv', () => ({
  kvGet: async (key: string) => store.get(key),
  kvSet: async (key: string, value: unknown) => void store.set(key, value),
  kvDelete: async (key: string) => void store.delete(key),
}));
const readRememberedFolder = vi.fn();
vi.mock('@/features/import/local-files', () => ({
  LAST_SYNC_KEY: 'claude-code-last-sync',
  readRememberedFolder: (ask: boolean) => readRememberedFolder(ask),
}));

/** How saving ends for each reading of the folder, in order; and every session that was opened for one. */
const saving = vi.hoisted(() => ({ outcomes: [] as Array<'moved' | 'saved'>, sessions: [] as Array<{ disposed: boolean }> }));
vi.mock('@/import/session', async () => {
  const { DatabaseMovedError } = await import('@/db/driver');
  return {
    ImportSession: class {
      disposed = false;
      constructor() {
        saving.sessions.push(this);
      }
      async detect() {
        return { parser: 'claude-code', fileIndexes: [0] };
      }
      async prepare() {
        return { preview: { requests: { new: 3 }, usageRows: { new: 3 } } };
      }
      async commit() {
        if (saving.outcomes.shift() === 'moved') throw new DatabaseMovedError();
        return {};
      }
      async dispose() {
        this.disposed = true;
      }
    },
  };
});

import { folderProblem, lastSync, syncClaudeCodeFolder } from '@/features/import/background-sync';
import type { SqlDriver } from '@/db/driver';

const db = {} as SqlDriver;
const browserError = (name: string, message: string) => Object.assign(new Error(message), { name });

beforeEach(() => {
  store.clear();
  readRememberedFolder.mockReset();
  saving.outcomes = [];
  saving.sessions = [];
});

describe('a remembered folder that cannot be opened', () => {
  it('ends as an attempt that did not work, with the reason, instead of an uncaught error', async () => {
    // what Chrome raises for a folder that was moved, renamed or deleted, or whose drive is gone
    readRememberedFolder.mockRejectedValue(browserError('NotFoundError', 'A requested file or directory could not be found at the time an operation was processed.'));
    const result = await syncClaudeCodeFolder(db, 1, false);
    expect(result).toMatchObject({ status: 'done', outcome: { added: 0 } });
    const problem = result.status === 'done' ? result.outcome.problem : undefined;
    expect(problem).toBe(
      'The remembered folder could not be found any more. It may have been moved, renamed or deleted, or its drive is not connected. Choose the folder again.',
    );
    // on record, so the import page can say so after an unattended run
    expect(await lastSync()).toMatchObject({ added: 0, problem });
  });

  it('gives the browser\'s own words for any other failure', () => {
    expect(folderProblem(browserError('InvalidStateError', 'The handle is no longer valid.'))).toBe(
      'The remembered folder could not be read (The handle is no longer valid.). Choose the folder again.',
    );
    expect(folderProblem('boom')).toBe('The remembered folder could not be read (boom). Choose the folder again.');
  });

  it('records nothing when no attempt was made', async () => {
    readRememberedFolder.mockResolvedValue({ status: 'no_folder' });
    expect(await syncClaudeCodeFolder(db, 1, false)).toEqual({ status: 'no_folder' });
    readRememberedFolder.mockResolvedValue({ status: 'no_permission', name: 'projects' });
    expect(await syncClaudeCodeFolder(db, 1, false)).toEqual({ status: 'no_permission', folder: 'projects' });
    expect(await lastSync()).toBeUndefined();
  });
});

describe('a reading during which the tab that held the database goes away', () => {
  const folder = { status: 'read', folder: { name: 'projects', files: [{ name: 'a.jsonl' }] }, source: { sourceRef: 'laptop', sourceLabel: 'Claude Code (laptop)' } };

  it('is done again by itself, since reading a folder twice adds nothing twice', async () => {
    readRememberedFolder.mockResolvedValue(folder);
    saving.outcomes = ['moved', 'saved'];

    const result = await syncClaudeCodeFolder(db, 1, false);

    // Before the fix the first failure was the outcome: nothing added, and a problem nobody was there to read.
    expect(result).toMatchObject({ status: 'done', outcome: { added: 3 } });
    expect(result.status === 'done' && result.outcome.problem).toBeUndefined();
    expect(saving.sessions).toHaveLength(2);
    expect(saving.sessions.every((session) => session.disposed)).toBe(true);
  });

  it('says what happened when it happens a second time, and leaves it at that', async () => {
    readRememberedFolder.mockResolvedValue(folder);
    saving.outcomes = ['moved', 'moved', 'saved'];

    const result = await syncClaudeCodeFolder(db, 1, false);

    expect(result).toMatchObject({ status: 'done', outcome: { added: 0 } });
    expect(result.status === 'done' && result.outcome.problem).toContain('The tab that held the database was closed or reloaded at that moment');
    expect(saving.sessions).toHaveLength(2);
    expect(await lastSync()).toMatchObject({ added: 0 });
  });
});
