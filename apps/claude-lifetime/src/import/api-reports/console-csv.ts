import { MODELS, tierForGeography } from '@/core/catalog';
import { Decimal } from '@/core/decimal';
import { ImportError, type ImportFile, type ImportParser, type ImportSink, type ParseContext, type ParsedImport } from '@/core/types';
import { genericCsvParser } from '../generic/csv';
import { describeFiles, InputMeter, ModelRegistry, requireFiles, WarningList } from '../generic/shared';
import { INT32_MAX, parseCount, parseTimestamp, sampleOf } from '../generic/values';
import { readCsv, readCsvHead } from '../util/csv';
import { usdAmount } from './cost';
import { detectConsoleCsvFormat, type ConsoleCsvFormat } from './detect';
import {
  API_REPORTS_PARSER_VERSION,
  bucketKey,
  Coverage,
  GranularityGuard,
  GroupingGuard,
  hasLongContextPremium,
  priceTierFor,
  RangeTracker,
  SERVICE_TIERS,
} from './dimensions';
import { looksLikeClaudeCode, noteClaudeCodeOverlap, noteHaikuLongContext, TOO_LARGE } from './notes';
import { mixedGranularity, mixedGrouping } from './report';

/**
 * Importer for the CSV files the Claude Console exports from its Usage and Cost
 * pages (platform.claude.com/usage, /cost). For accounts that cannot use the Admin
 * API — individual accounts cannot — these files are the only source of exact
 * figures.
 *
 * Anthropic does not document the columns. They were verified on 2026-11-10 against
 * files that users exported and committed to public GitHub repositories (found by
 * searching GitHub code for the column names):
 *
 *  Usage export, named claude_api_tokens_YYYY_MM.csv (a month, one row per day) or
 *  claude_api_tokens_YYYY_MM_DD.csv (a day, one row per hour). Seven files in six
 *  repositories:
 *    su-san1129/claude-pricing-dashboard  public/sample-usage.csv            (2025-06; a sample
 *                                         file of a dashboard project, possibly edited)
 *    RichJacobs69/job-analytics           docs/costs/claude_api_tokens_2025_12_04.csv
 *    Orhanguezel/GoldMoodAstro            doc/data/claude-usage/claude_api_tokens_2026_03.csv, …_2026_08.csv
 *    ammarsapru/Waypoint                  claude_api_tokens_2026_07.csv
 *    mhsu2112/board-duties-distill        release/claude_api_tokens_2026_07_04.csv
 *    vmilare/spotify-insight-pipeline     cost/provider_usage/anthropic_console_usage.csv   (2026-10)
 *  Header as of 2026:
 *    usage_date_utc,model_version,api_key,workspace,usage_type,context_window,
 *    usage_input_tokens_no_cache,usage_input_tokens_cache_write_5m,
 *    usage_input_tokens_cache_write_1h,usage_input_tokens_cache_read,
 *    usage_output_tokens,web_search_count,inference_geo,speed
 *  The 2025-06 file has no context_window, inference_geo and speed; the 2025-12 file
 *  has context_window but not the other two. Only the date, model and token columns
 *  are required here, so either header is read. Values seen: usage_date_utc "2026-07-05"
 *  (daily) and "2026-07-04 11:00" (hourly); model_version is the API model id;
 *  api_key and workspace are names, not ids; usage_type "standard"; context_window
 *  "≤ 200k" and "200k - 1M"; inference_geo "global" and "not_available"; speed empty
 *  or "standard".
 *
 *  Cost export, named claude_api_cost_YYYY_MM_DD_to_YYYY_MM_DD.csv. Five files:
 *    RichJacobs69/job-analytics                docs/costs/claude_api_cost_2025_12_01_to_2025_12_04.csv
 *    petroslamb/ethereum-protocol-verification examples/workflow_runs/…/claude_api_cost_2026_02_01_to_2026_02_01.csv
 *    nick-m-wight/livechat-ringcentral-sync    claude_api_cost_2026_02_08_to_2026_02_15.csv
 *    DwoaC/claude-monitor                      claude_api_cost_2026_03_01_to_2026_03_14.csv
 *    charlie-robison/bio-fact                  example-output/claude_api_cost_2026_03_01_to_2026_03_08.csv
 *  Header:
 *    usage_date_utc,model,workspace,api_key,usage_type,context_window,token_type,
 *    cost_usd,cost_type[,inference_geo,speed]
 *  Values seen: model is a display name ("Claude Haiku 4.5"); usage_type "message";
 *  token_type "input_no_cache", "input_cache_read", "input_cache_write_5m", "output";
 *  cost_type "token" and "web_search"; cost_usd is in dollars with two decimals;
 *  "--" stands for "does not apply".
 *
 * Not verified, because no sample contained them: how Batch API, Priority Tier and
 * fast mode usage appear. usage_type and speed are read with the API's value names
 * (batch, priority…, flex…, fast); any other usage_type is imported as standard
 * usage and reported in a warning. A single cache-write column
 * (usage_input_tokens_cache_write) was only seen in third-party code that reads
 * older exports; it is read as 5-minute cache writes if present.
 *
 * The files are other spellings of the API's usage and cost reports, so they are
 * imported into the same two sources and restate them: an import replaces what
 * was imported before for the days it covers, whichever of the formats it came in.
 *
 * An export lists only the days (or hours) that have usage. Each file therefore
 * speaks for the stretch from its first row to its last, and a file with hourly rows
 * for the whole UTC days it touches: the Console exports hours one day at a time, and
 * a day that is stored as one daily total can only be replaced as a whole. Several
 * files are several stretches; the time between them is not touched.
 *
 * A CSV file with any other header is handed to the generic CSV importer.
 */
