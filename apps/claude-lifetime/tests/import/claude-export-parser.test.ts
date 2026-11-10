import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Limitation } from '@/core/limitations';
import { commitImport, previewImport } from '@/import/commit';
import { basisForDate, createClaudeExportParser } from '@/import/claude-export/parser';
import { ROOT_PARENT } from '@/import/claude-export/accounting';
import { resetStaging, StagingWriter } from '@/import/staging';
import { createTestDb, type TestDb } from '../helpers/db';
import { collectingSink, fileOf } from '../helpers/sink';

// One character = one base unit, so expectations can be read off the fixtures.
const parser = createClaudeExportParser((text) => text.length);
const NOW = Date.UTC(2026, 10, 10);
const ctx = { options: { now: NOW } };

const SECRET = 'PRIVATE-MESSAGE-TEXT';
const ts = (iso: string) => iso.replace('Z', '.123456Z');
const textBlock = (text: string) => ({ type: 'text', text, citations: [], start_timestamp: null, stop_timestamp: null, flags: null });

/** A conversation in the 2026 export shape (parent pointers, typed content blocks). */
function modernConversation() {
  return {
    uuid: 'conv-modern',
    name: 'Trip planning',
    summary: `**Overview** ${SECRET} summary`,
    created_at: ts('2025-06-01T10:00:00Z'),
    updated_at: ts('2025-06-01T10:20:00Z'),
    account: { uuid: 'acct-1' },
    chat_messages: [
      {
        uuid: 'h1', parent_message_uuid: ROOT_PARENT, sender: 'human', text: `${SECRET} ignored flattening`,
        content: [textBlock('a'.repeat(10))],
        created_at: ts('2025-06-01T10:00:00Z'), updated_at: ts('2025-06-01T10:00:00Z'),
        attachments: [
          { file_name: 'notes.txt', file_size: 300, file_type: 'txt', extracted_content: 'n'.repeat(300) },
          { file_name: 'scan.pdf', file_size: 9000, file_type: 'pdf', extracted_content: '' },
        ],
        files: [{ file_name: 'notes.txt' }, { file_name: 'photo.png', file_uuid: 'f-1' }],
      },
      {
        uuid: 'a1', parent_message_uuid: 'h1', sender: 'assistant', text: 'flattened',
        content: [
          { type: 'thinking', thinking: 't'.repeat(40), summaries: [{ summary: 'x' }], cut_off: false, truncated: true, start_timestamp: ts('2025-06-01T10:00:02Z'), stop_timestamp: ts('2025-06-01T10:00:05Z') },
          { type: 'tool_use', name: 'web_search', input: { query: 'q'.repeat(5) }, message: 'Searching the web', integration_name: null },
          {
            type: 'tool_result', name: 'web_search', is_error: false,
            content: [
              { type: 'knowledge', title: 'T'.repeat(4), url: 'https://e.x', text: 'k'.repeat(50), metadata: { site_name: 'ignored-metadata' } },
              { type: 'text', text: 'r'.repeat(10) },
            ],
          },
          { type: 'token_budget', remaining: null },
          { ...textBlock('b'.repeat(6)), stop_timestamp: ts('2025-06-01T10:00:30Z') },
        ],
        created_at: ts('2025-06-01T10:00:01Z'), updated_at: ts('2025-06-01T10:00:30Z'), attachments: [], files: [],
      },
      {
        uuid: 'h2', parent_message_uuid: 'a1', sender: 'human', text: '', content: [textBlock('c'.repeat(3))],
        created_at: ts('2025-06-01T10:02:00Z'), updated_at: ts('2025-06-01T10:02:00Z'), attachments: [], files: [],
      },
      {
        uuid: 'a2', parent_message_uuid: 'h2', sender: 'assistant', text: '', content: [textBlock('d'.repeat(4))],
        created_at: ts('2025-06-01T10:02:05Z'), updated_at: ts('2025-06-01T10:02:09Z'), attachments: [], files: [],
      },
    ],
  };
}

