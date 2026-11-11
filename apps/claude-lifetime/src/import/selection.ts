import { ImportError, type ImportFile } from '@/core/types';
import { expandArchives } from './archive';
import type { ExportManifest } from './claude-export/manifest';
import { detectImport, type Detected } from './detect';

/**
 * The selection the page made, as the import worker sees it. ZIP archives in it are opened up first
 * (see archive.ts), so detection looks at the files inside them, and the positions it returns are
 * positions in the opened-up selection. Parsing starts from the page's selection again and opens it
 * up the same way, so those positions name the same files.
 */

/**
 * What the files to be read are, as `detectImport` says, with the archives they come from named.
 * `manifest`: a claude.ai export manifest whose parts the files are meant to be.
 */
export async function detectSelection(files: ImportFile[], manifest?: ExportManifest): Promise<Detected> {
  const expanded = await expandArchives(files);
  const detected = await detectImport(expanded, { manifests: manifest ? [manifest] : [] });
  const chosen = detected.fileIndexes.map((i) => expanded[i]);
  const archives = new Set(chosen.flatMap((f) => (f.archive === undefined ? [] : [f.archive])));
  let recognisedAs = detected.recognisedAs;
  if (archives.size > 0) {
    const all = chosen.every((f) => f.archive !== undefined);
    const where = archives.size === 1 ? `the ZIP archive "${[...archives][0]}"` : `${archives.size.toLocaleString('en-US')} ZIP archives`;
    recognisedAs += all ? `, from ${where}` : `, some of them from ${where}`;
  }
  return { ...detected, recognisedAs, leadName: chosen[0]?.name };
}

/** The files `detectSelection` chose, out of the same selection. */
export async function filesToParse(files: ImportFile[], fileIndexes: readonly number[]): Promise<ImportFile[]> {
  const expanded = await expandArchives(files);
  const chosen = fileIndexes.map((i) => expanded[i]);
  if (chosen.some((f) => f === undefined)) {
    throw new ImportError('The selected files changed while they were being read. Choose them again.', 'selection_changed');
  }
  return chosen;
}
