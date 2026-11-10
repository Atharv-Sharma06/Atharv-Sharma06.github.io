import { CACHE_TTL_SECONDS } from '@/core/catalog';
import { Limitation } from '@/core/limitations';

/**
 * Token accounting for one exported conversation.
 *
 * An export only contains the text of each message. To say how many tokens the
 * model *processed*, the requests that produced those messages have to be
 * reconstructed:
 *
 *  - Every assistant message needed at least one model request. Each request's input
 *    is the whole conversation so far; its output is what the model wrote.
 *  - When the model calls a tool, the tool result goes back in and another request
 *    follows, re-reading everything again. An assistant message with n tool round
 *    trips therefore stands for n + 1 requests.
 *
 * For each message this module reports, in base units (see core/tokens):
 *    input   new content given to the model: the user's text and attachments, and
 *            tool results
 *    output  what the model generated: reply text, visible thinking, tool calls
 *    replay  context that had already been sent before and was sent again
 *            (replayCached: the part a 5-minute prompt cache could have served)
 * so that input + output is "new" content, counted once, and input + output + replay
 * is everything the model processed — the quantity the API meters.
 *
 * What cannot be reconstructed is documented per message with limitation flags:
 * the system prompt and tool definitions, images and other binary files, thinking
 * that was summarised, and — for exports without parent pointers — which messages
 * belong to an abandoned edit or retry.
 */

export type BlockKind = 'text' | 'thinking' | 'tool_use' | 'tool_result';

export interface AccountBlock {
  kind: BlockKind;
  /** Size in base units. */
  base: number;
}

export interface AccountMessage {
  id: string;
  /** Parent message id when the export has parent pointers, else undefined. */
  parentId?: string | null;
  role: 'user' | 'assistant' | 'other';
  /** Epoch milliseconds used for ordering and cache timing. */
  timeMs: number;
  /** When the model finished this message, if known (last block's stop time). */
  endMs?: number;
  blocks: AccountBlock[];
  /** Extracted text of attachments, in base units (user messages). */
  attachmentBase: number;
  /** Context window that applies to requests for this message, in base units. */
  capBase: number;
}

export interface AccountResult {
  inputBase: number;
  outputBase: number;
  replayBase: number;
  replayCachedBase: number;
  requestCount: number;
  /** Limitation flags this module can determine (context cap, linearised branches). */
  flags: number;
}

/** First message of a thread points at this id in exports that carry parent pointers. */
export const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

interface Node {
  msg: AccountMessage;
  index: number;
  parent: Node | null;
  /** Context a later request re-reads because of this message (thinking is not re-sent on later turns). */
  carry: number;
  /** Sum of carry over all ancestors: the context that existed before this message. */
  ctxBefore: number;
  resolved: boolean;
  /** For a user message: an assistant child has already consumed it as new input. */
  answered: boolean;
  /** For an assistant message: input size and time of its last request (cache model). */
  lastRequestInput: number;
  lastRequestMs: number;
  /**
   * For an assistant message: how much of the context a request on the NEXT turn could
   * still read from the cache. Thinking is dropped from context when a new user message
   * arrives, which changes everything after the point where the thinking started.
   */
  cachedForNextTurn: number;
}

