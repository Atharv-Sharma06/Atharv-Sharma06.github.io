import { ImportError, type ImportFile, type ImportSink, type ParseContext, type ParsedImport } from '@/core/types';
import { newJsonInputInfo, readJsonValues } from '../generic/json-input';
import { describeFiles, InputMeter, ModelRegistry, requireFiles, WarningList } from '../generic/shared';
import { clip, isObject, type Json } from '../generic/values';
import { apiErrorMessage, classifyReportItem, isReportPage, type ApiReportFormat } from './detect';
import {
  API_REPORTS_PARSER_VERSION,
  bucketKey,
  bucketSecondsBetween,
  describeBucket,
  dimensionsOf,
  GranularityGuard,
  isTimeBucket,
  RangeTracker,
  reportTime,
} from './dimensions';

/**
 * Reads usage or cost reports of either API and hands out their rows in one shape.
 *
 * Accepted input, per file: one response page, a list of pages, JSON Lines with a
 * page (or a list of pages) per line, and — because that is what iterating with an
 * SDK produces — the rows or time buckets themselves as a list or as JSON Lines.
 *
 * The reader owns everything the two report kinds have in common: recognising the
 * shape, time buckets, deduplication keys, the range the report restates, and the
 * warnings about paging and missing time buckets. usage.ts and cost.ts turn a row's
 * measurements into staged records.
 */
export interface ReportRow {
  shape: 'legacy' | 'analytics';
  /** Bucket start, ISO-8601 UTC. */
  startIso: string;
  bucketSeconds: number;
  /** Where the row's dimensions are: its `group` (analytics) or the result itself (legacy). */
  dims: Json;
  /** Where its measurements are: its `usage` / `cost` (analytics) or the result itself (legacy). */
  metrics: Json;
  /** Names of the dimensions the row has a value for, i.e. what the report is grouped by. */
  dimensionNames: string[];
  dedupKey: string;
}

export interface ReportKind {
  kind: 'usage' | 'cost';
  source: ParsedImport['source'];
  formats: { legacy: ApiReportFormat; analytics: ApiReportFormat };
  labels: { legacy: string; analytics: string };
  /** Prefix of the rows' deduplication keys. */
  keyPrefix: string;
  /** Text fields of a legacy result that are measurements rather than dimensions. */
  measurementFields: ReadonlySet<string>;
  phase: string;
}

const ENDPOINTS = {
  usage: '/v1/organizations/usage_report/messages or /v1/organizations/analytics/usage',
  cost: '/v1/organizations/cost_report or /v1/organizations/analytics/cost',
};

/** The error for an import that states one day at two granularities (see GranularityGuard). */
export function mixedGranularity(clash: { day: string; widths: [number, number] }, what: string): ImportError {
  return new ImportError(
    `This import holds ${describeBucket(clash.widths[0])} and ${describeBucket(clash.widths[1])} figures for the same days (for example ${clash.day}). ` +
      `Adding them up would count that ${what} twice. Import the files one at a time: each import replaces what earlier ones said about the period it covers.`,
    'mixed_granularity',
  );
}

export class ReportReader {
  readonly warnings = new WarningList();
  readonly meter: InputMeter;
  readonly models: ModelRegistry;

  private readonly range = new RangeTracker();
  private readonly granularity = new GranularityGuard();
  private readonly keys = new Set<string>();
  private format: ApiReportFormat | null = null;
  private shape: 'legacy' | 'analytics' | null = null;
  private pages = 0;
  private buckets = 0;
  private emptyBuckets = 0;
  private seen = 0;
  private skippedRows = 0;
  private emittedRows = 0;
  private morePages = 0;
  private lastPages = 0;
  private wholeRangeRows = 0;
  private wholeRangeSample: string | undefined;
  private dataRefreshedAt: string | null = null;
  private layouts = new Set<string>();

  constructor(
    private readonly files: ImportFile[],
    sink: ImportSink,
    ctx: ParseContext,
    private readonly kind: ReportKind,
  ) {
    requireFiles(files);
    this.meter = new InputMeter(files, sink, ctx, kind.phase);
    this.models = new ModelRegistry(sink);
  }

  /** Every row of every file, except rows that repeat an earlier one. */
  async *rows(): AsyncGenerator<ReportRow> {
    for (const file of this.files) {
      if (file.size === 0) continue;
      const info = newJsonInputInfo();
      for await (const value of readJsonValues(file.blob, this.meter.onBytes, info)) yield* this.entry(value);
      if (info.layout !== null) this.layouts.add(info.layout);
      if (info.truncated) {
        this.warnings.add(
          'truncated_file',
          'The file ends unexpectedly. Complete entries were read; the last one was cut off. Save the report again to be sure nothing is missing.',
          file.name,
        );
      }
    }
  }

  /** A row handed out by rows() turned out to be unusable. */
  skip(code: string, message: string, sample?: string): void {
    this.skippedRows++;
    this.warnings.add(code, message, sample);
  }