/** A conversation in the early-2025 shape: no pointers, no summary, messages out of order. */
function legacyConversation() {
  return {
    uuid: 'conv-legacy',
    name: '',
    created_at: ts('2025-02-24T23:10:00Z'),
    updated_at: ts('2025-02-24T23:12:00Z'),
    account: { uuid: 'acct-1' },
    chat_messages: [
      { uuid: 'l-a1', sender: 'assistant', text: 'e'.repeat(20), content: [textBlock('e'.repeat(20))], created_at: ts('2025-02-24T23:10:30Z'), updated_at: '', attachments: [], files: [] },
      { uuid: 'l-h1', sender: 'human', text: 'f'.repeat(10), content: [], created_at: ts('2025-02-24T23:10:00Z'), updated_at: '', attachments: [], files: [] },
    ],
  };
}

const run = async (payload: unknown, name = 'conversations.json') => {
  const { out, sink } = collectingSink();
  const parsed = await parser.parse([fileOf(name, typeof payload === 'string' ? payload : JSON.stringify(payload))], sink, ctx);
  return { out, parsed };
};

describe('claude.ai export parser', () => {
  it('reads a modern export: blocks, attachments, tool round trips, parent pointers', async () => {
    const { out, parsed } = await run([modernConversation()]);

    expect(parsed).toMatchObject({
      format: 'claude-export/conversations',
      source: { kind: 'claude_export', externalRef: 'acct-1' },
      recordsSeen: 1,
      recordsSkipped: 0,
      missingFields: ['model', 'token counts'],
    });
    expect(parsed.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.stats).toMatchObject({ conversations: 1, messages: 4, userMessages: 2, assistantMessages: 2, thinkingBlocks: 1, toolCalls: 1, attachments: 2, binaryFiles: 1, hasBranchInformation: true });
    expect(parsed.warnings.map((w) => w.code)).toEqual(['binary_files_not_counted']);

    expect(out.conversations).toEqual([
      {
        dedupKey: 'claude_ai:conv-modern', kind: 'chat', externalId: 'conv-modern', title: 'Trip planning', projectLabel: null, modelKey: null,
        createdAt: '2025-06-01T10:00:00.123Z', updatedAt: '2025-06-01T10:20:00.123Z', metadata: { branched: false, hasBranchInfo: true },
      },
    ]);

    const [h1, a1, h2, a2] = out.messages;
    // user message: 10 chars of text + 300 chars of extracted attachment text
    expect(h1).toMatchObject({
      externalId: 'h1', parentExternalId: ROOT_PARENT, role: 'user', ordinal: 0, modelKey: null,
      createdAt: '2025-06-01T10:00:00.123Z', occurredAt: '2025-06-01T10:00:00.123Z',
      textChars: 10, attachmentChars: 300, attachmentCount: 2, fileCount: 1,
      inputBase: 310, outputBase: 0, replayBase: 0, requestCount: 0, methodKey: 'heuristic-v1/claude3',
    });
    expect(h1.limitationFlags).toBe(
      Limitation.MODEL_UNKNOWN | Limitation.HIDDEN_CONTEXT_EXCLUDED | Limitation.BINARY_FILES_EXCLUDED | Limitation.ATTACHMENT_TEXT_MISSING,
    );

    // tool_use text = 'web_search {"query":"qqqqq"}' = 11 + 17 = 28 chars
    // tool_result text = 'TTTT\nhttps://e.x\n' + 50 k + '\n' + 10 r + '\n' = 16 + 50 + 1 + 10 + 1 = 79 chars (wait: see below)
    const toolUse = 'web_search {"query":"qqqqq"}'.length;
    const toolResult = `TTTT\nhttps://e.x\n${'k'.repeat(50)}\n${'r'.repeat(10)}\n`.length;
    // request 1: input 310 (new) -> out thinking 40 + tool_use
    // request 2: input 310 + 40 + tool_use + tool_result; new = tool_result; re-read 310 + 40 + tool_use
    expect(a1).toMatchObject({
      role: 'assistant', thinkingChars: 40, textChars: 6, toolChars: toolUse + toolResult,
      inputBase: toolResult, outputBase: 40 + toolUse + 6, replayBase: 310 + 40 + toolUse, replayCachedBase: 310, requestCount: 2,
    });
    expect(a1.limitationFlags & Limitation.THINKING_PARTIAL).toBeTruthy();
    expect(a1.limitationFlags & Limitation.TOOL_OVERHEAD_EXCLUDED).toBeTruthy();

    expect(h2).toMatchObject({ inputBase: 3, replayBase: 0 });
    // next turn re-reads 310 + tool_use + tool_result + 6 (thinking is not carried). The earlier reply
    // contained thinking, which is dropped now, so the cache only still matches up to where it began (310).
    const carried = 310 + toolUse + toolResult + 6;
    expect(a2).toMatchObject({ outputBase: 4, replayBase: carried, replayCachedBase: 310, requestCount: 1 });
  });

  it('never lets message text, summaries or tool content through', async () => {
    const conv = modernConversation();
    conv.chat_messages[0].content = [textBlock(`${SECRET} in a block`)];
    const { out, parsed } = await run([conv]);
    expect(JSON.stringify({ out, parsed })).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('ignored-metadata');
  });

  it('reads an early-2025 export: no pointers, unordered messages, text fallback', async () => {
    const { out, parsed } = await run([legacyConversation()]);
    expect(parsed.missingFields).toEqual(['model', 'token counts', 'parent_message_uuid']);
    expect(parsed.warnings.map((w) => w.code)).toEqual(['no_branch_information']);
    expect(parsed.stats.hasBranchInformation).toBe(false);
    expect(out.conversations[0]).toMatchObject({ title: null, metadata: { branched: false, hasBranchInfo: false } });
    const assistant = out.messages.find((m) => m.externalId === 'l-a1')!;
    const human = out.messages.find((m) => m.externalId === 'l-h1')!;
    expect(human).toMatchObject({ textChars: 10, inputBase: 10, parentExternalId: null });
    // ordered by time, so the reply follows the prompt even though it is listed first
    expect(assistant).toMatchObject({ outputBase: 20, replayBase: 0, requestCount: 1 });
  });

  it('chooses the tokenizer generation from the date and never names a model', async () => {
    expect(basisForDate(Date.UTC(2023, 10, 1))).toBe('claude2');
    expect(basisForDate(Date.UTC(2024, 2, 4))).toBe('claude3');
    expect(basisForDate(Date.UTC(2026, 3, 15, 23))).toBe('claude3');
    expect(basisForDate(Date.UTC(2026, 3, 16))).toBe('mixed');
    const conv = (id: string, at: string) => ({
      uuid: id, name: id, created_at: at, updated_at: at, account: { uuid: 'acct-1' },
      chat_messages: [{ uuid: `${id}-m`, sender: 'human', text: 'x', content: [textBlock('x')], created_at: at, updated_at: at, attachments: [], files: [] }],
    });
    const { out } = await run([conv('old', '2023-11-01T00:00:00.000000Z'), conv('mid', '2025-01-01T00:00:00.000000Z'), conv('new', '2026-08-01T00:00:00.000000Z')]);
    expect(out.messages.map((m) => [m.methodKey, m.modelKey])).toEqual([
      ['heuristic-v1/claude2', null],
      ['heuristic-v1/claude3', null],
      ['heuristic-v1/mixed', null],
    ]);
    expect(out.models).toEqual([]);
  });

  it('repairs invalid timestamps from neighbours and skips conversations that cannot be dated', async () => {
    const broken = legacyConversation();
    broken.uuid = 'conv-broken';
    broken.chat_messages = [
      { uuid: 'b1', sender: 'human', text: 'x', content: [textBlock('x')], created_at: 'not-a-date', updated_at: '', attachments: [], files: [] },
      { uuid: 'b2', sender: 'assistant', text: 'y', content: [textBlock('y')], created_at: ts('2025-03-01T08:00:00Z'), updated_at: '', attachments: [], files: [] },
      { uuid: 'b3', sender: 'human', text: 'z', content: [textBlock('z')], created_at: '2199-01-01T00:00:00.000000Z', updated_at: '', attachments: [], files: [] },
      { uuid: 'b4', sender: 'assistant', text: 'w', content: [textBlock('w')], created_at: '', updated_at: '', attachments: [], files: [] },
    ];
    const undated = { uuid: 'conv-undated', name: 'x', created_at: null, updated_at: 'garbage', account: { uuid: 'acct-1' }, chat_messages: [{ uuid: 'u1', sender: 'human', text: 'q', content: [textBlock('q')], created_at: null, attachments: [], files: [] }] };
    const { out, parsed } = await run([broken, undated]);

    expect(out.conversations.map((c) => c.externalId)).toEqual(['conv-broken']);
    expect(out.messages.map((m) => [m.externalId, m.createdAt, m.occurredAt, (m.limitationFlags & Limitation.TIMESTAMP_INFERRED) !== 0])).toEqual([
      ['b1', null, '2025-03-01T08:00:00.123Z', true], // no earlier neighbour: takes the next valid one
      ['b2', '2025-03-01T08:00:00.123Z', '2025-03-01T08:00:00.123Z', false],
      ['b3', null, '2025-03-01T08:00:00.123Z', true], // year 2199 is not believable
      ['b4', null, '2025-03-01T08:00:00.123Z', true],
    ]);
    const codes = Object.fromEntries(parsed.warnings.map((w) => [w.code, w.count]));
    expect(codes.invalid_timestamp).toBe(3);
    expect(codes.no_valid_timestamps).toBe(1);
    expect(parsed.recordsSkipped).toBe(1);
  });

  it('skips emptied conversations and reports unknown block types', async () => {
    const ghost = { uuid: 'ghost', name: '', created_at: ts('2023-08-01T00:00:00Z'), updated_at: ts('2023-08-01T00:00:00Z'), account: { uuid: 'acct-1' }, chat_messages: [{ uuid: 'g1', sender: 'human', text: '', content: [textBlock('')], created_at: ts('2023-08-01T00:00:00Z'), attachments: [], files: [] }] };
    const odd = modernConversation();
    (odd.chat_messages[3].content as unknown[]).push({ type: 'hologram', payload: 'zzz' });
    const { out, parsed } = await run([ghost, odd, { uuid: 'no-messages', name: '', chat_messages: [] }, { something: 'else' }]);
    expect(out.conversations).toHaveLength(1);
    const codes = Object.fromEntries(parsed.warnings.map((w) => [w.code, w]));
    expect(codes.empty_conversations.count).toBe(2);
    expect(codes.unrecognised_records.count).toBe(1);
    expect(codes.unknown_content_blocks).toMatchObject({ count: 1, sample: 'hologram' });
  });

  it('gives messages without an id a stable identity', async () => {
    const conv = legacyConversation();
    for (const m of conv.chat_messages) delete (m as { uuid?: string }).uuid;
    const first = (await run([conv])).out.messages.map((m) => m.externalId);
    const second = (await run([conv])).out.messages.map((m) => m.externalId);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
    expect(first.every((id) => id.startsWith('h:'))).toBe(true);
  });

  it('reads the export ZIP directly and identifies it by the same hash as the extracted file', async () => {
    const json = JSON.stringify([modernConversation(), legacyConversation()]);
    const zip = zipSync({ 'data-2026-batch-0000/conversations.json': strToU8(json), 'data-2026-batch-0000/users.json': strToU8('[{"uuid":"acct-1","email_address":"x@example.com"}]') });
    const zipped = collectingSink();
    const fromZip = await parser.parse([fileOf('data-export.zip', zip)], zipped.sink, ctx);
    const plain = await run(json);
    expect(zipped.out.messages).toEqual(plain.out.messages);
    expect(zipped.out.conversations).toEqual(plain.out.conversations);
    expect(fromZip.contentHash).toBe(plain.parsed.contentHash);
    expect(JSON.stringify(zipped.out)).not.toContain('example.com');
  });

  it('explains files that are not a conversations export', async () => {
    const zip = zipSync({ 'export/users.json': strToU8('[]'), 'export/projects/p1.json': strToU8('{}') });
    await expect(parser.parse([fileOf('other.zip', zip)], collectingSink().sink, ctx)).rejects.toMatchObject({
      code: 'no_conversations_file',
      message: expect.stringContaining('export/users.json'),
    });
    await expect(run({ data: [] })).rejects.toMatchObject({ code: 'not_a_conversations_export' });
    await expect(run([{ id: 1 }, { id: 2 }])).rejects.toMatchObject({ code: 'not_a_conversations_export' });
    await expect(run([])).rejects.toMatchObject({ code: 'empty_export' });
    await expect(parser.parse([], collectingSink().sink, ctx)).rejects.toMatchObject({ code: 'no_files' });
  });

  it('keeps complete conversations from a file that was cut short', async () => {
    const json = JSON.stringify([modernConversation(), legacyConversation()]);
    const { out, parsed } = await run(json.slice(0, json.length - 60));
    expect(out.conversations.map((c) => c.externalId)).toEqual(['conv-modern']);
    expect(parsed.warnings.map((w) => w.code)).toContain('truncated_file');
  });

  it('says that a file cut short inside its first conversation is damaged, not that the export is empty', async () => {
    const json = JSON.stringify([modernConversation(), legacyConversation()]);
    await expect(run(json.slice(0, 400))).rejects.toMatchObject({
      code: 'truncated_file',
      message: expect.stringContaining('Download the export again'),
    });
  });

  it('notes when the file goes on after its list of conversations', async () => {
    // two exports joined into one file: only the first list is a valid document
    const joined = `${JSON.stringify([modernConversation()])}\n${JSON.stringify([legacyConversation()])}`;
    const { out, parsed } = await run(joined);
    expect(out.conversations.map((c) => c.externalId)).toEqual(['conv-modern']);
    expect(parsed.warnings.find((w) => w.code === 'trailing_data')?.message).toContain('Only the first list was read');
    // white space after the list is not "more data"
    expect((await run(`${JSON.stringify([modernConversation()])}\n  \n`)).parsed.warnings.map((w) => w.code)).not.toContain('trailing_data');
  });

  it('times the first request of a reply by its first block, as real exports stamp a reply when it is complete', async () => {
    const at = (seconds: number) => ts(new Date(Date.UTC(2026, 7, 13, 20, 0, seconds)).toISOString().replace('.000Z', 'Z'));
    const timed = (text: string, start: number, stop: number) => ({ ...textBlock(text), start_timestamp: at(start), stop_timestamp: at(stop) });
    const chat = (secondReplyTakes: number) => ({
      uuid: 'conv-timed', name: 'Timed', created_at: at(0), updated_at: at(600), account: { uuid: 'acct-1' },
      chat_messages: [
        { uuid: 'h1', parent_message_uuid: ROOT_PARENT, sender: 'human', text: '', content: [textBlock('a'.repeat(1000))], created_at: at(0), attachments: [], files: [] },
        { uuid: 'a1', parent_message_uuid: 'h1', sender: 'assistant', text: '', content: [timed('b'.repeat(20), 1, 5)], created_at: at(5), attachments: [], files: [] },
        // the user answers four minutes after the first reply was finished
        { uuid: 'h2', parent_message_uuid: 'a1', sender: 'human', text: '', content: [textBlock('c'.repeat(5))], created_at: at(245), attachments: [], files: [] },
        { uuid: 'a2', parent_message_uuid: 'h2', sender: 'assistant', text: '', content: [timed('d'.repeat(8), 246, 246 + secondReplyTakes)], created_at: at(246 + secondReplyTakes), attachments: [], files: [] },
      ],
    });
    const cached = async (seconds: number) => (await run([chat(seconds)])).out.messages.find((m) => m.externalId === 'a2')!.replayCachedBase;
    // the same request, sent at the same moment: how long the reply then took to write changes nothing
    expect(await cached(10)).toBe(1000);
    expect(await cached(60)).toBe(1000);
  });

  it('flags every conversation with several prompts in an export without pointers, and warns about several accounts', async () => {
    const m = (uuid: string, sender: string, seconds: number, n: number) => ({
      uuid, sender, text: 'x'.repeat(n), content: [textBlock('x'.repeat(n))], created_at: ts(`2025-02-24T23:10:${String(seconds).padStart(2, '0')}Z`), attachments: [], files: [],
    });
    // an edited prompt in an old export: prompt, reply, new prompt, new reply. Nothing tells it from two ordinary turns.
    const edited = { uuid: 'conv-edited', name: 'Edited', created_at: ts('2025-02-24T23:10:00Z'), updated_at: ts('2025-02-24T23:11:00Z'), account: { uuid: 'acct-2' },
      chat_messages: [m('h1', 'human', 0, 1000), m('a1', 'assistant', 10, 3000), m('h1b', 'human', 20, 1000), m('a1b', 'assistant', 30, 3000)] };
    const single = { uuid: 'conv-single', name: 'Single', created_at: ts('2025-02-24T23:10:00Z'), updated_at: ts('2025-02-24T23:11:00Z'), account: { uuid: 'acct-1' },
      chat_messages: [m('s-h1', 'human', 0, 10), m('s-a1', 'assistant', 10, 20)] };
    const { out, parsed } = await run([edited, single, { ...single, uuid: 'conv-single-2', chat_messages: [m('t-h1', 'human', 0, 10), m('t-a1', 'assistant', 10, 20)] }]);
    const flagged = (id: string) => (out.messages.find((x) => x.externalId === id)!.limitationFlags & Limitation.BRANCHES_LINEARISED) !== 0;
    expect(['h1', 'a1', 'h1b', 'a1b'].map(flagged)).toEqual([true, true, true, true]);
    // one prompt and its reply cannot contain an edit
    expect(['s-h1', 's-a1'].map(flagged)).toEqual([false, false]);

    const accounts = parsed.warnings.find((w) => w.code === 'several_accounts')!;
    expect(accounts).toMatchObject({ count: 2, sample: 'Conversations per account: 2, 1' });
    expect(accounts.message).toContain('count as one history');
    // the account with most conversations names the source; with a tie it is the same one whatever the order in the file
    expect(parsed.source.externalRef).toBe('acct-1');
    const tie = async (order: unknown[]) => (await run(order)).parsed.source.externalRef;
    expect(await tie([edited, single])).toBe(await tie([single, edited]));
  });

  it('streams a large export without holding it in memory as one value', async () => {
    const message = (i: number, j: number) => ({
      uuid: `c${i}-m${j}`, sender: j % 2 === 0 ? 'human' : 'assistant', text: '',
      content: [textBlock('lorem ipsum dolor sit amet '.repeat(40))],
      created_at: new Date(Date.UTC(2025, 0, 1, 0, 0, j) + i * 60_000).toISOString().replace('Z', '000Z'), attachments: [], files: [],
    });
    const parts: string[] = ['['];
    const conversations = 1500;
    for (let i = 0; i < conversations; i++) {
      parts.push((i ? ',' : '') + JSON.stringify({ uuid: `c${i}`, name: `Conversation ${i}`, created_at: '2025-01-01T00:00:00.000000Z', updated_at: '2025-01-01T00:00:00.000000Z', account: { uuid: 'acct-1' }, chat_messages: Array.from({ length: 20 }, (_, j) => message(i, j)) }));
    }
    parts.push(']');
    const file = { name: 'conversations.json', size: 0, blob: new Blob(parts) };
    file.size = file.blob.size;
    expect(file.size).toBeGreaterThan(30_000_000);

    let messages = 0;
    let maxBatchInMemory = 0;
    const { sink, out } = collectingSink();
    const started = performance.now();
    const parsed = await parser.parse([file], { ...sink, message: () => void messages++ }, ctx);
    const seconds = (performance.now() - started) / 1000;
    maxBatchInMemory = out.messages.length;
    expect(parsed.stats).toMatchObject({ conversations, messages: conversations * 20 });
    expect(messages).toBe(conversations * 20);
    expect(maxBatchInMemory).toBe(0);
    expect(out.progress.length).toBeGreaterThan(3);
    expect(out.progress.at(-1)).toMatchObject({ bytesRead: file.size, totalBytes: file.size, records: conversations });
    expect(seconds).toBeLessThan(20);
  });
});

