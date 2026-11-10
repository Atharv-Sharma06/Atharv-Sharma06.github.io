import { ImportError, type ImportFile, type ImportParser, type ImportSink, type ParseContext, type ParsedImport } from '@/core/types';
import { readCsv, readCsvHead } from '../util/csv';
import { checkCsvMapping, columnIndexes, detectCsvMapping, GENERIC_FIELDS, type GenericField, type GenericMapping, type MappingResult } from './fields';
import { DEFAULT_SOURCE_LABEL, finishGenericImport, GenericUsageBuilder, readGenericOptions, type RawRecord } from './records';
import { InputMeter, ModelRegistry, requireFiles, WarningList } from './shared';
import { isObject } from './values';

/**
 * Importer for usage data in a CSV file of the user's own making (a spreadsheet, a
 * log, the export of another tool).
 *
 * The file: UTF-8 (or UTF-16 with a byte order mark), comma, semicolon or tab
 * separated, column names in the first row, one row per usage record:
 *
 *     timestamp,model,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,requests,conversation_id,conversation_title,id,price_tier,bucket_seconds
 *     2026-03-01T09:15:00Z,claude-sonnet-4-6,1200,350,8000,0,0,1,conv-1,Refactoring notes,req-0001,standard,
 *     2026-03-02,claude-opus-4-6,50000,12000,0,0,0,40,,,day-2026-03-02,batch,
 *
 * Fields (only `timestamp` and one token column are required; see fields.ts):
 *   timestamp              ISO 8601 date-time (UTC unless it carries an offset), a date
 *                          YYYY-MM-DD (the whole UTC day), or Unix epoch seconds / milliseconds
 *   model                  model identifier; unknown identifiers are kept as they are
 *   input_tokens           uncached input tokens
 *   output_tokens          output tokens
 *   cache_read_tokens      input tokens read from the prompt cache
 *   cache_write_tokens     cache writes of unknown lifetime (stored as 5-minute writes)
 *   cache_write_5m_tokens  5-minute cache writes
 *   cache_write_1h_tokens  1-hour cache writes
 *   total_tokens           used only when a row has no input/output split; such rows are
 *                          counted under the tier "uncategorised" and never priced
 *   requests               number of API requests
 *   conversation_id        groups rows into a conversation
 *   conversation_title     title of that conversation
 *   id                     identifies the record; the same id is never imported twice
 *   price_tier             standard (default), batch, fast, long_context, priority, flex
 *   bucket_seconds         width of the period a row adds up (default: 86400 for a date, else 0)
 *
 * Columns may have other names: `ctx.options.mapping` maps our field names to the
 * file's headers, and without it the headers are matched by their usual aliases
 * (detectCsvMapping). Options: `mapping`, `confidence` ('exact' | 'estimated',
 * default 'estimated'), `sourceLabel`, `sourceRef`, `delimiter`.
 *
 * A row is identified by its `id` when that column is mapped, otherwise by a hash
 * of its values, so importing the same file again adds nothing.
 *
 * A row with more values than the header has columns is skipped, with a warning; a
 * row with fewer is read, and the values missing at its end count as empty.
 */
export const GENERIC_CSV_FORMAT = 'generic/csv';

const SURPLUS_VALUES =
  'Rows with more values than the header has columns were skipped, because their values cannot be matched to the columns. ' +
  'A value probably contains the delimiter, for example a number written as 1,200,000: such values have to be enclosed in quotation marks. ' +
  'A delimiter at the end of a row counts as one more value.';

const MISSING_VALUES = 'Some rows have fewer values than the header has columns. They were read, and the values missing at their end count as empty.';

export interface CsvPreview {
  /** Column names, trimmed. */
  header: string[];
  delimiter: string;
  /** The first data rows, for showing example values next to each column. */
  sampleRows: string[][];
  /** The mapping that would be used without `options.mapping`, and what it lacks. */
  detected: MappingResult;
}

/**
 * Reads the header and a few rows of a CSV file for the mapping step of the import
 * UI. Only the beginning of the file is read.
 */
