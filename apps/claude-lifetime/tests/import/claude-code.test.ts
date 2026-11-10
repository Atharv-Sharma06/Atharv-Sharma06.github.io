import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hash64 } from '@/core/sha256';
import { ImportError, type ImportFile, type ParseContext, type ParsedImport } from '@/core/types';
import {
  classifyUserRow,
  claudeCodeParser,
  extractTranscripts,
  priceTierOf,
  PromptKind,
  ResponseFlag,
  transcriptPathInfo,
} from '@/import/claude-code';
import {
  assistant,
  at,
  file,
  FIXTURE_DIR,
  jsonl,
  LATER,
  legacyUsage,
  loadFixtureDir,
  MemorySink,
  rowUuid,
  SESSION_A,
  SESSION_B,
  toolResult,
  toolUse,
  totals,
  totalsBy,
  usage,
  user,
} from '../fixtures/claude-code/builders';

type Json = Record<string, unknown>;

async function run(files: ImportFile[], ctx: ParseContext = {}) {
  const sink = new MemorySink();
  const parsed = await claudeCodeParser.parse(files, sink, { ...ctx, options: { now: LATER, ...ctx.options } });
  return { parsed, sink };
}

const main = (session: string, rows: unknown[], lastModified?: number) => file(`projects/-home-alex-demo/${session}.jsonl`, jsonl(rows), lastModified);
const warning = (parsed: ParsedImport, code: string) => parsed.warnings.find((w) => w.code === code);
const byModel = (sink: MemorySink) => totalsBy(sink.usages, (u) => u.modelKey ?? 'none');
const byTier = (sink: MemorySink) => totalsBy(sink.usages, (u) => u.priceTier);
const bySession = (sink: MemorySink) => totalsBy(sink.usages, (u) => u.conversationKey ?? 'none');

describe('research example (synthetic session of the format description, §10)', () => {
  const S = '11111111-1111-4111-8111-111111111111';

  it('contains the hazards: summing every assistant row would inflate the totals', () => {
    const naive = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    for (const f of [`${S}.jsonl`, `${S}/subagents/agent-a0000000000000001.jsonl`]) {
      const lines = readFileSync(join(FIXTURE_DIR, 'research-example/projects/-home-alex-demo', f), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const row = JSON.parse(line) as { type: string; message?: { usage?: Record<string, number> } };
        if (row.type !== 'assistant' || !row.message?.usage) continue;
        naive.input += row.message.usage.input_tokens;
        naive.output += row.message.usage.output_tokens;
        naive.cacheCreation += row.message.usage.cache_creation_input_tokens;
        naive.cacheRead += row.message.usage.cache_read_input_tokens;
      }
    }
    expect(naive).toEqual({ input: 23, output: 800, cacheCreation: 9240, cacheRead: 64150 });
  });

  it('counts 4 responses and 1 human prompt with the exact expected totals by model', async () => {
    const { parsed, sink } = await run(loadFixtureDir('research-example', Date.UTC(2026, 0, 15, 12)));

    expect(byModel(sink)).toEqual({
      // 3 main-thread responses (the first one is written as two lines)
      'claude-sonnet-4-5': { input: 9, output: 380, cacheRead: 49150, cacheWrite5m: 240, cacheWrite1h: 2000, requests: 3, userMessages: 1, assistantMessages: 1 },
      // 1 subagent response, only present in the subagent file
      'claude-haiku-4-5': { input: 10, output: 300, cacheRead: 0, cacheWrite5m: 5000, cacheWrite1h: 0, requests: 1, userMessages: 0, assistantMessages: 0 },
    });
    // Overall: 19 / 680 / 7,240 cache creation (1h 2,000 + 5m 5,240) / 49,150 cache read.
    // The subagent summary in toolUseResult.usage (10 / 300 / 5,000) is not in here.
    expect(totals(sink.usages)).toEqual({ input: 19, output: 680, cacheRead: 49150, cacheWrite5m: 5240, cacheWrite1h: 2000, requests: 4, userMessages: 1, assistantMessages: 1 });

    expect(parsed.stats).toMatchObject({
      files: 2, filesRead: 2, subagentFiles: 1, usageRows: 6, syntheticRows: 1, duplicateLines: 1,
      responses: 4, newResponses: 4, subagentResponses: 1, newSubagentResponses: 1,
      humanPrompts: 1, newHumanPrompts: 1, newTypedPrompts: 1,
      inputTokens: 19, outputTokens: 680, cacheReadTokens: 49150, cacheWrite5mTokens: 5240, cacheWrite1hTokens: 2000,
      sessions: 1, usageBuckets: 2, deferredInProgress: 0, cacheTtlUnknownRequests: 0,
      firstTimestamp: '2026-01-15T09:00:00.000Z', lastTimestamp: '2026-01-15T09:00:24.000Z',
    });
    expect(parsed).toMatchObject({
      format: 'claude-code/jsonl',
      formatLabel: 'Claude Code session transcripts',
      parserVersion: 'claude-code-1',
      source: { kind: 'claude_code', label: 'Claude Code (this computer)', externalRef: 'local' },
      fileName: '2 transcript files',
      contentHash: null,
      recordsSeen: 6,
      recordsSkipped: 1, // the <synthetic> row
      missingFields: [],
      warnings: [],
      duplicateRequests: 0,
    });
    expect(parsed.fileSize).toBe(readFixtureBytes(S));
    // 4 responses + 1 prompt
    expect(parsed.requestKeys).toHaveLength(5);
    expect(parsed.requestKeys).toContain(hash64('mr:msg_SYNTHETIC000000000000001:req_SYNTHETIC000000000000001'));
    expect(parsed.requestKeys).toContain(hash64('mr:msg_SYNTHETIC000000000000004:req_SYNTHETIC000000000000004'));
    expect(parsed.requestKeys).toContain(hash64('p:aaaaaaaa-0000-4000-8000-000000000001'));
  });

  it('stages one 15-minute row per model and one conversation', async () => {
    const { parsed, sink } = await run(loadFixtureDir('research-example', Date.UTC(2026, 0, 15, 12)));
    expect(sink.models).toEqual([]);
    expect(sink.usages).toHaveLength(2);
    for (const u of sink.usages) {
      expect(u).toMatchObject({
        conversationKey: `claude_code:${S}`,
        occurredAt: '2026-01-15T09:00:00.000Z',
        bucketSeconds: 900,
        priceTier: 'standard',
        confidence: 'exact',
        webSearchRequests: 0,
      });
    }
    expect(sink.conversations).toEqual([
      {
        dedupKey: `claude_code:${S}`,
        kind: 'code_session',
        externalId: S,
        // The summary row names a leaf (…0099) that is not in the files, so it is not this session's title.
        title: null,
        projectLabel: '/home/alex/demo',
        modelKey: 'claude-sonnet-4-5',
        createdAt: '2026-01-15T09:00:00.000Z',
        updatedAt: '2026-01-15T09:00:24.000Z',
        metadata: { gitBranch: 'main', version: '2.1.321', hasSubagents: true },
      },
    ]);
    expect(parsed.stats.summariesUnresolved).toBe(1);
    // Both files are old and complete, so both are remembered as synced.
    expect(parsed.syncedFiles?.map((f) => f.path)).toEqual([
      `projects/-home-alex-demo/${S}.jsonl`,
      `projects/-home-alex-demo/${S}/subagents/agent-a0000000000000001.jsonl`,
    ]);
  });

  it('does not count the subagent when only the parent file is given, and says nothing is missing', async () => {
    const files = loadFixtureDir('research-example').filter((f) => !f.path?.includes('/subagents/'));
    const { parsed, sink } = await run(files);
    expect(Object.keys(byModel(sink))).toEqual(['claude-sonnet-4-5']);
    expect(parsed.stats).toMatchObject({ responses: 3, subagentResponses: 0 });
    expect(parsed.fileName).toBe(`${S}.jsonl`);
    expect(sink.conversations[0].metadata).toEqual({ gitBranch: 'main', version: '2.1.321' });
  });

  function readFixtureBytes(session: string): number {
    const dir = join(FIXTURE_DIR, 'research-example/projects/-home-alex-demo');
    return readFileSync(join(dir, `${session}.jsonl`)).length + readFileSync(join(dir, session, 'subagents/agent-a0000000000000001.jsonl')).length;
  }
});

