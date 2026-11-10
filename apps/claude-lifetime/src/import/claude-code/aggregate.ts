import { resolveModel } from '@/core/models';
import { hash64, Sha256 } from '@/core/sha256';
import type { ImportSink, ParseWarning, StagedConversation, StagedModel, StagedUsage } from '@/core/types';
import {
  PromptKind,
  ResponseFlag,
  totalTokens,
  type PromptRecord,
  type ResponseRecord,
  type SessionInfo,
  type TokenCounts,
} from './extract';

/**
 * Turns de-duplicated responses and prompts (from transcripts or from the collector's
 * ledger) into the records the database stores.
 *
 * Two things happen here:
 *  1. Deduplication against earlier imports. Every response, advisor iteration and
 *     prompt has a key; its 64-bit hash is remembered by the import that counted it.
 *     A record whose hash is already known is skipped, so the same usage can arrive
 *     again and again (re-synced files, copies, the ledger after the transcripts)
 *     without being counted twice.
 *  2. Aggregation. The database keeps exact usage per 15-minute UTC bucket, session,
 *     model and price tier, not per request. Rows of a later import are added to the
 *     earlier ones, which is why each import's rows carry a nonce in their key.
 */

export const BUCKET_SECONDS = 900;
const BUCKET_MS = BUCKET_SECONDS * 1000;

/** Claude Haiku 5.5 is priced higher when the prompt is over this many tokens (core/catalog LONG_CONTEXT). */
const HAIKU_55_LONG_CONTEXT_OVER = 100_000;

/**
 * Price tier of one response. Speed and service tier are stated by the API; the
 * long-context tier is not, so it is derived from the size of the prompt
 * (uncached input + cache reads + cache writes).
 */
export function priceTierOf(modelKey: string | null, r: TokenCounts & { flags: number; serviceTier: string | null }): string {
  if ((r.flags & ResponseFlag.FAST) !== 0) return 'fast';
  const tier = r.serviceTier?.toLowerCase() ?? '';
  if (tier === 'batch') return 'batch';
  if (tier.startsWith('priority')) return 'priority';
  if (modelKey === 'claude-haiku-5-5' && r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h > HAIKU_55_LONG_CONTEXT_OVER) {
    return 'long_context';
  }
  return 'standard';
}

export interface UsageInput {
  responses: readonly ResponseRecord[];
  prompts: readonly PromptRecord[];
  sessions: ReadonlyMap<string, SessionInfo>;
}

export interface AggregateOutcome {
  /** Hashes of everything this import counted: responses, advisor iterations and prompts. */
  requestKeys: bigint[];
  /** Records (of the same three kinds) skipped because an earlier import counted them. */
  duplicateRequests: number;
  warnings: ParseWarning[];
  missingFields: string[];
  stats: Record<string, number | string | boolean>;
}

interface Bucket extends TokenCounts {
  sessionId: string;
  modelKey: string | null;
  tier: string;
  start: number;
  requests: number;
  userMessages: number;
  assistantMessages: number;
  webSearch: number;
}

interface SessionTotals {
  /** Tokens per model and tier over everything in the input, counted before or not. */
  tokens: Map<string, { modelKey: string | null; tier: string; tokens: number }>;
  /** Activity range of what this import counts. */
  first: number;
  last: number;
  counted: boolean;
}

/** `:` separates the parts of a dedup key, so it must not appear inside one. */
const keyPart = (s: string) => s.replace(/[%:]/g, (c) => (c === '%' ? '%25' : '%3A'));

class Models {
  private readonly byRaw = new Map<string, string>();
  /** Identifiers the built-in catalog does not know, by canonical key. */
  readonly unknown = new Map<string, StagedModel>();

  keyOf(raw: string | null): string | null {
    if (raw === null) return null;
    const hit = this.byRaw.get(raw);
    if (hit !== undefined) return hit === '' ? null : hit;
    const resolved = resolveModel(raw);
    this.byRaw.set(raw, resolved?.key ?? '');
    if (resolved && !resolved.known && !this.unknown.has(resolved.key)) {
      this.unknown.set(resolved.key, {
        key: resolved.key,
        displayName: resolved.model.displayName,
        family: resolved.model.family,
        tokenizerFamily: resolved.model.tokenizer,
      });
    }
    return resolved?.key ?? null;
  }
}

