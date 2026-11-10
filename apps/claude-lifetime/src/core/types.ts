/**
 * Import contracts.
 *
 * Every importer (claude.ai export, Claude Code transcripts, API usage reports, CSV,
 * manual entry, ...) turns its input into the same small set of normalised records and
 * hands them to an ImportSink. Nothing below is specific to one source, and nothing
 * carries message text: only metadata and token counts cross this boundary.
 */

export type SourceKind =
  | 'claude_export'
  | 'claude_code'
  | 'api_usage_report'
  | 'api_cost_report'
  | 'generic_json'
  | 'generic_csv'
  | 'manual';

export type ConversationKind = 'chat' | 'code_session' | 'usage_bucket' | 'manual';
export type MessageRole = 'user' | 'assistant' | 'other';
export type Confidence = 'exact' | 'estimated';

export interface StagedConversation {
  /** Source-aware deduplication identifier, e.g. `claude_ai:<uuid>` or `claude_code:<sessionId>`. */
  dedupKey: string;
  kind: ConversationKind;
  externalId: string;
  title: string | null;
  projectLabel: string | null;
  /** Canonical model key (see core/models.ts) or null when the source names none. */
  modelKey: string | null;
  /** ISO-8601 UTC. */
  createdAt: string | null;
  updatedAt: string | null;
  metadata?: Record<string, unknown>;
}

/** A message together with its token estimate (see core/tokens). */
export interface StagedMessage {
  conversationKey: string;
  externalId: string;
  parentExternalId: string | null;
  role: MessageRole;
  /** Timestamp exactly as the source gave it, or null when missing or invalid. */
  createdAt: string | null;
  /** Timestamp used for accounting: createdAt, or the nearest valid one in the conversation. */
  occurredAt: string;
  ordinal: number;
  modelKey: string | null;
  textChars: number;
  thinkingChars: number;
  toolChars: number;
  attachmentChars: number;
  attachmentCount: number;
  fileCount: number;
  /** Estimates in base units (legacy-tokenizer tokens); see token_estimates in the schema. */
  inputBase: number;
  outputBase: number;
  replayBase: number;
  replayCachedBase: number;
  requestCount: number;
  /** estimation_methods.method_key */
  methodKey: string;
  limitationFlags: number;
}

/** Token counts reported by a usage source, already aggregated into a time bucket. */
export interface StagedUsage {
  conversationKey: string | null;
  modelKey: string | null;
  /** Bucket start, ISO-8601 UTC. */
  occurredAt: string;
  bucketSeconds: number;
  /** standard | batch | fast | long_context | priority | flex | ... */
  priceTier: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  requestCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  webSearchRequests: number;
  confidence: Confidence;
  dedupKey: string;
}

/** Actual spend from a cost report. */
export interface StagedCost {
  modelKey: string | null;
  occurredAt: string;
  bucketSeconds: number;
  costType: string | null;
  tokenType: string | null;
  description: string | null;
  /** Exact decimal string, USD. */
  amountUsd: string;
  dedupKey: string;
}

/** A model identifier seen in the input that the built-in catalog does not know. */
export interface StagedModel {
  key: string;
  displayName: string;
  family: string;
  tokenizerFamily: string;
}

export interface SyncedFileInfo {
  path: string;
  size: number;
  lastModified: number;
}

export interface ParseWarning {
  /** Stable machine-readable code, e.g. `invalid_timestamp`. */
  code: string;
  message: string;
  /** How many records the warning applies to. */
  count: number;
  /** An example (identifier or short excerpt of metadata, never message text). */
  sample?: string;
}

export interface ImportSink {
  conversation(c: StagedConversation): void | Promise<void>;
  message(m: StagedMessage): void | Promise<void>;
  usage(u: StagedUsage): void | Promise<void>;
  cost(c: StagedCost): void | Promise<void>;
  model(m: StagedModel): void | Promise<void>;
  progress?(p: ImportProgress): void;
}

export interface ImportProgress {
  phase: string;
  bytesRead: number;
  totalBytes: number;
  records: number;
}

/** What a parser reports about the input once it has read all of it. */
export interface ParsedImport {
  /** Machine id of the detected format, e.g. `claude-export/conversations`. */
  format: string;
  formatLabel: string;
  parserVersion: string;
  source: {
    kind: SourceKind;
    label: string;
    /** Stable identity of the origin ('' when the input has none). */
    externalRef: string;
    isSynthetic?: boolean;
  };
  fileName: string;
  fileSize: number;
  /** SHA-256 (hex) of the input, when it could be computed. */
  contentHash: string | null;
  recordsSeen: number;
  recordsSkipped: number;
  /** Fields the format normally has that this input lacks. */
  missingFields: string[];
  warnings: ParseWarning[];
  /** 64-bit hashes of API requests newly seen in this input (Claude Code). */
  requestKeys?: bigint[];
  /** Requests skipped because an earlier import already counted them (Claude Code). */
  duplicateRequests?: number;
  /**
   * For restated aggregates (API reports): rows of the same source inside these
   * half-open UTC ranges are replaced by this import instead of being added to.
   * The ranges are in time order and neither overlap nor touch; the time between
   * two of them is not something the import speaks for.
   */
  replaceRanges?: TimeRange[];
  syncedFiles?: SyncedFileInfo[];
  stats: Record<string, number | string | boolean>;
}

/** A half-open range of time, as ISO-8601 UTC timestamps. */
export interface TimeRange {
  start: string;
  end: string;
}

export interface ImportFile {
  name: string;
  /** Path relative to the chosen directory, for directory imports. */
  path?: string;
  size: number;
  lastModified?: number;
  blob: Blob;
  /** For a file read out of a ZIP archive inside the import worker: the archive's name. */
  archive?: string;
}

export interface ParseContext {
  /** Request hashes already counted by earlier imports (Claude Code deduplication). */
  knownRequestKeys?: Set<bigint>;
  /** Files already synced and unchanged can be skipped. */
  knownFiles?: Map<string, { size: number; lastModified: number }>;
  /** Free-form options chosen in the import UI (column mapping, labels, ...). */
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ImportParser {
  parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport>;
}

export class ImportError extends Error {
  constructor(
    message: string,
    /** Stable code the UI can map to guidance. */
    readonly code: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}
