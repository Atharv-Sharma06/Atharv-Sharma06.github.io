import { strToU8, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ImportError, type ImportFile } from '@/core/types';
import { claudeExportParser } from '@/import/claude-export';
import { ExportManifestFound, readExportManifest } from '@/import/claude-export/manifest';
import { detectSelection, filesToParse } from '@/import/selection';
import { collectingSink, fileOf } from '../helpers/sink';

/**
 * The claude.ai export as it arrives since November 2026: a manifest that links to one ZIP per
 * category. The manifest holds no conversations; the app shows what to download, and reads the
 * conversations parts once they are chosen.
 */
const conversationsJson = readFileSync(fileURLToPath(new URL('../fixtures/claude-export/conversations.json', import.meta.url)));
const MANIFEST_NAME = 'manifest-00000000-0000-4000-8000-000000000000-1794420044-abcdef12-2026-11-11-18-02-14.json';

const entry = (batch: number, category: string, filename: string, url = `https://claude.ai/export/x/download/${batch}`) => ({
  batch_index: batch,
  category,
  part: 1,
  filename,
  export_url: url,
});
const manifestOf = (entries: unknown[], extra: Record<string, unknown> = {}) =>
  fileOf(MANIFEST_NAME, JSON.stringify({ created_at: '2026-11-11T18:02:14.000000+00:00', total_files: entries.length, data_files: entries, ...extra }, null, 2));
const fullManifest = (conversations = 1) =>
  manifestOf([
    ...Array.from({ length: conversations }, (_, i) => entry(i, 'conversations', `conversations-00${i}.zip`)),
    entry(conversations, 'light_metadata', 'light_metadata-000.zip'),
    entry(conversations + 1, 'projects', 'projects-000.zip'),
    entry(conversations + 2, 'memories', 'memories-000.zip'),
    entry(conversations + 3, 'feedback', 'feedback-000.zip'),
  ]);

const zipOf = (name: string, files: Record<string, Uint8Array>) => fileOf(name, zipSync(files));
const conversationsPart = (name = 'conversations-000.zip') => zipOf(name, { 'conversations.json': conversationsJson });
const otherParts = (projects = 2) => [
  zipOf('light_metadata-000.zip', {
    'users.json': strToU8('[{"uuid":"u1","full_name":"Alex","email_address":"alex@example.com"}]'),
    'login_history.json': strToU8('[{"created_at":"2026-11-01T10:00:00Z","ip_address":"192.0.2.1"}]'),
  }),
  zipOf(
    'projects-000.zip',
    Object.fromEntries(
      Array.from({ length: projects }, (_, i) => [`projects/p${i}.json`, strToU8(JSON.stringify({ uuid: `p${i}`, name: `Project ${i}`, created_at: '2026-01-01T00:00:00Z', docs: [] }))]),
    ),
  ),
  zipOf('memories-000.zip', { 'memories/acct.json': strToU8('{"memory":"likes tea"}') }),
  zipOf('feedback-000.zip', { 'reflections/acct.json': strToU8('[]') }),
];

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImportError) return error;
    throw error;
  }
  return null;
};

