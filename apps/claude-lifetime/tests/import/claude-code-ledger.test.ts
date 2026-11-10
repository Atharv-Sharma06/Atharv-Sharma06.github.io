import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportError, type ImportFile, type ImportParser, type ParseContext } from '@/core/types';
import {
  claudeCodeLedgerParser,
  claudeCodeParser,
  detectClaudeCodeFormat,
  extractTranscripts,
  isClaudeCodeLedgerFile,
  LEDGER_FORMAT,
  looksLikeLedger,
  mergeIntoLedger,
  parseLedger,
  ResponseFlag,
  serialiseLedger,
} from '@/import/claude-code';
import {
  appendTolerantSource,
  collect,
  CollectError,
  COLLECTOR_VERSION,
  EXIT_INCOMPLETE,
  findProjectsDirs,
  formatSummary,
  parseArgs,
  readFilesPath,
  runCli,
  USAGE,
} from '@/import/claude-code/collector';
import { emptyLedger, ledgerRecords } from '@/import/claude-code/ledger';
import {
  assistant,
  at,
  file,
  FIXTURE_DIR,
  fixtureText,
  jsonl,
  LATER,
  legacyUsage,
  loadDir,
  loadFixtureDir,
  MemorySink,
  SESSION_A,
  SESSION_B,
  toolResult,
  toolUse,
  totals,
  totalsBy,
  usage,
  user,
} from '../fixtures/claude-code/builders';

/**
 * The collector (in-process and as the bundled command-line tool), the ledger it
 * writes, and the ledger importer. Every directory used here is created under the
 * system temp folder; the real Claude Code data of this computer is never read.
 */
const APP_ROOT = join(FIXTURE_DIR, '..', '..', '..');
const PUBLISHED_TOOL = join(APP_ROOT, 'public', 'tools', 'claude-lifetime-collect.mjs');

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claude-lifetime-collector-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const scratch = (name: string) => mkdtempSync(join(tmp, `${name}-`));

function write(root: string, path: string, content: string): string {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

async function run(parser: ImportParser, files: ImportFile[], ctx: ParseContext = {}) {
  const sink = new MemorySink();
  const parsed = await parser.parse(files, sink, { ...ctx, options: { now: LATER, ...ctx.options } });
  return { parsed, sink };
}

const ledgerFile = (path: string, name = 'claude-code-ledger.json') => file(name, readFileSync(path, 'utf8'), Math.trunc(statSync(path).mtimeMs));
const readLedger = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { responses: unknown[][]; prompts: unknown[][] };

/** Text that exists in the transcripts below and must never reach a ledger. */
const SECRETS = [
  'PROMPT-ONE-ZEBRA-QUARTZ',
  'PROMPT-TWO-ZEBRA-QUARTZ',
  'SUBAGENT-PROMPT-ZEBRA-QUARTZ',
  'QUEUED-PROMPT-ZEBRA-QUARTZ',
  'THINKING-ZEBRA-QUARTZ',
  'HISTORY-ZEBRA-QUARTZ',
  'ASSISTANT-TEXT-MUST-NOT-LEAK',
  'TOOL-INPUT-MUST-NOT-LEAK',
  'TOOL-OUTPUT-MUST-NOT-LEAK',
];

const A1 = { id: 'msg_A1', req: 'req_A1', stop: 'tool_use', usage: usage(4, 120, 15000, 0, 2000) };
const A2 = { id: 'msg_A2', req: 'req_A2', usage: usage(2, 200, 17150, 90, 0) };

const sessionA = () => [
  { type: 'ai-title', aiTitle: 'Fix the date parser', sessionId: SESSION_A },
  { type: 'queue-operation', operation: 'enqueue', timestamp: at('08:59:59'), sessionId: SESSION_A, content: 'QUEUED-PROMPT-ZEBRA-QUARTZ' },
  user('PROMPT-ONE-ZEBRA-QUARTZ', { ts: at('09:00:00'), uuid: 'prompt-one' }),
  assistant({ ...A1, ts: at('09:00:02'), content: [{ type: 'thinking', thinking: 'THINKING-ZEBRA-QUARTZ' }] }),
  assistant({ ...A1, ts: at('09:00:03'), content: [toolUse()] }),
  toolResult({ ts: at('09:00:05') }),
  // the last response of the session is written as two lines, a second apart
  assistant({ ...A2, ts: at('09:00:08'), content: [{ type: 'thinking', thinking: 'THINKING-ZEBRA-QUARTZ' }] }),
  assistant({ ...A2, ts: at('09:00:09') }),
  { type: 'last-prompt', lastPrompt: 'PROMPT-ONE-ZEBRA-QUARTZ', sessionId: SESSION_A },
];
const subagentA = () => [
  user('SUBAGENT-PROMPT-ZEBRA-QUARTZ', { ts: at('09:00:04'), extra: { isSidechain: true, agentId: 'a1' } }),
  assistant({ id: 'msg_A3', req: 'req_A3', ts: at('09:00:04.500'), sidechain: true, model: 'claude-haiku-4-5-20251001', usage: usage(10, 300, 0, 5000, 0), extra: { agentId: 'a1' } }),
];
const sessionB = () => [
  user('PROMPT-TWO-ZEBRA-QUARTZ', { ts: at('10:00:00', '2026-01-16'), session: SESSION_B, uuid: 'prompt-two', extra: { cwd: '/work/other' } }),
  assistant({
    id: 'msg_B1', req: 'req_B1', ts: at('10:00:05', '2026-01-16'), session: SESSION_B, model: 'claude-sonnet-5-5', cwd: '/work/other',
    usage: {
      ...usage(5, 500, 1000, 0, 100, { speed: 'fast', inference_geo: 'us', output_tokens_details: { thinking_tokens: 77 }, server_tool_use: { web_search_requests: 2 } }),
      iterations: [
        { type: 'message', input_tokens: 5, output_tokens: 500, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } },
        { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } },
        { type: 'compaction', model: null, input_tokens: 9, output_tokens: 9 },
      ],
    },
  }),
];

const MAIN_A = `projects/-home-alex-demo/${SESSION_A}.jsonl`;
const SUB_A = `projects/-home-alex-demo/${SESSION_A}/subagents/agent-a1.jsonl`;
const MAIN_B = `projects/-work-other/${SESSION_B}.jsonl`;

/** A Claude Code config directory with two sessions, a subagent and the usual clutter around them. */
function writeConfig(root: string): string {
  write(root, MAIN_A, jsonl(sessionA()));
  write(root, SUB_A, jsonl(subagentA()));
  write(root, `projects/-home-alex-demo/${SESSION_A}/subagents/agent-a1.meta.json`, '{"agentType":"general-purpose","description":"SUBAGENT-PROMPT-ZEBRA-QUARTZ"}');
  // tool output is not a transcript, even when it looks like one
  write(root, `projects/-home-alex-demo/${SESSION_A}/tool-results/toolu_1.jsonl`, jsonl([assistant({ id: 'msg_FAKE', req: 'req_FAKE', ts: at('09:00:00'), usage: usage(999, 999) })]));
  write(root, MAIN_B, jsonl(sessionB()));
  write(root, 'history.jsonl', jsonl([{ display: 'HISTORY-ZEBRA-QUARTZ', timestamp: 1768467600000, project: '/home/alex/demo', sessionId: SESSION_A }]));
  write(root, 'stats-cache.json', '{"version":5}');
  return root;
}

const EXPECTED_BY_MODEL = {
  'claude-sonnet-4-5 standard': { input: 6, output: 320, cacheRead: 32150, cacheWrite5m: 90, cacheWrite1h: 2000, requests: 2, userMessages: 1, assistantMessages: 1 },
  'claude-haiku-4-5 standard': { input: 10, output: 300, cacheRead: 0, cacheWrite5m: 5000, cacheWrite1h: 0, requests: 1, userMessages: 0, assistantMessages: 0 },
  // fast mode with US-only inference
  'claude-sonnet-5-5 fast_us': { input: 5, output: 500, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 100, requests: 1, userMessages: 1, assistantMessages: 1 },
  // the advisor iteration of msg_B1, part of the same request
  'claude-opus-5-5 standard_us': { input: 100, output: 50, cacheRead: 1000, cacheWrite5m: 40, cacheWrite1h: 0, requests: 0, userMessages: 0, assistantMessages: 0 },
};
const byModelAndTier = (sink: MemorySink) => totalsBy(sink.usages, (u) => `${u.modelKey} ${u.priceTier}`);

