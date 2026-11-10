import { methodKeyFor } from '@/core/catalog';
import type { ParsedImport, StagedConversation, StagedMessage, StagedUsage } from '@/core/types';
import type { SqlDriver } from '@/db/driver';
import { commitImport, previewImport, type CommitOptions } from '@/import/commit';
import { resetStaging, StagingWriter, type StagedBatch } from '@/import/staging';

export const conv = (id: string, over: Partial<StagedConversation> = {}): StagedConversation => ({
  dedupKey: `claude_ai:${id}`,
  kind: 'chat',
  externalId: id,
  title: `Conversation ${id}`,
  projectLabel: null,
  modelKey: null,
  createdAt: '2025-01-01T10:00:00.000Z',
  updatedAt: '2025-01-01T11:00:00.000Z',
  ...over,
});

export const msg = (conversationId: string, n: number, over: Partial<StagedMessage> = {}): StagedMessage => ({
  conversationKey: `claude_ai:${conversationId}`,
  externalId: `${conversationId}-m${n}`,
  parentExternalId: null,
  role: n % 2 === 0 ? 'user' : 'assistant',
  createdAt: new Date(Date.UTC(2025, 0, 1, 10, n)).toISOString(),
  occurredAt: new Date(Date.UTC(2025, 0, 1, 10, n)).toISOString(),
  ordinal: n,
  modelKey: null,
  textChars: 400,
  thinkingChars: 0,
  toolChars: 0,
  attachmentChars: 0,
  attachmentCount: 0,
  fileCount: 0,
  inputBase: n % 2 === 0 ? 100 : 0,
  outputBase: n % 2 === 0 ? 0 : 200,
  replayBase: n % 2 === 0 ? 0 : 150 * n,
  replayCachedBase: 0,
  requestCount: n % 2 === 0 ? 0 : 1,
  methodKey: methodKeyFor('claude3'),
  limitationFlags: 3,
  ...over,
});

export const usage = (key: string, over: Partial<StagedUsage> = {}): StagedUsage => ({
  conversationKey: null,
  modelKey: 'claude-sonnet-4-5',
  occurredAt: '2025-06-01T00:00:00.000Z',
  bucketSeconds: 900,
  priceTier: 'standard',
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 20000,
  cacheWrite5mTokens: 3000,
  cacheWrite1hTokens: 0,
  requestCount: 4,
  userMessageCount: 1,
  assistantMessageCount: 4,
  webSearchRequests: 0,
  confidence: 'exact',
  dedupKey: key,
  ...over,
});

export const parsed = (over: Partial<ParsedImport> = {}): ParsedImport => ({
  format: 'test/format',
  formatLabel: 'Test format',
  parserVersion: 'test-1',
  source: { kind: 'claude_export', label: 'claude.ai export', externalRef: 'acct-1' },
  fileName: 'conversations.json',
  fileSize: 1234,
  contentHash: 'hash-1',
  recordsSeen: 0,
  recordsSkipped: 0,
  missingFields: [],
  warnings: [],
  stats: {},
  ...over,
});

/** Stage a batch of records the way a parser would. */
export async function stage(db: SqlDriver, batch: Partial<StagedBatch>) {
  await resetStaging(db);
  const writer = new StagingWriter(db);
  await writer.addBatch(batch);
  return writer;
}

export async function importRecords(db: SqlDriver, userId: number, batch: Partial<StagedBatch>, meta: Partial<ParsedImport> = {}, options: CommitOptions = {}) {
  await stage(db, batch);
  const p = parsed(meta);
  const preview = await previewImport(db, userId, p);
  const result = await commitImport(db, userId, p, options);
  return { preview, result };
}
