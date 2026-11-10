'use client';

import { useEffect, useState } from 'react';
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
/** The source the remembered folder is filed under, so every later reading lands in the same one. */
const FOLDER_SOURCE_KEY = 'claude-code-folder-source';
/** The name last typed into "Name of this computer". */
const COMPUTER_KEY = 'claude-code-computer';
const AUTO_SYNC_KEY = 'claude-code-auto-sync';
/** When automatic reading was switched off by a deletion, so the import page can say why the switch is off. */
const AUTO_SYNC_STOPPED_KEY = 'claude-code-auto-sync-stopped';

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

/**
 * Which source Claude Code usage is filed under: the label shown in the app and the
 * stable reference that identifies the source. Empty for the default source, "Claude
 * Code (this computer)".
 */
export interface FolderSource {
  sourceLabel?: string;
  sourceRef?: string;
}

export interface PickedFolder {
  name: string;
  files: ImportFile[];
}

/**
 * Opens the browser's folder picker. Resolves to null when the user closes it. The
 * folder is remembered together with the source it is imported under, so that reading
 * it again later adds to that same source and not to a second one.
 */
export async function pickClaudeCodeFolder(source: FolderSource = {}): Promise<PickedFolder | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  let handle: FsDirectoryHandle;
  try {
    handle = await picker.call(window, { id: 'claude-code', mode: 'read' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
  // Remembered so "Read the folder again" can re-read the same folder later. Handles can only be stored in IndexedDB.
  await kvSet(FOLDER_KEY, handle).catch(() => undefined);
  await kvSet(FOLDER_SOURCE_KEY, { ...source }).catch(() => undefined);
  return { name: handle.name, files: await readTranscriptFolder(handle) };
}

export interface RememberedFolder {
  name: string;
  /** Whether the browser will let the app read it without asking again. */
  permission: PermissionState;
  source: FolderSource;
}

async function folderSource(): Promise<FolderSource> {
  const stored = await kvGet<FolderSource>(FOLDER_SOURCE_KEY);
  const out: FolderSource = {};
  if (stored && typeof stored.sourceLabel === 'string' && stored.sourceLabel !== '') out.sourceLabel = stored.sourceLabel;
  if (stored && typeof stored.sourceRef === 'string' && stored.sourceRef !== '') out.sourceRef = stored.sourceRef;
  return out;
}

export async function rememberedFolder(): Promise<RememberedFolder | null> {
  const handle = await kvGet<FsDirectoryHandle>(FOLDER_KEY);
  if (!handle || handle.kind !== 'directory') return null;
  const permission = (await handle.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as const)) ?? 'prompt';
  return { name: handle.name, permission, source: await folderSource() };
}

export type FolderReading =
  | { status: 'read'; folder: PickedFolder; source: FolderSource }
  /** No folder is remembered on this device. */
  | { status: 'no_folder' }
  /** A folder is remembered, but the browser does not let the app read it (and was not, or could not be, asked). */
  | { status: 'no_permission'; name: string };

/**
 * Re-reads the remembered folder. With `ask`, the browser may show its permission
 * prompt (this needs a click); without it the folder is only read when permission is
 * already granted.
 */
export async function readRememberedFolder(ask: boolean): Promise<FolderReading> {
  const handle = await kvGet<FsDirectoryHandle>(FOLDER_KEY);
  if (!handle || handle.kind !== 'directory') return { status: 'no_folder' };
  let permission = (await handle.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as const)) ?? 'prompt';
  if (permission !== 'granted' && ask) permission = (await handle.requestPermission?.({ mode: 'read' }).catch(() => 'denied' as const)) ?? 'denied';
  if (permission !== 'granted') return { status: 'no_permission', name: handle.name };
  return { status: 'read', folder: { name: handle.name, files: await readTranscriptFolder(handle) }, source: await folderSource() };
}

export async function forgetFolder(): Promise<void> {
  await kvDelete(FOLDER_KEY);
  await kvDelete(FOLDER_SOURCE_KEY);
  await kvDelete(AUTO_SYNC_KEY);
  await kvDelete(AUTO_SYNC_STOPPED_KEY);
}

/** The name last given to this computer on the import page, so the field starts with it on the next visit. */
export async function rememberedComputerName(): Promise<string> {
  const name = await kvGet<string>(COMPUTER_KEY);
  return typeof name === 'string' ? name : '';
}

export async function rememberComputerName(name: string): Promise<void> {
  if (name.trim() === '') await kvDelete(COMPUTER_KEY);
  else await kvSet(COMPUTER_KEY, name.trim()).catch(() => undefined);
}

export async function autoSyncEnabled(): Promise<boolean> {
  return (await kvGet<boolean>(AUTO_SYNC_KEY)) === true;
}

/** The user's own choice, which also settles any earlier automatic switch-off. */
export async function setAutoSync(enabled: boolean): Promise<void> {
  if (enabled) await kvSet(AUTO_SYNC_KEY, true);
  else await kvDelete(AUTO_SYNC_KEY);
  await kvDelete(AUTO_SYNC_STOPPED_KEY);
}

/**
 * Call after Claude Code data was deleted. Automatic reading of the remembered folder
 * would bring the deleted usage straight back on the next visit, so it is switched off;
 * the folder stays remembered and can still be read on request. Returns whether the
 * switch was on.
 */
export async function stopAutoSyncAfterDeletion(): Promise<boolean> {
  if (!(await autoSyncEnabled())) return false;
  await kvDelete(AUTO_SYNC_KEY);
  await kvSet(AUTO_SYNC_STOPPED_KEY, Date.now()).catch(() => undefined);
  return true;
}

/** When a deletion last switched automatic reading off, until the user sets the switch again. */
export async function autoSyncStoppedAt(): Promise<number | null> {
  const at = await kvGet<number>(AUTO_SYNC_STOPPED_KEY);
  return typeof at === 'number' ? at : null;
}

/**
 * Whether automatic reading is switched on, for a dialog that has to say what a
 * deletion does to it. Read again whenever `refreshKey` changes; false until known.
 */
export function useAutoSyncEnabled(refreshKey: unknown = null): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void autoSyncEnabled().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return enabled;
}