describe('collector', () => {
  it('collects a config directory into a ledger that holds the usage and no message text', async () => {
    const dir = scratch('collect');
    const config = writeConfig(join(dir, 'config'));
    const ledgerPath = join(dir, 'ledger-home', 'claude-code-ledger.json');

    const result = await collect({ dirs: [config], ledgerPath, now: LATER, machine: 'test-machine' });
    expect(result).toMatchObject({
      roots: [join(config, 'projects')],
      // the two sessions and the subagent; tool-results/ and everything outside projects/ is not read
      transcriptFiles: 3,
      filesRead: 3,
      filesUnchanged: 0,
      foldersUnreadable: [],
      filesUnreadable: [],
      malformedLines: 0,
      responsesFound: 4,
      promptsFound: 2,
      deferredInProgress: 0,
      responsesAdded: 4,
      responsesImproved: 0,
      promptsAdded: 2,
      partialAdded: 0,
      responses: 4,
      prompts: 2,
      sessions: 2,
      firstTimestamp: '2026-01-15T09:00:00.000Z',
      lastTimestamp: '2026-01-16T10:00:05.000Z',
      ledgerPath,
      written: true,
      outPath: null,
    });

    const text = readFileSync(ledgerPath, 'utf8');
    expect(result.ledgerBytes).toBe(Buffer.byteLength(text));
    for (const secret of SECRETS) expect(text).not.toContain(secret);

    const doc = readLedger(ledgerPath);
    expect(doc).toMatchObject({
      format: 'claude-lifetime/claude-code-ledger',
      version: 1,
      generatedAt: new Date(LATER).toISOString(),
      machine: 'test-machine',
      collector: COLLECTOR_VERSION,
      // identifiers exactly as Claude Code wrote them, in order of first use
      models: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-opus-5-5'],
      serviceTiers: ['standard'],
      geos: ['global', 'us'],
      sessions: {
        [SESSION_A]: { i: 0, title: 'Fix the date parser', titleKind: 'ai', cwd: '/home/alex/demo', gitBranch: 'main', version: '2.1.321', subagents: true },
        [SESSION_B]: { i: 1, cwd: '/work/other', gitBranch: 'main', version: '2.1.321' },
      },
    });
    const F = ResponseFlag;
    expect(doc.responses).toEqual([
      ['m:msg_A1', 0, 0, Date.parse(at('09:00:02')), 4, 120, 15000, 0, 2000, 0, 0, F.TOOL_USE | F.HAS_SPEED, 0, 0],
      ['m:msg_A3', 0, 1, Date.parse(at('09:00:04.500')), 10, 300, 0, 5000, 0, 0, 0, F.SIDECHAIN | F.HAS_SPEED, 0, 0],
      ['m:msg_A2', 0, 0, Date.parse(at('09:00:08')), 2, 200, 17150, 90, 0, 0, 0, F.HAS_SPEED, 0, 0],
      [
        'm:msg_B1', 1, 2, Date.parse(at('10:00:05', '2026-01-16')), 5, 500, 1000, 0, 100, 77, 2, F.FAST | F.HAS_SPEED, 0, 1,
        // iterations other than the returned message: kept, whether or not they are counted today
        [[1, 'advisor_message', 3, 100, 50, 1000, 40, 0, 0], [2, 'compaction', -1, 9, 9, 0, 0, 0, 0]],
      ],
    ]);
    expect(doc.prompts).toEqual([
      ['p:prompt-one', 0, Date.parse(at('09:00:00')), 0],
      ['p:prompt-two', 1, Date.parse(at('10:00:00', '2026-01-16')), 0],
    ]);
    // one row per line, so the file can be inspected and diffed
    expect(text.split('\n').filter((line) => line.startsWith('["m:'))).toHaveLength(4);
    if (process.platform !== 'win32') expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  it('adds nothing on a second run and leaves the file alone', async () => {
    const dir = scratch('rerun');
    const config = writeConfig(join(dir, 'config'));
    const ledgerPath = join(dir, 'ledger.json');
    await collect({ dirs: [config], ledgerPath, now: LATER, machine: 'test-machine' });
    const before = readFileSync(ledgerPath, 'utf8');

    const again = await collect({ dirs: [config], ledgerPath, now: LATER + 86_400_000, machine: 'test-machine' });
    expect(again).toMatchObject({ responsesFound: 4, responsesAdded: 0, responsesImproved: 0, promptsAdded: 0, responses: 4, prompts: 2, written: false });
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
  });

  it('loses nothing when transcripts disappear, and adds what is new', async () => {
    const dir = scratch('retention');
    const config = writeConfig(join(dir, 'config'));
    const ledgerPath = join(dir, 'ledger.json');
    await collect({ dirs: [config], ledgerPath, now: LATER, machine: 'test-machine' });
    const complete = await run(claudeCodeLedgerParser, [ledgerFile(ledgerPath)]);

    // Claude Code's cleanup removes a session and the subagent transcript of another
    rmSync(join(config, MAIN_B));
    rmSync(join(config, SUB_A));
    const afterCleanup = await collect({ dirs: [config], ledgerPath, now: LATER, machine: 'test-machine' });
    expect(afterCleanup).toMatchObject({ transcriptFiles: 1, responsesFound: 2, responsesAdded: 0, responses: 4, prompts: 2, sessions: 2, written: false });
    const kept = await run(claudeCodeLedgerParser, [ledgerFile(ledgerPath)]);
    expect(kept.sink.usages).toEqual(complete.sink.usages);
    expect(kept.sink.conversations).toEqual(complete.sink.conversations);

    // a new session appears; the old ones stay
    const C = 'cccccccc-0000-4000-8000-00000000000c';
    write(config, `projects/-home-alex-demo/${C}.jsonl`, jsonl([
      user('PROMPT-THREE', { ts: at('08:00:00', '2026-02-01'), session: C, uuid: 'prompt-three' }),
      assistant({ id: 'msg_C1', req: 'req_C1', ts: at('08:00:03', '2026-02-01'), session: C, usage: usage(7, 70, 700) }),
    ]));
    const grown = await collect({ dirs: [config], ledgerPath, now: LATER, machine: 'test-machine' });
    expect(grown).toMatchObject({ responsesAdded: 1, promptsAdded: 1, responses: 5, prompts: 3, sessions: 3, written: true, lastTimestamp: '2026-02-01T08:00:03.000Z' });
    const all = await run(claudeCodeLedgerParser, [ledgerFile(ledgerPath)], { knownRequestKeys: new Set(complete.parsed.requestKeys) });
    expect(totals(all.sink.usages)).toMatchObject({ input: 7, output: 70, cacheRead: 700, requests: 1, userMessages: 1 });
  });

  it('leaves a response that is still being written for the next run, and completes a partial record later', async () => {
    const dir = scratch('progress');
    const config = join(dir, 'config');
    const ledgerPath = join(dir, 'ledger.json');
    const NOW = Date.parse(at('12:00:00'));
    const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
    const snapshot = (output: number, ts: string) => assistant({ id: 'msg_S1', req: 'req_S1', ts, stop: null, usage: legacyUsage(4, output, 1000, 0) });
    const path = write(config, MAIN_A, jsonl([
      assistant({ id: 'msg_S0', req: 'req_S0', ts: minutesAgo(30), usage: usage(1, 100) }),
      snapshot(8, minutesAgo(2)),
    ]));

    const first = await collect({ dirs: [config], ledgerPath, now: NOW, machine: 'm' });
    expect(first).toMatchObject({ responsesFound: 1, deferredInProgress: 1, responsesAdded: 1, responses: 1 });
    expect(readLedger(ledgerPath).responses.map((r) => r[0])).toEqual(['m:msg_S0']);

    // 20 minutes later the snapshot is all there is: it is recorded, flagged as partial
    const second = await collect({ dirs: [config], ledgerPath, now: NOW + 20 * 60_000, machine: 'm' });
    expect(second).toMatchObject({ deferredInProgress: 0, responsesAdded: 1, partialAdded: 1, responses: 2 });
    const partialRow = readLedger(ledgerPath).responses.find((r) => r[0] === 'm:msg_S1')!;
    expect([partialRow[5], (partialRow[11] as number) & ResponseFlag.PARTIAL]).toEqual([8, ResponseFlag.PARTIAL]);

    // the final line arrives after all: the ledger takes the complete record
    appendFileSync(path, jsonl([assistant({ id: 'msg_S1', req: 'req_S1', ts: minutesAgo(1), usage: usage(4, 310, 1000) })]));
    const third = await collect({ dirs: [config], ledgerPath, now: NOW + 30 * 60_000, machine: 'm' });
    expect(third).toMatchObject({ responsesAdded: 0, responsesImproved: 1, responses: 2, written: true });
    const finalRow = readLedger(ledgerPath).responses.find((r) => r[0] === 'm:msg_S1')!;
    expect([finalRow[5], (finalRow[11] as number) & ResponseFlag.PARTIAL]).toEqual([310, 0]);
    // still placed at the first line of the response
    expect(finalRow[3]).toBe(NOW - 2 * 60_000);
    expect(formatSummary(third)).toMatch(/New {8}0 responses and 0 prompts since the last run \(1 earlier record completed\)/);
  });

  describe('later runs', () => {
    /** Sets the modification time, which a freshly written test file has "now", long after the fixtures' clock. */
    const settle = (path: string, when = LATER - 3_600_000) => utimesSync(path, new Date(when), new Date(when));
    const settleAll = (config: string) => {
      for (const path of [MAIN_A, SUB_A, MAIN_B]) settle(join(config, path));
    };
    const listOf = (ledgerPath: string) => JSON.parse(readFileSync(readFilesPath(ledgerPath), 'utf8')) as { ledgerGeneratedAt: string; files: Record<string, [number, number]> };

    it('read only the transcripts that are new or have changed', async () => {
      const dir = scratch('incremental');
      const config = writeConfig(join(dir, 'config'));
      const ledgerPath = join(dir, 'claude-code-ledger.json');
      settleAll(config);

      const first = await collect({ dirs: [config], ledgerPath, now: LATER, machine: 'm' });
      expect(first).toMatchObject({ transcriptFiles: 3, filesRead: 3, filesUnchanged: 0, responsesAdded: 4, written: true });
      expect(readFilesPath(ledgerPath)).toBe(join(dir, 'claude-code-ledger.files.json'));
      const list = listOf(ledgerPath);
      expect(list.ledgerGeneratedAt).toBe(readLedger(ledgerPath).generatedAt);
      expect(Object.keys(list.files).sort()).toEqual([MAIN_A, SUB_A, MAIN_B].map((path) => join(config, path)).sort());
      if (process.platform !== 'win32') expect(statSync(readFilesPath(ledgerPath)).mode & 0o777).toBe(0o600);
      const ledgerText = readFileSync(ledgerPath, 'utf8');
      const listText = readFileSync(readFilesPath(ledgerPath), 'utf8');

      // nothing changed: nothing is read and neither file is written again
      const second = await collect({ dirs: [config], ledgerPath, now: LATER + 1000, machine: 'm' });
      expect(second).toMatchObject({ transcriptFiles: 3, filesRead: 0, filesUnchanged: 3, bytesRead: 0, responsesFound: 0, responsesAdded: 0, responses: 4, prompts: 2, written: false });
      expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerText);
      expect(readFileSync(readFilesPath(ledgerPath), 'utf8')).toBe(listText);
      expect(formatSummary(second)).toMatch(/^Read {7}0 transcript files \(1 KB\) under .*; 3 unchanged since an earlier run\n/);

      // one session goes on, one is new, one was cleaned up by Claude Code
      appendFileSync(join(config, MAIN_A), jsonl([assistant({ id: 'msg_A9', req: 'req_A9', ts: at('09:30:00'), usage: usage(3, 30) })]));
      settle(join(config, MAIN_A), LATER - 1_800_000);
      const C = 'cccccccc-0000-4000-8000-00000000000c';
      settle(write(config, `projects/-home-alex-demo/${C}.jsonl`, jsonl([assistant({ id: 'msg_C1', req: 'req_C1', ts: at('08:00:03', '2026-02-01'), session: C, usage: usage(7, 70) })])));
      rmSync(join(config, MAIN_B));
      const third = await collect({ dirs: [config], ledgerPath, now: LATER + 2000, machine: 'm' });
      expect(third).toMatchObject({ transcriptFiles: 3, filesRead: 2, filesUnchanged: 1, responsesFound: 4, responsesAdded: 2, responses: 6, written: true });
      expect(Object.keys(listOf(ledgerPath).files).sort()).toEqual(
        [MAIN_A, SUB_A, `projects/-home-alex-demo/${C}.jsonl`].map((path) => join(config, path)).sort(),
      );
      expect(listOf(ledgerPath).ledgerGeneratedAt).toBe(new Date(LATER + 2000).toISOString());
    });

    it('do not trust the list of read files when it was not written for the ledger that is there', async () => {
      const dir = scratch('list-mismatch');
      const config = writeConfig(join(dir, 'config'));
      const ledgerPath = join(dir, 'ledger.json');
      settleAll(config);
      await collect({ dirs: [config], ledgerPath, now: LATER, machine: 'm' });
      const complete = readLedger(ledgerPath).responses;

      // the ledger is deleted and the list stays behind: everything is read again
      rmSync(ledgerPath);
      const afterDelete = await collect({ dirs: [config], ledgerPath, now: LATER + 1000, machine: 'm' });
      expect(afterDelete).toMatchObject({ filesRead: 3, filesUnchanged: 0, responsesAdded: 4, responses: 4, written: true });
      expect(readLedger(ledgerPath).responses).toEqual(complete);

      // the ledger is replaced by an older copy that lacks a session
      const older = join(dir, 'older.json');
      const partial = join(dir, 'partial-config');
      cpSync(join(config, MAIN_A), join(partial, MAIN_A));
      await collect({ dirs: [partial], ledgerPath: older, now: LATER - 86_400_000, machine: 'm' });
      cpSync(older, ledgerPath);
      const afterRestore = await collect({ dirs: [config], ledgerPath, now: LATER + 2000, machine: 'm' });
      expect(afterRestore).toMatchObject({ filesRead: 3, filesUnchanged: 0, responsesAdded: 2, responses: 4, written: true });
      expect(readLedger(ledgerPath).responses).toEqual(complete);

      // a list that is damaged, or was written by another version of the tool, counts for nothing
      for (const content of ['{ not json', JSON.stringify({ ...listOf(ledgerPath), collector: '0.0.1' })]) {
        writeFileSync(readFilesPath(ledgerPath), content);
        expect(await collect({ dirs: [config], ledgerPath, now: LATER + 3000, machine: 'm' })).toMatchObject({ filesRead: 3, filesUnchanged: 0, responses: 4 });
        expect(await collect({ dirs: [config], ledgerPath, now: LATER + 4000, machine: 'm' })).toMatchObject({ filesRead: 0, filesUnchanged: 3, responses: 4 });
      }
    });

    it('read a transcript again that is still changing or holds a response in progress', async () => {
      const dir = scratch('hot');
      const config = join(dir, 'config');
      const ledgerPath = join(dir, 'ledger.json');
      const NOW = Date.parse(at('12:00:00'));
      const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
      // written two minutes ago, with a response that is still streaming
      const hot = write(config, MAIN_A, jsonl([
        assistant({ id: 'msg_H0', req: 'req_H0', ts: minutesAgo(30), usage: usage(1, 100) }),
        assistant({ id: 'msg_H1', req: 'req_H1', ts: minutesAgo(2), stop: null, usage: legacyUsage(4, 8) }),
      ]));
      settle(hot, NOW - 2 * 60_000);
      const quiet = write(config, MAIN_B, jsonl([assistant({ id: 'msg_Q1', req: 'req_Q1', ts: minutesAgo(90), session: SESSION_B, usage: usage(2, 20) })]));
      settle(quiet, NOW - 90 * 60_000);

      expect(await collect({ dirs: [config], ledgerPath, now: NOW, machine: 'm' })).toMatchObject({ filesRead: 2, deferredInProgress: 1, responses: 2 });
      expect(Object.keys(listOf(ledgerPath).files)).toEqual([quiet]);
      // same size, same date, and still read: this is how the response in progress gets counted in the end
      expect(await collect({ dirs: [config], ledgerPath, now: NOW + 20 * 60_000, machine: 'm' })).toMatchObject({ filesRead: 1, filesUnchanged: 1, responsesAdded: 1, partialAdded: 1, responses: 3 });
      expect(Object.keys(listOf(ledgerPath).files).sort()).toEqual([hot, quiet].sort());
    });

    it('a run that is cut short has saved what it read, and the next run continues from there', async () => {
      const dir = scratch('checkpoint');
      const config = writeConfig(join(dir, 'config'));
      const ledgerPath = join(dir, 'ledger.json');
      settleAll(config);

      // a save after every session; the run is stopped while it reads the second one
      let reports = 0;
      const stopped = collect({
        dirs: [config], ledgerPath, now: LATER, machine: 'm', checkpointBytes: 1,
        onProgress: () => {
          if (++reports === 2) throw new Error('stopped by the time limit');
        },
      });
      await expect(stopped).rejects.toThrow('stopped by the time limit');
      // session A and its subagent are in the ledger and on the list, session B is not
      expect(readLedger(ledgerPath).responses.map((r) => r[0])).toEqual(['m:msg_A1', 'm:msg_A3', 'm:msg_A2']);
      expect(Object.keys(listOf(ledgerPath).files).sort()).toEqual([join(config, MAIN_A), join(config, SUB_A)].sort());

      const next = await collect({ dirs: [config], ledgerPath, now: LATER + 60_000, machine: 'm', checkpointBytes: 1 });
      expect(next).toMatchObject({ filesRead: 1, filesUnchanged: 2, responsesAdded: 1, promptsAdded: 1, responses: 4, prompts: 2, written: true });

      // the same totals as one uninterrupted run
      const whole = join(dir, 'whole.json');
      await collect({ dirs: [config], ledgerPath: whole, now: LATER, machine: 'm' });
      expect(readLedger(ledgerPath).responses).toEqual(readLedger(whole).responses);
      expect(readLedger(ledgerPath).prompts).toEqual(readLedger(whole).prompts);
      expect(readLedger(ledgerPath).sessions).toEqual(readLedger(whole).sessions);
    });

    it('remove the temporary files a stopped run left behind, but not those of a run that is saving now', async () => {
      const dir = scratch('stale-temp');
      const config = writeConfig(join(dir, 'config'));
      const ledgerPath = join(dir, 'ledger.json');
      const NOW = Date.now();
      const stale = write(dir, '.ledger.json.4242.abc.tmp', 'half a ledger');
      settle(stale, NOW - 3_600_000);
      const staleList = write(dir, '.ledger.files.json.4242.abd.tmp', 'half a list');
      settle(staleList, NOW - 3_600_000);
      const fresh = write(dir, '.ledger.json.4243.abe.tmp', 'being written by another run');
      const unrelated = write(dir, '.ledger.json.notes', 'not ours');
      settle(unrelated, NOW - 3_600_000);
      await collect({ dirs: [config], ledgerPath, now: NOW, machine: 'm' });
      expect([existsSync(stale), existsSync(staleList), existsSync(fresh), existsSync(unrelated)]).toEqual([false, false, true, true]);
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(['.ledger.json.4243.abe.tmp']);
    });

    it('keep files with the same relative path under two config directories apart', async () => {
      const dir = scratch('two-roots');
      const one = join(dir, 'one');
      const two = join(dir, 'two');
      settle(write(one, MAIN_A, jsonl([assistant({ id: 'msg_R1', req: 'req_R1', ts: at('09:00:00'), usage: usage(1, 10) })])));
      settle(write(two, MAIN_A, jsonl([assistant({ id: 'msg_R2', req: 'req_R2', ts: at('09:00:00'), usage: usage(2, 20) })])));
      const ledgerPath = join(dir, 'ledger.json');
      expect(await collect({ dirs: [one, two], ledgerPath, now: LATER, machine: 'm' })).toMatchObject({ filesRead: 2, responses: 2 });
      expect(await collect({ dirs: [one, two], ledgerPath, now: LATER + 1000, machine: 'm' })).toMatchObject({ filesRead: 0, filesUnchanged: 2, responses: 2 });
    });
  });

  // Root ignores file permissions, so these need a second, unprivileged user.
  const canDropPrivileges = process.platform === 'linux' && process.getuid?.() === 0 && spawnSync('setpriv', ['--version']).status === 0;
  describe.skipIf(!canDropPrivileges)('what cannot be read', () => {
    const NOBODY = '65534';
    const asNobody = (args: string[], home: string) =>
      spawnSync('setpriv', ['--reuid', NOBODY, '--regid', NOBODY, '--clear-groups', process.execPath, join(home, 'tool.mjs'), ...args], {
        encoding: 'utf8',
        // only what the child needs: in particular not this computer's CLAUDE_CONFIG_DIR
        env: { PATH: process.env.PATH ?? '', HOME: home } as Record<string, string> as NodeJS.ProcessEnv,
      });

    it('is named, and the run ends with its own exit status, also with --quiet', () => {
      // under the app folder: the unprivileged user must be able to reach it
      const home = mkdtempSync(join(APP_ROOT, 'tests', '.tmp-collector-'));
      try {
        chmodSync(home, 0o755);
        const put = (project: string, session: string, n: number, input: number) =>
          write(home, `.claude/projects/${project}/${session}.jsonl`, jsonl([assistant({ id: `msg_P${n}`, req: `req_P${n}`, session, ts: at('09:00:00'), usage: usage(input, 10) })]));
        put('-home-alex-app', 's-app', 1, 100);
        const hidden = put('-home-alex-infra', 's-infra', 2, 5000);
        put('-home-alex-site', 's-site', 3, 70);
        const locked = put('-home-alex-site', 's-locked', 4, 900);
        cpSync(PUBLISHED_TOOL, join(home, 'tool.mjs'));
        expect(spawnSync('chown', ['-R', NOBODY, home]).status).toBe(0);
        // as left behind by Claude Code run as another user: the folder cannot be listed, the file cannot be opened
        chmodSync(dirname(hidden), 0o000);
        chmodSync(locked, 0o000);
        try {
          const run = asNobody([], home);
          expect(run.status).toBe(EXIT_INCOMPLETE);
          expect(run.stderr).toBe('');
          expect(run.stdout).toMatch(/^Read {7}3 transcript files /);
          expect(run.stdout).toContain(
            [
              '',
              'Incomplete 1 folder could not be opened, so the usage in it was not collected:',
              `  ${dirname(hidden)}: EACCES: permission denied`,
              '1 transcript could not be read to the end; what was read is in the ledger, the rest is tried again by the next run:',
              `  ${locked}: EACCES: permission denied`,
              '',
            ].join('\n'),
          );
          expect(readLedger(join(home, '.claude-lifetime', 'claude-code-ledger.json')).responses.map((r) => r[0])).toEqual(['m:msg_P1', 'm:msg_P3']);

          const quiet = asNobody(['--quiet'], home);
          expect(quiet.status).toBe(EXIT_INCOMPLETE);
          expect(quiet.stdout).toBe('');
          expect(quiet.stderr).toContain(`  ${dirname(hidden)}: EACCES: permission denied\n`);
          expect(quiet.stderr).toContain(`  ${locked}: EACCES: permission denied\n`);
        } finally {
          chmodSync(dirname(hidden), 0o700);
          chmodSync(locked, 0o600);
        }

        // once they can be read, the next run collects them and ends with 0
        const healed = asNobody([], home);
        expect(healed.status).toBe(0);
        expect(healed.stdout).not.toContain('Incomplete');
        expect(readLedger(join(home, '.claude-lifetime', 'claude-code-ledger.json')).responses).toHaveLength(4);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('never overwrites a ledger it cannot read', async () => {
    const dir = scratch('damaged');
    const config = writeConfig(join(dir, 'config'));
    for (const [name, content, why] of [
      ['garbage.json', 'this is not a ledger', /not a Claude Lifetime ledger/],
      ['truncated.json', '{"format": "claude-lifetime/claude-code-ledger", "version": 1, "responses": [', /not valid JSON/],
      ['newer.json', JSON.stringify({ format: LEDGER_FORMAT, version: 2, sessions: {}, responses: [], prompts: [] }), /format version 2/],
    ] as const) {
      const ledgerPath = write(dir, name, content);
      const error = await collect({ dirs: [config], ledgerPath, now: LATER }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CollectError);
      expect(error).toMatchObject({ code: 'ledger_unreadable' });
      expect((error as Error).message).toMatch(why);
      expect((error as Error).message).toMatch(/left untouched/);
      expect(readFileSync(ledgerPath, 'utf8')).toBe(content);
    }
  });

  it('says so when there is nothing to collect', async () => {
    const dir = scratch('nothing');
    const ledgerPath = join(dir, 'ledger.json');
    await expect(collect({ dirs: [join(dir, 'missing')], ledgerPath })).rejects.toMatchObject({ code: 'nothing_found', message: expect.stringMatching(/is not a directory/) });

    mkdirSync(join(dir, 'empty', 'projects'), { recursive: true });
    await expect(collect({ dirs: [join(dir, 'empty')], ledgerPath })).rejects.toMatchObject({ code: 'nothing_found', message: expect.stringMatching(/No transcripts/) });

    write(join(dir, 'no-usage'), MAIN_A, jsonl([user('hello', { ts: at('09:00:00') })]));
    // a prompt alone is still worth keeping
    const promptOnly = await collect({ dirs: [join(dir, 'no-usage')], ledgerPath: join(dir, 'prompt-only.json'), now: LATER });
    expect(promptOnly).toMatchObject({ responses: 0, prompts: 1 });
    write(join(dir, 'no-rows'), MAIN_A, jsonl([{ type: 'ai-title', aiTitle: 'x', sessionId: SESSION_A }]));
    await expect(collect({ dirs: [join(dir, 'no-rows')], ledgerPath, now: LATER })).rejects.toMatchObject({ code: 'nothing_found', message: expect.stringMatching(/No Claude Code usage found/) });

    // with defaults: no config directory at all
    await expect(collect({ env: {}, homeDir: join(dir, 'home-without-claude'), ledgerPath })).rejects.toMatchObject({ code: 'nothing_found', message: expect.stringMatching(/No Claude Code data found/) });
    expect(() => statSync(ledgerPath)).toThrow();
  });

  it('finds the config directories Claude Code and usage tools use', async () => {
    const dir = scratch('discover');
    const home = join(dir, 'home');
    const xdg = join(dir, 'xdg');
    const custom = join(dir, 'custom');
    for (const d of [join(home, '.claude'), join(home, '.config', 'claude'), join(xdg, 'claude'), custom]) mkdirSync(join(d, 'projects'), { recursive: true });
    mkdirSync(join(dir, 'no-projects'));

    expect(findProjectsDirs(undefined, {}, home)).toEqual([join(home, '.claude', 'projects'), join(home, '.config', 'claude', 'projects')]);
    expect(findProjectsDirs(undefined, { XDG_CONFIG_HOME: xdg }, home)).toEqual([join(home, '.claude', 'projects'), join(xdg, 'claude', 'projects')]);
    // CLAUDE_CONFIG_DIR replaces the defaults; several entries are separated by commas
    expect(findProjectsDirs(undefined, { CLAUDE_CONFIG_DIR: ` ${custom} , ${join(dir, 'no-projects')},${custom}` }, home)).toEqual([join(custom, 'projects')]);
    expect(() => findProjectsDirs(undefined, { CLAUDE_CONFIG_DIR: join(dir, 'no-projects') }, home)).toThrow(/No Claude Code data found/);
    // --dir wins over everything; a folder without projects/ is taken as a folder of transcripts
    expect(findProjectsDirs([custom, join(dir, 'no-projects')], { CLAUDE_CONFIG_DIR: home }, home)).toEqual([join(custom, 'projects'), join(dir, 'no-projects')]);

    // end to end with the defaults: two roots, the default ledger location, one copy of everything
    writeConfig(join(home, '.claude'));
    write(join(xdg, 'claude'), MAIN_A, jsonl(sessionA()));
    const result = await collect({ env: { XDG_CONFIG_HOME: xdg }, homeDir: home, now: LATER, machine: 'm' });
    expect(result).toMatchObject({
      roots: [join(home, '.claude', 'projects'), join(xdg, 'claude', 'projects')],
      transcriptFiles: 4, responses: 4, prompts: 2,
      ledgerPath: join(home, '.claude-lifetime', 'claude-code-ledger.json'),
    });
  });

  it('writes an identical copy with --out', async () => {
    const dir = scratch('out');
    const config = writeConfig(join(dir, 'config'));
    const ledgerPath = join(dir, 'ledger.json');
    const outPath = join(dir, 'export', 'copy.json');
    const first = await collect({ dirs: [config], ledgerPath, outPath, now: LATER, machine: 'm' });
    expect(first.outPath).toBe(outPath);
    expect(readFileSync(outPath, 'utf8')).toBe(readFileSync(ledgerPath, 'utf8'));
    // also when nothing changed
    rmSync(outPath);
    await collect({ dirs: [config], ledgerPath, outPath, now: LATER, machine: 'm' });
    expect(readFileSync(outPath, 'utf8')).toBe(readFileSync(ledgerPath, 'utf8'));
    await expect(collect({ dirs: [config], ledgerPath, outPath: ledgerPath })).rejects.toMatchObject({ code: 'bad_arguments' });
  });

  it('keeps reading a transcript that grows while it is being read', async () => {
    const dir = scratch('growing');
    const line = `${JSON.stringify(assistant({ id: 'msg_G', req: 'req_G', ts: at('09:00:00'), usage: usage(1, 1), content: [{ type: 'text', text: 'x'.repeat(400) }] }))}\n`;
    // about 1.5 MB: many chunks, so that reads happen after the file has changed
    const original = line.repeat(2000);
    const path = write(dir, 'growing.jsonl', original);
    const size = statSync(path).size;

    const reader = appendTolerantSource(path, size).stream().getReader();
    const chunks: Uint8Array[] = [];
    const first = await reader.read();
    chunks.push(first.value!);
    // Claude Code appends to the transcript; a plain file-backed Blob refuses further reads now
    appendFileSync(path, line.repeat(3));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    // exactly the file as it was when reading began: nothing lost, nothing of the appended part
    expect(bytes.length).toBe(size);
    expect(bytes.toString('utf8')).toBe(original);

    // and through the extraction: one response, the file read to its end
    const x = await extractTranscripts([{ name: 'growing.jsonl', size, blob: appendTolerantSource(path, size) }]);
    expect(x.files[0].status).toBe('read');
    expect(x.counters).toMatchObject({ usageRows: 2000, duplicateLines: 1999, bytesRead: size });
  });
});

describe('command line', () => {
  const io = () => {
    const captured = { out: '', err: '' };
    return { captured, io: { out: (t: string) => void (captured.out += t), err: (t: string) => void (captured.err += t) } };
  };

  it('parses its options', () => {
    expect(parseArgs([])).toEqual({ dirs: [], quiet: false, help: false, version: false });
    expect(parseArgs(['--dir', 'a', '--dir=b', '--ledger', 'l.json', '--out=o.json', '--quiet'])).toEqual({
      dirs: ['a', 'b'], ledger: 'l.json', out: 'o.json', quiet: true, help: false, version: false,
    });
    expect(parseArgs(['-h']).help).toBe(true);
    expect(() => parseArgs(['--dir'])).toThrow(/--dir needs a value/);
    expect(() => parseArgs(['--ledger='])).toThrow(/--ledger needs a value/);
    expect(() => parseArgs(['--frobnicate'])).toThrow(/Unknown option: --frobnicate/);
    expect(() => parseArgs(['stray'])).toThrow(/Unknown option: stray/);
  });

  it('prints a summary and returns 0; --quiet prints nothing', async () => {
    const dir = scratch('cli');
    const config = writeConfig(join(dir, 'config'));
    const ledgerPath = join(dir, 'ledger.json');

    const first = io();
    expect(await runCli(['--dir', config, '--ledger', ledgerPath], first.io, { now: LATER, machine: 'm' })).toBe(0);
    expect(first.captured.err).toBe('');
    const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const transcriptBytes = [MAIN_A, SUB_A, MAIN_B].reduce((sum, path) => sum + statSync(join(config, path)).size, 0);
    expect(first.captured.out).toBe(
      [
        `Read       3 transcript files (${kb(transcriptBytes)}) under ${join(config, 'projects')}`,
        'Found      4 responses and 2 prompts in them',
        'New        4 responses and 2 prompts since the last run',
        'Ledger     4 responses, 2 prompts, 2 sessions',
        'Range      2026-01-15 to 2026-01-16 (UTC)',
        `Saved to   ${ledgerPath} (${kb(statSync(ledgerPath).size)})`,
        '',
      ].join('\n'),
    );

    const second = io();
    expect(await runCli(['--dir', config, '--ledger', ledgerPath], second.io, { now: LATER, machine: 'm' })).toBe(0);
    expect(second.captured.out).toMatch(/New {8}0 responses and 0 prompts since the last run\n/);
    expect(second.captured.out).toMatch(/already up to date\n$/);

    const quiet = io();
    expect(await runCli(['--dir', config, '--ledger', ledgerPath, '--quiet'], quiet.io, { now: LATER })).toBe(0);
    expect(quiet.captured).toEqual({ out: '', err: '' });
  });

  it('returns 1 with a clear message when something is wrong', async () => {
    const dir = scratch('cli-errors');
    const config = writeConfig(join(dir, 'config'));

    const help = io();
    expect(await runCli(['--help'], help.io)).toBe(0);
    expect(help.captured.out).toBe(USAGE);
    const version = io();
    expect(await runCli(['--version'], version.io)).toBe(0);
    expect(version.captured.out).toBe(`${COLLECTOR_VERSION}\n`);

    const unknown = io();
    expect(await runCli(['--frobnicate'], unknown.io)).toBe(1);
    expect(unknown.captured.err).toMatch(/^Unknown option: --frobnicate\n\nClaude Lifetime collector/);
    expect(unknown.captured.out).toBe('');

    const nothing = io();
    mkdirSync(join(dir, 'empty'));
    expect(await runCli(['--dir', join(dir, 'empty'), '--ledger', join(dir, 'l.json')], nothing.io)).toBe(1);
    expect(nothing.captured.err).toMatch(/No transcripts \(\.jsonl files\) found under/);

    const damaged = io();
    const bad = write(dir, 'bad.json', '{"not": "a ledger"}');
    expect(await runCli(['--dir', config, '--ledger', bad], damaged.io)).toBe(1);
    expect(damaged.captured.err).toMatch(/could not be read: This file is not a Claude Lifetime ledger\.\nIt was left untouched/);
    expect(readFileSync(bad, 'utf8')).toBe('{"not": "a ledger"}');
  });
});

describe('ledger importer', () => {
  let config: string;
  let ledgerPath: string;
  beforeAll(async () => {
    const dir = scratch('import');
    config = writeConfig(join(dir, 'config'));
    ledgerPath = join(dir, 'claude-code-ledger.json');
    await collect({ dirs: [config], ledgerPath, now: LATER, machine: 'test-machine' });
  });

  it('gives the same totals as importing the transcripts themselves', async () => {
    const fromTranscripts = await run(claudeCodeParser, loadDir(config));
    const fromLedger = await run(claudeCodeLedgerParser, [ledgerFile(ledgerPath)]);

    expect(byModelAndTier(fromTranscripts.sink)).toEqual(EXPECTED_BY_MODEL);
    expect(byModelAndTier(fromLedger.sink)).toEqual(EXPECTED_BY_MODEL);
    // not just the same sums: the same rows, keys, conversations and request hashes
    expect(fromLedger.sink.usages).toEqual(fromTranscripts.sink.usages);
    expect(fromLedger.sink.conversations).toEqual(fromTranscripts.sink.conversations);
    expect(fromLedger.sink.models).toEqual(fromTranscripts.sink.models);
    expect(fromLedger.parsed.requestKeys).toEqual(fromTranscripts.parsed.requestKeys);
    expect(fromLedger.parsed.warnings).toEqual(fromTranscripts.parsed.warnings);
    expect(fromLedger.parsed.warnings.map((w) => [w.code, w.count])).toEqual([['iterations_not_counted', 1]]);

    expect(fromLedger.sink.conversations).toEqual([
      {
        dedupKey: `claude_code:${SESSION_A}`, kind: 'code_session', externalId: SESSION_A, title: 'Fix the date parser', projectLabel: '/home/alex/demo',
        modelKey: 'claude-sonnet-4-5', createdAt: '2026-01-15T09:00:00.000Z', updatedAt: '2026-01-15T09:00:08.000Z',
        metadata: { gitBranch: 'main', version: '2.1.321', hasSubagents: true },
      },
      {
        dedupKey: `claude_code:${SESSION_B}`, kind: 'code_session', externalId: SESSION_B, title: null, projectLabel: '/work/other',
        modelKey: 'claude-sonnet-5-5', createdAt: '2026-01-16T10:00:00.000Z', updatedAt: '2026-01-16T10:00:05.000Z',
        metadata: { gitBranch: 'main', version: '2.1.321' },
      },
    ]);
    expect(fromLedger.parsed).toMatchObject({
      format: 'claude-code/ledger',
      formatLabel: 'Claude Code usage ledger (collector)',
      parserVersion: 'claude-code-1',
      source: { kind: 'claude_code', label: 'Claude Code (this computer)', externalRef: 'local' },
      fileName: 'claude-code-ledger.json',
      fileSize: statSync(ledgerPath).size,
      recordsSeen: 4,
      recordsSkipped: 0,
      duplicateRequests: 0,
    });
    // 4 responses + 1 advisor iteration + 2 prompts
    expect(fromLedger.parsed.requestKeys).toHaveLength(7);
    expect(fromLedger.parsed.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fromLedger.parsed.stats).toMatchObject({
      files: 1, filesRead: 1, machine: 'test-machine', generatedAt: new Date(LATER).toISOString(),
      responses: 4, newResponses: 4, subagentResponses: 1, humanPrompts: 2, newHumanPrompts: 2, newAdvisorRecords: 1, iterationsNotCounted: 1, sessions: 2,
    });
    expect(fromLedger.parsed.syncedFiles).toEqual([{ path: 'claude-code-ledger.json', size: statSync(ledgerPath).size, lastModified: Math.trunc(statSync(ledgerPath).mtimeMs) }]);
  });

  it('adds nothing after the transcripts were imported, and the other way round', async () => {
    const transcripts = await run(claudeCodeParser, loadDir(config));
    const after = await run(claudeCodeLedgerParser, [ledgerFile(ledgerPath)], { knownRequestKeys: new Set(transcripts.parsed.requestKeys) });
    expect(after.sink.usages).toEqual([]);
    expect(after.sink.conversations).toEqual([]);
    expect(after.parsed).toMatchObject({ requestKeys: [], duplicateRequests: 7 });
    expect(after.parsed.stats).toMatchObject({ newResponses: 0, duplicateResponses: 4, duplicateAdvisorRecords: 1, duplicateHumanPrompts: 2 });

    const ledgerFirst = await run(claudeCodeLedgerParser, [ledgerFile(ledgerPath)]);
    const then = await run(claudeCodeParser, loadDir(config), { knownRequestKeys: new Set(ledgerFirst.parsed.requestKeys) });
    expect(then.sink.usages).toEqual([]);
    expect(then.parsed).toMatchObject({ requestKeys: [], duplicateRequests: 7 });
  });

  it('takes its options from the context and skips a ledger it has already read', async () => {
    const f = ledgerFile(ledgerPath);
    const labelled = await run(claudeCodeLedgerParser, [f], { options: { sourceLabel: 'Claude Code (laptop)', sourceRef: 'machine:laptop' } });
    expect(labelled.parsed.source).toEqual({ kind: 'claude_code', label: 'Claude Code (laptop)', externalRef: 'machine:laptop' });

    const knownFiles = new Map(labelled.parsed.syncedFiles!.map((s) => [s.path, { size: s.size, lastModified: s.lastModified }]));
    const skipped = await run(claudeCodeLedgerParser, [f], { knownFiles });
    expect(skipped.parsed).toMatchObject({ fileName: '0 ledger files', requestKeys: [], contentHash: null });
    expect(skipped.parsed.stats).toMatchObject({ filesRead: 0, filesSkippedUnchanged: 1 });
    expect(skipped.sink.usages).toEqual([]);
  });

  it('merges ledgers from several computers and counts shared responses once', async () => {
    const dir = scratch('two-machines');
    // the second computer has a copy of session A (synced folder) and session B
    const laptop = join(dir, 'laptop');
    write(laptop, MAIN_A, jsonl(sessionA()));
    write(laptop, SUB_A, jsonl(subagentA()));
    const desktop = join(dir, 'desktop');
    write(desktop, MAIN_A, jsonl(sessionA()));
    write(desktop, MAIN_B, jsonl(sessionB()));
    await collect({ dirs: [laptop], ledgerPath: join(dir, 'laptop.json'), now: LATER, machine: 'laptop' });
    await collect({ dirs: [desktop], ledgerPath: join(dir, 'desktop.json'), now: LATER + 1000, machine: 'desktop' });

    const { parsed, sink } = await run(claudeCodeLedgerParser, [ledgerFile(join(dir, 'laptop.json'), 'laptop.json'), ledgerFile(join(dir, 'desktop.json'), 'desktop.json')]);
    expect(byModelAndTier(sink)).toEqual(EXPECTED_BY_MODEL);
    expect(parsed).toMatchObject({ fileName: '2 ledger files', contentHash: null });
    expect(parsed.stats).toMatchObject({ files: 2, machine: 'desktop, laptop', generatedAt: new Date(LATER + 1000).toISOString(), responses: 4 });
  });

  it('rejects files that are not usable ledgers, with a code the UI can explain', async () => {
    const good = readFileSync(ledgerPath, 'utf8');
    const doc = JSON.parse(good) as Record<string, unknown> & { responses: unknown[][] };
    const cases: Array<[string, string, string]> = [
      ['some other JSON', '{"conversations": []}', 'not_a_ledger'],
      ['not JSON at all', 'hello', 'not_a_ledger'],
      ['a transcript', jsonl(sessionA()), 'not_a_ledger'],
      ['a ledger from a newer collector', JSON.stringify({ ...doc, version: 2 }), 'unsupported_ledger_version'],
      ['a cut-off ledger', good.slice(0, good.length - 40), 'invalid_ledger'],
      ['a ledger with a damaged row', JSON.stringify({ ...doc, responses: [['mr:x:y', 0, 0, 'yesterday', 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]] }), 'invalid_ledger'],
      ['a ledger with a negative count', JSON.stringify({ ...doc, responses: [['mr:x:y', 0, 0, 1768467602100, -5, 1, 0, 0, 0, 0, 0, 0, 0, 0]] }), 'invalid_ledger'],
      ['a ledger that refers to a missing session', JSON.stringify({ ...doc, responses: [['mr:x:y', 9, 0, 1768467602100, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]] }), 'invalid_ledger'],
      ['a ledger that refers to a missing model', JSON.stringify({ ...doc, responses: [['mr:x:y', 0, 99, 1768467602100, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]] }), 'invalid_ledger'],
      ['an empty ledger', JSON.stringify({ ...doc, sessions: {}, responses: [], prompts: [] }), 'no_usage_found'],
    ];
    for (const [name, content, code] of cases) {
      const error = await run(claudeCodeLedgerParser, [file('claude-code-ledger.json', content)]).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(ImportError);
      expect((error as ImportError).code, name).toBe(code);
    }
    await expect(run(claudeCodeLedgerParser, [])).rejects.toMatchObject({ code: 'no_files' });
  });

  it('recognises a ledger from the start of the file', async () => {
    expect(await isClaudeCodeLedgerFile(ledgerFile(ledgerPath))).toBe(true);
    expect(await isClaudeCodeLedgerFile(file('conversations.json', '[{"uuid": "x"}]'))).toBe(false);
    expect(await isClaudeCodeLedgerFile(file('a.jsonl', jsonl(sessionA())))).toBe(false);
    expect(looksLikeLedger('{\n  "format" : "claude-lifetime/claude-code-ledger",')).toBe(true);
    expect(looksLikeLedger('{"format": "something-else"}')).toBe(false);
  });

  it('tells a ledger and a transcript row from other parsed JSON', () => {
    expect(detectClaudeCodeFormat(readLedger(ledgerPath))).toBe('claude-code/ledger');
    for (const row of [...sessionA(), ...subagentA(), ...sessionB()]) expect(detectClaudeCodeFormat(row)).toBe('claude-code/jsonl');
    // the first line of the example transcript is a summary row, which names no session
    const firstLine = fixtureText('research-example/projects/-home-alex-demo/11111111-1111-4111-8111-111111111111.jsonl').split('\n')[0];
    expect(detectClaudeCodeFormat(JSON.parse(firstLine))).toBe('claude-code/jsonl');
    expect(detectClaudeCodeFormat({ type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false })).toBe('claude-code/jsonl');

    const others: unknown[] = [
      null, 42, 'text', [], {},
      { type: 'message', role: 'assistant' },
      { type: 'summary', summary: 'no leaf' },
      // Claude Code's prompt history: a session id, but not a transcript row
      { display: 'x', timestamp: 1768467600000, project: '/home/alex/demo', sessionId: SESSION_A },
      { timestamp: '2026-01-01T00:00:00Z', model: 'claude-sonnet-4-5', input_tokens: 5 },
      { format: 'claude-lifetime/usage', records: [] },
      { data: [], has_more: false },
    ];
    for (const other of others) expect(detectClaudeCodeFormat(other), JSON.stringify(other)).toBeNull();
  });
});

describe('ledger format', () => {
  it('survives a round trip through its text form', async () => {
    const x = await extractTranscripts(loadDir(writeConfig(join(scratch('roundtrip'), 'config'))));
    const ledger = emptyLedger();
    expect(mergeIntoLedger(ledger, x)).toEqual({ responsesAdded: 4, responsesImproved: 0, promptsAdded: 2, sessionsChanged: 2, changed: true });
    const header = { generatedAt: '2026-06-01T00:00:00.000Z', machine: 'm', collector: 'test' };
    const text = [...serialiseLedger(ledger, header)].join('');
    const back = parseLedger(text);

    expect(back).toMatchObject({ generatedAt: header.generatedAt, machine: 'm', collector: 'test' });
    const records = ledgerRecords(ledger);
    expect(ledgerRecords(back).prompts).toEqual(records.prompts);
    // the ledger keeps one timestamp per response
    expect(ledgerRecords(back).responses).toEqual(records.responses.map((r) => ({ ...r, lastTs: r.ts })));
    expect([...back.sessions.values()]).toEqual([...ledger.sessions.values()]);
    // writing what was read gives the same text: the format is deterministic
    expect([...serialiseLedger(back, header)].join('')).toBe(text);
    // merging a ledger into itself changes nothing
    expect(mergeIntoLedger(back, ledgerRecords(parseLedger(text)))).toMatchObject({ changed: false });
  });

  it('keeps the better title and the first known folder of a session across runs', () => {
    const session = (over: Record<string, unknown>) => new Map([[SESSION_A, { id: SESSION_A, title: null, titleKind: null, cwd: null, gitBranch: null, version: null, hasSubagents: false, ...over }]]);
    const response = { key: 'mr:a:b', sessionId: SESSION_A, model: null, ts: 1, lastTs: 1, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, webSearch: 0, flags: 0, serviceTier: null, geo: null, extras: null };
    const ledger = emptyLedger();
    const seen = (over: Record<string, unknown>) => mergeIntoLedger(ledger, { responses: [response], prompts: [], sessions: session(over) as never });

    seen({ title: 'Generated', titleKind: 'ai', cwd: '/first', version: '2.1.300' });
    seen({ title: 'Chosen by hand', titleKind: 'custom', cwd: '/second', gitBranch: 'main', hasSubagents: true });
    // a later run no longer sees the custom title (the transcript is gone) or sees only a generated one
    seen({ title: 'Generated again', titleKind: 'ai', version: '2.1.321' });
    seen({});
    expect(ledger.sessions.get(SESSION_A)).toEqual({
      id: SESSION_A, title: 'Chosen by hand', titleKind: 'custom', cwd: '/first', gitBranch: 'main', version: '2.1.321', hasSubagents: true,
    });
    // a renamed session: the newest title of the same kind wins
    seen({ title: 'Renamed', titleKind: 'custom' });
    expect(ledger.sessions.get(SESSION_A)?.title).toBe('Renamed');
  });
});

describe('the bundled command-line tool', () => {
  let bundle: string;
  // Only what the child needs: in particular not this computer's CLAUDE_CONFIG_DIR.
  const env = (home: string): NodeJS.ProcessEnv => {
    const vars: Record<string, string | undefined> = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home };
    return vars as NodeJS.ProcessEnv;
  };
  const runTool = (args: string[], home: string) => spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env: env(home) });

  beforeAll(() => {
    bundle = join(scratch('bundle'), 'claude-lifetime-collect.mjs');
    execFileSync(process.execPath, [join(APP_ROOT, 'scripts', 'build-collector.mjs'), '--outfile', bundle], { cwd: tmp, encoding: 'utf8' });
  });

  it('is a single file that needs nothing but Node', () => {
    const source = readFileSync(bundle, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const imported = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
    expect(imported.sort()).toEqual(['node:fs', 'node:os', 'node:path']);
    expect(source).not.toMatch(/\brequire\(/);
    // Node.js before 19.8 has no fs.openAsBlob. Imported by name, the file would not load there at all,
    // and the tool could not say which version it needs.
    expect(source).toContain('import * as fs from "node:fs"');
    expect(source).not.toMatch(/import\s*\{[^}]*\bopenAsBlob\b[^}]*\}\s*from/);
    // the tool is offered for download as it is built here
    expect(readFileSync(PUBLISHED_TOOL, 'utf8'), 'public/tools/claude-lifetime-collect.mjs is out of date: run "node scripts/build-collector.mjs"').toBe(source);
  });

  it('collects a fixture directory into a ledger that imports with the same totals as its transcripts', async () => {
    const dir = scratch('tool');
    const ledgerPath = join(dir, 'ledger.json');
    const fixture = join(FIXTURE_DIR, 'research-example');

    const first = runTool(['--dir', fixture, '--ledger', ledgerPath], dir);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`Read       2 transcript files (9 KB) under ${join(fixture, 'projects')}`);
    expect(first.stdout).toContain('Found      4 responses and 1 prompt in them');
    expect(first.stdout).toContain('New        4 responses and 1 prompt since the last run');
    expect(first.stdout).toContain('Range      2026-01-15 to 2026-01-15 (UTC)');
    expect(first.stdout).toContain(`Saved to   ${ledgerPath}`);

    const fromLedger = await run(claudeCodeLedgerParser, [ledgerFile(ledgerPath)]);
    const fromTranscripts = await run(claudeCodeParser, loadFixtureDir('research-example'));
    expect(fromLedger.sink.usages).toEqual(fromTranscripts.sink.usages);
    expect(fromLedger.sink.conversations).toEqual(fromTranscripts.sink.conversations);
    expect(fromLedger.parsed.requestKeys).toEqual(fromTranscripts.parsed.requestKeys);
    // the exact totals of the example: 4 responses, 1 prompt
    expect(totalsBy(fromLedger.sink.usages, (u) => u.modelKey ?? 'none')).toEqual({
      'claude-sonnet-4-5': { input: 9, output: 380, cacheRead: 49150, cacheWrite5m: 240, cacheWrite1h: 2000, requests: 3, userMessages: 1, assistantMessages: 1 },
      'claude-haiku-4-5': { input: 10, output: 300, cacheRead: 0, cacheWrite5m: 5000, cacheWrite1h: 0, requests: 1, userMessages: 0, assistantMessages: 0 },
    });
    expect(totals(fromLedger.sink.usages)).toEqual({ input: 19, output: 680, cacheRead: 49150, cacheWrite5m: 5240, cacheWrite1h: 2000, requests: 4, userMessages: 1, assistantMessages: 1 });
    const text = readFileSync(ledgerPath, 'utf8');
    for (const leaked of ['Why does test_parse_date fail', 'off by one', 'pytest', 'Search for weekday handling', 'API Error']) expect(text).not.toContain(leaked);

    const second = runTool(['--dir', fixture, '--ledger', ledgerPath, '--out', join(dir, 'copy.json')], dir);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('New        0 responses and 0 prompts since the last run');
    expect(second.stdout).toContain('already up to date');
    expect(readFileSync(join(dir, 'copy.json'), 'utf8')).toBe(text);

    const quiet = runTool(['--dir', fixture, '--ledger', ledgerPath, '--quiet'], dir);
    expect([quiet.status, quiet.stdout, quiet.stderr]).toEqual([0, '', '']);
  });

  it('uses ~/.claude and ~/.claude-lifetime by default', () => {
    const home = scratch('home');
    writeConfig(join(home, '.claude'));
    const result = runTool([], home);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Ledger     4 responses, 2 prompts, 2 sessions');
    expect(readLedger(join(home, '.claude-lifetime', 'claude-code-ledger.json')).responses).toHaveLength(4);
  });

  it('exits with 1 and a message when nothing is found or the ledger is damaged', () => {
    const home = scratch('empty-home');
    const none = runTool([], home);
    expect(none.status).toBe(1);
    expect(none.stdout).toBe('');
    expect(none.stderr).toMatch(/No Claude Code data found\. Looked for a "projects" folder in: .*\.claude/);

    const bad = write(home, 'bad.json', 'not a ledger');
    const damaged = runTool(['--dir', join(FIXTURE_DIR, 'research-example'), '--ledger', bad], home);
    expect(damaged.status).toBe(1);
    expect(damaged.stderr).toMatch(/could not be read/);
    expect(readFileSync(bad, 'utf8')).toBe('not a ledger');

    const usage = runTool(['--no-such-option'], home);
    expect(usage.status).toBe(1);
    expect(usage.stderr).toMatch(/Unknown option: --no-such-option/);
    const help = runTool(['--help'], home);
    expect([help.status, help.stdout]).toEqual([0, USAGE]);
  });
});
