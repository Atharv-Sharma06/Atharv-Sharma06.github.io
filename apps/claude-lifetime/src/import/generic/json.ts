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
 *  - `format` and `version` identify the file; `version` must be 1 (written as a
 *    number, or as the text "1").
 *  - `source` is optional. `label` names the data source in the app and `ref` is a
 *    stable identity for it (files with the same ref belong to one source). The
 *    options `sourceLabel` / `sourceRef` chosen in the UI take precedence. One import
 *    is filed under one source, so files that name different sources are refused
 *    when they are selected together (see `nameSource` below).
 *  - A record has the fields of the CSV importer, under exactly these names (see
 *    csv.ts): timestamp (required), model, input_tokens, output_tokens,
 *    cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
 *    cache_write_1h_tokens, total_tokens, requests, conversation_id,
 *    conversation_title, id, price_tier, bucket_seconds. Counts may be numbers or
 *    numeric strings; `timestamp` may be ISO 8601 text, a date, or a number of epoch
 *    seconds or milliseconds. `id` and `conversation_id` are best written as text: a
 *    number is used only while JSON holds it exactly, up to 9007199254740991. Other
 *    fields are ignored.
 *
 * Also accepted: a bare array of such records, and JSON Lines with one record per
 * line. Both are read record by record, so they suit very large files; the wrapped
 * form above is read whole.
 *
 * Validation, warnings, deduplication and the `confidence` option are the CSV
 * importer's (records.ts). The format has no field for the confidence: whether the
 * counts were metered is asked in the import UI before the file is read
 * (questions.ts).
 */
export const GENERIC_JSON_FORMAT = 'claude-lifetime/usage';
export const GENERIC_JSON_VERSION = 1;

const EXAMPLE_RECORD = '{"timestamp": "2026-03-01T09:15:00Z", "model": "claude-sonnet-4-6", "input_tokens": 1200, "output_tokens": 350}';

const SHAPE_HINT = `Each record needs a "timestamp" and token counts, for example ${EXAMPLE_RECORD}.`;

/** What kind of JSON value something is, for a message. */
const kindOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value === 'object' ? 'an object' : `a ${typeof value}`);

/**
 * True for a document that wraps records, as opposed to being one. A record always
 * has a timestamp. A document without one that holds "records" or names this format
 * is meant as the wrapped form, also when its "records" are missing or are not a
 * list: read as a single record, it would be reported as a row without a timestamp,
 * which says nothing about what is wrong with the file.
 */
function isWrapped(value: Json): boolean {
  if (Array.isArray(value.records)) return true;
  return !Object.hasOwn(value, 'timestamp') && (Object.hasOwn(value, 'records') || value.format === GENERIC_JSON_FORMAT);
}

