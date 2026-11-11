import { ImportError } from '@/core/types';

/**
 * The manifest of a claude.ai data export. Since November 2026 an export arrives as a small JSON
 * file, `manifest-….json`, instead of one ZIP. It lists the export's parts, one or more ZIP archives
 * per category (`conversations`, `light_metadata`, `projects`, `memories`, `feedback`), each with a
 * download link:
 *
 *   { "created_at": "…", "total_files": 7,
 *     "data_files": [{ "batch_index": 0, "category": "conversations", "part": 1,
 *                      "filename": "conversations-000.zip", "export_url": "https://claude.ai/export/…" }, …] }
 *
 * The links work only in a browser that is signed in to claude.ai, so the app cannot fetch the parts
 * itself. It shows them instead, and the person downloads the conversations and chooses them. Each
 * conversations part holds a `conversations.json`, which the export parser reads as before.
 */
export interface ExportManifestPart {
  category: string;
  filename: string;
  /** The part's download link: only an https link to claude.ai is kept, anything else is null. */
  url: string | null;
  /** The manifest gives a link for the part, but not one to claude.ai. It is neither shown nor to be opened. */
  linkRejected: boolean;
}

export interface ExportManifest {
  /** Name of the manifest file. */
  fileName: string;
  /** When the export was made, as the manifest gives it. */
  createdAt: string | null;
  /** In the order the manifest numbers them. */
  parts: ExportManifestPart[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A link that may be shown: https on claude.ai or one of its subdomains. A manifest is a file anyone can write. */
function claudeLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'claude.ai' || url.hostname.endsWith('.claude.ai')) && url.username === '' && url.password === ''
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A part's file name as it may be shown: no folders, no control characters, of reasonable length. */
function partName(value: string): string {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? value;
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
}

/** The manifest a parsed JSON value is, or null when it is something else. */
export function readExportManifest(value: unknown, fileName: string): ExportManifest | null {
  if (!isObject(value) || !Array.isArray(value.data_files)) return null;
  const entries = value.data_files;
  if (!entries.every((e) => isObject(e) && typeof e.category === 'string' && typeof e.filename === 'string')) return null;
  // An empty list is a manifest only when the rest of the document says so.
  if (entries.length === 0 && typeof value.total_files !== 'number' && typeof value.created_at !== 'string') return null;
  const order = (e: Record<string, unknown>) => (typeof e.batch_index === 'number' && Number.isFinite(e.batch_index) ? e.batch_index : Number.MAX_SAFE_INTEGER);
  const parts = (entries as Record<string, unknown>[])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => order(a.e) - order(b.e) || a.i - b.i)
    .map(({ e }) => {
      const url = claudeLink(e.export_url);
      return { category: e.category as string, filename: partName(e.filename as string), url, linkRejected: url === null && e.export_url !== undefined && e.export_url !== null };
    });
  return { fileName, createdAt: typeof value.created_at === 'string' ? value.created_at : null, parts };
}

/** The parts that hold conversations: the only ones this app reads. */
export const conversationParts = (manifest: ExportManifest): ExportManifestPart[] => manifest.parts.filter((p) => p.category === 'conversations');

const listOf = (names: string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(names);

/** Of several manifests, the one of the newest export: an older one's links have likely expired. */
export function newestManifest(manifests: readonly ExportManifest[]): ExportManifest {
  const time = (m: ExportManifest) => (m.createdAt === null ? Number.NEGATIVE_INFINITY : Date.parse(m.createdAt) || Number.NEGATIVE_INFINITY);
  return manifests.reduce((best, m) => (time(m) > time(best) ? m : best));
}

/**
 * Detection found a manifest and nothing to import with it. Not a failure as such: the import page
 * shows the parts to download (see features/import/export-manifest.tsx). `problem`: what is wrong
 * with another file that was chosen with it (a part that could not be read, for example).
 */
export class ExportManifestFound extends ImportError {
  constructor(
    readonly manifest: ExportManifest,
    readonly problem?: string,
  ) {
    const conversations = conversationParts(manifest).map((p) => p.filename);
    super(
      `"${manifest.fileName}" is the manifest of a claude.ai data export: it lists the parts of the export and holds none of your conversations. ` +
        (conversations.length === 0
          ? 'It lists no conversations part, so there is nothing in this export for the app to read.'
          : `Download the conversations ${conversations.length === 1 ? 'part' : 'parts'} it lists (${listOf(conversations)}) and choose ${conversations.length === 1 ? 'it' : 'them'} here.`),
      'export_manifest',
    );
    this.name = 'ExportManifestFound';
  }
}

/**
 * An export's conversations parts must all be read together, or conversations are missing without a word.
 * `chosen` is how many export files the import would read; with several manifests, the newest one counts.
 * Parts are counted rather than matched by name, since a browser renames a download whose name is taken.
 */
export function checkParts(manifests: readonly ExportManifest[], chosen: number): void {
  if (manifests.length === 0) return;
  const manifest = newestManifest(manifests);
  if (chosen < conversationParts(manifest).length) throw missingParts(manifest, chosen);
}

/** The error for a selection that holds a manifest and fewer conversations parts than it lists. */
export function missingParts(manifest: ExportManifest, chosen: number): ImportError {
  const listed = conversationParts(manifest).map((p) => p.filename);
  return new ImportError(
    `The export's manifest lists ${listed.length} conversations parts (${listOf(listed)}), but only ${chosen} of them ${chosen === 1 ? 'is' : 'are'} among the chosen files. ` +
      'Choose all of them together, so that no conversations are left out.',
    'missing_export_parts',
  );
}