const USAGE_FORMAT = 'anthropic/console-usage-csv';
const COST_FORMAT = 'anthropic/console-cost-csv';

/** Console spelling -> the Cost API's spelling, so one vocabulary is stored. Only the first, second, third and fifth were seen in samples. */
const TOKEN_TYPES: Record<string, string> = {
  input_no_cache: 'uncached_input_tokens',
  input_cache_read: 'cache_read_input_tokens',
  input_cache_write_5m: 'cache_creation.ephemeral_5m_input_tokens',
  input_cache_write_1h: 'cache_creation.ephemeral_1h_input_tokens',
  output: 'output_tokens',
};
const COST_TYPES: Record<string, string> = { token: 'tokens' };

/** The cost export names models the way the catalog's display names do ("Claude Sonnet 4.5"). */
const MODEL_BY_DISPLAY_NAME = new Map(MODELS.map((m) => [m.displayName.toLowerCase(), m.key]));

/** Shared state of one import of Console files. */
class ConsoleImport {
  readonly meter: InputMeter;
  readonly warnings = new WarningList();
  readonly models: ModelRegistry;
  readonly coverage = new Coverage();
  readonly granularity = new GranularityGuard();
  readonly grouping: GroupingGuard;
  /** First to last row of the file being read, and whether it has rows narrower than a day. */
  private fileRange = new RangeTracker();
  private fileHasHours = false;
  seen = 0;
  skipped = 0;
  emitted = 0;
  private readonly keys = new Set<string>();
  private keysOfFile = new Map<string, number>();

  constructor(
    readonly files: ImportFile[],
    readonly sink: ImportSink,
    ctx: ParseContext,
    phase: string,
    /** See GroupingGuard: 0 for token counts, 1 for amounts, which are rounded row by row. */
    figureTolerance: number,
  ) {
    this.meter = new InputMeter(files, sink, ctx, phase);
    this.models = new ModelRegistry(sink);
    this.grouping = new GroupingGuard(figureTolerance);
  }

  /**
   * Calls `row` for every data row of every file with a function that reads a cell
   * by column name ('' for a missing column, an empty cell or the "--" placeholder).
   */
  async eachRow(row: (cell: (column: string) => string, has: (column: string) => boolean, line: number) => Promise<void>): Promise<void> {
    for (const file of this.files) {
      if (file.size === 0) continue;
      this.keysOfFile = new Map();
      this.fileRange = new RangeTracker();
      this.fileHasHours = false;
      let columns: Map<string, number> | null = null;
      for await (const record of readCsv(file.blob.stream() as ReadableStream<Uint8Array>, { onBytes: this.meter.onBytes })) {
        if (columns === null) {
          columns = new Map(record.fields.map((name, index) => [name.trim().toLowerCase(), index]));
          continue;
        }
        if (record.fields.every((f) => f.trim() === '')) continue;
        const known = columns;
        this.seen++;
        await row(
          (column) => {
            const index = known.get(column);
            const value = index === undefined ? '' : (record.fields[index] ?? '').trim();
            return value === '--' ? '' : value;
          },
          (column) => known.has(column),
          record.line,
        );
        this.meter.records = this.seen;
        if ((this.seen & 1023) === 0) this.meter.checkCancelled();
      }
      const stretch = this.fileRange.bounds();
      if (stretch !== null) {
        const [start, end] = stretch;
        if (this.fileHasHours) this.coverage.add(Math.floor(start / DAY_MS) * DAY_MS, Math.ceil(end / DAY_MS) * DAY_MS);
        else this.coverage.add(start, end);
      }
      this.grouping.endUnit();
    }
  }

