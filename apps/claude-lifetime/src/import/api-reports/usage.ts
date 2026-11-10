import type { ImportFile, ImportParser, ImportSink, ParseContext, ParsedImport, StagedUsage } from '@/core/types';
import { clip, INT32_MAX, isObject, parseCount, type Json } from '../generic/values';
import { hasLongContextPremium, priceTierFor } from './dimensions';
import { looksLikeClaudeCode, noteClaudeCodeOverlap, noteHaikuLongContext, noteUsOnlyInference } from './notes';
import { ReportReader, type ReportKind } from './report';

/**
 * Importer for Anthropic's API usage reports: exact token counts per time bucket.
 *
 * Two endpoints report them, and the JSON a user saves from either is accepted
 * (see report.ts for the ways it may be saved):
 *
 *  - GET /v1/organizations/usage_report/messages   legacy Usage and Cost API
 *      data[]: { starting_at, ending_at, results[] }, one bucket per interval,
 *      empty intervals included; a result holds dimensions and token counts.
 *  - GET /v1/organizations/analytics/usage         Usage and Cost Analytics API
 *      data[]: { starting_at, ending_at, group{…}, usage{…} }, one row per
 *      combination of dimensions that has usage.
 *
 * Token fields are the same in both: uncached_input_tokens, cache_read_input_tokens,
 * cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens,
 * output_tokens and server_tool_use.web_search_requests. Only the Analytics API
 * reports a request count (usage.requests) and a total (usage.total_tokens).
 *
 * Reports are restated: Anthropic revises recent figures, and the same period can
 * be requested again with another grouping. Every import therefore replaces what
 * was imported from usage reports before, inside the time range it covers
 * (ParsedImport.replaceRange) — two reports of the same period are never added up.
 */
const USAGE_REPORT: ReportKind = {
  kind: 'usage',
  source: { kind: 'api_usage_report', label: 'Anthropic API usage report', externalRef: '' },
  formats: { legacy: 'anthropic/usage-report', analytics: 'anthropic/analytics-usage' },
  labels: {
    legacy: 'Anthropic API usage report (Usage and Cost API)',
    analytics: 'Anthropic API usage report (Usage and Cost Analytics API)',
  },
  keyPrefix: 'api',
  measurementFields: new Set(),
  phase: 'Reading usage report',
};

interface Counts {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  webSearches: number;
  requests: number;
  /** usage.total_tokens of the Analytics API; null when the row has none. */
  total: number | null;
}