/** Counts records by warning code and keeps one identifier as an example. */
class Tally {
  private readonly counts = new Map<string, { n: number; sample: string }>();
  add(code: string, sample: string, n = 1): void {
    const entry = this.counts.get(code);
    if (entry === undefined) this.counts.set(code, { n, sample });
    else entry.n += n;
  }
  get(code: string): { n: number; sample: string } | undefined {
    return this.counts.get(code);
  }
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const wait = async (result: void | Promise<void>) => {
  if (result) await result;
};

const compareBigInt = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** First 12 hex characters of the SHA-256 of the sorted hashes: the same input always yields the same nonce. */
function nonceOf(sorted: readonly bigint[]): string {
  const hash = new Sha256();
  const encoder = new TextEncoder();
  for (let i = 0; i < sorted.length; i += 512) hash.update(encoder.encode(`${sorted.slice(i, i + 512).join('\n')}\n`));
  return hash.hex().slice(0, 12);
}

export async function aggregateUsage(
  input: UsageInput,
  sink: ImportSink,
  knownRequestKeys?: ReadonlySet<bigint>,
): Promise<AggregateOutcome> {
  const models = new Models();
  const counted = new Set<bigint>();
  const buckets = new Map<string, Bucket>();
  const sessions = new Map<string, SessionTotals>();
  const tally = new Tally();
  const iterationTypes = new Map<string, number>();
  const usedModels = new Set<string>();

  const stats = {
    responses: input.responses.length,
    newResponses: 0,
    duplicateResponses: 0,
    subagentResponses: 0,
    newSubagentResponses: 0,
    humanPrompts: input.prompts.length,
    newHumanPrompts: 0,
    duplicateHumanPrompts: 0,
    newTypedPrompts: 0,
    newSlashCommands: 0,
    newShellCommands: 0,
    advisorRecords: 0,
    newAdvisorRecords: 0,
    duplicateAdvisorRecords: 0,
    iterationsNotCounted: 0,
    partialResponses: 0,
    cacheTtlUnknownRequests: 0,
    responsesWithoutModel: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    thinkingTokens: 0,
    webSearchRequests: 0,
  };

  /** A record is new when no earlier import, and nothing earlier in this one, has its hash. */
  const claim = (key: string): boolean => {
    const hash = hash64(key);
    if (knownRequestKeys?.has(hash) || counted.has(hash)) return false;
    counted.add(hash);
    return true;
  };

  const sessionOf = (id: string): SessionTotals => {
    let s = sessions.get(id);
    if (s === undefined) {
      s = { tokens: new Map(), first: Infinity, last: -Infinity, counted: false };
      sessions.set(id, s);
    }
    return s;
  };
  const weigh = (s: SessionTotals, modelKey: string | null, tier: string, tokens: number) => {
    const key = `${modelKey ?? ''}\n${tier}`;
    const entry = s.tokens.get(key);
    if (entry === undefined) s.tokens.set(key, { modelKey, tier, tokens });
    else entry.tokens += tokens;
  };
  const touch = (s: SessionTotals, first: number, last: number) => {
    s.counted = true;
    if (first < s.first) s.first = first;
    if (last > s.last) s.last = last;
  };
  const bucketFor = (sessionId: string, modelKey: string | null, tier: string, ts: number): Bucket => {
    const start = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    const key = `${sessionId}\n${modelKey ?? ''}\n${tier}\n${start}`;
    let b = buckets.get(key);
    if (b === undefined) {
      b = {
        sessionId, modelKey, tier, start,
        input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
        requests: 0, userMessages: 0, assistantMessages: 0, webSearch: 0,
      };
      buckets.set(key, b);
      if (modelKey !== null) usedModels.add(modelKey);
    }
    return b;
  };
  const addTokens = (b: Bucket, t: TokenCounts) => {
    b.input += t.input;
    b.output += t.output;
    b.cacheRead += t.cacheRead;
    b.cacheWrite5m += t.cacheWrite5m;
    b.cacheWrite1h += t.cacheWrite1h;
    stats.inputTokens += t.input;
    stats.outputTokens += t.output;
    stats.cacheReadTokens += t.cacheRead;
    stats.cacheWrite5mTokens += t.cacheWrite5m;
    stats.cacheWrite1hTokens += t.cacheWrite1h;
  };

  // Model and tier of every response, kept for attributing prompts afterwards.
  const modelOf: Array<string | null> = new Array(input.responses.length);
  const tierOf: string[] = new Array(input.responses.length);

  input.responses.forEach((r, i) => {
    const modelKey = models.keyOf(r.model);
    const tier = priceTierOf(modelKey, r);
    modelOf[i] = modelKey;
    tierOf[i] = tier;
    const sidechain = (r.flags & ResponseFlag.SIDECHAIN) !== 0;
    const session = sessionOf(r.sessionId);
    weigh(session, modelKey, tier, totalTokens(r));
    if (sidechain) stats.subagentResponses++;

    const isNew = claim(r.key);
    if (isNew) {
      const b = bucketFor(r.sessionId, modelKey, tier, r.ts);
      addTokens(b, r);
      b.requests++;
      b.webSearch += r.webSearch;
      // A turn ends with a main-thread response that does not hand over to a tool.
      if (!sidechain && (r.flags & ResponseFlag.TOOL_USE) === 0) b.assistantMessages++;
      touch(session, r.ts, r.lastTs);
      stats.newResponses++;
      stats.thinkingTokens += r.thinking;
      stats.webSearchRequests += r.webSearch;
      if (sidechain) stats.newSubagentResponses++;
      if (modelKey === null) stats.responsesWithoutModel++;
      if ((r.flags & ResponseFlag.PARTIAL) !== 0) tally.add('partial_usage', r.key);
      if ((r.flags & ResponseFlag.CACHE_TTL_UNKNOWN) !== 0) tally.add('cache_ttl_unknown', r.key);
      if ((r.flags & ResponseFlag.NO_REQUEST_ID) !== 0) tally.add('missing_request_id', r.key);
      if ((r.flags & ResponseFlag.NO_MESSAGE_ID) !== 0) tally.add('missing_message_id', r.key);
      if ((r.flags & ResponseFlag.TIMESTAMP_INFERRED) !== 0) tally.add('timestamp_inferred', r.key);
      if ((r.flags & ResponseFlag.UNMETERED) !== 0) tally.add('unmetered_responses', r.key);
      if ((r.flags & ResponseFlag.VIRTUAL) !== 0) tally.add('virtual_responses', r.key);
      if ((r.flags & ResponseFlag.MESSAGE_ID_REUSED) !== 0) tally.add('message_id_reused', r.key);
    } else stats.duplicateResponses++;

    for (const it of r.extras ?? []) {
      // The advisor tool runs a second model inside the same API request. Its tokens are
      // billed at that model's price and are not part of the top-level counters, so each
      // advisor iteration is a record of its own (tokens only: it is not another request).
      if (it.type === 'advisor_message' && it.model !== null) {
        const advisorModel = models.keyOf(it.model);
        const advisorTier = priceTierOf(advisorModel, { ...it, flags: 0, serviceTier: null });
        weigh(session, advisorModel, advisorTier, totalTokens(it));
        stats.advisorRecords++;
        if (claim(`${r.key}:advisor:${it.index}`)) {
          addTokens(bucketFor(r.sessionId, advisorModel, advisorTier, r.ts), it);
          touch(session, r.ts, r.lastTs);
          stats.newAdvisorRecords++;
          if (it.cacheTtlUnknown) tally.add('cache_ttl_unknown', r.key);
        } else stats.duplicateAdvisorRecords++;
      } else if (isNew) {
        // fallback_message, compaction and anything unknown: whether and how these add to
        // the bill is unverified, so they are reported instead of counted.
        stats.iterationsNotCounted++;
        tally.add('iterations_not_counted', r.key);
        iterationTypes.set(it.type, (iterationTypes.get(it.type) ?? 0) + 1);
      }
    }
  });

  /**
   * The model that processed the most tokens in a session, and the tier it mostly ran
   * at. Responses that name no model only decide when no response names one: "unknown"
   * is not a useful label for a session that did say which models it used.
   */
  const dominant = (s: SessionTotals): { modelKey: string | null; tier: string } | null => {
    if (s.tokens.size === 0) return null;
    const perModel = new Map<string, number>();
    for (const e of s.tokens.values()) {
      if (e.modelKey !== null) perModel.set(e.modelKey, (perModel.get(e.modelKey) ?? 0) + e.tokens);
    }
    let best: string | null = null;
    let bestTokens = -1;
    for (const [modelKey, tokens] of perModel) {
      // Ties go to the alphabetically first model, so the result does not depend on input order.
      if (tokens > bestTokens || (tokens === bestTokens && best !== null && modelKey < best)) {
        best = modelKey;
        bestTokens = tokens;
      }
    }
    let tier = 'standard';
    let tierTokens = -1;
    for (const e of s.tokens.values()) {
      if (e.modelKey === best && (e.tokens > tierTokens || (e.tokens === tierTokens && e.tier < tier))) {
        tier = e.tier;
        tierTokens = e.tokens;
      }
    }
    return { modelKey: best, tier };
  };

  // Prompts carry no model. Each is attributed to the first main-thread response of its
  // session at or after it (the answer), else to the session's dominant model.
  const newPrompts = input.prompts.filter((p) => {
    if (claim(p.key)) return true;
    stats.duplicateHumanPrompts++;
    return false;
  });
  if (newPrompts.length > 0) {
    const wanted = new Set(newPrompts.map((p) => p.sessionId));
    const timelines = new Map<string, number[]>();
    input.responses.forEach((r, i) => {
      if ((r.flags & ResponseFlag.SIDECHAIN) !== 0 || !wanted.has(r.sessionId)) return;
      const line = timelines.get(r.sessionId);
      if (line === undefined) timelines.set(r.sessionId, [i]);
      else line.push(i);
    });
    for (const line of timelines.values()) line.sort((a, b) => input.responses[a].ts - input.responses[b].ts || a - b);

    for (const p of newPrompts) {
      const line = timelines.get(p.sessionId) ?? [];
      let lo = 0;
      let hi = line.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (input.responses[line[mid]].ts < p.ts) lo = mid + 1;
        else hi = mid;
      }
      const session = sessionOf(p.sessionId);
      const target =
        lo < line.length ? { modelKey: modelOf[line[lo]], tier: tierOf[line[lo]] } : (dominant(session) ?? { modelKey: null, tier: 'standard' });
      bucketFor(p.sessionId, target.modelKey, target.tier, p.ts).userMessages++;
      touch(session, p.ts, p.ts);
      stats.newHumanPrompts++;
      if (p.kind === PromptKind.COMMAND) stats.newSlashCommands++;
      else if (p.kind === PromptKind.SHELL) stats.newShellCommands++;
      else stats.newTypedPrompts++;
    }
  }