describe('one response written as several lines', () => {
  it('legacy streaming snapshots: the largest line wins, never the sum, and a missing final line is reported', async () => {
    const { parsed, sink } = await run(loadFixtureDir('legacy-snapshots'));
    // lines carry output_tokens 8 and 310 for the same message id and request id
    expect(totals(sink.usages)).toEqual({ input: 4, output: 310, cacheRead: 15000, cacheWrite5m: 2000, cacheWrite1h: 0, requests: 1, userMessages: 0, assistantMessages: 0 });
    expect(sink.usages[0].occurredAt).toBe('2026-02-21T10:00:00.000Z');
    expect(parsed.stats).toMatchObject({ usageRows: 2, duplicateLines: 1, responses: 1, partialResponses: 1, cacheTtlUnknownRequests: 1 });
    expect(warning(parsed, 'partial_usage')).toMatchObject({ count: 1, sample: 'mr:msg_SYNTHETIC000000000000009:req_SYNTHETIC000000000000009' });
    expect(warning(parsed, 'partial_usage')?.message).toMatch(/output tokens may be undercounted/);
    expect(parsed.missingFields).toEqual(['cache_creation']);
  });

  it('a finished final line replaces the preliminary snapshots and raises no warning', async () => {
    const id = { id: 'msg_L1', req: 'req_L1' };
    const { parsed, sink } = await run([
      main(SESSION_A, [
        assistant({ ...id, ts: at('10:00:00'), stop: null, usage: legacyUsage(4, 2, 15000, 2000), content: [{ type: 'thinking', thinking: '...' }] }),
        assistant({ ...id, ts: at('10:00:01'), stop: null, usage: legacyUsage(4, 40, 15000, 2000) }),
        assistant({ ...id, ts: at('10:16:04'), stop: 'end_turn', usage: usage(4, 1093, 15000, 0, 2000) }),
      ]),
    ]);
    expect(totals(sink.usages)).toEqual({ input: 4, output: 1093, cacheRead: 15000, cacheWrite5m: 0, cacheWrite1h: 2000, requests: 1, userMessages: 0, assistantMessages: 1 });
    // bucketed at the first line of the response, even though the final line came a bucket later
    expect(sink.usages.map((u) => u.occurredAt)).toEqual(['2026-01-15T10:00:00.000Z']);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.stats).toMatchObject({ partialResponses: 0, cacheTtlUnknownRequests: 0, duplicateLines: 2 });
  });

  it('identical repeated usage (current versions) is counted once', async () => {
    const id = { id: 'msg_C1', req: 'req_C1', usage: usage(3, 500, 9000, 100, 0), stop: 'tool_use' };
    const { sink } = await run([
      main(SESSION_A, [
        assistant({ ...id, ts: at('11:00:00'), content: [{ type: 'thinking', thinking: '...' }] }),
        assistant({ ...id, ts: at('11:00:01'), content: [{ type: 'text', text: 'x' }] }),
        assistant({ ...id, ts: at('11:00:02'), content: [toolUse()] }),
        assistant({ ...id, ts: at('11:00:03'), content: [toolUse('Read')] }),
      ]),
    ]);
    expect(totals(sink.usages)).toMatchObject({ input: 3, output: 500, cacheRead: 9000, cacheWrite5m: 100, requests: 1, assistantMessages: 0 });
  });

  it('ranks lines: finished beats unfinished, then the larger total', async () => {
    const { sink } = await run([
      main(SESSION_A, [
        // an unfinished snapshot with a larger count than the finished line: the finished line is the record
        assistant({ id: 'msg_K1', req: 'req_K1', ts: at('12:00:00'), stop: null, usage: usage(1, 900) }),
        assistant({ id: 'msg_K1', req: 'req_K1', ts: at('12:00:01'), stop: 'end_turn', usage: usage(1, 700) }),
        // both finished: the larger one
        assistant({ id: 'msg_K2', req: 'req_K2', ts: at('12:01:00'), usage: usage(1, 10) }),
        assistant({ id: 'msg_K2', req: 'req_K2', ts: at('12:01:01'), usage: usage(1, 30) }),
        assistant({ id: 'msg_K2', req: 'req_K2', ts: at('12:01:02'), usage: usage(1, 20) }),
      ]),
    ]);
    expect(totals(sink.usages)).toMatchObject({ input: 2, output: 730, requests: 2 });
  });
});

describe('the same response in more than one file', () => {
  // The branch sorts before the original on purpose: attribution must not depend on file order.
  const ORIGINAL = SESSION_B;
  const BRANCH = SESSION_A;

  function sessionRows() {
    const r1 = { id: 'msg_R1', req: 'req_R1', session: ORIGINAL, stop: 'tool_use', usage: usage(4, 120, 15000, 0, 2000) };
    return [
      user('PROMPT-ONE-MUST-NOT-LEAK', { ts: at('09:00:00'), session: ORIGINAL }),
      assistant({ ...r1, ts: at('09:00:02') }),
      assistant({ ...r1, ts: at('09:00:03'), content: [toolUse()] }),
      toolResult({ ts: at('09:00:05'), session: ORIGINAL }),
      assistant({ id: 'msg_R2', req: 'req_R2', session: ORIGINAL, ts: at('09:00:08'), usage: usage(2, 200, 17150, 90, 0) }),
    ];
  }
  // What `/branch` does to each row it copies: new sessionId, forkedFrom pointing back.
  const branched = (row: Json): Json => ({ ...row, sessionId: BRANCH, forkedFrom: { sessionId: ORIGINAL, messageUuid: row.uuid } });

  it('a /branch copy, a whole-file copy and an .orphaned copy are counted once, under the original session', async () => {
    const rows = sessionRows();
    const files = [
      main(ORIGINAL, rows),
      main(BRANCH, [
        ...rows.map(branched),
        user('PROMPT-TWO-MUST-NOT-LEAK', { ts: at('09:20:00'), session: BRANCH }),
        assistant({ id: 'msg_R3', req: 'req_R3', session: BRANCH, ts: at('09:20:05'), usage: usage(3, 60, 17000, 150, 0) }),
      ]),
      file('backup/-a-copied-project/renamed-copy.jsonl', jsonl(rows)),
      file(`projects/-home-alex-demo/${ORIGINAL}.orphaned-1768467600000-ab12.jsonl`, jsonl(rows.slice(0, 3))),
    ];
    const { parsed, sink } = await run(files);

    expect(bySession(sink)).toEqual({
      [`claude_code:${ORIGINAL}`]: { input: 6, output: 320, cacheRead: 32150, cacheWrite5m: 90, cacheWrite1h: 2000, requests: 2, userMessages: 1, assistantMessages: 1 },
      [`claude_code:${BRANCH}`]: { input: 3, output: 60, cacheRead: 17000, cacheWrite5m: 150, cacheWrite1h: 0, requests: 1, userMessages: 1, assistantMessages: 1 },
    });
    // 3 + 4 + 3 + 2 usage rows describe 3 responses
    expect(parsed.stats).toMatchObject({ files: 4, usageRows: 12, duplicateLines: 9, responses: 3, humanPrompts: 2, sessions: 2 });
    expect(sink.conversations.map((c) => [c.externalId, c.createdAt, c.updatedAt])).toEqual([
      [BRANCH, '2026-01-15T09:20:00.000Z', '2026-01-15T09:20:05.000Z'],
      [ORIGINAL, '2026-01-15T09:00:00.000Z', '2026-01-15T09:00:08.000Z'],
    ]);
  });

  it('gives the same result whichever copy is read, and in any combination', async () => {
    const rows = sessionRows();
    const original = await run([main(ORIGINAL, rows)]);
    const copyOnly = await run([file('backup/renamed-copy.jsonl', jsonl(rows))]);
    const branchOnly = await run([main(BRANCH, rows.map(branched))]);
    for (const other of [copyOnly, branchOnly]) {
      expect(other.sink.usages).toEqual(original.sink.usages);
      expect(other.parsed.requestKeys).toEqual(original.parsed.requestKeys);
    }
  });

  it('old-style resume copies (same ids, another sessionId, no forkedFrom) are counted once', async () => {
    const rows = sessionRows();
    const resumed = rows.map((row) => ({ ...row, sessionId: BRANCH }));
    const { parsed, sink } = await run([main(ORIGINAL, rows), main(BRANCH, resumed)]);
    expect(totals(sink.usages)).toMatchObject({ input: 6, output: 320, requests: 2, userMessages: 1 });
    expect(parsed.stats).toMatchObject({ responses: 2, humanPrompts: 1 });
  });
});