/** Reads a row's measurements; returns the name and value of the first field that is not a count. */
function readCounts(metrics: Json): Counts | { invalid: string } {
  const cacheCreation = isObject(metrics.cache_creation) ? metrics.cache_creation : {};
  const serverTools = isObject(metrics.server_tool_use) ? metrics.server_tool_use : {};
  const fields: Array<[name: string, value: unknown, max: number]> = [
    ['uncached_input_tokens', metrics.uncached_input_tokens, Number.MAX_SAFE_INTEGER],
    ['cache_read_input_tokens', metrics.cache_read_input_tokens, Number.MAX_SAFE_INTEGER],
    ['cache_creation.ephemeral_5m_input_tokens', cacheCreation.ephemeral_5m_input_tokens, Number.MAX_SAFE_INTEGER],
    ['cache_creation.ephemeral_1h_input_tokens', cacheCreation.ephemeral_1h_input_tokens, Number.MAX_SAFE_INTEGER],
    ['output_tokens', metrics.output_tokens, Number.MAX_SAFE_INTEGER],
    // Stored in INTEGER columns.
    ['server_tool_use.web_search_requests', serverTools.web_search_requests, INT32_MAX],
    ['requests', metrics.requests, INT32_MAX],
    ['total_tokens', metrics.total_tokens, Number.MAX_SAFE_INTEGER],
  ];
  const values: Array<number | null> = [];
  for (const [name, value, max] of fields) {
    const count = parseCount(value, max);
    if (!count.ok) return { invalid: `${name}: ${clip(value, 40)}` };
    values.push(count.value);
  }
  const [input, cacheRead, cacheWrite5m, cacheWrite1h, output, webSearches, requests, total] = values;
  return {
    input: input ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite5m: cacheWrite5m ?? 0,
    cacheWrite1h: cacheWrite1h ?? 0,
    output: output ?? 0,
    webSearches: webSearches ?? 0,
    requests: requests ?? 0,
    total,
  };
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export const apiUsageReportParser: ImportParser = {
  async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
    const reader = new ReportReader(files, sink, ctx, USAGE_REPORT);
    const groupedBy = new Set<string>();
    let rowsWithModel = 0;
    let premiumModelRows = 0;
    let claudeCodeRows = 0;
    let usOnlyRows = 0;
    let haikuRows = 0;
    let totalMismatches = 0;
    let totalMismatchSample: string | undefined;
    const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, requests: 0 };

    for await (const row of reader.rows()) {
      const counts = readCounts(row.metrics);
      if ('invalid' in counts) {
        reader.skip('invalid_number', 'Rows with a token count that is negative or not a whole number were skipped.', `${counts.invalid} (${row.startIso})`);
        continue;
      }
      const dims = row.dims;
      const modelKey = await reader.models.resolve(dims.model);
      for (const name of row.dimensionNames) groupedBy.add(name);

      const usage: StagedUsage = {
        conversationKey: null,
        modelKey,
        occurredAt: row.startIso,
        bucketSeconds: row.bucketSeconds,
        priceTier: priceTierFor({ modelKey, serviceTier: dims.service_tier, speed: dims.speed, contextWindow: dims.context_window }),
        inputTokens: counts.input,
        outputTokens: counts.output,
        cacheReadTokens: counts.cacheRead,
        cacheWrite5mTokens: counts.cacheWrite5m,
        cacheWrite1hTokens: counts.cacheWrite1h,
        requestCount: counts.requests,
        userMessageCount: 0,
        assistantMessageCount: 0,
        webSearchRequests: counts.webSearches,
        confidence: 'exact',
        dedupKey: row.dedupKey,
      };
      await sink.usage(usage);
      reader.emitted();

      if (modelKey !== null) rowsWithModel++;
      if (hasLongContextPremium(modelKey)) premiumModelRows++;
      if (modelKey === 'claude-haiku-5-5') haikuRows++;
      if (looksLikeClaudeCode(dims.product)) claudeCodeRows++;
      if (text(dims.inference_geo) === 'us') usOnlyRows++;
      const tokens = counts.input + counts.output + counts.cacheRead + counts.cacheWrite5m + counts.cacheWrite1h;
      if (counts.total !== null && counts.total !== tokens) {
        totalMismatches++;
        totalMismatchSample ??= `total_tokens ${counts.total}, token types add up to ${tokens} (${row.startIso})`;
      }
      sum.input += counts.input;
      sum.output += counts.output;
      sum.cacheRead += counts.cacheRead;
      sum.cacheWrite += counts.cacheWrite5m + counts.cacheWrite1h;
      sum.webSearches += counts.webSearches;
      sum.requests += counts.requests;
    }

    const missingFields: string[] = [];
    const warnings = reader.warnings;

    if (rowsWithModel === 0) {
      missingFields.push('model');
      warnings.add(
        'model_not_grouped',
        'This report is not broken down by model. Its tokens are counted, but no price can be applied to them, so their equivalent API value stays unknown. ' +
          'Request the report again with group_by[]=model (other group_by[] values can be added) and import it: the new report replaces this one.',
        undefined,
        reader.emittedCount,
      );
    }

    // Without these dimensions every row reads as standard usage.
    const tierGaps: string[] = [];
    const tierEffects: string[] = [];
    if (!groupedBy.has('service_tier')) {
      tierGaps.push('service_tier');
      tierEffects.push('Batch API, Priority Tier and flex usage');
    }
    if (!groupedBy.has('speed')) {
      tierGaps.push('speed');
      tierEffects.push('fast mode usage');
    }
    if (!groupedBy.has('context_window') && premiumModelRows > 0) {
      tierGaps.push('context_window');
      tierEffects.push('long-context usage of Claude Sonnet 4 and 4.5');
    }
    missingFields.push(...tierGaps);
    if (tierGaps.length > 0 && rowsWithModel > 0) {
      warnings.add(
        'tier_not_grouped',
        `This report is not broken down by ${tierGaps.join(', ')}, so ${tierEffects.join(', ')} cannot be told apart from standard usage. ` +
          'All of it is valued at the standard price, although these kinds of usage are billed at other rates. ' +
          `For an exact valuation, add ${tierGaps.map((g) => `group_by[]=${g}`).join('&')} to the request.`,
        undefined,
        reader.emittedCount,
      );
    }

    noteClaudeCodeOverlap(warnings, claudeCodeRows);
    noteHaikuLongContext(warnings, haikuRows);
    noteUsOnlyInference(warnings, usOnlyRows);
    if (totalMismatches > 0) {
      warnings.add(
        'total_mismatch',
        'Rows whose total_tokens differs from the sum of their token types were imported by token type. The report may contain a kind of token this version does not know.',
        totalMismatchSample,
        totalMismatches,
      );
    }

    return reader.finish({
      missingFields,
      stats: {
        groupedBy: [...groupedBy].sort().join(', '),
        inputTokens: sum.input,
        outputTokens: sum.output,
        cacheReadTokens: sum.cacheRead,
        cacheWriteTokens: sum.cacheWrite,
        webSearchRequests: sum.webSearches,
        requests: sum.requests,
        unknownModels: reader.models.unknownCount,
      },
    });
  },
};