export function accountConversation(messages: AccountMessage[]): AccountResult[] {
  const hasPointers = messages.some((m) => m.parentId !== undefined && m.parentId !== null);
  const nodes: Node[] = messages.map((msg, index) => ({
    msg,
    index,
    parent: null,
    carry: 0,
    ctxBefore: 0,
    resolved: false,
    answered: false,
    lastRequestInput: 0,
    lastRequestMs: 0,
    cachedForNextTurn: 0,
  }));

  // ── 1. who follows whom ────────────────────────────────────────────────────
  let order: Node[];
  let linearised = false;
  if (hasPointers) {
    const byId = new Map<string, Node>();
    for (const n of nodes) byId.set(n.msg.id, n);
    for (const n of nodes) {
      const pid = n.msg.parentId;
      if (pid === undefined || pid === null || pid === ROOT_PARENT) continue;
      const parent = byId.get(pid);
      // A parent that is missing from the export: fall back to the message listed just before.
      n.parent = parent && parent !== n ? parent : n.index > 0 ? nodes[n.index - 1] : null;
    }
    order = nodes;
  } else {
    // No tree information: treat the conversation as one thread in time order.
    order = [...nodes].sort((a, b) => a.msg.timeMs - b.msg.timeMs || a.index - b.index);
    for (let i = 1; i < order.length; i++) order[i].parent = order[i - 1];
    // Two user messages or two assistant messages in a row suggest an edit or a retry
    // whose abandoned branch cannot be told apart.
    for (let i = 1; i < order.length; i++) {
      if (order[i].msg.role === order[i - 1].msg.role && order[i].msg.role !== 'other') {
        linearised = true;
        break;
      }
    }
  }

  // ── 2. carry and context before each message (parents first, no recursion) ──
  for (const n of nodes) {
    let carry = n.msg.attachmentBase;
    for (const b of n.msg.blocks) if (b.kind !== 'thinking') carry += b.base;
    n.carry = carry;
  }
  for (const start of nodes) {
    if (start.resolved) continue;
    const chain: Node[] = [];
    let cur: Node | null = start;
    const guard = new Set<Node>();
    while (cur && !cur.resolved && !guard.has(cur)) {
      guard.add(cur);
      chain.push(cur);
      cur = cur.parent;
    }
    if (cur && !cur.resolved) cur = null; // a cycle in the pointers: treat the repeated node as a root
    for (let i = chain.length - 1; i >= 0; i--) {
      const n = chain[i];
      const p = i === chain.length - 1 ? cur : chain[i + 1];
      if (p === null) n.parent = null;
      n.ctxBefore = p ? p.ctxBefore + p.carry : 0;
      n.resolved = true;
    }
  }

  // ── 3. requests ────────────────────────────────────────────────────────────
  const results: AccountResult[] = nodes.map(() => ({
    inputBase: 0,
    outputBase: 0,
    replayBase: 0,
    replayCachedBase: 0,
    requestCount: 0,
    flags: linearised ? Limitation.BRANCHES_LINEARISED : 0,
  }));
  const ttlMs = CACHE_TTL_SECONDS * 1000;

  // Messages are visited in time order so "the previous request" is well defined.
  const visit = hasPointers ? [...nodes].sort((a, b) => a.msg.timeMs - b.msg.timeMs || a.index - b.index) : order;
  for (const n of visit) {
    const r = results[n.index];
    const m = n.msg;

    if (m.role !== 'assistant') {
      // New input, counted once here. The request it triggers belongs to the reply.
      let input = m.attachmentBase;
      for (const b of m.blocks) input += b.base;
      r.inputBase = input;
      continue;
    }

    // The nearest earlier assistant message on this thread gives the previous request.
    let prev: Node | null = n.parent;
    while (prev && prev.msg.role !== 'assistant') prev = prev.parent;

    // The user message being answered is new input for the first request, unless an
    // earlier reply (a retry sibling) already consumed it: then it is re-sent context.
    let pendingNewInput = 0;
    const parent = n.parent;
    if (parent && parent.msg.role !== 'assistant' && !parent.answered) {
      pendingNewInput = parent.carry;
      parent.answered = true;
    }

    let turn = 0; // context added by this message so far, including its own thinking
    let requestOpen = false;
    let previousInput = prev ? prev.cachedForNextTurn : 0;
    let previousWithinTtl = prev !== null && m.timeMs - prev.lastRequestMs <= ttlMs;

    const openRequest = () => {
      const totalInput = n.ctxBefore + turn;
      let replay = totalInput - pendingNewInput;
      if (totalInput > m.capBase) {
        replay = Math.max(0, m.capBase - pendingNewInput);
        r.flags |= Limitation.CONTEXT_CAPPED;
      }
      r.replayBase += replay;
      if (previousWithinTtl) r.replayCachedBase += Math.min(replay, previousInput);
      r.requestCount += 1;
      previousInput = Math.min(totalInput, m.capBase);
      previousWithinTtl = true; // later requests of the same message follow within seconds
      pendingNewInput = 0;
      requestOpen = true;
    };

    for (const b of m.blocks) {
      if (b.kind === 'tool_result') {
        // Fed back to the model: new input, and the request that was running is over.
        r.inputBase += b.base;
        pendingNewInput += b.base;
        turn += b.base;
        requestOpen = false;
        continue;
      }
      if (!requestOpen) openRequest();
      r.outputBase += b.base;
      turn += b.base;
    }
    n.lastRequestInput = previousInput;
    n.lastRequestMs = m.endMs ?? m.timeMs;
    const thought = m.blocks.some((b) => b.kind === 'thinking');
    n.cachedForNextTurn = thought ? Math.min(n.ctxBefore, m.capBase, previousInput) : previousInput;
    if (r.requestCount === 0 && prev) {
      // Nothing was generated (an empty or interrupted reply): keep the thread's cache state.
      n.lastRequestInput = prev.lastRequestInput;
      n.lastRequestMs = prev.lastRequestMs;
      n.cachedForNextTurn = prev.cachedForNextTurn;
    }
  }

  return results;
}