describe('claude.ai export → database', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  const importJson = async (payload: unknown) => {
    await resetStaging(t.db);
    const writer = new StagingWriter(t.db);
    const parsed = await parser.parse([fileOf('conversations.json', JSON.stringify(payload))], writer, ctx);
    await writer.finish();
    const preview = await previewImport(t.db, t.userId, parsed);
    const result = await commitImport(t.db, t.userId, parsed);
    return { parsed, preview, result };
  };
  const totals = async () =>
    (
      await t.db.query<Record<string, number>>(
        // `rows` counts the per-message estimates; the view itself serves them summed into 15-minute buckets
        `SELECT (SELECT count(*) FROM token_estimates)::int AS rows,
                sum(input_tokens)::int AS input, sum(output_tokens)::int AS output, sum(replay_tokens)::int AS replay,
                sum(user_message_count)::int AS user_messages, sum(assistant_message_count)::int AS assistant_messages
           FROM usage_facts WHERE confidence = 'estimated'`,
      )
    ).rows[0];

  it('imports, shows estimates as estimates, and is idempotent', async () => {
    const first = await importJson([modernConversation(), legacyConversation()]);
    expect(first.preview).toMatchObject({
      conversations: { total: 2, new: 2, existing: 0 },
      messages: { total: 6, new: 6, duplicate: 0, withoutModel: 6, withoutTimestamp: 0 },
      coverage: { hasExactUsage: false, hasModel: false, modelShare: 0 },
      nothingNew: false,
    });
    expect(first.preview.tokens.exact).toBe(0);
    expect(first.preview.tokens.estimated).toBeGreaterThan(0);
    expect(first.result.inserted).toMatchObject({ conversations: 2, messages: 6 });

    const after = await totals();
    expect(after).toMatchObject({ rows: 6, user_messages: 3, assistant_messages: 3 });
    expect(first.preview.tokens.estimated).toBe(after.input + after.output + after.replay);
    // every estimate carries the claude3 factor (1.25) for these 2025 dates
    const toolUse = 'web_search {"query":"qqqqq"}'.length;
    const toolResult = `TTTT\nhttps://e.x\n${'k'.repeat(50)}\n${'r'.repeat(10)}\n`.length;
    expect(after.input).toBe([310, toolResult, 3, 10].reduce((s, n) => s + Math.round(n * 1.25), 0));
    expect(after.output).toBe([40 + toolUse + 6, 4, 20].reduce((s, n) => s + Math.round(n * 1.25), 0));

    const again = await importJson([modernConversation(), legacyConversation()]);
    expect(again.preview.nothingNew).toBe(true);
    expect(again.preview.previousImport?.batchId).toBe(first.result.batchId);
    expect(again.result.nothingNew).toBe(true);
    expect(await totals()).toEqual(after);
  });

  it('a later export of a longer conversation adds only the new messages', async () => {
    const before = await totals();
    const longer = modernConversation();
    longer.updated_at = ts('2025-06-02T09:00:00Z');
    longer.chat_messages.push(
      { uuid: 'h3', parent_message_uuid: 'a2', sender: 'human', text: '', content: [textBlock('e'.repeat(8))], created_at: ts('2025-06-02T08:59:00Z'), updated_at: '', attachments: [], files: [] } as never,
      { uuid: 'a3', parent_message_uuid: 'h3', sender: 'assistant', text: '', content: [textBlock('f'.repeat(16))], created_at: ts('2025-06-02T08:59:10Z'), updated_at: '', attachments: [], files: [] } as never,
    );
    const later = await importJson([longer]);
    expect(later.preview.conversations).toEqual({ total: 1, new: 0, existing: 1 });
    expect(later.preview.messages).toMatchObject({ total: 6, new: 2, duplicate: 4 });
    expect(later.result.inserted.messages).toBe(2);
    const after = await totals();
    expect(after.rows).toBe(before.rows + 2);
    expect(after.input).toBe(before.input + Math.round(8 * 1.25));
    expect(after.output).toBe(before.output + Math.round(16 * 1.25));
    const conv = (await t.db.query<Record<string, unknown>>(`SELECT message_count, updated_at FROM conversations WHERE external_id = 'conv-modern'`)).rows[0];
    expect(conv.message_count).toBe(6);
    expect((conv.updated_at as Date).toISOString()).toBe('2025-06-02T09:00:00.123Z');
  });
});
