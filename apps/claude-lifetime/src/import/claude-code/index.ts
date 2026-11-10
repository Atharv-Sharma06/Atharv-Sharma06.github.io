/**
 * Claude Code importer: exact, de-duplicated token usage from Claude Code's local
 * session transcripts, read either directly (a folder picked in the browser) or
 * through the ledger kept by the collector CLI.
 *
 * Everything exported here runs in the browser. The collector itself
 * (collector.ts, collector-cli.ts) needs Node and is deliberately not re-exported.
 */
export {
  claudeCodeParser,
  claudeCodeLedgerParser,
  isClaudeCodeLedgerFile,
  CLAUDE_CODE_PARSER_VERSION,
  CLAUDE_CODE_TRANSCRIPT_FORMAT,
  CLAUDE_CODE_LEDGER_FORMAT,
  type ClaudeCodeImportOptions,
} from './parser';
export { aggregateUsage, priceTierOf, BUCKET_SECONDS, type AggregateOutcome, type UsageInput } from './aggregate';
export {
  classifyUserRow,
  deferInProgress,
  extractTranscripts,
  transcriptPathInfo,
  IN_PROGRESS_WINDOW_MS,
  PromptKind,
  ResponseFlag,
  type Extraction,
  type ExtractOptions,
  type PromptRecord,
  type ResponseRecord,
  type SessionInfo,
  type TranscriptPathInfo,
  type TranscriptSource,
} from './extract';
export {
  looksLikeLedger,
  mergeIntoLedger,
  parseLedger,
  serialiseLedger,
  LedgerError,
  LEDGER_FORMAT,
  LEDGER_VERSION,
  type Ledger,
} from './ledger';