  /** A row handed out by rows() was staged. */
  emitted(): void {
    this.emittedRows++;
    this.meter.records = this.emittedRows;
  }

  /** Rows staged so far. */
  get emittedCount(): number {
    return this.emittedRows;
  }

  finish(extra: { missingFields: string[]; stats: Record<string, number | string | boolean> }): ParsedImport {
    this.meter.report();
    const what = this.kind.kind;
    const range = this.range.get();

    if (this.seen === 0) {
      const covered = range ? ` between ${range.start.slice(0, 10)} and ${range.end.slice(0, 10)}` : '';
      throw new ImportError(
        this.buckets > 0
          ? `The report has ${this.buckets} time bucket${this.buckets === 1 ? '' : 's'}${covered}, but none of them contains any ${what}. There is nothing to import.`
          : `The report contains no rows ("data" is empty), so there is nothing to import. Check the date range of the request; the Analytics API also returns nothing until the data for a period has been processed.`,
        'no_rows',
      );
    }
    if (this.emittedRows === 0) {
      const first = this.warnings.toArray()[0];
      throw new ImportError(
        `None of the ${this.seen} row${this.seen === 1 ? '' : 's'} in the report could be imported.${first ? ` ${first.message}${first.sample ? ` (for example: ${first.sample})` : ''}` : ''}`,
        'no_valid_rows',
      );
    }

    const clash = this.granularity.conflict();
    if (clash !== null) throw mixedGranularity(clash, what);

    if (this.wholeRangeRows > 0) {
      this.warnings.add(
        'no_time_buckets',
        `Rows of this report cover a whole date range instead of a minute, an hour or a day, so the ${what} cannot be placed on the days it happened. ` +
          'It is attributed to the start of the range. For a daily breakdown, request the report again with time_bucket_width=1d.',
        this.wholeRangeSample,
        this.wholeRangeRows,
      );
    }
    if (this.morePages > 0 && this.lastPages === 0) {
      this.warnings.add(
        'more_pages_available',
        'The report continues on a further page that is not in this file ("has_more" is true on every page). ' +
          'Request the next page with the "next_page" value as the "page" parameter and import it as well; until then the period is incomplete.',
        undefined,
        this.morePages,
      );
    }

    const format = this.format ?? this.kind.formats[this.shape ?? 'legacy'];
    const legacy = format === this.kind.formats.legacy;
    return {
      format,
      formatLabel: legacy ? this.kind.labels.legacy : this.kind.labels.analytics,
      parserVersion: API_REPORTS_PARSER_VERSION,
      source: { ...this.kind.source },
      ...describeFiles(this.files),
      contentHash: this.meter.contentHash(),
      recordsSeen: this.seen,
      recordsSkipped: this.skippedRows,
      missingFields: extra.missingFields,
      warnings: this.warnings.toArray(),
      ...(range ? { replaceRange: range } : {}),
      stats: {
        api: legacy ? 'usage-cost' : 'analytics',
        pages: this.pages,
        ...(legacy ? { timeBuckets: this.buckets, emptyBuckets: this.emptyBuckets } : {}),
        rows: this.emittedRows,
        ...(this.dataRefreshedAt ? { dataRefreshedAt: this.dataRefreshedAt } : {}),
        layout: [...this.layouts].join(', '),
        bytesRead: this.meter.bytesRead,
        ...extra.stats,
      },
    };
  }

  /** One top-level value of a file: a page, a row or bucket on its own, or a list of either. */
  private *entry(entry: unknown): Generator<ReportRow> {
    if (Array.isArray(entry)) {
      for (const inner of entry) yield* this.entry(inner);
      return;
    }
    this.meter.checkCancelled();
    const apiError = apiErrorMessage(entry);
    if (apiError !== null) {
      throw new ImportError(
        `This file holds an error message from the Anthropic API instead of a report: "${clip(apiError, 200)}". ` +
          'Run the request again and save the response once it succeeds.',
        'api_error_response',
      );
    }

    if (!isReportPage(entry)) {
      // A row or bucket saved without the page around it (what iterating with an SDK yields).
      yield* this.item(entry, true);
      return;
    }

    // Other list endpoints of the API answer with a "data" list as well.
    const foreign =
      entry.data.length === 0 ? !('has_more' in entry) : entry.data.every((item) => classifyReportItem(item) === null);
    if (foreign) throw this.notAReport(entry);

    this.pages++;
    if (entry.has_more === true) this.morePages++;
    else if (entry.has_more === false) this.lastPages++;
    if (typeof entry.data_refreshed_at === 'string' && (this.dataRefreshedAt === null || entry.data_refreshed_at > this.dataRefreshedAt)) {
      this.dataRefreshedAt = entry.data_refreshed_at;
    }
    for (const item of entry.data) yield* this.item(item, false);
  }

