'use client';

import type { ImportFile } from '@/core/types';
import { kvDelete, kvGet, kvSet } from '@/lib/kv';

/**
 * Access to folders and files on the user's computer. Everything here happens on
 * the user's explicit action through the browser's own pickers; the app can only read
 * what was picked, and the browser asks again before a remembered folder is re-read.
 */
type PermissionState = 'granted' | 'denied' | 'prompt';

interface FsHandle {
  kind: 'file' | 'directory';
  name: string;
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
}
interface FsFileHandle extends FsHandle {
  kind: 'file';
  getFile(): Promise<File>;
}
interface FsDirectoryHandle extends FsHandle {
  kind: 'directory';
  values(): AsyncIterable<FsFileHandle | FsDirectoryHandle>;
}
type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' }) => Promise<FsDirectoryHandle>;
  showOpenFilePicker?: (options?: { id?: string; multiple?: boolean }) => Promise<FsFileHandle[]>;
};

export const canPickFolders = () => typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';

const FOLDER_KEY = 'claude-code-folder';
const AUTO_SYNC_KEY = 'claude-code-auto-sync';

/** Folders inside a Claude Code directory that never hold transcripts and can be large. */
const SKIP_DIRECTORIES = new Set(['tool-results', 'mcp-tasks', 'node_modules', '.git', 'shell-snapshots', 'statsig', 'todos', 'ide', 'plugins', 'debug']);
const MAX_FILES = 200_000;

async function walk(directory: FsDirectoryHandle, prefix: string, out: ImportFile[]): Promise<void> {
  for await (const entry of directory.values()) {
    if (out.length >= MAX_FILES) return;
    const path = `${prefix}/${entry.name}`;
    if (entry.kind === 'directory') {
      if (!SKIP_DIRECTORIES.has(entry.name)) await walk(entry, path, out);
    } else if (/\.jsonl(\.superseded-[^/]*)?$/i.test(entry.name)) {
      const file = await entry.getFile();
      out.push({ name: file.name, path, size: file.size, lastModified: file.lastModified, blob: file });
    }
  }
}

/** The transcript files (.jsonl) below a folder, with their paths relative to it. */
export async function readTranscriptFolder(handle: FsDirectoryHandle): Promise<ImportFile[]> {
  const out: ImportFile[] = [];
  await walk(handle, handle.name, out);
  return out;
}

export interface PickedFolder {
  name: string;
  files: ImportFile[];
}

/** Opens the browser's folder picker. Resolves to null when the user closes it. */
export async function pickClaudeCodeFolder(): Promise<PickedFolder | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  let handle: FsDirectoryHandle;
  try {
    handle = await picker.call(window, { id: 'claude-code', mode: 'read' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
  // Remembered so "Sync again" can re-read the same folder later. Handles can only be stored in IndexedDB.
  await kvSet(FOLDER_KEY, handle).catch(() => undefined);
  return { name: handle.name, files: await readTranscriptFolder(handle) };
}

export interface RememberedFolder {
  name: string;
  /** Whether the browser will let the app read it without asking again. */
  permission: PermissionState;
}

export async function rememberedFolder(): Promise<RememberedFolder | null> {
  const handle = await kvGet<FsDirectoryHandle>(FOLDER_KEY);
  if (!handle || handle.kind !== 'directory') return null;
  const permission = (await handle.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as const)) ?? 'prompt';
  return { name: handle.name, permission };
}

/**
 * Re-reads the remembered folder. With `ask`, the browser may show its permission
 * prompt (this needs a click); without it the folder is only read when permission is
 * already granted. Resolves to null when there is no folder or no permission.
 */
export async function readRememberedFolder(ask: boolean): Promise<PickedFolder | null> {
  const handle = await kvGet<FsDirectoryHandle>(FOLDER_KEY);
  if (!handle || handle.kind !== 'directory') return null;
  let permission = (await handle.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as const)) ?? 'prompt';
  if (permission !== 'granted' && ask) permission = (await handle.requestPermission?.({ mode: 'read' }).catch(() => 'denied' as const)) ?? 'denied';
  if (permission !== 'granted') return null;
  return { name: handle.name, files: await readTranscriptFolder(handle) };
}

export async function forgetFolder(): Promise<void> {
  await kvDelete(FOLDER_KEY);
  await kvDelete(AUTO_SYNC_KEY);
}

export async function autoSyncEnabled(): Promise<boolean> {
  return (await kvGet<boolean>(AUTO_SYNC_KEY)) === true;
}

export async function setAutoSync(enabled: boolean): Promise<void> {
  if (enabled) await kvSet(AUTO_SYNC_KEY, true);
  else await kvDelete(AUTO_SYNC_KEY);
}