describe('subagents and sidechain replays', () => {
  const parent = () => [
    user('PROMPT-MUST-NOT-LEAK', { ts: at('09:00:00') }),
    assistant({ id: 'msg_PARENT', req: 'req_P1', ts: at('09:00:02'), usage: usage(10, 100, 50000) }),
  ];
  const aside = () => [
    user('SIDE-QUESTION-MUST-NOT-LEAK', { ts: at('09:05:00'), extra: { isSidechain: true, agentId: 'aside1' } }),
    // the parent message replayed under a new request id, with the parent's cache read
    assistant({ id: 'msg_PARENT', req: 'req_REPLAY', ts: at('09:05:01'), sidechain: true, usage: usage(10, 100, 50000) }),
    assistant({ id: 'msg_SIDE', req: 'req_S1', ts: at('09:05:03'), sidechain: true, usage: usage(5, 40, 50100) }),
  ];
  const asidePath = `projects/-home-alex-demo/${SESSION_A}/subagents/agent-aside_question-1.jsonl`;

  it('a sidechain replay of a parent message under another requestId keeps the parent row only', async () => {
    const { parsed, sink } = await run([main(SESSION_A, parent()), file(asidePath, jsonl(aside()))]);
    expect(totals(sink.usages)).toEqual({ input: 15, output: 140, cacheRead: 100100, cacheWrite5m: 0, cacheWrite1h: 0, requests: 2, userMessages: 1, assistantMessages: 1 });
    expect(parsed.stats).toMatchObject({ responses: 2, subagentResponses: 1, sidechainReplaysDropped: 1, humanPrompts: 1 });
    expect(parsed.requestKeys).toContain(hash64('mr:msg_PARENT:req_P1'));
    expect(parsed.requestKeys).not.toContain(hash64('mr:msg_PARENT:req_REPLAY'));
  });

  it('still drops the replay when the parent file is unchanged and would be skipped', async () => {
    const mainFile = main(SESSION_A, parent(), LATER - 3_600_000);
    const first = await run([mainFile]);
    expect(first.parsed.syncedFiles).toHaveLength(1);

    const knownFiles = new Map(first.parsed.syncedFiles!.map((f) => [f.path, { size: f.size, lastModified: f.lastModified }]));
    const second = await run([mainFile, file(asidePath, jsonl(aside()), LATER - 3_000_000)], {
      knownFiles,
      knownRequestKeys: new Set(first.parsed.requestKeys),
    });
    expect(second.parsed.stats).toMatchObject({
      filesRereadForContext: 1, filesSkippedUnchanged: 0, sidechainReplaysDropped: 1, newResponses: 1, duplicateResponses: 1, duplicateHumanPrompts: 1,
    });
    expect(totals(second.sink.usages)).toMatchObject({ input: 5, output: 40, cacheRead: 50100, requests: 1 });
    expect(second.parsed.duplicateRequests).toBe(2);
  });

  it('keeps one row when sidechain files replay a message whose parent row is not available', async () => {
    const other = aside().map((row) => (row.type === 'assistant' && (row.message as Json).id === 'msg_PARENT' ? { ...row, requestId: 'req_REPLAY2', uuid: rowUuid() } : { ...row, uuid: rowUuid() }));
    const { parsed, sink } = await run([
      file(asidePath, jsonl(aside())),
      file(asidePath.replace('question-1', 'question-2'), jsonl(other)),
    ]);
    expect(parsed.stats).toMatchObject({ responses: 2, sidechainReplaysDropped: 1 });
    expect(totals(sink.usages)).toMatchObject({ input: 15, output: 140, requests: 2, userMessages: 0, assistantMessages: 0 });
  });

  it('counts both when a message id appears under two request ids on the main thread, and reports it', async () => {
    const { parsed, sink } = await run([
      main(SESSION_A, [
        assistant({ id: 'msg_TWICE', req: 'req_T1', ts: at('09:00:00'), usage: usage(1, 10) }),
        assistant({ id: 'msg_TWICE', req: 'req_T2', ts: at('09:00:05'), usage: usage(2, 20) }),
      ]),
    ]);
    expect(totals(sink.usages)).toMatchObject({ input: 3, output: 30, requests: 2 });
    expect(parsed.stats.messageIdsReused).toBe(1);
    expect(warning(parsed, 'message_id_reused')).toMatchObject({ count: 2 });
  });

  it('legacy progress wrappers merge with the subagent file and stand in for it when it is gone', async () => {
    const sub = assistant({ id: 'msg_SUB', req: 'req_SUB', ts: at('09:10:00'), sidechain: true, model: 'claude-haiku-4-5-20251001', usage: usage(7, 70, 700) });
    const wrapper = {
      type: 'progress',
      uuid: rowUuid(),
      timestamp: at('09:10:01'),
      sessionId: SESSION_A,
      cwd: '/home/alex/demo',
      toolUseID: 'toolu_TEST',
      data: { type: 'agent_progress', message: { timestamp: sub.timestamp, requestId: sub.requestId, isSidechain: true, message: sub.message } },
    };
    const mainFile = main(SESSION_A, [...parent(), wrapper]);
    const legacyAgentFile = file('projects/-home-alex-demo/agent-abc123.jsonl', jsonl([sub]));

    const both = await run([mainFile, legacyAgentFile]);
    const wrapperOnly = await run([mainFile]);
    for (const { parsed, sink } of [both, wrapperOnly]) {
      expect(byModel(sink)['claude-haiku-4-5']).toMatchObject({ input: 7, output: 70, cacheRead: 700, requests: 1 });
      expect(parsed.stats).toMatchObject({ responses: 2, subagentResponses: 1 });
    }
    expect(both.parsed.stats.duplicateLines).toBe(1);
    expect(both.parsed.requestKeys).toEqual(wrapperOnly.parsed.requestKeys);
  });
});