  private *item(item: unknown, bare: boolean): Generator<ReportRow> {
    const kind = classifyReportItem(item);
    if (kind === null || !isObject(item)) {
      // Outside a page, something that is not a row means the file is something else altogether.
      if (bare) throw this.notAReport(item);
      this.seen++;
      this.skip('unrecognised_rows', 'Entries of the report that are neither a time bucket nor a row were skipped.', clip(item, 80));
      return;
    }

    const startMs = reportTime(item.starting_at);
    const endMs = reportTime(item.ending_at);

    if (kind === 'empty-bucket') {
      this.setShape('legacy');
      this.buckets++;
      this.emptyBuckets++;
      // An empty bucket is a statement too: nothing was used then. It belongs to the restated range.
      if (startMs !== null) this.range.add(startMs, endMs);
      return;
    }
    this.setFormat(kind);

    if (this.shape === 'legacy') {
      const results = item.results as unknown[];
      this.buckets++;
      if (startMs === null) {
        this.seen += results.length;
        this.skippedRows += results.length;
        this.warnings.add('invalid_timestamp', 'Time buckets whose "starting_at" is not a valid timestamp were skipped.', clip(item.starting_at), results.length);
        return;
      }
      this.range.add(startMs, endMs);
      for (const result of results) {
        if (!isObject(result)) {
          this.seen++;
          this.skip('unrecognised_rows', 'Entries of the report that are neither a time bucket nor a row were skipped.', clip(result, 80));
          continue;
        }
        const row = this.row(startMs, endMs, result, result);
        if (row !== null) yield row;
      }
      return;
    }

    if (startMs === null) {
      this.seen++;
      this.skip('invalid_timestamp', 'Rows whose "starting_at" is not a valid timestamp were skipped.', clip(item.starting_at));
      return;
    }
    this.range.add(startMs, endMs);
    const metrics = (this.kind.kind === 'usage' ? item.usage : item.cost) as Json;
    const row = this.row(startMs, endMs, isObject(item.group) ? item.group : {}, metrics);
    if (row !== null) yield row;
  }

  private row(startMs: number, endMs: number | null, dims: Json, metrics: Json): ReportRow | null {
    this.seen++;
    const shape = this.shape as 'legacy' | 'analytics';
    const startIso = new Date(startMs).toISOString();
    const bucketSeconds = bucketSecondsBetween(startMs, endMs);
    const dimensions = shape === 'legacy' ? dimensionsOf(dims, 'result', this.kind.measurementFields) : dimensionsOf(dims, 'group');
    const dedupKey = bucketKey(this.kind.keyPrefix, startIso, bucketSeconds, dimensions);
    if (this.keys.has(dedupKey)) {
      this.skip(
        'duplicate_rows',
        'Rows that describe a time bucket and grouping an earlier row of this import already covered were skipped, so nothing is counted twice. ' +
          'This happens when the same page is in the file twice, or when differently filtered reports of one period are combined; ' +
          'in the second case request one report grouped by the dimension you filtered on (for example workspace_id).',
        startIso,
      );
      return null;
    }
    this.keys.add(dedupKey);
    this.granularity.add(startMs, bucketSeconds);
    if (bucketSeconds > 0 && !isTimeBucket(bucketSeconds)) {
      this.wholeRangeRows++;
      this.wholeRangeSample ??= `${startIso.slice(0, 10)} to ${new Date(endMs as number).toISOString().slice(0, 10)}`;
    }
    return { shape, startIso, bucketSeconds, dims, metrics, dimensionNames: dimensions.pairs.map(([name]) => name), dedupKey };
  }

  private setShape(shape: 'legacy' | 'analytics'): void {
    if (this.shape === null) this.shape = shape;
    else if (this.shape !== shape) {
      throw new ImportError(
        'This import mixes responses of the legacy Usage and Cost API with responses of the Usage and Cost Analytics API. ' +
          'Import them separately, so that a period both of them cover is not counted twice.',
        'mixed_report_shapes',
      );
    }
  }

  private setFormat(format: ApiReportFormat): void {
    const { formats, kind } = this.kind;
    if (format !== formats.legacy && format !== formats.analytics) {
      throw new ImportError(
        kind === 'usage'
          ? 'This file is a cost report, not a usage report: its rows hold amounts instead of token counts. Import it as an API cost report.'
          : 'This file is a usage report, not a cost report: its rows hold token counts instead of amounts. Import it as an API usage report.',
        'wrong_report_type',
      );
    }
    this.setShape(format === formats.legacy ? 'legacy' : 'analytics');
    this.format = format;
  }

  private notAReport(found: unknown): ImportError {
    const keys = isObject(found) ? Object.keys(found).slice(0, 6).join(', ') : '';
    return new ImportError(
      `This JSON file is not an Anthropic ${this.kind.kind} report. A report is the response of ${ENDPOINTS[this.kind.kind]}, ` +
        `saved as it was returned: an object with a "data" list of time buckets or rows` +
        (keys ? ` (this file has: ${keys}).` : '.'),
      'not_a_report',
    );
  }
}
