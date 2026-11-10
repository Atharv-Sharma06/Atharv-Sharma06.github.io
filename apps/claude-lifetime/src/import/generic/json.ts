import { ImportError, type ImportFile, type ImportParser, type ImportSink, type ParseContext, type ParsedImport } from '@/core/types';
import { detectApiReportFormat } from '../api-reports/detect';
import { GENERIC_FIELDS } from './fields';
import { newJsonInputInfo, readJsonValues } from './json-input';
import { DEFAULT_SOURCE_LABEL, finishGenericImport, GenericUsageBuilder, readGenericOptions, type RawRecord } from './records';
import { InputMeter, ModelRegistry, requireFiles, WarningList } from './shared';
import { clip, isObject, type Json } from './values';

/**
 * Importer for usage data in the app's own JSON format — the format to write when
 * exporting usage from another system, or by hand.
 *
 *     {
 *       "format": "claude-lifetime/usage",
 *       "version": 1,
 *       "source": { "label": "My proxy logs", "ref": "proxy-eu-1" },
 *       "records": [
 *         {
 *           "timestamp": "2026-03-01T09:15:00Z",
 *           "model": "claude-sonnet-4-6",
 *           "input_tokens": 1200,
 *           "output_tokens": 350,
 *           "cache_read_tokens": 8000,
 *           "cache_write_5m_tokens": 0,
 *           "cache_write_1h_tokens": 0,
 *           "requests": 1,
 *           "conversation_id": "conv-1",
 *           "conversation_title": "Refactoring notes",
 *           "id": "req-0001",
 *           "price_tier": "standard"
 *         },
 *         { "timestamp": "2026-03-02", "model": "claude-opus-4-6", "total_tokens": 62000 }
 *       ]
 *     }
 *
 *  - `format` and `version` identify the file; `version` must be 1.
 *  - `source` is optional. `label` names the data source in the app and `ref` is a
 *    stable identity for it (files with the same ref belong to one source). The
 *    options `sourceLabel` / `sourceRef` chosen in the UI take precedence.
 *  - A record has the fields of the CSV importer, under exactly these names (see
 *    csv.ts): timestamp (required), model, input_tokens, output_tokens,
 *    cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
 *    cache_write_1h_tokens, total_tokens, requests, conversation_id,
 *    conversation_title, id, price_tier, bucket_seconds. Counts may be numbers or
 *    numeric strings; `timestamp` may be ISO 8601 text, a date, or a number of epoch
 *    seconds or milliseconds. Other fields are ignored.
 *
 * Also accepted: a bare array of such records, and JSON Lines with one record per
 * line. Both are read record by record, so they suit very large files; the wrapped
 * form above is read whole.
 *
 * Validation, warnings, deduplication and the `confidence` option are the CSV
 * importer's (records.ts).
 */
export const GENERIC_JSON_FORMAT = 'claude-lifetime/usage';
export const GENERIC_JSON_VERSION = 1;

const SHAPE_HINT =
  'Each record needs a "timestamp" and token counts, for example {"timestamp": "2026-03-01T09:15:00Z", "model": "claude-sonnet-4-6", "input_tokens": 1200, "output_tokens": 350}.';

export const genericJsonParser: ImportParser = {
  async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
    requireFiles(files);
    const options = readGenericOptions(ctx);
    const meter = new InputMeter(files, sink, ctx, 'Reading records');
    const warnings = new WarningList();
    const models = new ModelRegistry(sink);
    const builder = new GenericUsageBuilder(sink, options, warnings, models);
    let fileLabel: string | null = null;
    const layouts = new Set<string>();

    const record = async (value: unknown): Promise<void> => {
      const where = `record ${builder.seen + 1}`;
      if (!isObject(value)) {
        builder.reject('not_a_record', 'Entries that are not objects were skipped.', `${clip(value, 30)} (${where})`);
        return;
      }
      const raw: RawRecord = {};
      for (const field of GENERIC_FIELDS) if (Object.hasOwn(value, field)) raw[field] = value[field];
      await builder.add(raw, where);
      meter.records = builder.seen;
      if ((builder.seen & 1023) === 0) meter.checkCancelled();
    };

    const wrapped = async (doc: Json): Promise<void> => {
      if (doc.format !== undefined && doc.format !== GENERIC_JSON_FORMAT) {
        throw new ImportError(
          `The file says its format is "${clip(doc.format, 60)}", which this importer does not read. It reads files with "format": "${GENERIC_JSON_FORMAT}".`,
          'wrong_format',
        );
      }
      if (doc.version !== undefined && doc.version !== GENERIC_JSON_VERSION) {
        throw new ImportError(
          `The file is version ${clip(doc.version, 20)} of the usage format; this version of the app reads version ${GENERIC_JSON_VERSION}. Update the app, or export the data as version ${GENERIC_JSON_VERSION}.`,
          'unsupported_version',
        );
      }
      if (isObject(doc.source)) {
        const label = typeof doc.source.label === 'string' ? doc.source.label.trim().slice(0, 200) : '';
        const ref = typeof doc.source.ref === 'string' ? doc.source.ref.trim().slice(0, 200) : '';
        if (label !== '') fileLabel ??= label;
        // What the user chose in the UI wins over what the file says about itself.
        if (ref !== '' && options.sourceRef === null) builder.setSourceRef(ref);
      }
      for (const entry of doc.records as unknown[]) await record(entry);
    };

    for (const file of files) {
      if (file.size === 0) continue;
      const info = newJsonInputInfo();
      for await (const value of readJsonValues(file.blob, meter.onBytes, info)) {
        if (Array.isArray(value)) {
          for (const entry of value) await record(entry);
        } else if (isObject(value) && Array.isArray(value.records)) {
          await wrapped(value);
        } else if (detectApiReportFormat(value) !== null) {
          throw new ImportError(
            'This file is a usage or cost report of the Anthropic API, not a file in the "claude-lifetime/usage" format. Import it as an API usage report or an API cost report.',
            'wrong_format',
          );
        } else {
          await record(value);
        }
      }
      if (info.layout !== null) layouts.add(info.layout);
      if (info.truncated) {
        warnings.add(
          'truncated_file',
          'The file ends unexpectedly. Complete records were read; the last one was cut off. Save the file again to be sure nothing is missing.',
          file.name,
        );
      }
    }
    await builder.finish();

    return finishGenericImport({
      files,
      meter,
      builder,
      models,
      kind: 'generic_json',
      format: GENERIC_JSON_FORMAT,
      formatLabel: 'Usage data (JSON)',
      sourceLabel: options.sourceLabel ?? fileLabel ?? DEFAULT_SOURCE_LABEL,
      emptyMessage: `The file contains no usage records. ${SHAPE_HINT}`,
      shapeHint: SHAPE_HINT,
      stats: { layout: [...layouts].join(', ') },
    });
  },
};
