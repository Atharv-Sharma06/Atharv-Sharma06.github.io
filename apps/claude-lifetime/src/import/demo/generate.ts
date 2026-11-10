import { DEFAULT_CONTEXT_WINDOW, METHODS, methodKeyFor, MODELS, PRICES, type ModelFamily } from '@/core/catalog';
import { Decimal } from '@/core/decimal';
import { Limitation } from '@/core/limitations';
import type { ImportSink, ParsedImport, StagedMessage, StagedUsage } from '@/core/types';
import { accountConversation, ROOT_PARENT, type AccountBlock, type AccountMessage } from '../claude-export/accounting';
import { basisForDate } from '../claude-export/parser';

/**
 * The synthetic demo dataset.
 *
 * Everything produced here is invented by a seeded random generator so the app can be
 * explored before any real data is imported. Nothing is derived from a real account.
 * Every source it creates is flagged `isSynthetic`, the dashboard shows a banner while
 * it is loaded, and it is removed automatically when real data is imported.
 *
 * It follows one made-up person over about thirty months: light chat use on the free
 * plan, a Pro subscription, Claude Code from the second year, some API usage, and a
 * move to Max. Chat conversations go through the same accounting model as a real
 * claude.ai export, so estimated and exact usage behave as they do with real imports.
 */
export const DEMO_PARSER_VERSION = 'demo-1';
const DAY = 86_400_000;

export interface DemoPart {
  parsed: ParsedImport;
  write(sink: ImportSink): Promise<void>;
}

export interface DemoPeriod {
  planKey: string;
  /** Inclusive calendar days. `lastDate` null = still active. */
  startDate: string;
  lastDate: string | null;
  monthlyPrice: string;
}

export interface DemoDataset {
  parts: DemoPart[];
  periods: DemoPeriod[];
}

/** Small, fast, seedable generator (mulberry32). */
function createRandom(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const api = {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    /** Log-normal around a median; `spread` is the standard deviation of the logarithm. */
    logNormal: (median: number, spread: number) => {
      const u = Math.max(next(), 1e-9);
      const v = next();
      return median * Math.exp(spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    },
    poisson: (mean: number) => {
      if (mean <= 0) return 0;
      const limit = Math.exp(-mean);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= next();
      } while (p > limit);
      return k - 1;
    },
  };
  return api;
}

const iso = (ms: number) => new Date(ms).toISOString();
const dayOf = (ms: number) => iso(ms).slice(0, 10);

const TOPICS = [
  'the billing module', 'a trip to Lisbon', 'Bayes’ theorem', 'my cover letter', 'a sourdough schedule', 'the quarterly report',
  'a Rust borrow checker error', 'the onboarding email', 'a SQL window function', 'the reading list', 'a product launch plan',
  'the React state bug', 'a budget spreadsheet', 'a wedding toast', 'the API rate limiter', 'a study plan for statistics',
  'the lease agreement', 'a cron expression', 'the conference talk', 'a Dockerfile', 'a short story draft', 'the interview questions',
  'a regex for log lines', 'the garden layout', 'a migration to PostgreSQL', 'the team retro notes', 'a recipe for ramen',
  'the pricing page copy', 'a Kubernetes manifest', 'the marathon training plan', 'a linear algebra proof', 'the newsletter intro',
];
const VERBS = ['Help with', 'Rewrite', 'Explain', 'Review', 'Plan', 'Debug', 'Summarise', 'Brainstorm', 'Outline', 'Improve', 'Compare options for', 'Draft'];
const PROJECTS = ['storefront-web', 'ledger-service', 'mobile-app', 'data-pipeline', 'docs-site', 'infra'];

interface Phase {
  plan: 'free' | 'pro' | 'max_5x';
  chatsPerDay: number;
  codeSessionsPerWeekday: number;
}

function newestModel(family: ModelFamily, day: string): string | null {
  let best: { key: string; releasedOn: string } | null = null;
  for (const m of MODELS) {
    if (m.family !== family || !m.releasedOn || m.releasedOn > day) continue;
    if (m.retiredOn && m.retiredOn <= day) continue;
    if (!best || m.releasedOn > best.releasedOn) best = { key: m.key, releasedOn: m.releasedOn };
  }
  return best?.key ?? null;
}

