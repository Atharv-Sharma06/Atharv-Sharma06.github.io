'use client';

import type { ImportFile } from '@/core/types';
import { toImportFiles } from '@/import/session';

/** Minimal shapes of the drag-and-drop entry API (non-standard names, supported by all current browsers). */
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FileEntry extends Entry {
  file(success: (file: File) => void, failure: (error: unknown) => void): void;
}
interface DirectoryEntry extends Entry {
  createReader(): { readEntries(success: (entries: Entry[]) => void, failure: (error: unknown) => void): void };
}

const SKIP_DIRECTORIES = new Set(['tool-results', 'mcp-tasks', 'node_modules', '.git']);
const USEFUL = /\.(jsonl|json|csv|tsv|zip)$|\.jsonl\.superseded-/i;
const MAX_FILES = 200_000;

async function collect(entry: Entry, out: ImportFile[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  if (entry.isFile) {
    if (!USEFUL.test(entry.name)) return;
    const file = await new Promise<File>((resolve, reject) => (entry as FileEntry).file(resolve, reject));
    out.push({ name: file.name, path: entry.fullPath.replace(/^\//, ''), size: file.size, lastModified: file.lastModified, blob: file });
    return;
  }
  if (!entry.isDirectory || SKIP_DIRECTORIES.has(entry.name)) return;
  const reader = (entry as DirectoryEntry).createReader();
  // readEntries hands out the directory in chunks; an empty chunk means the end.
  for (;;) {
    const chunk = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (chunk.length === 0) break;
    for (const child of chunk) await collect(child, out);
  }
}

/**
 * The files of a drop, including the contents of dropped folders. The entries must be
 * taken from the event synchronously; the browser invalidates them afterwards.
 */
export function filesFromDrop(data: DataTransfer): Promise<ImportFile[]> {
  const entries: Entry[] = [];
  for (const item of Array.from(data.items)) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.some((e) => e.isDirectory)) return Promise.resolve(toImportFiles(Array.from(data.files)));
  return (async () => {
    const out: ImportFile[] = [];
    for (const entry of entries) await collect(entry, out);
    return out;
  })();
}