describe('human prompts', () => {
  const row = (content: unknown, extra: Json = {}): Json => ({ type: 'user', uuid: 'u', timestamp: at('09:00:00'), sessionId: SESSION_A, message: { role: 'user', content }, ...extra });
  const text = (t: string) => ({ type: 'text', text: t });

  const counted: Array<[string, Json, number]> = [
    ['a typed prompt (string)', row('Why does the test fail?'), PromptKind.TYPED],
    ['a typed prompt (text block)', row([text('Why does the test fail?')]), PromptKind.TYPED],
    ['a typed prompt marked origin human', row('hello', { origin: { kind: 'human' }, turnOrigin: 'human', promptSource: 'typed' }), PromptKind.TYPED],
    ['a pasted image without text', row([{ type: 'image', source: { type: 'base64', data: '' } }]), PromptKind.TYPED],
    ['a prompt with an injected block in front of it', row([text('<system-reminder>context</system-reminder>'), text('the actual prompt')]), PromptKind.TYPED],
    ['a slash command', row('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'), PromptKind.COMMAND],
    ['a slash command with the message tag first', row('<command-message>review</command-message>\n<command-name>/review</command-name>'), PromptKind.COMMAND],
    ['a ! shell command', row('<bash-input>ls -la</bash-input>'), PromptKind.SHELL],
  ];
  it.each(counted)('counts %s', (_name, r, kind) => {
    expect(classifyUserRow(r)).toEqual({ prompt: kind });
  });

  const excluded: Array<[string, Json, string]> = [
    ['a subagent prompt written by the model (isSidechain)', row('Search for weekday handling', { isSidechain: true, agentId: 'a1' }), 'sidechain'],
    ['an injected meta row (isMeta)', row('<system-reminder>\nToday is Monday.\n</system-reminder>', { isMeta: true }), 'meta'],
    ['an expanded skill body (isMeta)', row([text('Base directory for this skill: /x')], { isMeta: true, sourceToolUseID: 't' }), 'meta'],
    ['a compaction summary (isCompactSummary)', row('Summary of the earlier conversation', { isCompactSummary: true }), 'compact_summary'],
    ['a transcript-only row (isVisibleInTranscriptOnly)', row('Summary', { isVisibleInTranscriptOnly: true }), 'compact_summary'],
    ['a tool result (toolUseResult)', row([{ type: 'tool_result', tool_use_id: 't', content: '1 failed' }], { toolUseResult: { stdout: '1 failed' } }), 'tool_result'],
    ['a tool result (string toolUseResult)', row('some output', { toolUseResult: 'Error: denied' }), 'tool_result'],
    ['a tool_result block without toolUseResult', row([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]), 'tool_result'],
    ['a tool result followed by an interrupt marker', row([{ type: 'tool_result', tool_use_id: 't', content: 'x' }, text('[Request interrupted by user for tool use]')]), 'tool_result'],
    ['an empty string', row(''), 'empty'],
    ['whitespace only', row('  \n\t'), 'empty'],
    ['an empty block list', row([]), 'empty'],
    ['a row without message content', { type: 'user', uuid: 'u', timestamp: at('09:00:00') }, 'empty'],
    ['a task notification (origin)', row('Background task finished', { origin: { kind: 'task-notification' } }), 'origin'],
    ['an auto-continuation (origin)', row('Continue', { origin: { kind: 'auto-continuation' } }), 'origin'],
    ['local command output', row('<local-command-stdout>Set model to opus</local-command-stdout>'), 'injected'],
    ['local command errors', row('<local-command-stderr>oops</local-command-stderr>'), 'injected'],
    ['the local command caveat', row('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'), 'injected'],
    ['shell output', row('<bash-stdout>total 4</bash-stdout><bash-stderr></bash-stderr>'), 'injected'],
    ['shell errors', row('<bash-stderr>not found</bash-stderr>'), 'injected'],
    ['a task notification (text)', row('<task-notification>\n<task-id>1</task-id>\n</task-notification>'), 'injected'],
    ['a system reminder', row('<system-reminder>be careful</system-reminder>'), 'injected'],
    ['a memory input', row('<user-memory-input>remember this</user-memory-input>'), 'injected'],
    ['a teammate message', row('<teammate-message teammate_id="lead">hi</teammate-message>'), 'injected'],
    ['an interrupt marker', row([text('[Request interrupted by user]')]), 'injected'],
    ['a continued-session summary without the flag', row('This session is being continued from a previous conversation that ran out of context.'), 'injected'],
  ];
  it.each(excluded)('does not count %s', (_name, r, reason) => {
    expect(classifyUserRow(r)).toEqual({ excluded: reason });
  });

  it('does not count any user row of a subagent file', () => {
    expect(classifyUserRow(row('Search for weekday handling'), true)).toEqual({ excluded: 'sidechain' });
  });

  it('counts each prompt once, attributes it to the answering model and never keeps its text', async () => {
    const rows = [
      ...counted.map(([, r], i) => ({ ...r, uuid: `prompt-${i}`, timestamp: at(`09:0${i}:00`) })),
      ...excluded.map(([, r], i) => ({ ...r, uuid: `other-${i}`, timestamp: at('09:30:00') })),
      // the queue repeats the prompt text; it is not a user row
      { type: 'queue-operation', operation: 'enqueue', timestamp: at('09:00:00'), sessionId: SESSION_A, content: 'Why does the test fail?' },
      assistant({ id: 'msg_ANSWER', req: 'req_ANSWER', ts: at('09:40:00'), model: 'claude-opus-5-5', usage: usage(1, 1) }),
    ];
    const { parsed, sink } = await run([main(SESSION_A, rows)]);
    expect(parsed.stats).toMatchObject({ humanPrompts: 8, newHumanPrompts: 8, newTypedPrompts: 5, newSlashCommands: 2, newShellCommands: 1 });
    // every prompt precedes the only response, so all are attributed to its model
    expect(byModel(sink)).toEqual({ 'claude-opus-5-5': expect.objectContaining({ userMessages: 8, requests: 1 }) });
    expect(parsed.requestKeys).toContain(hash64('p:prompt-0'));
    expect(JSON.stringify([parsed, sink.usages, sink.conversations], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/Why does the test fail|actual prompt|ls -la|MUST-NOT-LEAK/);
  });

  it('attributes a prompt without a later response to the dominant model of its session', async () => {
    const { sink } = await run([
      main(SESSION_A, [
        user('first', { ts: at('09:00:00') }),
        assistant({ id: 'msg_1', req: 'req_1', ts: at('09:00:05'), model: 'claude-haiku-4-5', usage: usage(10, 10) }),
        user('second', { ts: at('09:01:00') }),
        assistant({ id: 'msg_2', req: 'req_2', ts: at('09:01:05'), model: 'claude-opus-5-5', usage: usage(5000, 500), stop: 'tool_use', content: [toolUse()] }),
        user('<command-name>/exit</command-name>', { ts: at('10:00:00') }),
      ]),
    ]);
    const rows = sink.usages.map((u) => [u.occurredAt.slice(11, 16), u.modelKey, u.userMessageCount, u.requestCount, u.assistantMessageCount]);
    expect(rows).toEqual([
      ['09:00', 'claude-haiku-4-5', 1, 1, 1],
      ['09:00', 'claude-opus-5-5', 1, 1, 0],
      // no response follows /exit: it goes to the model that processed the most tokens
      ['10:00', 'claude-opus-5-5', 1, 0, 0],
    ]);
  });
});

describe('price tiers and cache writes', () => {
  it('derives the tier from speed, service tier and, for Haiku 5.5, the prompt size', async () => {
    const r = (n: number, model: string, u: Json) => assistant({ id: `msg_T${n}`, req: `req_T${n}`, ts: at('09:00:00'), model, usage: u });
    const { sink } = await run([
      main(SESSION_A, [
        r(1, 'claude-opus-5-5', usage(10, 1, 0, 0, 0, { speed: 'fast' })),
        r(2, 'claude-opus-5-5', usage(20, 1, 0, 0, 0, { service_tier: 'batch' })),
        r(3, 'claude-opus-5-5', usage(30, 1, 0, 0, 0, { service_tier: 'priority' })),
        r(4, 'claude-opus-5-5', usage(40, 1, 0, 0, 0, { service_tier: 'priority_on_demand' })),
        // fast mode wins over the service tier
        r(5, 'claude-opus-5-5', usage(50, 1, 0, 0, 0, { speed: 'fast', service_tier: 'batch' })),
        r(6, 'claude-opus-5-5', usage(60, 1, 500000, 0, 0)),
        // input + cache read + cache write = 100,001: over the threshold
        r(7, 'claude-haiku-5-5', usage(60000, 1, 30000, 10000, 1)),
        // exactly 100,000: not over
        r(8, 'claude-haiku-5-5', usage(60000, 1, 30000, 10000, 0)),
        // output does not count towards the prompt
        r(9, 'claude-haiku-5-5', usage(1000, 150000, 0, 0, 0)),
        // only Haiku 5.5 has a long-context price
        r(10, 'claude-haiku-4-5-20251001', usage(70000, 1, 90000, 0, 0)),
      ]),
    ]);
    const rows = Object.fromEntries(sink.usages.map((u) => [`${u.modelKey} ${u.priceTier}`, [u.inputTokens, u.requestCount]]));
    expect(rows).toEqual({
      'claude-opus-5-5 fast': [60, 2],
      'claude-opus-5-5 batch': [20, 1],
      'claude-opus-5-5 priority': [70, 2],
      'claude-opus-5-5 standard': [60, 1],
      'claude-haiku-5-5 long_context': [60000, 1],
      'claude-haiku-5-5 standard': [61000, 2],
      'claude-haiku-4-5 standard': [70000, 1],
    });
    expect(Object.keys(byTier(sink)).sort()).toEqual(['batch', 'fast', 'long_context', 'priority', 'standard']);
  });

  it('priceTierOf', () => {
    const t = (modelKey: string | null, flags: number, serviceTier: string | null, input = 0, cacheRead = 0, w5 = 0, w1 = 0) =>
      priceTierOf(modelKey, { flags, serviceTier, input, output: 999999, cacheRead, cacheWrite5m: w5, cacheWrite1h: w1 });
    expect(t('claude-opus-5-5', ResponseFlag.FAST, 'standard')).toBe('fast');
    expect(t('claude-opus-5-5', 0, 'batch')).toBe('batch');
    expect(t('claude-opus-5-5', 0, 'priority')).toBe('priority');
    expect(t('claude-opus-5-5', 0, null)).toBe('standard');
    expect(t(null, 0, null, 500000)).toBe('standard');
    expect(t('claude-haiku-5-5', 0, 'standard', 1, 99999, 0, 0)).toBe('standard');
    expect(t('claude-haiku-5-5', 0, 'standard', 1, 99999, 0, 1)).toBe('long_context');
    expect(t('claude-haiku-5-5', ResponseFlag.FAST, 'standard', 200000)).toBe('fast');
    expect(t('claude-haiku-5-5', 0, 'batch', 200000)).toBe('batch');
  });

  it('uses the 5m / 1h split when present and falls back to 5-minute writes when it is not', async () => {
    const r = (n: number, u: Json) => assistant({ id: `msg_W${n}`, req: `req_W${n}`, ts: at('09:00:00'), usage: u });
    const { parsed, sink } = await run([
      main(SESSION_A, [
        r(1, usage(1, 1, 0, 300, 500)),
        // old rows: only the total
        r(2, legacyUsage(1, 1, 0, 700)),
        // nothing written to the cache: nothing unknown
        r(3, legacyUsage(1, 1, 50, 0)),
        // a split that does not explain the whole total: the rest is held as 5-minute writes
        r(4, { ...usage(1, 1, 0, 300, 500), cache_creation_input_tokens: 1000 }),
      ]),
    ]);
    expect(totals(sink.usages)).toMatchObject({ cacheWrite5m: 300 + 700 + 300 + 200, cacheWrite1h: 500 + 500, cacheRead: 50 });
    expect(parsed.stats.cacheTtlUnknownRequests).toBe(2);
    expect(parsed.missingFields).toEqual(['cache_creation']);
    expect(warning(parsed, 'cache_ttl_unknown')).toMatchObject({ count: 2 });
  });
});

describe('usage.iterations', () => {
  const top = { input_tokens: 2, output_tokens: 357, cache_read_input_tokens: 61878, cache_creation_input_tokens: 35120, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 35120 } };
  const withIterations = (iterations: unknown) => ({ ...usage(2, 357, 61878, 0, 35120), iterations });
  const advisor = { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } };

  it('a single message iteration is the response itself and adds nothing', async () => {
    const { parsed, sink } = await run([
      main(SESSION_A, [assistant({ id: 'msg_I0', req: 'req_I0', ts: at('09:00:00'), model: 'claude-sonnet-5-5', usage: withIterations([{ ...top, type: 'message' }]) })]),
    ]);
    expect(totals(sink.usages)).toMatchObject({ input: 2, output: 357, cacheRead: 61878, cacheWrite1h: 35120, requests: 1 });
    expect(parsed.requestKeys).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
  });

  it('advisor iterations become records under the advisor model; fallback and compaction iterations are reported, not added', async () => {
    const files = [
      main(SESSION_A, [
        assistant({
          id: 'msg_I1', req: 'req_I1', ts: at('09:00:00'), model: 'claude-sonnet-5-5',
          usage: withIterations([
            { ...top, type: 'message' },
            advisor,
            { type: 'fallback_message', model: 'claude-sonnet-4-5', input_tokens: 7, output_tokens: 9 },
            { type: 'compaction', model: null, input_tokens: 5000, output_tokens: 800 },
            // an advisor entry that names no model cannot be attributed
            { ...advisor, model: null },
          ]),
        }),
      ]),
    ];
    const { parsed, sink } = await run(files);
    expect(byModel(sink)).toEqual({
      'claude-sonnet-5-5': { input: 2, output: 357, cacheRead: 61878, cacheWrite5m: 0, cacheWrite1h: 35120, requests: 1, userMessages: 0, assistantMessages: 1 },
      // tokens only: the advisor ran inside the same API request
      'claude-opus-5-5': { input: 100, output: 50, cacheRead: 1000, cacheWrite5m: 40, cacheWrite1h: 0, requests: 0, userMessages: 0, assistantMessages: 0 },
    });
    expect(parsed.requestKeys?.slice().sort()).toEqual([hash64('mr:msg_I1:req_I1'), hash64('mr:msg_I1:req_I1:advisor:1')].sort());
    expect(parsed.stats).toMatchObject({ responses: 1, advisorRecords: 1, newAdvisorRecords: 1, iterationsNotCounted: 3 });
    expect(warning(parsed, 'iterations_not_counted')).toMatchObject({ count: 3, sample: 'mr:msg_I1:req_I1' });
    expect(warning(parsed, 'iterations_not_counted')?.message).toMatch(/fallback_message: 1, compaction: 1, advisor_message: 1/);

    // importing again adds neither the response nor the advisor record
    const again = await run(files, { knownRequestKeys: new Set(parsed.requestKeys) });
    expect(again.sink.usages).toEqual([]);
    expect(again.parsed).toMatchObject({ requestKeys: [], duplicateRequests: 2, warnings: [] });
  });

  it('several message iterations are not interpreted', async () => {
    const { parsed, sink } = await run([
      main(SESSION_A, [assistant({ id: 'msg_I2', req: 'req_I2', ts: at('09:00:00'), usage: withIterations([{ ...top, type: 'message' }, { ...top, type: 'message' }]) })]),
    ]);
    expect(totals(sink.usages)).toMatchObject({ input: 2, output: 357, requests: 1 });
    expect(warning(parsed, 'iterations_not_counted')).toMatchObject({ count: 2 });
  });
});