  skip(code: string, message: string, sample: string): void {
    this.skipped++;
    this.warnings.add(code, message, sample);
  }

  /** Reads `usage_date_utc`: a day, or a day and an hour. Null (and a warning) when it is neither. */
  bucket(value: string, line: number): { startMs: number; startIso: string; seconds: number } | null {
    const time = parseTimestamp(value);
    if (time === null) {
      this.skip('invalid_timestamp', 'Rows whose usage_date_utc is not a date were skipped.', `${sampleOf(value)} (line ${line})`);
      return null;
    }
    // "2026-07-05" is a day and "2026-07-04 11:00" an hour. Anything finer was not seen in an export; its width stays unknown.
    const seconds = time.dateOnly ? 86400 : time.ms % 3_600_000 === 0 ? 3600 : 0;
    return { startMs: time.ms, startIso: new Date(time.ms).toISOString(), seconds };
  }

  /**
   * Key of a row. Within one file, rows with the same visible dimensions are separate
   * figures (the exports do contain such rows: something the file does not show
   * tells them apart), so the second gets "#2". Across the files of one import the
   * same key means the same export was chosen twice, and the repeat is dropped.
   * Returns null for a repeat. `figures` are what the row measures (see GroupingGuard).
   */
  key(
    prefix: string,
    bucket: { startMs: number; startIso: string; seconds: number },
    pairs: Array<[string, string]>,
    figures: number[],
    line: number,
  ): string | null {
    const dims = pairs.filter(([, value]) => value !== '').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.grouping.add(bucket.startMs, bucket.seconds, dims.map(([name]) => name), figures);
    let key = bucketKey(prefix, bucket.startIso, bucket.seconds, { pairs: dims, structured: false });
    const nth = (this.keysOfFile.get(key) ?? 0) + 1;
    this.keysOfFile.set(key, nth);
    if (nth > 1) key += `#${nth}`;
    if (this.keys.has(key)) {
      this.skip('duplicate_rows', 'Rows that an earlier file of this import already contains were skipped, so nothing is counted twice.', `${bucket.startIso.slice(0, 16)} (line ${line})`);
      return null;
    }
    this.keys.add(key);
    this.fileRange.add(bucket.startMs, bucket.seconds > 0 ? bucket.startMs + bucket.seconds * 1000 : null);
    if (bucket.seconds < 86400) this.fileHasHours = true;
    this.granularity.add(bucket.startMs, bucket.seconds);
    return key;
  }

  finish(what: 'usage' | 'cost', parts: Pick<ParsedImport, 'format' | 'formatLabel' | 'source' | 'missingFields' | 'stats'>): ParsedImport {
    this.meter.report();
    if (this.seen === 0) throw new ImportError(`The export has a header row but no data rows, so there is no ${what} to import.`, 'no_rows');
    if (this.emitted === 0) {
      const first = this.warnings.toArray()[0];
      throw new ImportError(
        `None of the ${this.seen} row${this.seen === 1 ? '' : 's'} of the export could be imported.${first ? ` ${first.message}${first.sample ? ` For example: ${first.sample}.` : ''}` : ''}`,
        'no_valid_rows',
      );
    }
    const clash = this.granularity.conflict();
    if (clash !== null) throw mixedGranularity(clash, what);
    const regrouped = this.grouping.conflict();
    if (regrouped !== null) throw mixedGrouping(regrouped, what);
    const ranges = this.coverage.ranges();
    return {
      ...parts,
      parserVersion: API_REPORTS_PARSER_VERSION,
      ...describeFiles(this.files),
      contentHash: this.meter.contentHash(),
      recordsSeen: this.seen,
      recordsSkipped: this.skipped,
      warnings: this.warnings.toArray(),
      ...(ranges.length > 0 ? { replaceRanges: ranges } : {}),
      stats: { rows: this.emitted, bytesRead: this.meter.bytesRead, ...parts.stats },
    };
  }
}

const DAY_MS = 86_400_000;