describe('reading a manifest', () => {
  it('lists the parts in the order the manifest numbers them', () => {
    const manifest = readExportManifest(
      { created_at: '2026-11-11T18:02:14Z', total_files: 3, data_files: [entry(2, 'projects', 'projects-000.zip'), entry(0, 'conversations', 'conversations-000.zip'), entry(1, 'conversations', 'conversations-001.zip')] },
      'm.json',
    );
    expect(manifest).toEqual({
      fileName: 'm.json',
      createdAt: '2026-11-11T18:02:14Z',
      parts: [
        { category: 'conversations', filename: 'conversations-000.zip', url: 'https://claude.ai/export/x/download/0' },
        { category: 'conversations', filename: 'conversations-001.zip', url: 'https://claude.ai/export/x/download/1' },
        { category: 'projects', filename: 'projects-000.zip', url: 'https://claude.ai/export/x/download/2' },
      ],
    });
  });

  it('keeps only https links to claude.ai, and only the name of a part', () => {
    const urls = [
      'javascript:alert(1)',
      'http://claude.ai/export/x',
      'https://claude.ai.example.com/export/x',
      'https://user:pw@claude.ai/export/x',
      'https://www.claude.ai/export/x',
      'not a url',
      42,
    ];
    const manifest = readExportManifest({ created_at: 'x', data_files: urls.map((u, i) => ({ ...entry(i, 'conversations', `a/b\\c-${i}.zip`), export_url: u })) }, 'm.json');
    expect(manifest?.parts.map((p) => p.url)).toEqual([null, null, null, null, 'https://www.claude.ai/export/x', null, null]);
    expect(manifest?.parts.map((p) => p.filename)).toEqual(urls.map((_, i) => `c-${i}.zip`));
  });

  it('is not fooled by other JSON', () => {
    expect(readExportManifest({ data: [] }, 'x.json')).toBeNull();
    expect(readExportManifest({ data_files: [{ category: 'conversations' }] }, 'x.json')).toBeNull();
    expect(readExportManifest({ data_files: [] }, 'x.json')).toBeNull();
    expect(readExportManifest([{ data_files: [] }], 'x.json')).toBeNull();
    expect(readExportManifest({ data_files: [], total_files: 0 }, 'x.json')).toMatchObject({ parts: [] });
  });
});

describe('a manifest in the selection', () => {
  it('chosen alone, says what to download instead of failing as an unknown file', async () => {
    const error = await caught(detectSelection([fullManifest(2)]));
    expect(error).toBeInstanceOf(ExportManifestFound);
    expect(error?.code).toBe('export_manifest');
    expect(error?.message).toBe(
      `"${MANIFEST_NAME}" is the manifest of a claude.ai data export: it lists the parts of the export and holds none of your conversations. ` +
        'Download the conversations parts it lists (conversations-000.zip and conversations-001.zip) and choose them here.',
    );
    expect((error as ExportManifestFound).manifest.parts.filter((p) => p.category === 'conversations')).toHaveLength(2);
  });

  it('chosen with the parts that hold no conversations, still says what to download', async () => {
    expect(await caught(detectSelection([fullManifest(), ...otherParts()]))).toBeInstanceOf(ExportManifestFound);
  });

  it('chosen with its conversations part, is passed over and the conversations are read', async () => {
    const files = [fullManifest(), conversationsPart()];
    const detected = await detectSelection(files);
    expect(detected).toMatchObject({ parser: 'claude-export', fileIndexes: [1], ignoredFiles: 1, leadName: 'conversations-000.zip' });
    const { sink, out } = collectingSink();
    const parsed = await claudeExportParser.parse(await filesToParse(files, detected.fileIndexes), sink, {});
    expect(parsed.fileName).toBe('conversations-000.zip');
    expect(out.conversations.length).toBeGreaterThan(0);
  });

  it('chosen with every part, reads the conversations and passes over the rest, also a projects part with hundreds of projects', async () => {
    const files: ImportFile[] = [fullManifest(), conversationsPart(), ...otherParts(250)];
    const detected = await detectSelection(files);
    expect(detected).toMatchObject({ parser: 'claude-export', fileIndexes: [1], ignoredFiles: 5 });
  });

  it('refuses a selection that lacks one of the conversations parts the manifest lists', async () => {
    const error = await caught(detectSelection([fullManifest(2), conversationsPart()]));
    expect(error).toMatchObject({
      code: 'missing_export_parts',
      message:
        "The export's manifest lists 2 conversations parts (conversations-000.zip and conversations-001.zip), but only 1 of them is among the chosen files. " +
        'Choose all of them together, so that no conversations are left out.',
    });
    // A part that the browser renamed on download counts all the same.
    const both = [fullManifest(2), conversationsPart(), conversationsPart('conversations-001 (1).zip')];
    expect(await detectSelection(both)).toMatchObject({ parser: 'claude-export', fileIndexes: [1, 2] });
  });

  it('says that a part of the export without conversations is not the one to choose', async () => {
    const [metadata] = otherParts();
    expect(await caught(detectSelection([metadata]))).toMatchObject({
      code: 'unknown_format',
      message: expect.stringContaining('choose the conversations part (conversations-000.zip'),
    });
  });
});
