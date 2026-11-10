import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ImportFile,
  ImportProgress,
  ImportSink,
  StagedConversation,
  StagedCost,
  StagedMessage,
  StagedModel,
  StagedUsage,
} from '@/core/types';

/**
 * Builders for synthetic Claude Code transcripts. Everything here is invented:
 * ids, text and numbers. Row shapes follow the verified format description
 * (research §3-4); only the fields the importer reads are filled in.
 */
export const FIXTURE_DIR = fileURLToPath(new URL('.', import.meta.url));

export const SESSION_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const SESSION_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** A fixed "now" long after every fixture timestamp, so nothing counts as in progress. */
export const LATER = Date.UTC(2026, 5, 1);

/** ISO timestamp on the fixtures' day. `at('09:00:02.100')` -> 2026-01-15T09:00:02.100Z */
export const at = (time: string, day = '2026-01-15'): string => `${day}T${time.length === 8 ? `${time}.000` : time}Z`;

let counter = 0;
/** A fresh row uuid (deterministic within a test run). */
export const rowUuid = (): string => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;

type Json = Record<string, unknown>;

/** A usage object in the current shape (with the 5m / 1h cache write split). */
export function usage(input: number, output: number, cacheRead = 0, write5m = 0, write1h = 0, extra: Json = {}): Json {
  return {
    input_tokens: input,
    cache_creation_input_tokens: write5m + write1h,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
    inference_geo: 'global',
    speed: 'standard',
    ...extra,
  };
}

/** A usage object as old versions wrote it: no cache split, no speed, no tier. */
export function legacyUsage(input: number, output: number, cacheRead = 0, cacheCreation = 0): Json {
  return { input_tokens: input, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead, output_tokens: output };
}

export interface AssistantOptions {
  /** message.id; null leaves it out. */
  id?: string | null;
  /** requestId; null leaves it out. */
  req?: string | null;
  model?: string | null;
  ts: string;
  session?: string;
  sidechain?: boolean;
  stop?: string | null;
  content?: unknown[];
  usage?: Json;
  uuid?: string;
  cwd?: string;
  /** Further envelope fields (forkedFrom, agentId, isUnmetered, ...). */
  extra?: Json;
}

export function assistant(o: AssistantOptions): Json {
  const message: Json = {
    model: o.model === undefined ? 'claude-sonnet-4-5-20250929' : o.model,
    type: 'message',
    role: 'assistant',
    content: o.content ?? [{ type: 'text', text: 'ASSISTANT-TEXT-MUST-NOT-LEAK' }],
    stop_reason: o.stop === undefined ? 'end_turn' : o.stop,
    stop_sequence: null,
    usage: o.usage ?? usage(1, 1),
  };
  if (o.id !== null) message.id = o.id ?? 'msg_TEST0001';
  if (o.model === null) delete message.model;
  const row: Json = {
    parentUuid: null,
    isSidechain: o.sidechain ?? false,
    message,
    type: 'assistant',
    uuid: o.uuid ?? rowUuid(),
    timestamp: o.ts,
    userType: 'external',
    cwd: o.cwd ?? '/home/alex/demo',
    sessionId: o.session ?? SESSION_A,
    version: '2.1.321',
    gitBranch: 'main',
    ...o.extra,
  };
  if (o.req !== null) row.requestId = o.req ?? 'req_TEST0001';
  return row;
}

export const toolUse = (name = 'Bash'): Json => ({ type: 'tool_use', id: 'toolu_TEST', name, input: { command: 'TOOL-INPUT-MUST-NOT-LEAK' } });

export interface UserOptions {
  ts: string;
  session?: string;
  uuid?: string;
  /** Further envelope fields (isMeta, origin, toolUseResult, isSidechain, ...). */
  extra?: Json;
}

/** A `user` row; `content` is a string or an array of blocks. */
export function user(content: unknown, o: UserOptions): Json {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: o.uuid ?? rowUuid(),
    timestamp: o.ts,
    userType: 'external',
    cwd: '/home/alex/demo',
    sessionId: o.session ?? SESSION_A,
    version: '2.1.321',
    gitBranch: 'main',
    ...o.extra,
  };
}

export function toolResult(o: UserOptions): Json {
  return user([{ tool_use_id: 'toolu_TEST', type: 'tool_result', content: 'TOOL-OUTPUT-MUST-NOT-LEAK', is_error: false }], {
    ...o,
    extra: { toolUseResult: { stdout: 'TOOL-OUTPUT-MUST-NOT-LEAK', stderr: '', interrupted: false }, ...o.extra },
  });
}

export const jsonl = (rows: unknown[]): string => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

/** An ImportFile as a directory picker would hand it over. */
export function file(path: string, content: string, lastModified?: number): ImportFile {
  const blob = new Blob([content]);
  return { name: path.split('/').pop() ?? path, path, size: blob.size, lastModified, blob };
}

/** Text of one fixture file, by its path below tests/fixtures/claude-code/. */
export const fixtureText = (path: string): string => readFileSync(join(FIXTURE_DIR, path), 'utf8');

/** Every file below tests/fixtures/claude-code/<dir>, with paths relative to it. */
export function loadFixtureDir(dir: string, lastModified?: number): ImportFile[] {
  const root = join(FIXTURE_DIR, dir);
  const out: ImportFile[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (statSync(child).isDirectory()) walk(child, childRel);
      else out.push(file(childRel, readFileSync(child, 'utf8'), lastModified));
    }
  };
  walk(root, '');
  return out;
}

/** Collects what a parser emits. */
export class MemorySink implements ImportSink {
  conversations: StagedConversation[] = [];
  messages: StagedMessage[] = [];
  usages: StagedUsage[] = [];
  costs: StagedCost[] = [];
  models: StagedModel[] = [];
  progressCalls: ImportProgress[] = [];

  conversation(c: StagedConversation) {
    this.conversations.push(c);
  }
  message(m: StagedMessage) {
    this.messages.push(m);
  }
  usage(u: StagedUsage) {
    this.usages.push(u);
  }
  cost(c: StagedCost) {
    this.costs.push(c);
  }
  model(m: StagedModel) {
    this.models.push(m);
  }
  progress(p: ImportProgress) {
    this.progressCalls.push(p);
  }
}

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  requests: number;
  userMessages: number;
  assistantMessages: number;
}

const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0, userMessages: 0, assistantMessages: 0 });

function add(t: Totals, u: StagedUsage): void {
  t.input += u.inputTokens;
  t.output += u.outputTokens;
  t.cacheRead += u.cacheReadTokens;
  t.cacheWrite5m += u.cacheWrite5mTokens;
  t.cacheWrite1h += u.cacheWrite1hTokens;
  t.requests += u.requestCount;
  t.userMessages += u.userMessageCount;
  t.assistantMessages += u.assistantMessageCount;
}

export function totals(rows: StagedUsage[]): Totals {
  const t = zero();
  for (const u of rows) add(t, u);
  return t;
}

/** Totals per value of `key` (model, tier, conversation). */
export function totalsBy(rows: StagedUsage[], key: (u: StagedUsage) => string): Record<string, Totals> {
  const out: Record<string, Totals> = {};
  for (const u of rows) add((out[key(u)] ??= zero()), u);
  return out;
}