function standardPrice(model: string, day: string) {
  return PRICES.find(
    (p) => p.model === model && p.tier === 'standard' && (!p.effectiveFrom || p.effectiveFrom <= day) && (!p.effectiveTo || day < p.effectiveTo),
  );
}

export function buildDemoDataset(now: Date = new Date(), seed = 20261110): DemoDataset {
  const rnd = createRandom(seed);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const totalDays = 912;
  const start = end - totalDays * DAY;

  const proFrom = start + 243 * DAY;
  const codeFrom = start + 365 * DAY;
  const apiFrom = start + 420 * DAY;
  const apiTo = start + 600 * DAY;
  const maxFrom = start + 578 * DAY;
  // Three weeks away from the keyboard: shows up as a gap in coverage.
  const awayFrom = start + 505 * DAY;
  const awayTo = awayFrom + 20 * DAY;

  const phaseAt = (ms: number): Phase =>
    ms < proFrom
      ? { plan: 'free', chatsPerDay: 0.45, codeSessionsPerWeekday: 0 }
      : ms < maxFrom
        ? { plan: 'pro', chatsPerDay: 1.25, codeSessionsPerWeekday: ms >= codeFrom ? 0.9 : 0 }
        : { plan: 'max_5x', chatsPerDay: 1.5, codeSessionsPerWeekday: 2.3 };

  const periods: DemoPeriod[] = [
    { planKey: 'free', startDate: dayOf(start), lastDate: dayOf(proFrom - DAY), monthlyPrice: '0' },
    { planKey: 'pro', startDate: dayOf(proFrom), lastDate: dayOf(maxFrom - DAY), monthlyPrice: '20' },
    { planKey: 'max_5x', startDate: dayOf(maxFrom), lastDate: null, monthlyPrice: '100' },
  ];

  const factorOf = new Map(METHODS.map((m) => [m.basis, Number(m.centralFactor)]));
  const HOURS = [8, 9, 9, 10, 10, 11, 12, 13, 14, 14, 15, 16, 16, 17, 19, 20, 20, 21, 21, 22, 23];
  const nowMs = now.getTime();

  // ── claude.ai export: chat conversations, estimated ─────────────────────────────
  const chat: DemoPart = {
    parsed: {
      format: 'demo/claude-export',
      formatLabel: 'Synthetic demo data (chat conversations)',
      parserVersion: DEMO_PARSER_VERSION,
      source: { kind: 'claude_export', label: 'Demo: claude.ai export', externalRef: 'demo', isSynthetic: true },
      fileName: 'synthetic-demo-conversations',
      fileSize: 0,
      contentHash: null,
      recordsSeen: 0,
      recordsSkipped: 0,
      missingFields: ['model', 'token counts'],
      warnings: [],
      stats: { synthetic: true },
    },
    async write(sink) {
      let serial = 0;
      for (let d = 0; d < totalDays; d++) {
        const dayStart = start + d * DAY;
        if (dayStart >= awayFrom && dayStart < awayTo) continue;
        const phase = phaseAt(dayStart);
        const weekend = [0, 6].includes(new Date(dayStart).getUTCDay());
        const count = rnd.poisson(phase.chatsPerDay * (weekend ? 0.6 : 1.15));
        for (let c = 0; c < count; c++) {
          serial++;
          const id = `demo-chat-${String(serial).padStart(5, '0')}`;
          let t = dayStart + rnd.pick(HOURS) * 3_600_000 + rnd.int(0, 59) * 60_000 + rnd.int(0, 59) * 1000;
          if (t > nowMs) continue;
          const basis = basisForDate(t);
          const capBase = Math.floor(DEFAULT_CONTEXT_WINDOW / (factorOf.get(basis) ?? 1));
          const turns = Math.min(40, 1 + Math.floor(rnd.logNormal(3.2, 0.9)));
          const thinkingAvailable = dayOf(t) >= '2025-02-24';
          const toolsAvailable = dayOf(t) >= '2024-11-01';

          const account: AccountMessage[] = [];
          const shape: Array<Pick<StagedMessage, 'role' | 'textChars' | 'thinkingChars' | 'toolChars' | 'attachmentChars' | 'attachmentCount' | 'fileCount'>> = [];
          for (let turn = 0; turn < turns; turn++) {
            const userText = Math.round(rnd.logNormal(70, 1.0)) + 4;
            const attachment = rnd.chance(0.07) ? Math.round(rnd.logNormal(4500, 0.8)) : 0;
            const image = rnd.chance(0.04);
            // The demo stands for a current export, which records what each message answers.
            account.push({
              id: `${id}-m${account.length}`,
              parentId: account.length > 0 ? account[account.length - 1].id : ROOT_PARENT,
              role: 'user',
              timeMs: t,
              blocks: [{ kind: 'text', base: userText }],
              attachmentBase: attachment,
              capBase,
            });
            shape.push({
              role: 'user',
              textChars: Math.round(userText * 4.4),
              thinkingChars: 0,
              toolChars: 0,
              attachmentChars: Math.round(attachment * 4.2),
              attachmentCount: attachment > 0 ? 1 : 0,
              fileCount: image ? 1 : 0,
            });

            t += rnd.int(4, 40) * 1000;
            const blocks: AccountBlock[] = [];
            let thinkingBase = 0;
            let toolBase = 0;
            if (thinkingAvailable && rnd.chance(0.28)) {
              thinkingBase = Math.round(rnd.logNormal(420, 0.7));
              blocks.push({ kind: 'thinking', base: thinkingBase });
            }
            if (toolsAvailable && rnd.chance(0.13)) {
              const rounds = rnd.int(1, 3);
              for (let r = 0; r < rounds; r++) {
                const use = Math.round(rnd.logNormal(90, 0.5));
                const result = Math.round(rnd.logNormal(1100, 0.9));
                blocks.push({ kind: 'tool_use', base: use }, { kind: 'tool_result', base: result });
                toolBase += use + result;
              }
            }
            const reply = Math.round(rnd.logNormal(340, 0.85)) + 8;
            blocks.push({ kind: 'text', base: reply });
            const endMs = t + rnd.int(3, 45) * 1000;
            account.push({ id: `${id}-m${account.length}`, parentId: account.length > 0 ? account[account.length - 1].id : ROOT_PARENT, role: 'assistant', timeMs: t, endMs, blocks, attachmentBase: 0, capBase });
            shape.push({
              role: 'assistant',
              textChars: Math.round(reply * 4.5),
              thinkingChars: Math.round(thinkingBase * 4.5),
              toolChars: Math.round(toolBase * 3.4),
              attachmentChars: 0,
              attachmentCount: 0,
              fileCount: 0,
            });
            // Most follow-ups come quickly; some after the prompt cache has expired.
            t = endMs + (rnd.chance(0.22) ? rnd.int(6, 90) * 60_000 : rnd.int(20, 240) * 1000);
          }

          const results = accountConversation(account);
          const firstMs = account[0].timeMs;
          const lastMs = account[account.length - 1].endMs ?? account[account.length - 1].timeMs;
          await sink.conversation({
            dedupKey: `claude_ai:${id}`,
            kind: 'chat',
            externalId: id,
            title: `${rnd.pick(VERBS)} ${rnd.pick(TOPICS)}`,
            projectLabel: null,
            modelKey: null,
            createdAt: iso(firstMs),
            updatedAt: iso(lastMs),
            metadata: { synthetic: true },
          });
          for (let i = 0; i < account.length; i++) {
            const m = account[i];
            const r = results[i];
            const s = shape[i];
            let flags = r.flags | Limitation.MODEL_UNKNOWN | Limitation.HIDDEN_CONTEXT_EXCLUDED;
            if (s.fileCount > 0) flags |= Limitation.BINARY_FILES_EXCLUDED;
            if (s.thinkingChars > 0) flags |= Limitation.THINKING_PARTIAL;
            if (s.toolChars > 0) flags |= Limitation.TOOL_OVERHEAD_EXCLUDED;
            await sink.message({
              conversationKey: `claude_ai:${id}`,
              externalId: m.id,
              parentExternalId: i > 0 ? account[i - 1].id : null,
              createdAt: iso(m.timeMs),
              occurredAt: iso(m.timeMs),
              ordinal: i,
              modelKey: null,
              ...s,
              inputBase: r.inputBase,
              outputBase: r.outputBase,
              replayBase: r.replayBase,
              replayCachedBase: r.replayCachedBase,
              requestCount: r.requestCount,
              methodKey: methodKeyFor(basisForDate(m.timeMs)),
              limitationFlags: flags,
            });
            chat.parsed.recordsSeen++;
          }
        }
      }
    },
  };

  // ── Claude Code: sessions with metered usage, exact ─────────────────────────────
  const code: DemoPart = {
    parsed: {
      format: 'demo/claude-code',
      formatLabel: 'Synthetic demo data (Claude Code sessions)',
      parserVersion: DEMO_PARSER_VERSION,
      source: { kind: 'claude_code', label: 'Demo: Claude Code', externalRef: 'demo', isSynthetic: true },
      fileName: 'synthetic-demo-claude-code',
      fileSize: 0,
      contentHash: null,
      recordsSeen: 0,
      recordsSkipped: 0,
      missingFields: [],
      warnings: [],
      stats: { synthetic: true },
    },
    async write(sink) {
      let serial = 0;
      for (let d = 0; d < totalDays; d++) {
        const dayStart = start + d * DAY;
        if (dayStart < codeFrom || (dayStart >= awayFrom && dayStart < awayTo)) continue;
        const phase = phaseAt(dayStart);
        const weekend = [0, 6].includes(new Date(dayStart).getUTCDay());
        const sessions = rnd.poisson(phase.codeSessionsPerWeekday * (weekend ? 0.3 : 1));
        const day = dayOf(dayStart - 4 * DAY);
        for (let sIdx = 0; sIdx < sessions; sIdx++) {
          serial++;
          const id = `demo-session-${String(serial).padStart(5, '0')}`;
          const opusShare = phase.plan === 'max_5x' ? 0.45 : 0.12;
          const main = (rnd.chance(opusShare) ? newestModel('opus', day) : null) ?? newestModel('sonnet', day);
          if (!main) continue;
          const helper = rnd.chance(0.3) ? newestModel('haiku', day) : null;
          const firstBucket = Math.floor((dayStart + rnd.pick(HOURS) * 3_600_000 + rnd.int(0, 3) * 900_000) / 900_000) * 900_000;
          const buckets = Math.max(1, Math.min(14, Math.round(rnd.logNormal(4, 0.7))));
          if (firstBucket + buckets * 900_000 > nowMs) continue;
          await sink.conversation({
            dedupKey: `claude_code:${id}`,
            kind: 'code_session',
            externalId: id,
            title: `${rnd.pick(VERBS)} ${rnd.pick(TOPICS)}`,
            projectLabel: rnd.pick(PROJECTS),
            modelKey: main,
            createdAt: iso(firstBucket),
            updatedAt: iso(firstBucket + buckets * 900_000),
            metadata: { synthetic: true },
          });
          let context = rnd.int(18_000, 40_000);
          for (let b = 0; b < buckets; b++) {
            const bucketMs = firstBucket + b * 900_000;
            const requests = rnd.int(3, 34);
            const prompts = Math.max(1, Math.round(requests / rnd.between(4, 9)));
            context = Math.min(180_000, context + rnd.int(2_000, 14_000));
            const write = Math.round(requests * rnd.between(600, 3_800));
            const longCache = phase.plan === 'max_5x' && rnd.chance(0.5);
            const row = (model: string, scale: number, nonce: number): StagedUsage => ({
              conversationKey: `claude_code:${id}`,
              modelKey: model,
              occurredAt: iso(bucketMs),
              bucketSeconds: 900,
              priceTier: 'standard',
              inputTokens: Math.round(requests * rnd.between(40, 900) * scale),
              outputTokens: Math.round(requests * rnd.between(180, 1_400) * scale),
              cacheReadTokens: Math.round(requests * context * rnd.between(0.75, 0.98) * scale),
              cacheWrite5mTokens: longCache ? 0 : Math.round(write * scale),
              cacheWrite1hTokens: longCache ? Math.round(write * scale) : 0,
              requestCount: Math.max(1, Math.round(requests * scale)),
              userMessageCount: scale === 1 ? prompts : 0,
              assistantMessageCount: Math.max(1, Math.round(requests * scale)),
              webSearchRequests: scale === 1 && rnd.chance(0.05) ? rnd.int(1, 4) : 0,
              confidence: 'exact',
              dedupKey: `cc:${id}:${model}:standard:${bucketMs / 1000}:${nonce}`,
            });
            await sink.usage(row(main, 1, 0));
            code.parsed.recordsSeen++;
            if (helper && helper !== main && rnd.chance(0.5)) {
              await sink.usage(row(helper, 0.18, 1));
              code.parsed.recordsSeen++;
            }
          }
        }
      }
    },
  };

  // ── Anthropic API: daily usage report and the matching cost report, exact ───────
  const apiRows: StagedUsage[] = [];
  const buildApiRows = () => {
    if (apiRows.length > 0) return apiRows;
    for (let dayStart = apiFrom; dayStart < apiTo; dayStart += DAY) {
      if (dayStart >= awayFrom && dayStart < awayTo) continue;
      if (rnd.chance(0.35)) continue;
      const day = dayOf(dayStart - 10 * DAY);
      for (const family of ['sonnet', 'haiku'] as const) {
        const model = newestModel(family, day);
        if (!model || (family === 'haiku' && rnd.chance(0.4))) continue;
        const requests = rnd.int(20, 900);
        const input = Math.round(requests * rnd.between(900, 5_000));
        apiRows.push({
          conversationKey: null,
          modelKey: model,
          occurredAt: iso(dayStart),
          bucketSeconds: 86_400,
          priceTier: 'standard',
          inputTokens: input,
          outputTokens: Math.round(requests * rnd.between(150, 1_100)),
          cacheReadTokens: rnd.chance(0.5) ? Math.round(input * rnd.between(0.4, 2.5)) : 0,
          cacheWrite5mTokens: rnd.chance(0.5) ? Math.round(input * rnd.between(0.05, 0.3)) : 0,
          cacheWrite1hTokens: 0,
          requestCount: requests,
          userMessageCount: 0,
          assistantMessageCount: 0,
          webSearchRequests: 0,
          confidence: 'exact',
          dedupKey: `demo-api:${model}:${dayOf(dayStart)}`,
        });
      }
    }
    return apiRows;
  };

  const apiUsage: DemoPart = {
    parsed: {
      format: 'demo/api-usage',
      formatLabel: 'Synthetic demo data (API usage report)',
      parserVersion: DEMO_PARSER_VERSION,
      source: { kind: 'api_usage_report', label: 'Demo: API usage report', externalRef: 'demo', isSynthetic: true },
      fileName: 'synthetic-demo-api-usage',
      fileSize: 0,
      contentHash: null,
      recordsSeen: 0,
      recordsSkipped: 0,
      missingFields: [],
      warnings: [],
      stats: { synthetic: true },
    },
    async write(sink) {
      for (const row of buildApiRows()) {
        await sink.usage(row);
        apiUsage.parsed.recordsSeen++;
      }
    },
  };

  const apiCost: DemoPart = {
    parsed: {
      format: 'demo/api-cost',
      formatLabel: 'Synthetic demo data (API cost report)',
      parserVersion: DEMO_PARSER_VERSION,
      source: { kind: 'api_cost_report', label: 'Demo: API cost report', externalRef: 'demo', isSynthetic: true },
      fileName: 'synthetic-demo-api-cost',
      fileSize: 0,
      contentHash: null,
      recordsSeen: 0,
      recordsSkipped: 0,
      missingFields: [],
      warnings: [],
      stats: { synthetic: true },
    },
    async write(sink) {
      for (const row of buildApiRows()) {
        const day = row.occurredAt.slice(0, 10);
        const price = row.modelKey ? standardPrice(row.modelKey, day) : undefined;
        if (!price) continue;
        const amount = Decimal.from(row.inputTokens)
          .mul(price.input)
          .add(Decimal.from(row.outputTokens).mul(price.output))
          .add(Decimal.from(row.cacheReadTokens).mul(price.cacheRead))
          .add(Decimal.from(row.cacheWrite5mTokens).mul(price.cacheWrite5m))
          .div(1_000_000);
        await sink.cost({
          modelKey: row.modelKey,
          occurredAt: row.occurredAt,
          bucketSeconds: 86_400,
          costType: 'tokens',
          tokenType: null,
          description: 'Synthetic demo cost',
          amountUsd: amount.toString(6),
          dedupKey: `demo-cost:${row.modelKey}:${day}`,
        });
        apiCost.parsed.recordsSeen++;
      }
    },
  };

  return { parts: [chat, code, apiUsage, apiCost], periods };
}
