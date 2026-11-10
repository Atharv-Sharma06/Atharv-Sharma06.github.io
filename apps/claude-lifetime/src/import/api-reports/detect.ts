/**
 * Recognising Anthropic usage and cost reports by their shape. Pure functions with
 * no dependencies: the app's format detection calls them on a value it has already
 * parsed (or on the header row of a CSV file).
 *
 * The four JSON shapes, from Anthropic's API reference (read 2026-11-10):
 *
 *  anthropic/usage-report      GET /v1/organizations/usage_report/messages  (legacy)
 *      { data: [ { starting_at, ending_at, results: [ { uncached_input_tokens, … } ] } ], has_more, next_page }
 *  anthropic/cost-report       GET /v1/organizations/cost_report            (legacy)
 *      { data: [ { starting_at, ending_at, results: [ { amount, currency, … } ] } ], has_more, next_page }
 *  anthropic/analytics-usage   GET /v1/organizations/analytics/usage
 *      { data: [ { starting_at, ending_at, group: {…}, usage: {…} } ], has_more, next_page, data_refreshed_at }
 *  anthropic/analytics-cost    GET /v1/organizations/analytics/cost
 *      { data: [ { starting_at, ending_at, group: {…}, cost: {…} } ], has_more, next_page, data_refreshed_at }
 */
export type ApiReportFormat =
  | 'anthropic/usage-report'
  | 'anthropic/analytics-usage'
  | 'anthropic/cost-report'
  | 'anthropic/analytics-cost';

export type ConsoleCsvFormat = 'anthropic/console-usage-csv' | 'anthropic/console-cost-csv';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Token fields of a usage result (legacy) or of a row's `usage` object (analytics). */
const USAGE_FIELDS = ['uncached_input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation', 'total_tokens'];

/**
 * What one element of a report's `data` list is. A legacy time bucket whose
 * `results` are empty is a bucket of either legacy report: the two cannot be told
 * apart without a result.
 */
export function classifyReportItem(item: unknown): ApiReportFormat | 'empty-bucket' | null {
  if (!isObject(item) || typeof item.starting_at !== 'string') return null;
  if (isObject(item.usage) && USAGE_FIELDS.some((k) => k in (item.usage as Json))) return 'anthropic/analytics-usage';
  if (isObject(item.cost) && 'amount' in item.cost) return 'anthropic/analytics-cost';
  if (!Array.isArray(item.results)) return null;
  for (const result of item.results) {
    if (!isObject(result)) continue;
    if ('amount' in result) return 'anthropic/cost-report';
    if (USAGE_FIELDS.some((k) => k in result)) return 'anthropic/usage-report';
  }
  return 'empty-bucket';
}

/** A response page: an object with a `data` list. */
export function isReportPage(value: unknown): value is Json & { data: unknown[] } {
  return isObject(value) && Array.isArray(value.data);
}

/**
 * Says which report a parsed JSON value is, or null when it is none of them.
 *
 * `value` may be one response page, a list of pages, or a list of the rows or
 * buckets themselves (what an SDK's auto-pagination yields). For JSON Lines, pass
 * the value of the first line.
 *
 * A report without a single row is still recognised, so that the user is told "this
 * report is empty" rather than "unknown file": empty legacy buckets and an empty
 * legacy page are reported as `anthropic/usage-report`, an empty Analytics API page
 * (it has `data_refreshed_at`) as `anthropic/analytics-usage`. Whether such a file
 * was meant to hold usage or cost cannot be known and does not matter, as there is
 * nothing in it to import.
 */
export function detectApiReportFormat(value: unknown): ApiReportFormat | null {
  const entries = Array.isArray(value) ? value : [value];
  let emptyBuckets = false;
  let emptyPage: Json | null = null;
  for (const entry of entries) {
    if (isReportPage(entry)) {
      if (entry.data.length === 0) {
        // Other list endpoints answer with `data` and `has_more` too; `next_page` is specific to the reports.
        if (!('has_more' in entry && 'next_page' in entry)) return null;
        emptyPage ??= entry;
        continue;
      }
      for (const item of entry.data) {
        const kind = classifyReportItem(item);
        if (kind === null) return null;
        if (kind !== 'empty-bucket') return kind;
        emptyBuckets = true;
      }
      continue;
    }
    const kind = classifyReportItem(entry);
    if (kind === null) return null;
    if (kind !== 'empty-bucket') return kind;
    emptyBuckets = true;
  }
  if (emptyBuckets) return 'anthropic/usage-report';
  if (emptyPage !== null) return 'data_refreshed_at' in emptyPage ? 'anthropic/analytics-usage' : 'anthropic/usage-report';
  return null;
}

/**
 * The message of an API error body, `{ "type": "error", "error": { "type", "message" } }`.
 * People save the output of a request that failed (wrong key, missing beta header)
 * and then try to import it; they deserve to be told what the file is.
 */
export function apiErrorMessage(value: unknown): string | null {
  if (!isObject(value) || value.type !== 'error' || !isObject(value.error)) return null;
  const type = typeof value.error.type === 'string' ? value.error.type : '';
  const message = typeof value.error.message === 'string' ? value.error.message : '';
  if (type === '' && message === '') return null;
  return message === '' ? type : type === '' ? message : `${message} (${type})`;
}

/**
 * Recognises the CSV files the Claude Console exports from its Usage and Cost pages
 * by their header row. Column names were verified against exported files, see
 * console-csv.ts.
 */
export function detectConsoleCsvFormat(header: readonly string[]): ConsoleCsvFormat | null {
  const names = new Set(header.map((h) => h.trim().toLowerCase()));
  if (!names.has('usage_date_utc')) return null;
  if (names.has('model_version') && names.has('usage_input_tokens_no_cache') && names.has('usage_output_tokens')) {
    return 'anthropic/console-usage-csv';
  }
  if (names.has('cost_usd') && names.has('cost_type')) return 'anthropic/console-cost-csv';
  return null;
}
