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

import { folderProblem, lastSync, syncClaudeCodeFolder } from '@/features/import/background-sync';
import type { SqlDriver } from '@/db/driver';

const db = {} as SqlDriver;
const browserError = (name: string, message: string) => Object.assign(new Error(message), { name });

beforeEach(() => {
  store.clear();
  readRememberedFolder.mockReset();
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