describe('aggregation into 15-minute buckets', () => {
  const rows = () => [
    assistant({ id: 'msg_B1', req: 'req_B1', ts: at('09:01:00'), usage: usage(1, 10, 100, 5, 7, { server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } }) }),
    assistant({ id: 'msg_B2', req: 'req_B2', ts: at('09:14:59.999'), usage: usage(2, 20, 200, 6, 8, { server_tool_use: { web_search_requests: 1 } }), stop: 'tool_use', content: [toolUse()] }),
    // next bucket
    assistant({ id: 'msg_B3', req: 'req_B3', ts: at('09:15:00'), usage: usage(4, 40, 400) }),
    // same window, another model
    assistant({ id: 'msg_B4', req: 'req_B4', ts: at('09:02:00'), model: 'claude-opus-5-5', usage: usage(8, 80, 800) }),
    // same window and model, another tier
    assistant({ id: 'msg_B5', req: 'req_B5', ts: at('09:03:00'), usage: usage(16, 160, 1600, 0, 0, { speed: 'fast' }) }),
    // same window, model and tier, another session
    assistant({ id: 'msg_B6', req: 'req_B6', ts: at('09:04:00'), session: SESSION_B, usage: usage(32, 320, 3200) }),
    // no model at all
    assistant({ id: 'msg_B7', req: 'req_B7', ts: at('09:05:00'), model: null, usage: usage(64, 640, 6400) }),
  ];

  it('collapses responses of one window, session, model and tier into one row with summed tokens', async () => {
    const { parsed, sink } = await run([main(SESSION_A, rows())]);
    const shape = sink.usages.map((u) => [
      u.occurredAt.slice(11, 19), u.conversationKey?.slice(12, 20), u.modelKey, u.priceTier,
      u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWrite5mTokens, u.cacheWrite1hTokens, u.requestCount, u.assistantMessageCount, u.webSearchRequests,
    ]);
    expect(shape).toEqual([
      ['09:00:00', 'aaaaaaaa', null, 'standard', 64, 640, 6400, 0, 0, 1, 1, 0],
      ['09:00:00', 'aaaaaaaa', 'claude-opus-5-5', 'standard', 8, 80, 800, 0, 0, 1, 1, 0],
      ['09:00:00', 'aaaaaaaa', 'claude-sonnet-4-5', 'fast', 16, 160, 1600, 0, 0, 1, 1, 0],
      ['09:00:00', 'aaaaaaaa', 'claude-sonnet-4-5', 'standard', 3, 30, 300, 11, 15, 2, 1, 3],
      ['09:00:00', 'bbbbbbbb', 'claude-sonnet-4-5', 'standard', 32, 320, 3200, 0, 0, 1, 1, 0],
      ['09:15:00', 'aaaaaaaa', 'claude-sonnet-4-5', 'standard', 4, 40, 400, 0, 0, 1, 1, 0],
    ]);
    expect(parsed.stats).toMatchObject({ usageBuckets: 6, responses: 7, sessions: 2, webSearchRequests: 3, responsesWithoutModel: 1 });
    expect(parsed.missingFields).toEqual(['message.model']);
    expect(sink.conversations.map((c) => c.modelKey)).toEqual(['claude-sonnet-4-5', 'claude-sonnet-4-5']);
  });

  it('gives every row a key that is unique to the import and deterministic for the same input', async () => {
    const first = await run([main(SESSION_A, rows())]);
    const keys = first.sink.usages.map((u) => u.dedupKey);
    expect(new Set(keys).size).toBe(keys.length);
    const nonce = keys[0].split(':').pop()!;
    expect(nonce).toMatch(/^[0-9a-f]{12}$/);
    expect(keys).toContain(`cc:${SESSION_A}:claude-sonnet-4-5:standard:${Date.parse(at('09:00:00')) / 1000}:${nonce}`);
    expect(keys).toContain(`cc:${SESSION_A}:-:standard:${Date.parse(at('09:00:00')) / 1000}:${nonce}`);
    for (const key of keys) expect(key.endsWith(`:${nonce}`)).toBe(true);

    const again = await run([main(SESSION_A, rows())]);
    expect(again.sink.usages.map((u) => u.dedupKey)).toEqual(keys);

    // a later import of more data lands in the same buckets under other keys, so its rows add up
    const more = await run([main(SESSION_A, [...rows(), assistant({ id: 'msg_B8', req: 'req_B8', ts: at('09:06:00'), usage: usage(1, 1) })])], {
      knownRequestKeys: new Set(first.parsed.requestKeys),
    });
    expect(more.sink.usages).toHaveLength(1);
    expect(more.sink.usages[0]).toMatchObject({ occurredAt: '2026-01-15T09:00:00.000Z', inputTokens: 1, requestCount: 1 });
    expect(keys).not.toContain(more.sink.usages[0].dedupKey);
    expect(more.sink.usages[0].dedupKey.split(':').slice(0, -1)).toEqual(keys.find((k) => k.includes('claude-sonnet-4-5:standard'))!.split(':').slice(0, -1));
  });

  it('stages model identifiers the catalog does not know, once, and resolves known spellings', async () => {
    const r = (n: number, model: string) => assistant({ id: `msg_M${n}`, req: `req_M${n}`, ts: at('09:00:00'), model, usage: usage(1, 1) });
    const { sink } = await run([
      main(SESSION_A, [
        r(1, 'claude-opus-9-20300101'),
        r(2, 'claude-opus-9-20300101'),
        r(3, 'us.anthropic.claude-opus-4-1-20250805-v1:0'),
        r(4, 'claude-sonnet-4-5-20250929[1m]'),
        r(5, 'some-gateway/custom-model'),
      ]),
    ]);
    expect(sink.models).toEqual([
      { key: 'claude-opus-9', displayName: 'claude-opus-9-20300101', family: 'opus', tokenizerFamily: 'unknown' },
      { key: 'some-gateway/custom-model', displayName: 'some-gateway/custom-model', family: 'other', tokenizerFamily: 'unknown' },
    ]);
    expect(sink.usages.map((u) => [u.modelKey, u.requestCount]).sort()).toEqual([
      ['claude-opus-4-1', 1], ['claude-opus-9', 2], ['claude-sonnet-4-5', 1], ['some-gateway/custom-model', 1],
    ]);
  });
});

