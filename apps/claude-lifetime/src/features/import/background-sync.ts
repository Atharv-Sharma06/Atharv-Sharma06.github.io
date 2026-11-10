'use client';

import { ImportError } from '@/core/types';
import type { SqlDriver } from '@/db/driver';
import { ImportSession } from '@/import/session';
import { kvGet, kvSet } from '@/lib/kv';
import { readRememberedFolder } from './local-files';

const LAST_SYNC_KEY = 'claude-code-last-sync';

export interface SyncOutcome {
  at: number;
  /** Model requests newly counted by this sync. */
  added: number;
  /** Set when the sync failed, with the reason for the user. */
  problem?: string;
}

/**
 * How a sync ended. Only `done` means the folder was read; the others say why it was
 * not, so each can be told apart on screen.
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
  const reading = await readRememberedFolder(ask);
  if (reading.status === 'no_folder') return { status: 'no_folder' };
  if (reading.status === 'no_permission') return { status: 'no_permission', folder: reading.name };
  const { folder, source } = reading;
  const session = new ImportSession(db, userId);
  let outcome: SyncOutcome;
  try {
    if (folder.files.length === 0) {
      outcome = { at: Date.now(), added: 0, problem: `No transcripts were found in “${folder.name}”.` };
    } else {
      const detected = await session.detect(folder.files);
      if (detected.parser !== 'claude-code') throw new ImportError(`“${folder.name}” no longer looks like a Claude Code folder.`, 'unknown_format');
      const prepared = await session.prepare(folder.files, detected, { ...source });
      const added = prepared.preview.requests?.new ?? prepared.preview.usageRows.new;
      // An import with nothing new is still committed: it records which files were read, so the next sync can skip them.
      await session.commit(prepared);
      outcome = { at: Date.now(), added };
    }
  } catch (error) {
    // Another import holds the staging tables: not a failure of this folder, and nothing to record about it.
    if (error instanceof ImportError && error.code === 'import_in_progress') return { status: 'busy' };
    outcome = { at: Date.now(), added: 0, problem: error instanceof Error ? error.message : String(error) };
  } finally {
    await session.dispose();
  }
  await kvSet(LAST_SYNC_KEY, outcome).catch(() => undefined);
  return { status: 'done', outcome };
}