export async function previewCsv(blob: Blob, options: { delimiter?: string; rows?: number } = {}): Promise<CsvPreview> {
  if (blob.size === 0) throw new ImportError('The file is empty.', 'empty_file');
  const { records, delimiter } = await readCsvHead(blob, (options.rows ?? 5) + 1, { delimiter: options.delimiter });
  if (records.length === 0) throw new ImportError('The file is empty.', 'empty_file');
  const header = records[0].fields.map((h) => h.trim());
  return { header, delimiter, sampleRows: records.slice(1).map((r) => r.fields), detected: detectCsvMapping(header) };
}

const DELIMITER_NAMES: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

export const genericCsvParser: ImportParser = {
  async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
    requireFiles(files);
    const options = readGenericOptions(ctx);
    const chosen = ctx.options?.mapping;
    if (chosen !== undefined && chosen !== null && !isObject(chosen)) {
      throw new ImportError('The "mapping" option must be an object of field names and column headers.', 'invalid_option');
    }
    const delimiterOption = typeof ctx.options?.delimiter === 'string' && ctx.options.delimiter !== '' ? ctx.options.delimiter : undefined;

    const meter = new InputMeter(files, sink, ctx, 'Reading rows');
    const warnings = new WarningList();
    const models = new ModelRegistry(sink);
    const builder = new GenericUsageBuilder(sink, options, warnings, models, 'generic_csv');
    let delimiter = ',';
    let mapping: GenericMapping = {};

    for (const file of files) {
      if (file.size === 0) continue;
      let columns: Partial<Record<GenericField, number>> | null = null;
      let width = 0;
      const records = readCsv(file.blob.stream() as ReadableStream<Uint8Array>, {
        delimiter: delimiterOption,
        onBytes: meter.onBytes,
        onDelimiter: (d) => (delimiter = d),
      });
      for await (const record of records) {
        if (columns === null) {
          const header = record.fields.map((h) => h.trim());
          const result = isObject(chosen) ? checkCsvMapping(header, chosen) : detectCsvMapping(header);
          if (result.problems.length > 0) throw new ImportError(result.problems[0].message, result.problems[0].code);
          mapping = result.mapping;
          columns = columnIndexes(header, mapping);
          width = header.length;
          continue;
        }
        // Spreadsheets pad files with rows of nothing but delimiters.
        if (record.fields.every((f) => f.trim() === '')) continue;
        const shape = `line ${record.line}: ${record.fields.length} values, ${width} columns`;
        if (record.fields.length > width) {
          // One value too many means a delimiter inside a value, and it is not known which: from there on every
          // value would be read as its neighbour's column. An empty value at the end does not make the row safe
          // either, because "1,200" followed by an empty cell is written the same way. Read by position, such a
          // row would store a guess as a token count.
          builder.reject('column_count_mismatch', SURPLUS_VALUES, shape);
        } else {
          // A row that stops early is read: exports leave out empty cells at the end of a row. It is noted all
          // the same, because a row cut in two by a line break inside a value looks no different.
          if (record.fields.length < width) warnings.add('short_rows', MISSING_VALUES, shape);
          const raw: RawRecord = {};
          for (const field of GENERIC_FIELDS) {
            const index = columns[field];
            if (index !== undefined) raw[field] = record.fields[index] ?? '';
          }
          await builder.add(raw, `line ${record.line}`);
        }
        meter.records = builder.seen;
        if ((builder.seen & 1023) === 0) meter.checkCancelled();
      }
      if (columns === null) throw new ImportError(`"${file.name}" contains no rows.`, 'empty_file');
    }
    await builder.finish();

    return finishGenericImport({
      files,
      meter,
      builder,
      models,
      format: GENERIC_CSV_FORMAT,
      formatLabel: 'Usage data (CSV)',
      sourceLabel: options.sourceLabel ?? DEFAULT_SOURCE_LABEL,
      emptyMessage: 'The file has a header row but no data rows, so there is nothing to import.',
      shapeHint: 'Check the column mapping and the format of the values.',
      stats: {
        delimiter: DELIMITER_NAMES[delimiter] ?? delimiter,
        mapping: GENERIC_FIELDS.filter((f) => mapping[f] !== undefined)
          .map((f) => `${f}=${mapping[f]}`)
          .join(', '),
      },
    });
  },
};