describe('sessions', () => {
  it('takes the title from custom-title, then ai-title, then a summary that names a row of the session', async () => {
    const leafA = rowUuid();
    const leafB = rowUuid();
    const C = 'cccccccc-0000-4000-8000-00000000000c';
    const D = 'dddddddd-0000-4000-8000-00000000000d';
    const { parsed, sink } = await run([
      main(SESSION_A, [
        // old versions wrote summaries of earlier sessions at the top of the next session's file
        { type: 'summary', summary: 'Summary of session B', leafUuid: leafB },
        { type: 'summary', summary: 'Summary of a session that is gone', leafUuid: 'no-such-row' },
        { type: 'summary', summary: 'First summary of A', leafUuid: leafA },
        { type: 'summary', summary: '  Latest   summary\n of A ', leafUuid: leafA },
        assistant({ id: 'msg_S1', req: 'req_S1', ts: at('09:00:00'), uuid: leafA, usage: usage(1, 1) }),
      ]),
      main(SESSION_B, [assistant({ id: 'msg_S2', req: 'req_S2', ts: at('09:00:00'), session: SESSION_B, uuid: leafB, usage: usage(1, 1), cwd: '/work/b' })]),
      main(C, [
        { type: 'summary', summary: 'Summary of C', leafUuid: 'leaf-c' },
        assistant({ id: 'msg_S3', req: 'req_S3', ts: at('09:00:00'), session: C, uuid: 'leaf-c', usage: usage(1, 1) }),
        { type: 'ai-title', aiTitle: 'First generated title', sessionId: C },
        { type: 'ai-title', aiTitle: 'Generated title of C', sessionId: C },
      ]),
      main(D, [
        { type: 'custom-title', customTitle: 'My own title', sessionId: D },
        assistant({ id: 'msg_S4', req: 'req_S4', ts: at('09:00:00'), session: D, usage: usage(1, 1) }),
        { type: 'ai-title', aiTitle: 'Generated title of D', sessionId: D },
      ]),
    ]);
    expect(Object.fromEntries(sink.conversations.map((c) => [c.externalId, c.title]))).toEqual({
      [SESSION_A]: 'Latest summary of A',
      [SESSION_B]: 'Summary of session B',
      [C]: 'Generated title of C',
      [D]: 'My own title',
    });
    expect(parsed.stats.summariesUnresolved).toBe(1);
    expect(sink.conversations.find((c) => c.externalId === SESSION_B)?.projectLabel).toBe('/work/b');
  });

  it('takes the folder, branch and version from the main thread, not from subagents', async () => {
    const sub = file(`projects/p/${SESSION_A}/subagents/agent-a1.jsonl`, jsonl([
      assistant({ id: 'msg_V1', req: 'req_V1', ts: at('08:59:00'), sidechain: true, cwd: '/home/alex/demo/.worktrees/agent', usage: usage(1, 1), extra: { gitBranch: 'agent-branch', version: '2.1.300' } }),
    ]));
    const mainFile = file(`projects/p/${SESSION_A}.jsonl`, jsonl([
      assistant({ id: 'msg_V2', req: 'req_V2', ts: at('09:00:00'), cwd: '/home/alex/demo', usage: usage(1, 1), extra: { gitBranch: 'main', version: '2.1.320' } }),
      assistant({ id: 'msg_V3', req: 'req_V3', ts: at('09:30:00'), cwd: '/home/alex/demo/sub', usage: usage(1, 1), extra: { gitBranch: 'feature', version: '2.1.321' } }),
    ]));
    for (const files of [[mainFile, sub], [sub, mainFile]]) {
      const { sink } = await run(files);
      expect(sink.conversations[0]).toMatchObject({
        projectLabel: '/home/alex/demo',
        metadata: { gitBranch: 'feature', version: '2.1.321', hasSubagents: true },
      });
    }
    const subOnly = await run([sub]);
    expect(subOnly.sink.conversations[0]).toMatchObject({ projectLabel: '/home/alex/demo/.worktrees/agent', metadata: { gitBranch: 'agent-branch', version: '2.1.300', hasSubagents: true } });
  });

  it('reads the session id from the row, then from forkedFrom, then from the file location', async () => {
    const noSession = (n: number) => {
      const row = assistant({ id: `msg_P${n}`, req: `req_P${n}`, ts: at('09:00:00'), usage: usage(1, 1) });
      delete row.sessionId;
      return row;
    };
    const { sink } = await run([
      file(`projects/p/${SESSION_A}.jsonl`, jsonl([noSession(1)])),
      file(`projects/p/${SESSION_B}/subagents/workflows/run1/agent-w1.jsonl`, jsonl([noSession(2)])),
      file('projects/p/agent-legacy1.jsonl', jsonl([noSession(3)])),
      file(`projects/p/${SESSION_A}.jsonl.superseded-1768467600000`, jsonl([noSession(4)])),
    ]);
    expect(Object.fromEntries(sink.usages.map((u) => [u.conversationKey, u.requestCount]))).toEqual({
      [`claude_code:${SESSION_A}`]: 2,
      [`claude_code:${SESSION_B}`]: 1,
      // a legacy flat agent file names no session; without one in the row the file name is all there is
      'claude_code:agent-legacy1': 1,
    });
  });
});

describe('transcript paths', () => {
  it.each([
    ['projects/-home-user/1111.jsonl', { isTranscript: true, isSubagent: false, sessionId: '1111' }],
    ['1111.jsonl', { isTranscript: true, isSubagent: false, sessionId: '1111' }],
    ['.claude\\projects\\C--Users-me\\1111.jsonl', { isTranscript: true, isSubagent: false, sessionId: '1111' }],
    ['projects/p/1111/subagents/agent-a598.jsonl', { isTranscript: true, isSubagent: true, sessionId: '1111' }],
    ['projects/p/1111/subagents/workflows/run9/agent-w1.jsonl', { isTranscript: true, isSubagent: true, sessionId: '1111' }],
    ['subagents/agent-a598.jsonl', { isTranscript: true, isSubagent: true, sessionId: null }],
    ['projects/p/agent-a598.jsonl', { isTranscript: true, isSubagent: true, sessionId: null }],
    ['projects/p/1111.orphaned-1768467600000-ab12.jsonl', { isTranscript: true, isSubagent: false, sessionId: '1111' }],
    ['projects/p/1111.jsonl.superseded-1768467600000', { isTranscript: true, isSubagent: false, sessionId: '1111' }],
    ['projects/p/1111/tool-results/toolu_1.jsonl', { isTranscript: false }],
    ['projects/p/1111/mcp-tasks/task.jsonl', { isTranscript: false }],
    ['projects/p/1111/subagents/agent-a598.meta.json', { isTranscript: false }],
    ['stats-cache.json', { isTranscript: false }],
    ['projects/p/memory/MEMORY.md', { isTranscript: false }],
    ['history.jsonl.bak', { isTranscript: false }],
  ])('%s', (path, expected) => {
    expect(transcriptPathInfo(path)).toMatchObject(expected);
  });
});

describe('missing identifiers', () => {
  it('without requestId, real message ids collapse per session and placeholder ids per session and timestamp', async () => {
    const { parsed, sink } = await run([
      main(SESSION_A, [
        // one response, two lines, no requestId, a real Anthropic id
        assistant({ id: 'msg_NR1', req: null, ts: at('09:00:00'), usage: usage(1, 10) }),
        assistant({ id: 'msg_NR1', req: null, ts: at('09:00:01'), usage: usage(1, 10) }),
        // a gateway that puts the same id on every response
        assistant({ id: 'ocgo', req: null, ts: at('09:01:00'), usage: usage(2, 20) }),
        assistant({ id: 'ocgo', req: null, ts: at('09:01:00'), usage: usage(2, 20) }),
        assistant({ id: 'ocgo', req: null, ts: at('09:02:00'), usage: usage(4, 40) }),
      ]),
      // the same placeholder id in another session is another response
      main(SESSION_B, [assistant({ id: 'ocgo', req: null, ts: at('09:01:00'), session: SESSION_B, usage: usage(8, 80) })]),
    ]);
    expect(totals(sink.usages)).toMatchObject({ input: 15, output: 150, requests: 4 });
    expect(parsed.requestKeys).toContain(hash64(`ms:${SESSION_A}:msg_NR1`));
    expect(parsed.requestKeys).toContain(hash64(`mst:${SESSION_A}:ocgo:${Date.parse(at('09:01:00'))}`));
    expect(warning(parsed, 'missing_request_id')).toMatchObject({ count: 4 });
    expect(parsed.missingFields).toEqual(['requestId']);
  });

  it('without a message id, a row is recognised by its row uuid (so copies still merge) and reported', async () => {
    const row = assistant({ id: null, req: 'req_X', ts: at('09:00:00'), uuid: 'row-uuid-1', usage: usage(3, 30) });
    const anonymous = assistant({ id: null, req: null, ts: at('09:05:00'), usage: usage(5, 50) });
    delete anonymous.uuid;
    const { parsed, sink } = await run([main(SESSION_A, [row, anonymous]), file('backup/copy.jsonl', jsonl([row]))]);
    expect(totals(sink.usages)).toMatchObject({ input: 8, output: 80, requests: 2 });
    expect(parsed.requestKeys).toContain(hash64('u:row-uuid-1'));
    expect(parsed.requestKeys).toContain(hash64(`line:${SESSION_A}.jsonl:2`));
    expect(warning(parsed, 'missing_message_id')).toMatchObject({ count: 2 });
  });

  it('a usage row without a timestamp borrows the nearest one in its file', async () => {
    const noTime = (n: number) => {
      const row = assistant({ id: `msg_NT${n}`, req: `req_NT${n}`, ts: '', usage: usage(1, 1) });
      delete row.timestamp;
      return row;
    };
    const { parsed, sink } = await run([
      main(SESSION_A, [
        noTime(1), // nothing before it: takes the next timestamp
        assistant({ id: 'msg_NT0', req: 'req_NT0', ts: at('09:20:00'), usage: usage(1, 1) }),
        { ...noTime(2), timestamp: 'not a date' }, // takes the previous one
      ]),
      // no timestamp anywhere in the file: the file's modification time is used
      file(`projects/p/${SESSION_B}.jsonl`, jsonl([{ ...noTime(3), sessionId: SESSION_B }]), Date.parse(at('11:00:30'))),
      // ... and without one the row cannot be placed
      file('projects/p/cccccccc.jsonl', jsonl([{ ...noTime(4), sessionId: 'cccccccc' }])),
    ]);
    expect(sink.usages.map((u) => [u.occurredAt.slice(11, 16), u.requestCount])).toEqual([['09:15', 3], ['11:00', 1]]);
    expect(warning(parsed, 'timestamp_inferred')).toMatchObject({ count: 3 });
    expect(warning(parsed, 'rows_without_timestamp')).toMatchObject({ count: 1 });
    expect(parsed.recordsSkipped).toBe(1);
  });

  it('counts rows that Claude Code marks isUnmetered or isVirtual, and says so', async () => {
    const { parsed, sink } = await run([
      main(SESSION_A, [
        assistant({ id: 'msg_U1', req: 'req_U1', ts: at('09:00:00'), usage: usage(1, 1), extra: { isUnmetered: true } }),
        assistant({ id: 'msg_U2', req: 'req_U2', ts: at('09:00:00'), usage: usage(1, 1), extra: { isVirtual: true } }),
      ]),
    ]);
    expect(totals(sink.usages).requests).toBe(2);
    expect(warning(parsed, 'unmetered_responses')).toMatchObject({ count: 1 });
    expect(warning(parsed, 'virtual_responses')).toMatchObject({ count: 1 });
  });
});

