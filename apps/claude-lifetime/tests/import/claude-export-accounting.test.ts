import { describe, expect, it } from 'vitest';
import { Limitation } from '@/core/limitations';
import { accountConversation, ROOT_PARENT, type AccountBlock, type AccountMessage } from '@/import/claude-export/accounting';

// In these tests one character is one base unit, so the arithmetic can be read off the fixtures.
const T0 = Date.UTC(2025, 5, 1, 12, 0, 0);
const text = (n: number): AccountBlock => ({ kind: 'text', base: n });
const thinking = (n: number): AccountBlock => ({ kind: 'thinking', base: n });
const toolUse = (n: number): AccountBlock => ({ kind: 'tool_use', base: n });
const toolResult = (n: number): AccountBlock => ({ kind: 'tool_result', base: n });

let seq = 0;
const m = (role: 'user' | 'assistant', seconds: number, blocks: AccountBlock[], over: Partial<AccountMessage> = {}): AccountMessage => ({
  id: over.id ?? `m${seq++}`,
  role,
  timeMs: T0 + seconds * 1000,
  blocks,
  attachmentBase: 0,
  capBase: 1_000_000,
  ...over,
});
const sum = (rows: ReturnType<typeof accountConversation>) =>
  rows.reduce(
    (a, r) => ({ input: a.input + r.inputBase, output: a.output + r.outputBase, replay: a.replay + r.replayBase, cached: a.cached + r.replayCachedBase, requests: a.requests + r.requestCount }),
    { input: 0, output: 0, replay: 0, cached: 0, requests: 0 },
  );