/** The version a document states, also when it is written as text ("1"). Null for anything that is not a number. */
function statedVersion(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** A source as a document names it, or as records are filed: `label` is null and `ref` is '' where there is none. */
interface SourceName {
  label: string | null;
  ref: string;
}

/** What a source is called in a message. Null for records that name no source at all. */
function describeSource(source: SourceName): string | null {
  if (source.label === null && source.ref === '') return null;
  const reference = source.ref === '' ? 'no reference' : `reference "${clip(source.ref, 60)}"`;
  return source.label === null ? `the source with the ${reference}` : `"${clip(source.label, 60)}" (${reference})`;
}

/**
 * The error for input that names two sources. `withinFile`: both are named inside
 * the one file. `storedApart`: imported on their own, the two would be stored as two
 * sources. With one reference (or none) they would be one source under either name,
 * and the advice must not promise otherwise.
 */
function mixedSources(file: ImportFile, withinFile: boolean, named: SourceName, used: SourceName, storedApart: boolean): ImportError {
  const before = describeSource(used);
  const origin = before === null ? 'name no source' : `come from ${before}`;
  const what = withinFile
    ? `"${file.name}" holds records of more than one source: some say they come from ${describeSource(named)}, but the records before them ${origin}.`
    : `"${file.name}" says its records come from ${describeSource(named)}, but the records read before it ${origin}.`;
  const how = withinFile ? 'Save the records of each source in a file of their own and import the files one at a time' : 'Import the files one at a time';
  const outcome = storedApart
    ? ', so that each is filed under its own source.'
    : '. Files with the same "ref", or without one, are stored as one source, shown under the name that was imported last; give each its own "ref" to keep them apart.';
  return new ImportError(`${what} One import is filed under one source. ${how}${outcome}`, 'mixed_sources');
}

export const genericJsonParser: ImportParser = {
  async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
    requireFiles(files);
    const options = readGenericOptions(ctx);
    const meter = new InputMeter(files, sink, ctx, 'Reading records');
    const warnings = new WarningList();
    const models = new ModelRegistry(sink);
    const builder = new GenericUsageBuilder(sink, options, warnings, models, 'generic_json');
    /** The name the documents read so far give their source, when one of them gives one. */
    let fileLabel: string | null = null;
    const layouts = new Set<string>();

    const record = async (value: unknown): Promise<void> => {
      const where = `record ${builder.seen + 1}`;
      if (!isObject(value)) {
        // Only what kind of value it is: a stray text in the list is not quoted in a warning.
        builder.reject('not_a_record', 'Entries that are not objects with fields were skipped.', `${kindOf(value)} (${where})`);
        return;
      }
      const raw: RawRecord = {};
      for (const field of GENERIC_FIELDS) if (Object.hasOwn(value, field)) raw[field] = value[field];
      await builder.add(raw, where);
      meter.records = builder.seen;
      if ((builder.seen & 1023) === 0) meter.checkCancelled();
    };

    /**
     * Takes in what a wrapped document says about the source of its records.
     *
     * One import is stored under one source, and every key it writes carries that
     * source's reference. A document that names another source than the one records
     * were already read under can therefore not be filed correctly any more: under
     * the first source its records would be counted for the wrong origin, and those
     * whose ids repeat would be dropped as duplicates. Such input is refused. A
     * document that names the same source, or says nothing about its source, goes
     * along with the others.
     *
     * A document that names its source names the reference too: none, when it gives
     * a label only. On its own it would be stored under no reference, so it is not
     * quietly filed under the reference of a file it happens to be selected with.
     * A missing label says nothing: the label is a name, not the identity.
     *
     * `seenBefore` is the number of records read when the file was opened.
     */
    const nameSource = (source: Json, file: ImportFile, seenBefore: number): void => {
      const label = typeof source.label === 'string' ? source.label.trim().slice(0, 200) : '';
      const ref = typeof source.ref === 'string' ? source.ref.trim().slice(0, 200) : '';
      if (label === '' && ref === '') return;

      // Before the first record the document decides, label and reference together: what an
      // earlier document without records said is dropped whole, so that its label never ends
      // up on this document's reference. After it, a document can only agree with the source
      // in use, or give a name to a source that had none.
      const first = builder.seen === 0;
      const used: SourceName = { label: options.sourceLabel ?? fileLabel, ref: builder.resolvedSourceRef };
      // What the user chose in the UI wins over what the file says about itself, so only what the UI left open is compared.
      const refFits = options.sourceRef !== null || builder.setSourceRef(ref);
      const labelFits = options.sourceLabel !== null || label === '' || first || fileLabel === null || fileLabel === label;
      if (!refFits || !labelFits) {
        const named: SourceName = { label: label === '' ? null : label, ref };
        throw mixedSources(file, builder.seen > seenBefore, named, used, options.sourceRef === null && ref !== used.ref);
      }
      if (first) fileLabel = label === '' ? null : label;
      else if (label !== '') fileLabel = label;
    };

    const wrapped = async (doc: Json, file: ImportFile, seenBefore: number): Promise<void> => {
      if (doc.format !== undefined && doc.format !== GENERIC_JSON_FORMAT) {
        throw new ImportError(
          `The file says its format is "${clip(doc.format, 60)}", which this importer does not read. It reads files with "format": "${GENERIC_JSON_FORMAT}".`,
          'wrong_format',
        );
      }
      if (doc.version !== undefined) {
        const version = statedVersion(doc.version);
        if (version !== GENERIC_JSON_VERSION) {
          throw new ImportError(
            // Only a later version is something an update of the app could read.
            version !== null && version > GENERIC_JSON_VERSION
              ? `The file is version ${version} of the usage format; this version of the app reads version ${GENERIC_JSON_VERSION}. Update the app, or export the data as version ${GENERIC_JSON_VERSION}.`
              : `The file gives its "version" as ${clip(JSON.stringify(doc.version), 20)}, which is not a version of the usage format. Write "version": ${GENERIC_JSON_VERSION}, or leave the field out.`,
            'unsupported_version',
          );
        }
      }
      if (!Array.isArray(doc.records)) {
        throw new ImportError(
          doc.records === undefined
            ? `"${file.name}" is marked as a "${GENERIC_JSON_FORMAT}" file but has no "records". The usage records have to be a list under "records", for example "records": [${EXAMPLE_RECORD}].`
            : `"records" in "${file.name}" is ${kindOf(doc.records)}, not a list. The usage records have to be a list in square brackets, for example "records": [${EXAMPLE_RECORD}].`,
          'invalid_records',
        );
      }
      if (isObject(doc.source)) nameSource(doc.source, file, seenBefore);
      for (const entry of doc.records as unknown[]) await record(entry);
    };

    for (const file of files) {
      if (file.size === 0) continue;
      const info = newJsonInputInfo();
      const seenBefore = builder.seen;
      for await (const value of readJsonValues(file.blob, meter.onBytes, info)) {
        if (Array.isArray(value)) {
          for (const entry of value) await record(entry);
        } else if (isObject(value) && isWrapped(value)) {
          await wrapped(value, file, seenBefore);
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
      format: GENERIC_JSON_FORMAT,
      formatLabel: 'Usage data (JSON)',
      sourceLabel: options.sourceLabel ?? fileLabel ?? DEFAULT_SOURCE_LABEL,
      emptyMessage: `The file contains no usage records. ${SHAPE_HINT}`,
      shapeHint: SHAPE_HINT,
      stats: { layout: [...layouts].join(', ') },
    });
  },
};