describe('responses in progress, synced files and unchanged files', () => {
  const NOW = Date.parse(at('12:00:00'));
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
  const partial = (n: number, ts: string, output = 8) => assistant({ id: `msg_IP${n}`, req: `req_IP${n}`, ts, stop: null, usage: legacyUsage(4, output, 1000, 0) });

  const hot = () => main(SESSION_A, [
    user('earlier prompt', { ts: minutesAgo(6), uuid: 'p-old' }),
    assistant({ id: 'msg_DONE', req: 'req_DONE', ts: minutesAgo(5), usage: usage(1, 100) }),
    user('prompt being answered', { ts: minutesAgo(3), uuid: 'p-answering' }),
    partial(1, minutesAgo(2.5)),
    partial(1, minutesAgo(2), 40),
    user('prompt just typed', { ts: minutesAgo(1), uuid: 'p-new' }),
  ], NOW - 60_000);
  const old = () => main(SESSION_B, [
    { ...partial(2, minutesAgo(30), 77), sessionId: SESSION_B },
  ], NOW - 3_600_000);
  // the file looks old, but a row in it is recent (clock differences, copied files)
  const skewed = () => file('projects/p/cccccccc-0000-4000-8000-00000000000c.jsonl', jsonl([
    { ...partial(3, minutesAgo(1)), sessionId: 'cccccccc-0000-4000-8000-00000000000c' },
  ]), NOW - 3_600_000);

  it('leaves a response that may still be streaming, and the prompt it answers, for the next import', async () => {
    const { parsed, sink } = await run([hot(), old(), skewed()], { options: { now: NOW } });
    expect(parsed.stats).toMatchObject({ deferredInProgress: 2, deferredPrompts: 2, responses: 2, newResponses: 2, humanPrompts: 1, newHumanPrompts: 1 });
    expect(warning(parsed, 'in_progress_deferred')).toMatchObject({ count: 2 });
    expect(warning(parsed, 'prompts_deferred')).toMatchObject({ count: 2 });
    // the old unfinished response is counted as it is, with a warning
    expect(warning(parsed, 'partial_usage')).toMatchObject({ count: 1, sample: 'mr:msg_IP2:req_IP2' });
    expect(totals(sink.usages)).toMatchObject({ input: 5, output: 177, requests: 2, userMessages: 1 });
    expect(parsed.requestKeys).toHaveLength(3);
    expect(parsed.requestKeys).not.toContain(hash64('mr:msg_IP1:req_IP1'));
    expect(parsed.requestKeys).not.toContain(hash64('p:p-new'));
    expect(parsed.requestKeys).toContain(hash64('p:p-old'));
    // 2 deferred responses are part of the skipped records
    expect(parsed).toMatchObject({ recordsSeen: 5, recordsSkipped: 2 });
    // only the old file is done: one is still being written, one holds a deferred row
    expect(parsed.syncedFiles).toEqual([{ path: `projects/-home-alex-demo/${SESSION_B}.jsonl`, size: old().size, lastModified: NOW - 3_600_000 }]);
  });

  it('counts the deferred response once it is finished or old enough', async () => {
    const first = await run([hot(), old(), skewed()], { options: { now: NOW } });
    const known = new Set(first.parsed.requestKeys);

    // 20 minutes later nothing was added to the files: the snapshot is all there will ever be
    const later = await run([hot(), old(), skewed()], { options: { now: NOW + 20 * 60_000 }, knownRequestKeys: known });
    expect(later.parsed.stats).toMatchObject({ deferredInProgress: 0, deferredPrompts: 0, newResponses: 2, duplicateResponses: 2, newHumanPrompts: 2, duplicateHumanPrompts: 1 });
    expect(totals(later.sink.usages)).toMatchObject({ input: 8, output: 48, requests: 2, userMessages: 2 });
    expect(warning(later.parsed, 'partial_usage')).toMatchObject({ count: 2 });
    expect(later.parsed.syncedFiles).toHaveLength(3);

    // ... whereas if Claude Code finishes the response, the final line is what gets counted
    const finished = main(SESSION_A, [
      partial(1, minutesAgo(2), 40),
      assistant({ id: 'msg_IP1', req: 'req_IP1', ts: minutesAgo(1.5), usage: usage(4, 2500, 1000) }),
    ], NOW);
    const done = await run([finished], { options: { now: NOW + 60_000 }, knownRequestKeys: known });
    expect(totals(done.sink.usages)).toMatchObject({ input: 4, output: 2500, requests: 1 });
    expect(done.parsed.warnings).toEqual([]);
    // finished, but written to a moment ago: read again next time
    expect(done.parsed.syncedFiles).toEqual([]);
  });

  it('skips files that are known and unchanged without reading them', async () => {
    const a = main(SESSION_A, [assistant({ id: 'msg_F1', req: 'req_F1', ts: minutesAgo(600), usage: usage(1, 1) })], NOW - 7_200_000);
    const b = main(SESSION_B, [assistant({ id: 'msg_F2', req: 'req_F2', ts: minutesAgo(600), session: SESSION_B, usage: usage(2, 2) })], NOW - 7_200_000);
    const first = await run([a, b], { options: { now: NOW } });
    expect(first.parsed.syncedFiles).toHaveLength(2);
    const knownFiles = new Map(first.parsed.syncedFiles!.map((f) => [f.path, { size: f.size, lastModified: f.lastModified }]));
    const unreadable = (f: ImportFile): ImportFile => ({ ...f, blob: { stream: () => { throw new Error('must not be read'); } } as unknown as Blob });

    // nothing changed: nothing is read, nothing is new, and that is not an error
    const same = await run([unreadable(a), unreadable(b)], { options: { now: NOW }, knownFiles, knownRequestKeys: new Set(first.parsed.requestKeys) });
    expect(same.parsed.stats).toMatchObject({ files: 2, filesRead: 0, filesSkippedUnchanged: 2, filesUnreadable: 0, responses: 0 });
    expect(same.parsed).toMatchObject({ fileName: '0 transcript files', fileSize: 0, requestKeys: [], duplicateRequests: 0, syncedFiles: [] });
    expect(same.sink.usages).toEqual([]);

    // b grew: only b is read; its old response is a duplicate, the new one is added
    const grown = main(SESSION_B, [
      assistant({ id: 'msg_F2', req: 'req_F2', ts: minutesAgo(600), session: SESSION_B, usage: usage(2, 2) }),
      assistant({ id: 'msg_F3', req: 'req_F3', ts: minutesAgo(500), session: SESSION_B, usage: usage(4, 4) }),
    ], NOW - 3_600_000);
    const next = await run([unreadable(a), grown], { options: { now: NOW }, knownFiles, knownRequestKeys: new Set(first.parsed.requestKeys) });
    expect(next.parsed.stats).toMatchObject({ filesRead: 1, filesSkippedUnchanged: 1, newResponses: 1, duplicateResponses: 1 });
    expect(next.parsed.fileName).toBe(`${SESSION_B}.jsonl`);
    expect(totals(next.sink.usages)).toMatchObject({ input: 4, output: 4, requests: 1 });
    expect(next.parsed.syncedFiles?.map((f) => f.path)).toEqual([grown.path]);

    // same size, other modification time: read again
    const touched = await run([{ ...a, lastModified: NOW - 7_000_000 }], { options: { now: NOW }, knownFiles, knownRequestKeys: new Set(first.parsed.requestKeys) });
    expect(touched.parsed.stats).toMatchObject({ filesRead: 1, filesSkippedUnchanged: 0, duplicateResponses: 1 });
  });

  it('does not remember a file without a modification time, or one that could not be read to the end', async () => {
    const rows = [assistant({ id: 'msg_G1', req: 'req_G1', ts: minutesAgo(600), usage: usage(1, 1) })];
    const noTime = main(SESSION_A, rows);
    const broken: ImportFile = {
      name: 'broken.jsonl', path: 'projects/p/broken.jsonl', size: 10, lastModified: NOW - 7_200_000,
      blob: {
        stream: () => {
          const bytes = new TextEncoder().encode(jsonl([assistant({ id: 'msg_G2', req: 'req_G2', ts: minutesAgo(600), usage: usage(2, 2) })]) + '{"type":"assis');
          let sent = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent) return controller.error(new DOMException('The blob could not be read', 'NotReadableError'));
              sent = true;
              controller.enqueue(bytes);
            },
          });
        },
      } as unknown as Blob,
    };
    const { parsed, sink } = await run([noTime, broken], { options: { now: NOW } });
    // the complete line that arrived before the failure is counted; the torn rest is not
    expect(totals(sink.usages)).toMatchObject({ input: 3, requests: 2 });
    expect(parsed.syncedFiles).toEqual([]);
    expect(warning(parsed, 'unreadable_files')).toMatchObject({ count: 1 });
    expect(parsed.stats.filesUnreadable).toBe(1);
  });
});