/** Columns that say what a row is about, as opposed to how much. */
const USAGE_DIMENSIONS = ['model_version', 'api_key', 'workspace', 'usage_type', 'context_window', 'inference_geo', 'speed'];
const COST_DIMENSIONS = ['model', 'workspace', 'api_key', 'usage_type', 'context_window', 'token_type', 'cost_type', 'inference_geo', 'speed'];

const USAGE_COUNTS: Array<[column: string, max: number]> = [
  ['usage_input_tokens_no_cache', Number.MAX_SAFE_INTEGER],
  ['usage_input_tokens_cache_write_5m', Number.MAX_SAFE_INTEGER],
  ['usage_input_tokens_cache_write_1h', Number.MAX_SAFE_INTEGER],
  ['usage_input_tokens_cache_write', Number.MAX_SAFE_INTEGER],
  ['usage_input_tokens_cache_read', Number.MAX_SAFE_INTEGER],
  ['usage_output_tokens', Number.MAX_SAFE_INTEGER],
  ['web_search_count', INT32_MAX],
];

async function importUsage(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
  const run = new ConsoleImport(files, sink, ctx, 'Reading usage export', 0);
  const absent = new Set<string>();
  let rowsWithModel = 0;
  let premiumModelRows = 0;
  let claudeCodeRows = 0;
  let haikuRows = 0;
  let tokens = 0;

  await run.eachRow(async (cell, has, line) => {
    const bucket = run.bucket(cell('usage_date_utc'), line);
    if (bucket === null) return;

    const counts: Record<string, number> = {};
    for (const [column, max] of USAGE_COUNTS) {
      const count = parseCount(cell(column), max);
      if (!count.ok) {
        const sample = `${column}: ${sampleOf(cell(column))} (line ${line})`;
        if (count.reason === 'too_large') return run.skip(TOO_LARGE.code, TOO_LARGE.message, sample);
        return run.skip('invalid_number', 'Rows with a token count that is negative or not a whole number were skipped.', sample);
      }
      counts[column] = count.value ?? 0;
    }

    for (const column of ['context_window', 'speed']) if (!has(column)) absent.add(column);
    const usageType = cell('usage_type').toLowerCase();
    if (usageType !== '' && !SERVICE_TIERS.has(usageType)) {
      run.warnings.add(
        'unknown_usage_type',
        'Rows have a usage_type this version does not know. They were imported as standard usage; if it is a discounted or premium kind of usage, its equivalent API value is off.',
        `${sampleOf(usageType)} (line ${line})`,
      );
    }

    const dedupKey = run.key(
      'api-csv',
      bucket,
      USAGE_DIMENSIONS.map((column): [string, string] => [column, cell(column)]),
      [
        counts.usage_input_tokens_no_cache,
        counts.usage_input_tokens_cache_read,
        counts.usage_input_tokens_cache_write_5m + counts.usage_input_tokens_cache_write,
        counts.usage_input_tokens_cache_write_1h,
        counts.usage_output_tokens,
      ],
      line,
    );
    if (dedupKey === null) return;

    const modelKey = await run.models.resolve(cell('model_version'));
    await sink.usage({
      conversationKey: null,
      modelKey,
      occurredAt: bucket.startIso,
      bucketSeconds: bucket.seconds,
      priceTier: tierForGeography(
        priceTierFor({ modelKey, serviceTier: usageType, speed: cell('speed'), contextWindow: cell('context_window') }),
        cell('inference_geo'),
      ),
      inputTokens: counts.usage_input_tokens_no_cache,
      outputTokens: counts.usage_output_tokens,
      cacheReadTokens: counts.usage_input_tokens_cache_read,
      cacheWrite5mTokens: counts.usage_input_tokens_cache_write_5m + counts.usage_input_tokens_cache_write,
      cacheWrite1hTokens: counts.usage_input_tokens_cache_write_1h,
      // The export has no request count.
      requestCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      webSearchRequests: counts.web_search_count,
      confidence: 'exact',
      dedupKey,
    });
    run.emitted++;

    if (modelKey !== null) rowsWithModel++;
    if (hasLongContextPremium(modelKey)) premiumModelRows++;
    if (modelKey === 'claude-haiku-5-5') haikuRows++;
    // Claude Code signs in to its own workspace and creates keys named claude_code_key_<user>_<suffix>.
    if (looksLikeClaudeCode(cell('workspace')) || cell('api_key').startsWith('claude_code_key_')) claudeCodeRows++;
    tokens +=
      counts.usage_input_tokens_no_cache + counts.usage_output_tokens + counts.usage_input_tokens_cache_read +
      counts.usage_input_tokens_cache_write_5m + counts.usage_input_tokens_cache_write + counts.usage_input_tokens_cache_write_1h;
  });

  const missingFields: string[] = [];
  if (rowsWithModel === 0) missingFields.push('model');
  // Exports made before the columns existed cannot tell these kinds of usage apart.
  const gaps: string[] = [];
  if (absent.has('speed')) gaps.push('speed');
  if (absent.has('context_window') && premiumModelRows > 0) gaps.push('context_window');
  missingFields.push(...gaps);
  if (gaps.length > 0) {
    const effects = gaps.map((g) => (g === 'speed' ? 'fast mode usage' : 'long-context usage of Claude Sonnet 4 and 4.5'));
    run.warnings.add(
      'tier_columns_missing',
      `This export has no ${gaps.join(' and no ')} column (exports made before the column existed do not), so ${effects.join(' and ')} ` +
        'cannot be told apart from standard usage and is valued at the standard price. A fresh export of the same period should include it.',
    );
  }
  noteClaudeCodeOverlap(run.warnings, claudeCodeRows);
  noteHaikuLongContext(run.warnings, haikuRows);

  return run.finish('usage', {
    format: USAGE_FORMAT,
    formatLabel: 'Claude Console usage export (CSV)',
    source: { kind: 'api_usage_report', label: 'Anthropic API usage report', externalRef: '' },
    missingFields,
    stats: { tokens, unknownModels: run.models.unknownCount },
  });
}