  const requestKeys = [...counted].sort(compareBigInt);
  const nonce = requestKeys.length > 0 ? nonceOf(requestKeys) : '';

  // ── Emit: models the catalog does not know, then conversations, then usage rows ──
  const conversations: StagedConversation[] = [];
  for (const [id, s] of sessions) {
    if (!s.counted) continue;
    const info = input.sessions.get(id);
    const modelKey = dominant(s)?.modelKey ?? null;
    if (modelKey !== null) usedModels.add(modelKey);
    const metadata: Record<string, unknown> = {};
    if (info?.gitBranch) metadata.gitBranch = info.gitBranch;
    if (info?.version) metadata.version = info.version;
    // Only ever set to true: metadata of later imports is merged over earlier ones, and
    // an import that happens to see no subagent rows must not erase the fact.
    if (info?.hasSubagents) metadata.hasSubagents = true;
    conversations.push({
      dedupKey: `claude_code:${id}`,
      kind: 'code_session',
      externalId: id,
      title: info?.title ?? null,
      projectLabel: info?.cwd ?? null,
      modelKey,
      createdAt: new Date(s.first).toISOString(),
      updatedAt: new Date(s.last).toISOString(),
      metadata,
    });
  }
  conversations.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));

  let unknownModels = 0;
  for (const [key, model] of models.unknown) {
    if (!usedModels.has(key)) continue;
    unknownModels++;
    await wait(sink.model(model));
  }
  for (const c of conversations) await wait(sink.conversation(c));

  const rows = [...buckets.values()].sort(
    (a, b) =>
      a.start - b.start ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) ||
      ((a.modelKey ?? '') < (b.modelKey ?? '') ? -1 : (a.modelKey ?? '') > (b.modelKey ?? '') ? 1 : 0) ||
      (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0),
  );
  let first = Infinity;
  let last = -Infinity;
  for (const b of rows) {
    const modelPart = b.modelKey === null ? '-' : b.modelKey === '-' ? '%2D' : keyPart(b.modelKey);
    const usage: StagedUsage = {
      conversationKey: `claude_code:${b.sessionId}`,
      modelKey: b.modelKey,
      occurredAt: new Date(b.start).toISOString(),
      bucketSeconds: BUCKET_SECONDS,
      priceTier: b.tier,
      inputTokens: b.input,
      outputTokens: b.output,
      cacheReadTokens: b.cacheRead,
      cacheWrite5mTokens: b.cacheWrite5m,
      cacheWrite1hTokens: b.cacheWrite1h,
      requestCount: b.requests,
      userMessageCount: b.userMessages,
      assistantMessageCount: b.assistantMessages,
      webSearchRequests: b.webSearch,
      confidence: 'exact',
      // Unique per import: rows of later imports add to the earlier rows of the same bucket.
      dedupKey: `cc:${keyPart(b.sessionId)}:${modelPart}:${b.tier}:${b.start / 1000}:${nonce}`,
    };
    await wait(sink.usage(usage));
  }
  for (const s of sessions.values()) {
    if (!s.counted) continue;
    if (s.first < first) first = s.first;
    if (s.last > last) last = s.last;
  }

  // ── Warnings ──
  const warnings: ParseWarning[] = [];
  const missingFields: string[] = [];
  const warn = (code: string, message: (n: number) => string) => {
    const hit = tally.get(code);
    if (hit) warnings.push({ code, message: message(hit.n), count: hit.n, sample: hit.sample });
    return hit !== undefined;
  };
  warn(
    'partial_usage',
    (n) =>
      `${plural(n, 'response was', 'responses were')} only recorded as an unfinished streaming snapshot (stop_reason is null). ` +
      'Input and cache counts are reliable, but output tokens may be undercounted; the final count was never written to the transcript and cannot be recovered.',
  );
  if (
    warn(
      'cache_ttl_unknown',
      (n) =>
        `${plural(n, 'response does', 'responses do')} not say whether cache writes were 5-minute or 1-hour writes. ` +
        'They are counted as 5-minute writes, the cheaper kind, so their estimated cost may be too low.',
    )
  ) {
    missingFields.push('cache_creation');
  }
  if (
    warn(
      'missing_request_id',
      (n) =>
        `${plural(n, 'response has', 'responses have')} no requestId (usual behind gateways and proxies). ` +
        'They are recognised by session and message id instead; a copy of such a row in a different session would be counted again.',
    )
  ) {
    missingFields.push('requestId');
  }
  if (
    warn(
      'missing_message_id',
      (n) =>
        `${plural(n, 'response has', 'responses have')} no message id. Each row is counted on its own, ` +
        'so a response that was written as several lines may be counted more than once.',
    )
  ) {
    missingFields.push('message.id');
  }
  if (
    warn(
      'timestamp_inferred',
      (n) => `${plural(n, 'response has', 'responses have')} no usable timestamp; the nearest timestamp in the same file was used.`,
    )
  ) {
    missingFields.push('timestamp');
  }
  if (stats.iterationsNotCounted > 0) {
    const types = [...iterationTypes.entries()].map(([type, n]) => `${type}: ${n}`).join(', ');
    warnings.push({
      code: 'iterations_not_counted',
      message:
        `${plural(stats.iterationsNotCounted, 'extra attempt', 'extra attempts')} listed under usage.iterations ` +
        `(${types}) ${stats.iterationsNotCounted === 1 ? 'was' : 'were'} not added to the totals, because how Claude Code ` +
        'records these is unverified. Usage for the affected responses may be undercounted.',
      count: stats.iterationsNotCounted,
      sample: tally.get('iterations_not_counted')?.sample,
    });
  }
  warn(
    'message_id_reused',
    (n) =>
      `${plural(n, 'response shares', 'responses share')} a message id with another request in the same session. ` +
      'Each request was counted; if these are copies rather than separate requests, they are counted twice.',
  );
  warn(
    'unmetered_responses',
    (n) => `${plural(n, 'response is', 'responses are')} marked isUnmetered by Claude Code. They are counted, but may not have been billed.`,
  );
  warn(
    'virtual_responses',
    (n) => `${plural(n, 'response is', 'responses are')} marked isVirtual by Claude Code. They are counted, but may not correspond to a billed request.`,
  );
  if (stats.responsesWithoutModel > 0) missingFields.push('message.model');

  stats.partialResponses = tally.get('partial_usage')?.n ?? 0;
  stats.cacheTtlUnknownRequests = tally.get('cache_ttl_unknown')?.n ?? 0;

  return {
    requestKeys,
    duplicateRequests: stats.duplicateResponses + stats.duplicateAdvisorRecords + stats.duplicateHumanPrompts,
    warnings,
    missingFields,
    stats: {
      ...stats,
      sessions: conversations.length,
      usageBuckets: rows.length,
      unknownModels,
      firstTimestamp: Number.isFinite(first) ? new Date(first).toISOString() : '',
      lastTimestamp: Number.isFinite(last) ? new Date(last).toISOString() : '',
    },
  };
}