describe('conversation accounting', () => {
  it('counts new content once and re-read context on every later request', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)]),
      m('assistant', 10, [text(20)]),
      m('user', 60, [text(5)]),
      m('assistant', 70, [text(8)]),
    ]);
    expect(rows[0]).toMatchObject({ inputBase: 10, outputBase: 0, replayBase: 0, requestCount: 0 });
    // first reply: the user's message is new input, nothing is re-read
    expect(rows[1]).toMatchObject({ inputBase: 0, outputBase: 20, replayBase: 0, replayCachedBase: 0, requestCount: 1 });
    expect(rows[2]).toMatchObject({ inputBase: 5 });
    // second reply re-reads the first exchange (10 + 20); the first request's input (10) was cached 60 s earlier
    expect(rows[3]).toMatchObject({ outputBase: 8, replayBase: 30, replayCachedBase: 10, requestCount: 1 });
    expect(sum(rows)).toEqual({ input: 15, output: 28, replay: 30, cached: 10, requests: 2 });
  });

  it('gives no cache credit when the previous request is more than five minutes old', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)]),
      m('assistant', 10, [text(20)]),
      m('user', 700, [text(5)]),
      m('assistant', 710, [text(8)]),
    ]);
    expect(rows[3]).toMatchObject({ replayBase: 30, replayCachedBase: 0 });
  });

  it('times the cache window from request to request, whatever time a reply took to write', () => {
    // In an export a reply is stamped when it is complete; its blocks say when the model began to answer.
    const at = (seconds: number) => T0 + seconds * 1000;
    const reply = (began: number, completed: number, n: number, over: Partial<AccountMessage> = {}) =>
      m('assistant', completed, [{ kind: 'text', base: n, startMs: at(began) }], over);
    const second = (seconds: number) =>
      accountConversation([m('user', 0, [text(1000)]), reply(1, 5, 20), m('user', 245, [text(5)]), reply(246, 246 + seconds, 8)])[3].replayCachedBase;
    // The user answers four minutes after the first reply. The second request is sent at the same moment and over the
    // same context whether its reply then takes ten seconds or a minute to write.
    expect(second(10)).toBe(1000);
    expect(second(60)).toBe(1000);
    expect(second(400)).toBe(1000);

    // More than five minutes between the two requests: no credit, even though the first reply only finished
    // four minutes before the second one began.
    const slow = accountConversation([m('user', 0, [text(1000)]), reply(1, 90, 20), m('user', 330, [text(5)]), reply(331, 340, 8)]);
    expect(slow[3]).toMatchObject({ replayBase: 1020, replayCachedBase: 0 });

    // A reply that makes several requests keeps the cache warm with each of them.
    const long = accountConversation([
      m('user', 0, [text(1000)]),
      reply(1, 5, 20),
      m('user', 10, [text(5)]),
      m('assistant', 400, [
        { kind: 'tool_use', base: 10, startMs: at(11) },
        toolResult(100),
        { kind: 'tool_use', base: 10, startMs: at(200) },
        toolResult(100),
        { kind: 'text', base: 30, startMs: at(390) },
      ]),
      m('user', 500, [text(5)]),
      reply(501, 510, 8),
    ]);
    // request 1: 1,020 re-read, of which the 1,000 the first request read were cached 10 s earlier
    // request 2: 1,035 re-read; request 1 read 1,025 of that 189 s earlier (the tool call was written, not read, by it)
    // request 3: 1,145 re-read; request 2 read 1,135 of that 190 s earlier
    expect(long[3]).toMatchObject({ requestCount: 3, replayBase: 1020 + 1035 + 1145, replayCachedBase: 1000 + 1025 + 1135 });
    // the next turn follows the LAST request of that reply (390 s) by 111 s, not its first by 490 s:
    // 1,275 re-read, of which request 3 had read 1,245
    expect(long[5]).toMatchObject({ replayBase: 1275, replayCachedBase: 1245 });

    // A tool that kept the model waiting for more than five minutes: the request after it finds no cache.
    const waited = accountConversation([
      m('user', 0, [text(1000)]),
      m('assistant', 700, [{ kind: 'tool_use', base: 10, startMs: at(1) }, toolResult(100), { kind: 'text', base: 30, startMs: at(690) }]),
    ]);
    expect(waited[1]).toMatchObject({ requestCount: 2, replayBase: 1010, replayCachedBase: 0 });
  });

  it('falls back to the time the prompt was sent when blocks are not timed, and never trusts a time outside the turn', () => {
    // no block times: the request is taken to have been sent with the prompt
    const untimed = accountConversation([m('user', 0, [text(10)]), m('assistant', 10, [text(20)]), m('user', 250, [text(5)]), m('assistant', 600, [text(8)])]);
    expect(untimed[3].replayCachedBase).toBe(10);
    // a block time before the prompt or after the completed reply is not used
    const early = accountConversation([m('user', 0, [text(10)]), m('assistant', 10, [text(20)]), m('user', 400, [text(5)]), m('assistant', 410, [{ kind: 'text', base: 8, startMs: T0 + 100_000 }])]);
    expect(early[3].replayCachedBase).toBe(0);
    const late = accountConversation([m('user', 0, [text(10)]), m('assistant', 10, [text(20)]), m('user', 100, [text(5)]), m('assistant', 110, [{ kind: 'text', base: 8, startMs: T0 + 900_000 }])]);
    expect(late[3].replayCachedBase).toBe(10);
  });

  it('counts a prompt as new input for the first request that carries it, never as re-read context of that request', () => {
    const tree = (id: string, parentId: string, role: 'user' | 'assistant', seconds: number, blocks: AccountBlock[], attachmentBase = 0) =>
      m(role, seconds, blocks, { id, parentId, attachmentBase });
    // The first reply failed before any output; the user pressed retry.
    const retry = accountConversation([
      tree('h1', ROOT_PARENT, 'user', 0, [text(100)], 50_000),
      tree('a1', 'h1', 'assistant', 5, []),
      tree('a1b', 'h1', 'assistant', 30, [text(400)]),
    ]);
    expect(retry[1]).toMatchObject({ requestCount: 0, replayBase: 0 });
    expect(retry[2]).toMatchObject({ requestCount: 1, replayBase: 0, outputBase: 400 });
    expect(sum(retry)).toMatchObject({ input: 50_100, output: 400, replay: 0, requests: 1 });

    // The same when the user wrote a follow-up instead ...
    const followUp = accountConversation([
      tree('h1', ROOT_PARENT, 'user', 0, [text(100)], 50_000),
      tree('a1', 'h1', 'assistant', 5, []),
      tree('h2', 'a1', 'user', 60, [text(20)]),
      tree('a2', 'h2', 'assistant', 70, [text(400)]),
    ]);
    expect(sum(followUp)).toMatchObject({ input: 50_120, output: 400, replay: 0, requests: 1 });

    // ... and when the first prompt has no reply message at all.
    const unanswered = accountConversation([
      tree('h1', ROOT_PARENT, 'user', 0, [text(100)], 50_000),
      tree('h2', 'h1', 'user', 60, [text(20)]),
      tree('a2', 'h2', 'assistant', 70, [text(400)]),
    ]);
    expect(sum(unanswered)).toMatchObject({ input: 50_120, output: 400, replay: 0, requests: 1 });

    // Once a request has carried a prompt, a retry of the same prompt re-reads it, as before.
    const realRetry = accountConversation([
      tree('h1', ROOT_PARENT, 'user', 0, [text(100)]),
      tree('a1', 'h1', 'assistant', 5, [text(40)]),
      tree('a1b', 'h1', 'assistant', 30, [text(400)]),
    ]);
    expect(realRetry[2]).toMatchObject({ requestCount: 1, replayBase: 100 });
    // and the turn after an empty reply still finds the cache of the last real request
    const afterEmpty = accountConversation([
      tree('h1', ROOT_PARENT, 'user', 0, [text(100)]),
      tree('a1', 'h1', 'assistant', 5, [text(40)]),
      tree('h2', 'a1', 'user', 20, [text(7)]),
      tree('a2', 'h2', 'assistant', 25, []),
      tree('h3', 'a2', 'user', 40, [text(9)]),
      tree('a3', 'h3', 'assistant', 45, [text(11)]),
    ]);
    // a3 reads h1 + a1 again (140) and gets h2 and h3 for the first time
    expect(afterEmpty[5]).toMatchObject({ requestCount: 1, replayBase: 140, replayCachedBase: 100 });
    expect(sum(afterEmpty)).toMatchObject({ input: 116, replay: 140, requests: 2 });
  });

  it('models one request per tool round trip inside a reply', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)]),
      m('assistant', 5, [text(4), toolUse(6), toolResult(100), text(7), toolUse(3), toolResult(50), text(9)]),
    ]);
    // request 1: in 10 (new)            out 4+6
    // request 2: in 10+10+100 = 120     new 100, re-read 20 (10 of it cached)   out 7+3
    // request 3: in 120+10+50 = 180     new 50,  re-read 130 (120 cached)       out 9
    expect(rows[1]).toEqual({ inputBase: 150, outputBase: 29, replayBase: 150, replayCachedBase: 130, requestCount: 3, flags: 0 });
  });

  it('re-sends thinking within the same reply but not on later turns', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)]),
      m('assistant', 5, [thinking(40), toolUse(5), toolResult(20), text(6)]),
      m('user', 60, [text(3)]),
      m('assistant', 65, [text(4)]),
    ]);
    // request 2 of the first reply re-reads 10 + 40 + 5 = 55
    expect(rows[1]).toMatchObject({ inputBase: 20, outputBase: 51, replayBase: 55, requestCount: 2 });
    // the next turn re-reads 10 + (5 + 20 + 6) = 41: the 40 units of thinking are gone
    expect(rows[3]).toMatchObject({ outputBase: 4, replayBase: 41 });
  });

  it('limits cache credit after a reply that used thinking', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)]),
      m('assistant', 5, [thinking(40), text(6)]),
      m('user', 60, [text(3)]),
      m('assistant', 65, [text(4)]),
    ]);
    // re-read 10 + 6; the cached prefix only still matches up to where the thinking began (10)
    expect(rows[3]).toMatchObject({ replayBase: 16, replayCachedBase: 10 });
  });

  it('counts attachment text as input and carries it forward', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)], { attachmentBase: 500 }),
      m('assistant', 5, [text(20)]),
      m('user', 30, [text(5)]),
      m('assistant', 35, [text(1)]),
    ]);
    expect(rows[0].inputBase).toBe(510);
    expect(rows[3].replayBase).toBe(530);
  });

  it('follows parent pointers: a retry re-reads the prompt, and only the chosen branch is carried on', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)], { id: 'h1', parentId: ROOT_PARENT }),
      m('assistant', 5, [text(20)], { id: 'a1', parentId: 'h1' }),
      m('assistant', 40, [text(30)], { id: 'a1b', parentId: 'h1' }), // regenerated reply
      m('user', 80, [text(5)], { id: 'h2', parentId: 'a1b' }),
      m('assistant', 85, [text(8)], { id: 'a2', parentId: 'h2' }),
    ]);
    expect(rows[1]).toMatchObject({ outputBase: 20, replayBase: 0 });
    // the retry sends the same prompt again: now it is re-read context, not new input
    expect(rows[2]).toMatchObject({ outputBase: 30, replayBase: 10 });
    // the abandoned first reply (20) is not part of the thread any more: 10 + 30 re-read
    expect(rows[4]).toMatchObject({ outputBase: 8, replayBase: 40 });
    expect(sum(rows)).toMatchObject({ input: 15, output: 58, replay: 50, requests: 3 });
    expect(rows.every((r) => (r.flags & Limitation.BRANCHES_LINEARISED) === 0)).toBe(true);
  });

  it('falls back to the previous message when a parent is missing from the export', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)], { id: 'h1', parentId: ROOT_PARENT }),
      m('assistant', 5, [text(20)], { id: 'a1', parentId: 'h1' }),
      m('user', 60, [text(5)], { id: 'h2', parentId: 'not-in-export' }),
      m('assistant', 65, [text(8)], { id: 'a2', parentId: 'h2' }),
    ]);
    expect(rows[3].replayBase).toBe(30);
  });

  it('survives a cycle in the parent pointers', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)], { id: 'x', parentId: 'y' }),
      m('assistant', 5, [text(20)], { id: 'y', parentId: 'x' }),
    ]);
    expect(sum(rows)).toMatchObject({ input: 10, output: 20, requests: 1 });
  });

  it('without pointers, orders by time and flags conversations that look edited', () => {
    const rows = accountConversation([
      m('assistant', 10, [text(20)]), // listed out of order, as in 2025 exports
      m('user', 0, [text(10)]),
      m('assistant', 30, [text(7)]), // a second reply to the same prompt: a retry we cannot tell apart
    ]);
    expect(rows[0]).toMatchObject({ outputBase: 20, replayBase: 0 });
    expect(rows[2]).toMatchObject({ outputBase: 7, replayBase: 30 });
    expect(rows.every((r) => (r.flags & Limitation.BRANCHES_LINEARISED) !== 0)).toBe(true);
  });

  it('caps re-read context at the context window and says so', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)], { capBase: 100 }),
      m('assistant', 5, [text(200)], { capBase: 100 }),
      m('user', 30, [text(5)], { capBase: 100 }),
      m('assistant', 35, [text(1)], { capBase: 100 }),
    ]);
    expect(rows[3].replayBase).toBe(95);
    expect(rows[3].flags & Limitation.CONTEXT_CAPPED).toBe(Limitation.CONTEXT_CAPPED);
    expect(rows[1].flags & Limitation.CONTEXT_CAPPED).toBe(0);
  });

  it('handles a prompt that never got a reply and a reply with no content', () => {
    const rows = accountConversation([m('user', 0, [text(10)]), m('assistant', 5, []), m('user', 20, [text(4)])]);
    expect(sum(rows)).toEqual({ input: 14, output: 0, replay: 0, cached: 0, requests: 0 });
  });

  it('handles very long conversations without recursion', () => {
    const msgs: AccountMessage[] = [];
    for (let i = 0; i < 20_000; i++) msgs.push(m(i % 2 === 0 ? 'user' : 'assistant', i, [text(1)], { id: `n${i}`, parentId: i === 0 ? ROOT_PARENT : `n${i - 1}` }));
    const rows = accountConversation(msgs);
    // reply k (1-based) re-reads the 2(k-1) units before its prompt
    expect(rows[19_999].replayBase).toBe(19_998);
    expect(sum(rows).requests).toBe(10_000);
  });
});