async function importCost(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
  const run = new ConsoleImport(files, sink, ctx, 'Reading cost export', 1);
  let total = Decimal.zero;

  await run.eachRow(async (cell, _has, line) => {
    const bucket = run.bucket(cell('usage_date_utc'), line);
    if (bucket === null) return;
    const amountUsd = usdAmount(cell('cost_usd'), 'dollars');
    if (amountUsd === null) {
      return run.skip('invalid_amount', 'Rows whose cost_usd is not a decimal number were skipped.', `${sampleOf(cell('cost_usd'))} (line ${line})`);
    }
    const dedupKey = run.key(
      'cost-csv',
      bucket,
      COST_DIMENSIONS.map((column): [string, string] => [column, cell(column)]),
      // hundred-millionths of a dollar, the unit amounts are stored in
      [Math.round(Number(amountUsd) * 1e8)],
      line,
    );
    if (dedupKey === null) return;

    const model = cell('model');
    await sink.cost({
      modelKey: MODEL_BY_DISPLAY_NAME.get(model.toLowerCase()) ?? (await run.models.resolve(model)),
      occurredAt: bucket.startIso,
      bucketSeconds: bucket.seconds,
      costType: COST_TYPES[cell('cost_type')] ?? (cell('cost_type') || null),
      tokenType: TOKEN_TYPES[cell('token_type')] ?? (cell('token_type') || null),
      // The export has no description; what the row is for is in the two types above.
      description: null,
      amountUsd,
      dedupKey,
    });
    run.emitted++;
    total = total.add(amountUsd);
  });

  return run.finish('cost', {
    format: COST_FORMAT,
    formatLabel: 'Claude Console cost export (CSV)',
    source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' },
    missingFields: [],
    stats: { totalUsd: total.toString(), unknownModels: run.models.unknownCount },
  });
}

/**
 * Entry point for a CSV file that may be a Console export. Looks at the header of
 * every file: Console usage exports and Console cost exports go to their importers,
 * anything else to the generic CSV importer with the same options.
 */
export const consoleCsvParser: ImportParser = {
  async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
    requireFiles(files);
    const formats = new Set<ConsoleCsvFormat | null>();
    for (const file of files) {
      if (file.size === 0) continue;
      const head = await readCsvHead(file.blob, 1);
      formats.add(head.records.length === 0 ? null : detectConsoleCsvFormat(head.records[0].fields));
    }
    if (formats.size > 1) {
      throw new ImportError(
        'The selected files are of different kinds (Claude Console usage exports, cost exports or other CSV files). Import each kind separately.',
        'mixed_files',
      );
    }
    const [format] = formats;
    if (format === USAGE_FORMAT) return importUsage(files, sink, ctx);
    if (format === COST_FORMAT) return importCost(files, sink, ctx);
    return genericCsvParser.parse(files, sink, ctx);
  },
};
