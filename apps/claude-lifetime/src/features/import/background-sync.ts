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
  /** Set when the sync did not run or failed, with the reason for the user. */
  problem?: string;
}

export const lastSync = () => kvGet<SyncOutcome>(LAST_SYNC_KEY);

/**
 * Reads the remembered Claude Code folder again and saves what is new, without a
 * preview. This only ever runs for a folder the user picked and for which the browser
 * has granted read access; when `ask` is false it never triggers a permission prompt.
 * Every run that adds something is a normal import: listed in the history, deletable.
 */
export async function syncClaudeCodeFolder(db: SqlDriver, userId: number, ask: boolean): Promise<SyncOutcome | null> {
  const folder = await readRememberedFolder(ask);
  if (!folder) return null;
  const session = new ImportSession(db, userId);
  let outcome: SyncOutcome;
  try {
    if (folder.files.length === 0) {
      outcome = { at: Date.now(), added: 0, problem: `No transcripts were found in “${folder.name}”.` };
    } else {
      const detected = await session.detect(folder.files);
      if (detected.parser !== 'claude-code') throw new ImportError(`“${folder.name}” no longer looks like a Claude Code folder.`, 'unknown_format');
      const prepared = await session.prepare(folder.files, detected);
      const added = prepared.preview.requests?.new ?? prepared.preview.usageRows.new;
      // An import with nothing new is still committed: it records which files were read, so the next sync can skip them.
      await session.commit(prepared);
      outcome = { at: Date.now(), added };
    }
  } catch (error) {
    // Another tab is importing: not a failure, the next sync picks the files up.
    if (error instanceof ImportError && error.code === 'import_in_progress') return null;
    outcome = { at: Date.now(), added: 0, problem: error instanceof Error ? error.message : String(error) };
  } finally {
    await session.dispose();
  }
  await kvSet(LAST_SYNC_KEY, outcome).catch(() => undefined);
  return outcome;
}
