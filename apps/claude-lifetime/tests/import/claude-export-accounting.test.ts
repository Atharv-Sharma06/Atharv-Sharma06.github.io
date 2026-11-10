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

  it('uses the end of the previous reply for cache timing when it is known', () => {
    const rows = accountConversation([
      m('user', 0, [text(10)]),
      m('assistant', 10, [text(20)], { endMs: T0 + 500_000 }),
      m('user', 700, [text(5)]),
      m('assistant', 710, [text(8)]),
    ]);
    // 710 s after the start, but only 210 s after the previous reply finished
    expect(rows[3].replayCachedBase).toBe(10);
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
