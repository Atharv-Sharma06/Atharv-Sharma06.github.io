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
        { category: 'conversations', filename: 'conversations-000.zip', url: 'https://claude.ai/export/x/download/0', linkRejected: false },
        { category: 'conversations', filename: 'conversations-001.zip', url: 'https://claude.ai/export/x/download/1', linkRejected: false },
        { category: 'projects', filename: 'projects-000.zip', url: 'https://claude.ai/export/x/download/2', linkRejected: false },
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
    expect(manifest?.parts.map((p) => p.linkRejected)).toEqual([true, true, true, true, false, true, true]);
    expect(manifest?.parts.map((p) => p.filename)).toEqual(urls.map((_, i) => `c-${i}.zip`));
    // A part without a link is not one with a rejected link.
    expect(readExportManifest({ created_at: 'x', data_files: [{ category: 'conversations', filename: 'c.zip' }] }, 'm.json')?.parts[0]).toEqual({
      category: 'conversations',
      filename: 'c.zip',
      url: null,
      linkRejected: false,
    });
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

  it('checks the parts also when a conversations part was unpacked, and reads parts a browser or archive tool renamed', async () => {
    const unpacked = fileOf('conversations.json', conversationsJson);
    expect(await caught(detectSelection([fullManifest(2), unpacked]))).toMatchObject({ code: 'missing_export_parts' });
    expect(await detectSelection([fullManifest(2), unpacked, fileOf('conversations 2.json', conversationsJson)])).toMatchObject({
      parser: 'claude-export',
      fileIndexes: [1, 2],
    });
    expect(await detectSelection([fullManifest(2), conversationsPart(), unpacked])).toMatchObject({ parser: 'claude-export', fileIndexes: [1, 2] });
    // An unpacked export of the old kind reads as before: its side files are not taken for conversations.
    const old = [unpacked, fileOf('users.json', '[{"uuid":"u1","email_address":"a@example.com"}]'), fileOf('projects.json', '[{"uuid":"p1","name":"P","created_at":"2026-01-01T00:00:00Z"}]')];
    expect(await detectSelection(old)).toMatchObject({ parser: 'claude-export', fileIndexes: [0], recognisedAs: 'unpacked claude.ai data export' });
  });

  it('checks the parts chosen from the manifest step against the manifest, which is not chosen again', async () => {
    const manifest = readExportManifest(JSON.parse(await fullManifest(2).blob.text()), MANIFEST_NAME)!;
    expect(await caught(detectSelection([conversationsPart()], manifest))).toMatchObject({ code: 'missing_export_parts' });
    expect(await detectSelection([conversationsPart(), conversationsPart('conversations-001.zip')], manifest)).toMatchObject({ parser: 'claude-export', fileIndexes: [0, 1] });
    // Something unreadable chosen there brings the step back, saying what was wrong with it.
    const error = await caught(detectSelection([fileOf('conversations-000.zip', '')], manifest));
    expect(error).toBeInstanceOf(ExportManifestFound);
    expect((error as ExportManifestFound).problem).toBe('"conversations-000.zip" is empty.');
  });

  it('says what is wrong with a part chosen with the manifest, and leaves out the parts expected without conversations', async () => {
    const broken = await caught(detectSelection([fullManifest(), fileOf('conversations-000.zip', '<html>Sign in</html>')]));
    expect(broken).toBeInstanceOf(ExportManifestFound);
    expect((broken as ExportManifestFound).problem).toMatch(/^"conversations-000.zip" /);
    const sideOnly = await caught(detectSelection([fullManifest(), ...otherParts()]));
    expect((sideOnly as ExportManifestFound).problem).toBeUndefined();
  });

  it('of several manifests, shows and checks the newest', async () => {
    const older = fileOf(
      'manifest-old.json',
      JSON.stringify({ created_at: '2026-11-01T10:00:00Z', total_files: 1, data_files: [entry(0, 'conversations', 'old-conversations-000.zip')] }),
    );
    const newer = fullManifest(2);
    const error = await caught(detectSelection([older, newer]));
    expect((error as ExportManifestFound).manifest.fileName).toBe(MANIFEST_NAME);
    // Only the newest one's parts count: it lists two.
    expect(await caught(detectSelection([older, newer, conversationsPart()]))).toMatchObject({ code: 'missing_export_parts' });
  });

  it('passes over the parts other than the conversations, which may look like something the app reads', async () => {
    // The export as it arrived in November 2026: eight parts, numbered from 0, the conversations last.
    const real = fileOf(
      'manifest-real.json',
      JSON.stringify({
        instructions: 'Download each file using the export_url. Each link expires 24 hours after it is created.',
        created_at: '2026-11-11T18:02:14.424124+00:00',
        total_files: 8,
        data_files: ['light_metadata', 'projects', 'memories', 'design_chats', 'frames', 'artifact_data', 'claude_code_cloud', 'conversations'].map((category, i) => ({
          batch_index: i,
          export_url: `https://claude.ai/export/00000000-0000-4000-8000-000000000000/download/${i}`,
          category,
          part: 0,
          filename: `${category}-000.zip`,
        })),
        version: '1.0',
      }),
    );
    const alone = await caught(detectSelection([real]));
    expect((alone as ExportManifestFound).manifest.parts.map((p) => p.category)).toEqual([
      'light_metadata', 'projects', 'memories', 'design_chats', 'frames', 'artifact_data', 'claude_code_cloud', 'conversations',
    ]);
    expect(alone?.message).toMatch(/Download the conversations part it lists \(conversations-000.zip\)/);

    // Parts whose contents are not described anywhere: one holds what reads as Claude Code sessions, one what reads as chats.
    const session = JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'hi' } });
    const cloud = zipOf('claude_code_cloud-000.zip', { 'sessions/s1.jsonl': strToU8(`${session}\n`), 'sessions/s2.jsonl': strToU8(`${session}\n`) });
    const design = zipOf('design_chats-000.zip', { 'design_chats/d1.json': conversationsJson });
    const parts = [conversationsPart(), cloud, design, zipOf('frames-000.zip', { 'frames/f1.json': strToU8('{}') })];
    expect(await detectSelection([real, ...parts])).toMatchObject({ parser: 'claude-export', fileIndexes: [1], recognisedAs: 'ZIP archive of a claude.ai data export' });
    // Also when the parts were zipped together first.
    const together = fileOf('parts.zip', zipSync({ 'conversations-000.zip': zipSync({ 'conversations.json': conversationsJson }), 'claude_code_cloud-000.zip': zipSync({ 's1.jsonl': strToU8(`${session}\n`) }) }));
    expect(await detectSelection([real, together])).toMatchObject({ parser: 'claude-export', fileIndexes: [1] });
    // Chosen from the manifest step, a part without conversations says so.
    const manifest = (alone as ExportManifestFound).manifest;
    const wrong = await caught(detectSelection([cloud], manifest));
    expect((wrong as ExportManifestFound).problem).toBe('"claude_code_cloud-000.zip" is a part of the export that holds no conversations.');
    // Without a manifest, such a part is looked at like any other file.
    expect(await detectSelection([cloud])).toMatchObject({ parser: 'claude-code' });
  });

  it('says that a part of the export without conversations is not the one to choose', async () => {
    const [metadata] = otherParts();
    expect(await caught(detectSelection([metadata]))).toMatchObject({
      code: 'unknown_format',
      message: expect.stringContaining('choose the conversations part (conversations-000.zip'),
    });
  });
});
