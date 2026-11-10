import { ImportError, type ImportFile, type ImportSink, type ParseContext, type ParsedImport } from '@/core/types';
import { newJsonInputInfo, readJsonValues } from '../generic/json-input';
import { describeFiles, InputMeter, ModelRegistry, requireFiles, WarningList } from '../generic/shared';
import { clip, isObject, type Json } from '../generic/values';
import { apiErrorMessage, classifyReportItem, isReportPage, type ApiReportFormat } from './detect';
import {
  API_REPORTS_PARSER_VERSION,
  bucketKey,
  bucketSecondsBetween,
  Coverage,
  describeBucket,
  dimensionsOf,
  GranularityGuard,
  GroupingGuard,
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
 * shape, time buckets, deduplication keys, the time the report restates, and the
 * warnings about paging and missing time buckets. usage.ts and cost.ts turn a row's
 * measurements into staged records.
 *
 * Which time an import speaks for depends on the API, because the two page differently:
 *  - The legacy API lists every time bucket of the requested range, empty ones
 *    included, oldest first, a fixed number of buckets per page. So exactly the
 *    buckets that are listed are restated; a page on its own is a complete statement
 *    of its buckets, and the time of a page that was left out is not touched.
 *  - The Analytics API leaves out buckets without usage and ranks rows by size across
 *    the whole range, so every page reaches from the first to the last day. A file
 *    speaks for the stretch from its first row to its last, and a selection that lacks
 *    the last page is refused: its rows are the largest ones, not a period.
 */
export interface ReportRow {
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
  /** What a row measures, as numbers that add up: used to notice one period stated twice under two groupings. */
  figures(metrics: Json): number[];
  /** How far two sums of figures may differ per row and still be the same statement (amounts are rounded per row). */
  figureTolerance: number;
}

const ENDPOINTS = {
  usage: '/v1/organizations/usage_report/messages or /v1/organizations/analytics/usage',
  cost: '/v1/organizations/cost_report or /v1/organizations/analytics/cost',
};

/** The error for an import that states one period under two groupings (see GroupingGuard). */
export function mixedGrouping(clash: { day: string; groupings: [string[], string[]] }, what: string): ImportError {
  const name = (names: string[]) => (names.length === 0 ? 'not broken down' : `broken down by ${names.join(', ')}`);
  return new ImportError(
    `This import holds the same ${what} twice: once ${name(clash.groupings[0])} and once ${name(clash.groupings[1])} (for example on ${clash.day}, where both add up to the same figures). ` +
      `Adding them up would count that ${what} twice. Import only the more detailed files, or import the files one at a time: each import replaces what earlier ones said about the period it covers.`,
    'mixed_grouping',
  );
}

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

  private readonly coverage = new Coverage();
  /** First to last row of the file being read (Analytics API). */
  private fileRange = new RangeTracker();
  private readonly granularity = new GranularityGuard();
  /**
   * One guard takes a file as the unit and one a page. A report saved page by page in one file is
   * whole only as the file; two reports saved into one file are apart only as pages.
   */
  private readonly groupingByFile: GroupingGuard;
  private readonly groupingByPage: GroupingGuard;
  private readonly keys = new Set<string>();
  /** Starts of all legacy buckets, and where each legacy page that announces a further page ends. */
  private readonly bucketStarts = new Set<number>();
  private readonly continuesAt: number[] = [];
  private pageEnd = -Infinity;
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
    this.groupingByFile = new GroupingGuard(kind.figureTolerance);
    this.groupingByPage = new GroupingGuard(kind.figureTolerance);
  }

  /** Every row of every file, except rows that repeat an earlier one. */
  async *rows(): AsyncGenerator<ReportRow> {
    for (const file of this.files) {
      if (file.size === 0) continue;
      const info = newJsonInputInfo();
      this.fileRange = new RangeTracker();
      for await (const value of readJsonValues(file.blob, this.meter.onBytes, info)) yield* this.entry(value);
      const stretch = this.fileRange.bounds();
      if (stretch !== null) this.coverage.add(stretch[0], stretch[1]);
      this.groupingByFile.endUnit();
      this.groupingByPage.endUnit();
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
    const ranges = this.coverage.ranges();

    if (this.seen === 0) {
      const covered = ranges.length > 0 ? ` between ${ranges[0].start.slice(0, 10)} and ${ranges[ranges.length - 1].end.slice(0, 10)}` : '';
      // Empty buckets look the same in a usage and in a cost report.
      const nothing = this.format === null ? 'usage or cost' : what;
      throw new ImportError(
        this.buckets > 0
          ? `The report has ${this.buckets} time bucket${this.buckets === 1 ? '' : 's'}${covered}, but none of them contains any ${nothing}. There is nothing to import.`
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
    const regrouped = this.groupingByFile.conflict() ?? this.groupingByPage.conflict();
    if (regrouped !== null) throw mixedGrouping(regrouped, what);

    // Rows of the Analytics API are ranked by size across the whole range, so the pages before the last
    // one are the largest rows of every day, not a period. Stored as they are they would pass for the
    // period's usage, and a later import of the remaining pages would replace them.
    if (this.shape === 'analytics' && this.morePages > 0 && this.lastPages === 0) {
      throw new ImportError(
        'This is only part of a report: every page in the selection says that a further page follows ("has_more" is true), and the last page is missing. ' +
          'The rows of this API are ranked by size, not by date, so a part of the report does not cover a period. ' +
          'Request the remaining pages (pass each "next_page" value as the "page" parameter) and select all pages together. Nothing was saved.',
        'incomplete_report',
      );
    }

    if (this.wholeRangeRows > 0) {
      this.warnings.add(
        'no_time_buckets',
        `Rows of this report cover a whole date range instead of a minute, an hour or a day, so the ${what} cannot be placed on the days it happened. ` +
          'It is attributed to the start of the range. For a daily breakdown, request the report again with time_bucket_width=1d.',
        this.wholeRangeSample,
        this.wholeRangeRows,
      );
    }
    // A legacy page that announces a further page ends where that page begins. When no bucket of the
    // selection starts there, the page that follows was left out.
    const open = this.continuesAt.filter((end) => !this.bucketStarts.has(end)).sort((a, b) => a - b);
    if (open.length > 0 || (this.shape === 'legacy' && this.continuesAt.length === 0 && this.morePages > 0 && this.lastPages === 0)) {
      this.warnings.add(
        'more_pages_available',
        'The report continues on a page that is not in the selection ("has_more" is true on the page before it). ' +
          'The time that page covers is missing here and is left as it is. Request it with the "next_page" value as the "page" parameter and import it, ' +
          'together with these pages or on its own.',
        open.length > 0 ? `missing from ${new Date(open[0]).toISOString().slice(0, 16).replace('T', ' ')} UTC` : undefined,
        Math.max(open.length, 1),
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
      ...(ranges.length > 0 ? { replaceRanges: ranges } : {}),
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
    this.pageEnd = -Infinity;
    // Rows that stood on their own before this page are a unit of their own.
    this.groupingByPage.endUnit();
    for (const item of entry.data) yield* this.item(item, false);
    this.groupingByPage.endUnit();
    if (entry.has_more === true && this.shape === 'legacy' && this.pageEnd !== -Infinity) this.continuesAt.push(this.pageEnd);
  }

  /** A time bucket of the legacy API: listed, so restated, with or without results. */
  private legacyBucket(startMs: number, endMs: number | null): void {
    this.coverage.add(startMs, endMs);
    this.bucketStarts.add(startMs);
    if (endMs !== null && endMs > this.pageEnd) this.pageEnd = endMs;
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
      // An empty bucket is a statement too: nothing was used then. It belongs to the restated time.
      if (startMs !== null) this.legacyBucket(startMs, endMs);
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
      this.legacyBucket(startMs, endMs);
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
    this.fileRange.add(startMs, endMs);
    const metrics = (this.kind.kind === 'usage' ? item.usage : item.cost) as Json;
    const row = this.row(startMs, endMs, isObject(item.group) ? item.group : {}, metrics);
    if (row !== null) yield row;
  }

  private row(startMs: number, endMs: number | null, dims: Json, metrics: Json): ReportRow | null {
    this.seen++;
    const startIso = new Date(startMs).toISOString();
    const bucketSeconds = bucketSecondsBetween(startMs, endMs);
    const dimensions = this.shape === 'legacy' ? dimensionsOf(dims, 'result', this.kind.measurementFields) : dimensionsOf(dims, 'group');
    const dedupKey = bucketKey(this.kind.keyPrefix, startIso, bucketSeconds, dimensions);
    // Before repeats are dropped: a file's figures are what it states, whatever is imported of it.
    const names = dimensions.pairs.map(([name]) => name);
    const figures = this.kind.figures(metrics);
    this.groupingByFile.add(startMs, bucketSeconds, names, figures);
    this.groupingByPage.add(startMs, bucketSeconds, names, figures);
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
    return { startIso, bucketSeconds, dims, metrics, dimensionNames: names, dedupKey };
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
