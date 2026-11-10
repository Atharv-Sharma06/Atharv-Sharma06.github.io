import type { Confidence } from '@/core/types';

/**
 * The importers the app has, as data. This module is deliberately free of parser
 * code so that the page can describe a format without loading the parsers (they run
 * in a Web Worker, see worker/import.worker.ts).
 */
export type ParserKey =
  | 'claude-export'
  | 'claude-code'
  | 'claude-code-ledger'
  | 'api-usage'
  | 'api-cost'
  | 'console-csv'
  | 'generic-csv'
  | 'generic-json';

export interface FormatInfo {
  key: ParserKey;
  /** What the file is, in the user's words. */
  label: string;
  /** What kind of figures an import of this format produces. */
  yields: Confidence | 'money';
  /** One sentence on what is read from it. */
  reads: string;
}

export const FORMATS: Record<ParserKey, FormatInfo> = {
  'claude-export': {
    key: 'claude-export',
    label: 'claude.ai data export',
    yields: 'estimated',
    reads: 'Conversations and messages with their dates. The export holds no token counts and no model names, so tokens are estimated from the text.',
  },
  'claude-code': {
    key: 'claude-code',
    label: 'Claude Code session transcripts',
    yields: 'exact',
    reads: 'The token usage Claude Code recorded for every model response: input, output and cache tokens, with model, project and time.',
  },
  'claude-code-ledger': {
    key: 'claude-code-ledger',
    label: 'Claude Code usage ledger',
    yields: 'exact',
    reads: 'The compact record of Claude Code usage kept by the collector script, with the same exact token counts as the transcripts.',
  },
  'api-usage': {
    key: 'api-usage',
    label: 'Anthropic API usage report',
    yields: 'exact',
    reads: 'Token counts per time bucket as reported by the Admin API, with model and cache details.',
  },
  'api-cost': {
    key: 'api-cost',
    label: 'Anthropic API cost report',
    yields: 'money',
    reads: 'Billed amounts as reported by the Admin API. These are actual costs, kept apart from token counts.',
  },
  'console-csv': {
    key: 'console-csv',
    label: 'Claude Console CSV export',
    yields: 'exact',
    reads: 'The usage or cost table exported from the Claude Console.',
  },
  'generic-csv': {
    key: 'generic-csv',
    label: 'CSV file',
    yields: 'estimated',
    reads: 'Usage rows from a spreadsheet or another tool, using a column mapping you confirm.',
  },
  'generic-json': {
    key: 'generic-json',
    label: 'JSON usage file',
    yields: 'estimated',
    reads: 'Usage records in the documented Claude Lifetime JSON format.',
  },
};
