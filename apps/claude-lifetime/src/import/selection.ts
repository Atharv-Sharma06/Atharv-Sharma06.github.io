import { ImportError, type ImportFile } from '@/core/types';
import { expandArchives } from './archive';
import { ExportManifestFound, newestManifest, readExportManifest, type ExportManifest } from './claude-export/manifest';
import { detectImport, type Detected } from './detect';

/**
 * The selection the page made, as the import worker sees it. ZIP archives in it are opened up first
 * (see archive.ts), so detection looks at the files inside them, and the positions it returns are
 * positions in the opened-up selection. Parsing starts from the page's selection again and opens it
 * up the same way, so those positions name the same files.
 */

const MANIFEST_NAME = /^manifest.*\.json$/i;
/** A manifest lists a few parts; a file of that name this large is something else. */
const MANIFEST_MAX_BYTES = 1024 * 1024;

/** The claude.ai export manifests among the files, found by their name. */
async function manifestsIn(files: readonly ImportFile[]): Promise<ExportManifest[]> {
  const found: ExportManifest[] = [];
  for (const file of files) {
    if (!MANIFEST_NAME.test(file.name) || file.size > MANIFEST_MAX_BYTES) continue;
    try {
      const manifest = readExportManifest(JSON.parse((await file.blob.text()).replace(/^\uFEFF/, '')), file.name);
      if (manifest) found.push(manifest);
    } catch {
      // Not a manifest after all: detection says what it is.
    }
  }
  return found;
}

/**
 * What the files to be read are, as `detectImport` says, with the archives they come from named.
 * `manifest`: a claude.ai export manifest whose parts the files are meant to be.
 *
 * When a manifest is known (passed, or among the files), the parts it lists besides the conversations
 * are passed over: what they hold is not described anywhere, and a part that happens to look like
 * something the app reads (Claude Code sessions, chats of another kind) must not take the place of the
 * conversations or be counted as one of them. They are found by name, also inside a ZIP of the parts.
 */
export async function detectSelection(files: ImportFile[], manifest?: ExportManifest): Promise<Detected> {
  const expanded = await expandArchives(files);
  const given = manifest ? [manifest] : [];
  const manifests = [...given, ...(await manifestsIn(expanded))];
  const partsOf = (keep: (category: string) => boolean) =>
    new Set(manifests.flatMap((m) => m.parts.filter((p) => keep(p.category)).map((p) => p.filename.toLowerCase())));
  const inParts = (names: Set<string>) => (f: ImportFile) => (f.path ?? f.name).split('/').some((segment) => names.has(segment.toLowerCase()));
  const sideParts = partsOf((category) => category !== 'conversations');
  const isSidePart = inParts(sideParts);
  let kept = expanded.map((file, i) => ({ file, i })).filter(({ file }) => !isSidePart(file));
  let manifestsForDetection = given;
  // Chosen on its own, the Claude Code on the web part is read like any other file: the manifest step suggests trying that.
  const isCloudPart = inParts(partsOf((category) => category === 'claude_code_cloud'));
  if (kept.length === 0 && expanded.some(isCloudPart)) {
    kept = expanded.map((file, i) => ({ file, i })).filter(({ file }) => isCloudPart(file));
    manifestsForDetection = [];
  }
  if (kept.length === 0) {
    const names = [...new Set(expanded.map((f) => (f.path ?? f.name).split('/').find((s) => sideParts.has(s.toLowerCase())) ?? f.name))];
    throw new ExportManifestFound(
      newestManifest(manifests),
      `${names.length === 1 ? `"${names[0]}" is a part` : `${names.map((n) => `"${n}"`).join(', ')} are parts`} of the export that ${names.length === 1 ? 'holds' : 'hold'} no conversations.`,
    );
  }
  const found = await detectImport(
    kept.map((k) => k.file),
    { manifests: manifestsForDetection },
  );
  const fileIndexes = found.fileIndexes.map((i) => kept[i].i);
  const detected = { ...found, fileIndexes, ignoredFiles: expanded.length - fileIndexes.length };
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