describe('damaged and empty input', () => {
  it('tolerates and counts malformed and torn lines', async () => {
    const good = assistant({ id: 'msg_OK', req: 'req_OK', ts: at('09:00:00'), usage: usage(5, 50) });
    const torn = JSON.stringify(assistant({ id: 'msg_TORN', req: 'req_TORN', ts: at('09:00:05'), usage: usage(900, 900) })).slice(0, 180);
    const content = ['', '   ', JSON.stringify(good), 'this is not json', '42', '[1,2,3]', '', torn].join('\r\n');
    const { parsed, sink } = await run([file(`projects/p/${SESSION_A}.jsonl`, content)]);
    expect(totals(sink.usages)).toMatchObject({ input: 5, output: 50, requests: 1 });
    expect(parsed.stats).toMatchObject({ lines: 5, malformedLines: 4, usageRows: 1 });
    expect(warning(parsed, 'malformed_lines')).toMatchObject({ count: 4, sample: `${SESSION_A}.jsonl:4` });
    expect(parsed).toMatchObject({ recordsSeen: 1, recordsSkipped: 4 });
  });

  it('ignores usage objects without counts and usage on rows that are not responses', async () => {
    const { parsed, sink } = await run([
      main(SESSION_A, [
        assistant({ id: 'msg_E1', req: 'req_E1', ts: at('09:00:00'), usage: {} }),
        assistant({ id: 'msg_E2', req: 'req_E2', ts: at('09:00:00'), usage: { input_tokens: 'many', output_tokens: null } }),
        // negative and fractional counts are not trusted / truncated
        assistant({ id: 'msg_E3', req: 'req_E3', ts: at('09:00:00'), usage: { input_tokens: 10.9, output_tokens: -5, cache_read_input_tokens: -1 } }),
        { type: 'system', subtype: 'turn_duration', uuid: rowUuid(), timestamp: at('09:00:01'), sessionId: SESSION_A, message: { usage: usage(999, 999) } },
        { type: 'cost-state', sessionId: SESSION_A, modelUsage: { 'claude-sonnet-4-5': { inputTokens: 999, outputTokens: 999 } } },
      ]),
    ]);
    expect(totals(sink.usages)).toMatchObject({ input: 10, output: 0, cacheRead: 0, requests: 1 });
    expect(warning(parsed, 'usage_without_counts')).toMatchObject({ count: 2 });
  });

  it('throws no_usage_found when no file has a usage row', async () => {
    const onlyPrompts = main(SESSION_A, [user('hello', { ts: at('09:00:00') }), toolResult({ ts: at('09:00:01') })]);
    const error = await run([onlyPrompts]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ code: 'no_usage_found' });
    expect((error as ImportError).message).toMatch(/contain no token usage/);

    await expect(run([file('projects/p/empty.jsonl', '')])).rejects.toMatchObject({ code: 'no_usage_found' });
    await expect(run([file('projects/p/garbage.jsonl', 'not json\n{"half":')])).rejects.toMatchObject({ code: 'no_usage_found' });
  });

  it('throws no_usage_found with guidance when the selection holds no transcripts at all', async () => {
    const error = await run([file('stats-cache.json', '{}'), file('projects/p/memory/MEMORY.md', '# notes'), file('settings.json', '{}')]).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ImportError', code: 'no_usage_found' });
    expect((error as ImportError).message).toMatch(/\.claude/);
    await expect(run([])).rejects.toMatchObject({ code: 'no_files' });
  });

  it('a session that only has locally generated (synthetic) rows adds nothing and is not an error', async () => {
    const { parsed, sink } = await run([
      main(SESSION_A, [assistant({ id: 'e2b0b1c4-0000-4000-8000-000000000000', req: null, ts: at('09:00:00'), model: '<synthetic>', stop: 'stop_sequence', usage: usage(0, 0) })]),
    ]);
    expect(sink.usages).toEqual([]);
    expect(sink.conversations).toEqual([]);
    expect(parsed).toMatchObject({ recordsSeen: 1, recordsSkipped: 1, requestKeys: [] });
  });
});

describe('progress and cancellation', () => {
  const bigFile = () => {
    const rows: unknown[] = [];
    // ~3 MB, so that progress is reported more than once
    for (let i = 0; i < 3000; i++) rows.push(assistant({ id: `msg_P${i}`, req: `req_P${i}`, ts: at('09:00:00'), usage: usage(1, 1), content: [{ type: 'text', text: 'x'.repeat(700) }] }));
    return main(SESSION_A, rows);
  };

  it('reports progress while reading', async () => {
    const f = bigFile();
    const { parsed, sink } = await run([f]);
    const reading = sink.progressCalls.filter((p) => p.phase === 'Reading transcripts');
    expect(reading.length).toBeGreaterThanOrEqual(2);
    expect(reading[reading.length - 1]).toMatchObject({ bytesRead: f.size, totalBytes: f.size, records: 3000 });
    for (let i = 1; i < reading.length; i++) expect(reading[i].bytesRead).toBeGreaterThanOrEqual(reading[i - 1].bytesRead);
    expect(sink.progressCalls[sink.progressCalls.length - 1].phase).toBe('Counting usage');
    expect(parsed.fileSize).toBe(f.size);
  });

  it('stops when the import is cancelled', async () => {
    const controller = new AbortController();
    const sink = new MemorySink();
    sink.progress = () => controller.abort();
    await expect(claudeCodeParser.parse([bigFile()], sink, { signal: controller.signal, options: { now: LATER } })).rejects.toMatchObject({ code: 'cancelled' });
    expect(sink.usages).toEqual([]);

    const aborted = new AbortController();
    aborted.abort();
    await expect(claudeCodeParser.parse([bigFile()], new MemorySink(), { signal: aborted.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('throughput', () => {
  it('reads 50,000 transcript rows in a few seconds', async () => {
    const files: ImportFile[] = [];
    const perFile = 1000;
    let expectedOutput = 0;
    for (let f = 0; f < 25; f++) {
      const session = `${f.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      const lines: string[] = [];
      for (let i = 0; i < perFile; i++) {
        const n = f * perFile + i;
        const ts = new Date(Date.UTC(2026, 0, 1 + f, 8, 0, 0) + i * 20_000).toISOString();
        const id = { id: `msg_${n.toString(36).padStart(24, '0')}`, req: `req_${n.toString(36).padStart(24, '0')}`, session, usage: usage(3, 100 + (n % 50), 60000 + n, 500, 0), stop: 'tool_use' };
        expectedOutput += 100 + (n % 50);
        // one response = two lines with identical usage, like current Claude Code versions
        lines.push(JSON.stringify(assistant({ ...id, ts, content: [{ type: 'text', text: 'lorem ipsum '.repeat(40) }] })));
        lines.push(JSON.stringify(assistant({ ...id, ts, content: [toolUse()] })));
      }
      files.push(file(`projects/-home-alex-demo/${session}.jsonl`, lines.join('\n') + '\n'));
    }
    const started = performance.now();
    const { parsed, sink } = await run(files);
    const elapsed = performance.now() - started;

    expect(parsed.stats).toMatchObject({ usageRows: 50_000, responses: 25_000, duplicateLines: 25_000, sessions: 25 });
    expect(totals(sink.usages)).toMatchObject({ input: 75_000, output: expectedOutput, requests: 25_000 });
    expect(parsed.requestKeys).toHaveLength(25_000);
    // Generous on purpose: this guards against accidental quadratic behaviour, not against a slow machine.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('extractTranscripts', () => {
  it('returns responses and prompts in time order with their raw facts', async () => {
    const x = await extractTranscripts([
      main(SESSION_A, [
        user('hello', { ts: at('09:00:00'), uuid: 'p1' }),
        assistant({ id: 'msg_X2', req: 'req_X2', ts: at('09:00:09'), usage: usage(1, 2, 3, 4, 5, { speed: 'fast', service_tier: 'priority', inference_geo: 'us', output_tokens_details: { thinking_tokens: 1 } }) }),
        assistant({ id: 'msg_X1', req: 'req_X1', ts: at('09:00:02'), stop: 'tool_use', content: [toolUse()], usage: usage(9, 8, 7, 6, 5) }),
      ]),
    ]);
    expect(x.responses).toEqual([
      {
        key: 'mr:msg_X1:req_X1', sessionId: SESSION_A, model: 'claude-sonnet-4-5-20250929', ts: Date.parse(at('09:00:02')), lastTs: Date.parse(at('09:00:02')),
        input: 9, output: 8, cacheRead: 7, cacheWrite5m: 6, cacheWrite1h: 5, thinking: 0, webSearch: 0,
        flags: ResponseFlag.TOOL_USE | ResponseFlag.HAS_SPEED, serviceTier: 'standard', geo: 'global', extras: null,
      },
      {
        key: 'mr:msg_X2:req_X2', sessionId: SESSION_A, model: 'claude-sonnet-4-5-20250929', ts: Date.parse(at('09:00:09')), lastTs: Date.parse(at('09:00:09')),
        input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, thinking: 1, webSearch: 0,
        flags: ResponseFlag.HAS_SPEED | ResponseFlag.FAST, serviceTier: 'priority', geo: 'us', extras: null,
      },
    ]);
    expect(x.prompts).toEqual([{ key: 'p:p1', sessionId: SESSION_A, ts: Date.parse(at('09:00:00')), kind: PromptKind.TYPED }]);
    expect([...x.sessions.values()]).toEqual([
      { id: SESSION_A, title: null, titleKind: null, cwd: '/home/alex/demo', gitBranch: 'main', version: '2.1.321', hasSubagents: false },
    ]);
  });
});
