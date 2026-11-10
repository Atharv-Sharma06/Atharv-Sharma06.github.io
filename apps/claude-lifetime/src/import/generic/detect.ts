import { detectApiReportFormat, detectConsoleCsvFormat, type ApiReportFormat, type ConsoleCsvFormat } from '../api-reports/detect';
import { detectCsvMapping, TOKEN_FIELDS } from './fields';
import { isObject } from './values';

/**
 * Format detection for the app's import screen: pure functions over a value that
 * has already been parsed (or over the header row of a CSV file).
 */
export type UsageJsonFormat = ApiReportFormat | 'claude-lifetime/usage';
export type UsageCsvFormat = ConsoleCsvFormat | 'generic/csv';

/** An object with a timestamp and at least one token count under the format's own field names. */
function looksLikeRecord(value: unknown): boolean {
  return isObject(value) && 'timestamp' in value && TOKEN_FIELDS.some((f) => f in value);
}

/**
 * True for a file in the app's own usage format (generic/json.ts): the wrapped form
 * with `"format": "claude-lifetime/usage"`, a bare array of records, or a single
 * record (the first line of a JSON Lines file).
 */
export function isGenericUsageJson(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && looksLikeRecord(value[0]);
  if (!isObject(value)) return false;
  if (value.format === 'claude-lifetime/usage') return true;
  if (Array.isArray(value.records)) return value.format === undefined && value.records.length > 0 && looksLikeRecord(value.records[0]);
  return looksLikeRecord(value);
}

/**
 * Which of the usage formats a parsed JSON value is, or null for none of them:
 * 'anthropic/usage-report', 'anthropic/analytics-usage', 'anthropic/cost-report',
 * 'anthropic/analytics-cost' (see api-reports/detect.ts) or 'claude-lifetime/usage'.
 * For JSON Lines, pass the value of the first line.
 */
export function detectJsonFormat(value: unknown): UsageJsonFormat | null {
  return detectApiReportFormat(value) ?? (isGenericUsageJson(value) ? 'claude-lifetime/usage' : null);
}

/**
 * Which CSV importer a header row belongs to: one of the Claude Console exports, or
 * 'generic/csv' when the columns can be mapped without help. Null means the generic
 * importer can still read the file, but only with a mapping chosen by the user.
 */
export function detectCsvFormat(header: readonly string[]): UsageCsvFormat | null {
  return detectConsoleCsvFormat(header) ?? (detectCsvMapping(header).problems.length === 0 ? 'generic/csv' : null);
}
