'use client';

import { ImportError } from '@/core/types';
import { DatabaseMovedError, type SqlDriver } from '@/db/driver';
import { ImportSession } from '@/import/session';
import { kvGet, kvSet } from '@/lib/kv';
import { LAST_SYNC_KEY, readRememberedFolder, type FolderReading } from './local-files';

/** How an attempt to read the folder ended. With a `problem` it did not get as far as saving anything. */
export interface SyncOutcome {
  at: number;
  /** Model requests newly counted by this sync. */
  added: number;
  /** Set when the sync failed, with the reason for the user. */
  problem?: string;
}

/**
 * Why a remembered folder cannot be opened, in words for the person. The browser keeps
 * a reference to the folder, not the folder: when it was moved, renamed or deleted, or
 * its drive is not connected, reading it fails with a NotFoundError.
 */
export function folderProblem(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotFoundError') {
    return 'The remembered folder could not be found any more. It may have been moved, renamed or deleted, or its drive is not connected. Choose the folder again.';
  }
  return `The remembered folder could not be read (${error instanceof Error ? error.message : String(error)}). Choose the folder again.`;
}

/**
 * How a sync ended. `done` means an attempt was made and is on record, with its problem
 * when it failed; the others say why no attempt was made, so each can be told apart on screen.
 */
export type SyncResult =
  | { status: 'done'; outcome: SyncOutcome }
  | { status: 'no_folder' }
  | { status: 'no_permission'; folder: string }
  /** Another import is being prepared or is waiting at its preview, in this tab or another one. */
  | { status: 'busy' };

export const lastSync = () => kvGet<SyncOutcome>(LAST_SYNC_KEY);

/**
 * Reads the remembered Claude Code folder again and saves what is new, without a
 * preview. This only ever runs for a folder the user picked and for which the browser
 * has granted read access; when `ask` is false it never triggers a permission prompt.
 * The usage goes to the source the folder was first imported under. Every run that
 * adds something is a normal import: listed in the history, deletable.
 */
export async function syncClaudeCodeFolder(db: SqlDriver, userId: number, ask: boolean): Promise<SyncResult> {
  let reading: FolderReading;
  try {
    reading = await readRememberedFolder(ask);
  } catch (error) {
    // Nothing was read. That is worth keeping on record, because this also runs unattended when the app opens.
    const outcome: SyncOutcome = { at: Date.now(), added: 0, problem: folderProblem(error) };
    await kvSet(LAST_SYNC_KEY, outcome).catch(() => undefined);
    return { status: 'done', outcome };
  }
  if (reading.status === 'no_folder') return { status: 'no_folder' };
  if (reading.status === 'no_permission') return { status: 'no_permission', folder: reading.name };
  const { folder, source } = reading;
  /** One reading of the folder. 'moved' when the tab that held the database went away in the middle of it. */
  const attempt = async (): Promise<SyncOutcome | 'busy' | 'moved'> => {
    const session = new ImportSession(db, userId);
    try {
      if (folder.files.length === 0) return { at: Date.now(), added: 0, problem: `No transcripts were found in “${folder.name}”.` };
      const detected = await session.detect(folder.files);
      if (detected.parser !== 'claude-code') throw new ImportError(`“${folder.name}” no longer looks like a Claude Code folder.`, 'unknown_format');
      const prepared = await session.prepare(folder.files, detected, { ...source });
      const added = prepared.preview.requests?.new ?? prepared.preview.usageRows.new;
      // An import with nothing new is still committed: it records which files were read, so the next sync can skip them.
      await session.commit(prepared);
      return { at: Date.now(), added };
    } catch (error) {
      // Another import holds the staging tables: not a failure of this folder, and nothing to record about it.
      if (error instanceof ImportError && error.code === 'import_in_progress') return 'busy';
      if (error instanceof DatabaseMovedError) return 'moved';
      return { at: Date.now(), added: 0, problem: error instanceof Error ? error.message : String(error) };
    } finally {
      await session.dispose();
    }
  };
  let result = await attempt();
  // Reading the folder twice adds nothing twice, so after a move it is simply read again, by the tab that took over.
  if (result === 'moved') result = await attempt();
  if (result === 'busy') return { status: 'busy' };
  const outcome: SyncOutcome = result === 'moved' ? { at: Date.now(), added: 0, problem: new DatabaseMovedError().message } : result;
  await kvSet(LAST_SYNC_KEY, outcome).catch(() => undefined);
  return { status: 'done', outcome };
}
