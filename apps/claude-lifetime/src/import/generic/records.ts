import { sha256Hex } from '@/core/sha256';
import {
  ImportError,
  type Confidence,
  type ImportFile,
  type ImportSink,
  type ParseContext,
  type ParsedImport,
  type ParseWarning,
  type SourceKind,
  type StagedUsage,
} from '@/core/types';
import { describeFiles, InputMeter, ModelRegistry, WarningList } from './shared';
import type { GenericField } from './fields';
import {
  INT32_MAX,
  KNOWN_PRICE_TIERS,
  normalisePriceTier,
  parseCount,
  parseTimestamp,
  sampleOf,
  UNCATEGORISED_TIER,
} from './values';

/**
 * Turns generic usage records — rows of a CSV file or records of the JSON format —
 * into staged usage. Both importers hand over records as "field name -> raw value"
 * and get the same validation, the same warnings and the same deduplication.
 */
export const GENERIC_PARSER_VERSION = 'generic-1';

export const DEFAULT_SOURCE_LABEL = 'Custom usage data';

/** The two formats the records come from. */
export type GenericKind = Extract<SourceKind, 'generic_csv' | 'generic_json'>;

/** One record as it comes out of a file: text from a CSV cell, any JSON value from a JSON record. */
export type RawRecord = Partial<Record<GenericField, unknown>>;

export interface GenericOptions {
  /** Whether the counts in the file are reported by a provider or are approximations. */
  confidence: Confidence;
  /** Null: not chosen in the UI (a JSON file may then name its own). */
  sourceLabel: string | null;
  sourceRef: string | null;
  /** Latest timestamp taken seriously, ms since the epoch. */
  maxTimeMs: number;
}

/** No Claude model was available before 2021; an earlier date is a wrong column or a broken clock. */
const MIN_TIME_MS = Date.UTC(2021, 0, 1);

const shortText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null);

/** Reads the options the import UI passes in `ctx.options`. */
export function readGenericOptions(ctx: ParseContext): GenericOptions {
  const o = ctx.options ?? {};
  if (o.confidence !== undefined && o.confidence !== 'exact' && o.confidence !== 'estimated') {
    throw new ImportError('The "confidence" option must be "exact" or "estimated".', 'invalid_option');
  }
  const now = typeof o.now === 'number' ? o.now : Date.now();
  return {
    // Nothing vouches for the numbers in a file someone made: they are estimates until the user says otherwise.
    confidence: o.confidence ?? 'estimated',
    sourceLabel: shortText(o.sourceLabel),
    sourceRef: shortText(o.sourceRef),
    // A day of slack, for clocks that are ahead and for local times written without their offset.
    maxTimeMs: now + 86_400_000,
  };
}

const MODEL_CHARACTERS = /^[\p{L}\p{N}][\p{L}\p{N} ._:@/[\]()+-]*$/u;

/**
 * What a model identifier looks like, as opposed to a cell of free text that was
 * mapped as "model" by mistake: an id without spaces ("claude-sonnet-4-5-20250929",
 * a cloud provider's long id), or a short display name of a few words ("Claude
 * Sonnet 4.5"). A sentence is neither.
 */
function looksLikeModelId(text: string): boolean {
  if (!MODEL_CHARACTERS.test(text)) return false;
  const words = text.split(' ').length;
  return words === 1 ? text.length <= 120 : words <= 5 && text.length <= 64;
}

/** More different unknown "models" than this means the column holds something else. */
const MAX_UNKNOWN_MODELS = 200;

const DAY_MS = 86_400_000;
/** A row may add up ten years at most. A longer period is a mistake in the column, or says nothing about when the usage was. */
const MAX_PERIOD_DAYS = 3660;

/** Keys remembered to recognise rows that repeat inside one import. Beyond this the database still deduplicates. */
const MAX_REMEMBERED_KEYS = 1_000_000;

const COUNT_FIELDS: Array<[field: GenericField, max: number]> = [
  ['input_tokens', Number.MAX_SAFE_INTEGER],
  ['output_tokens', Number.MAX_SAFE_INTEGER],
  ['cache_read_tokens', Number.MAX_SAFE_INTEGER],
  ['cache_write_tokens', Number.MAX_SAFE_INTEGER],
  ['cache_write_5m_tokens', Number.MAX_SAFE_INTEGER],
  ['cache_write_1h_tokens', Number.MAX_SAFE_INTEGER],
  ['total_tokens', Number.MAX_SAFE_INTEGER],
  // request_count is an INTEGER column
  ['requests', INT32_MAX],
];

/**
 * The warnings that tell the person what to change in their file. What can be
 * changed differs by format: a table has columns and a column mapping, a JSON file
 * has fields, and advice about a mapping means nothing to someone who wrote a JSON
 * file. Everything else a warning says is the same for both.
 */
interface Advice {
  timestampOutOfRange: string;
  totalMismatch: string;
  /** What the individual token counts of a record are called in an example. */
  tokenCounts: string;
  duplicateIds: string;
  duplicateRows: string;
  tooManyModels(example: string): string;
}

const ADVICE: Record<GenericKind, Advice> = {
  generic_csv: {
    timestampOutOfRange:
      'Rows dated before 2021 or in the future were skipped: no Claude usage can have happened then. If the column holds something other than the time of the usage, choose another column.',
    totalMismatch:
      'In some rows total_tokens differs from the sum of the individual token columns. The individual columns were imported; if a kind of token is missing, check the column mapping.',
    tokenCounts: 'columns',
    duplicateIds:
      'Rows whose id already occurred earlier in the import were skipped, so each id is counted once. If the id column does not identify single records, remove it from the column mapping.',
    duplicateRows:
      'Rows identical to an earlier row in every field were skipped, so they are counted once. If they are separate records, add a column that identifies each record and map it as "id".',
    tooManyModels: (example) =>
      `The model column holds more than ${MAX_UNKNOWN_MODELS} different values that are not known models (for example "${example}"). ` +
      'It probably is not a column of model names; check the column mapping.',
  },
  generic_json: {
    timestampOutOfRange:
      'Rows dated before 2021 or in the future were skipped: no Claude usage can have happened then. If "timestamp" holds something other than the time of the usage, correct it in the file.',
    totalMismatch:
      'In some rows total_tokens differs from the sum of the individual token counts. The individual counts were imported; if a kind of token is missing, add its field to the records.',
    tokenCounts: 'the individual counts',
    duplicateIds:
      'Rows whose id already occurred earlier in the import were skipped, so each id is counted once. If "id" does not identify single records, leave it out of the records.',
    duplicateRows:
      'Rows identical to an earlier row in every field were skipped, so they are counted once. If they are separate records, give each one an "id" of its own.',
    tooManyModels: (example) =>
      `The "model" field holds more than ${MAX_UNKNOWN_MODELS} different values that are not known models (for example "${example}"). ` +
      'It probably does not hold model names; check what the file writes there.',
  },
};

interface ConversationSummary {
  title: string | null;
  modelKey: string | null;
  firstMs: number;
  lastMs: number;
}

/**
 * Reads an id: text as it stands, and a number only when it is a whole number that
 * JSON holds exactly. JSON.parse keeps 53 bits of a number, so of the 64-bit ids that
 * some systems write as numbers, neighbours arrive as the same value. Such a number
 * identifies nothing (`inexact`): used as an id, it would make different records
 * look like repeats of each other.
 */
function readId(value: unknown): { text: string; inexact: boolean } {
  if (typeof value === 'string') return { text: value.trim(), inexact: false };
  if (typeof value !== 'number') return { text: '', inexact: false };
  return Number.isSafeInteger(value) ? { text: String(value), inexact: false } : { text: '', inexact: true };
}

export class GenericUsageBuilder {
  seen = 0;
  skipped = 0;
  emitted = 0;
  rowsWithModel = 0;
  totalOnlyRows = 0;
  tokens = 0;
  firstMs = Infinity;
  lastMs = -Infinity;

  private sourceRef: string;
  private readonly advice: Advice;
  private readonly conversations = new Map<string, ConversationSummary>();
  private readonly keys = new Set<string | number>();
  /** How many records each warning kept out, by its code. */
  private readonly skips = new Map<string, number>();

  constructor(
    private readonly sink: ImportSink,
    private readonly options: GenericOptions,
    readonly warnings: WarningList,
    private readonly models: ModelRegistry,
    readonly kind: GenericKind,
  ) {
    this.sourceRef = options.sourceRef ?? '';
    this.advice = ADVICE[kind];
  }

  /**
   * Files the records under `ref`. The reference scopes every deduplication key, so
   * it cannot change once a record was read. Returns false when records were already
   * read under another reference: the caller then has to refuse the input, because
   * neither reference would be right for all of its records.
   */
  setSourceRef(ref: string): boolean {
    if (this.seen > 0) return ref === this.sourceRef;
    this.sourceRef = ref;
    return true;
  }

  get conversationCount(): number {
    return this.conversations.size;
  }

  /** Counts a record as kept out, under the warning that says why. */
  private keepOut(code: string, message: string, sample?: string): void {
    this.skipped++;
    this.skips.set(code, (this.skips.get(code) ?? 0) + 1);
    this.warnings.add(code, message, sample);
  }

  /** A record that is not usable at all (not an object, say). */
  reject(code: string, message: string, sample?: string): void {
    this.seen++;
    this.keepOut(code, message, sample);
  }

  /**
   * The warning that kept the most records out, the earliest one among equals. It
   * explains an import in which no record was usable. A warning about records that
   * were read is never the answer to that, however early it was raised.
   */
  get mainSkipReason(): ParseWarning | undefined {
    let reason: ParseWarning | undefined;
    let most = 0;
    for (const warning of this.warnings.toArray()) {
      const count = this.skips.get(warning.code) ?? 0;
      if (count > most) {
        reason = warning;
        most = count;
      }
    }
    return reason;
  }

  /** `where` locates the record for the user: "line 12", "record 3". */
  async add(raw: RawRecord, where: string): Promise<void> {
    this.seen++;
    const skip = (code: string, message: string, sample: string): void => this.keepOut(code, message, `${sample} (${where})`);

    // ── when ──
    const time = parseTimestamp(raw.timestamp);
    if (time === null) {
      return skip(
        'invalid_timestamp',
        'Rows whose timestamp is missing or cannot be read were skipped. Accepted: ISO 8601 date-times such as 2025-03-01T14:30:00Z (UTC when no offset is given), dates such as 2025-03-01, and Unix epoch seconds or milliseconds.',
        sampleOf(raw.timestamp),
      );
    }
    if (time.ms < MIN_TIME_MS || time.ms > this.options.maxTimeMs) {
      return skip('timestamp_out_of_range', this.advice.timestampOutOfRange, sampleOf(raw.timestamp));
    }

    // ── how much ──
    const counts: Partial<Record<GenericField, number | null>> = {};
    for (const [field, max] of COUNT_FIELDS) {
      const count = parseCount(raw[field], max);
      if (!count.ok) {
        const sample = `${field}: ${sampleOf(raw[field])}`;
        if (count.reason === 'negative') {
          return skip('negative_value', 'Rows with a negative token or request count were skipped: a count cannot be below zero.', sample);
        }
        if (count.reason === 'too_large') {
          // A whole number, only not one that can be a count: saying "not a whole number" would send the person looking for the wrong thing.
          return skip(
            'number_too_large',
            'Rows with a token or request count that is too large were skipped: a token count above 9,007,199,254,740,991 cannot be read exactly, and a request count can be 2,147,483,647 at most. ' +
              'A number of that size is usually something else, such as an id or a timestamp.',
            sample,
          );
        }
        return skip('invalid_number', 'Rows with a token or request count that is not a whole number were skipped.', sample);
      }
      counts[field] = count.value;
    }
    if (COUNT_FIELDS.every(([field]) => counts[field] === null)) {
      return skip('no_usage_values', 'Rows without any token or request count were skipped.', sampleOf(raw.timestamp));
    }

    // A total of cache writes next to its 5-minute / 1-hour breakdown is the same tokens
    // twice. Only what the breakdown does not account for is added, to the 5-minute column:
    // that is the default cache lifetime, and the only one there was before the 1-hour cache.
    let cacheWrite5m = counts.cache_write_5m_tokens ?? 0;
    const cacheWrite1h = counts.cache_write_1h_tokens ?? 0;
    const cacheWriteTotal = counts.cache_write_tokens ?? 0;
    if (cacheWriteTotal > cacheWrite5m + cacheWrite1h) cacheWrite5m = cacheWriteTotal - cacheWrite1h;

    let input = counts.input_tokens ?? 0;
    const output = counts.output_tokens ?? 0;
    const cacheRead = counts.cache_read_tokens ?? 0;
    const itemised = input + output + cacheRead + cacheWrite5m + cacheWrite1h;
    const total = counts.total_tokens ?? null;

    // Remarks about a row that is imported all the same. They are recorded once it is
    // certain that the row is not a repeat of an earlier one.
    const notes: Array<[code: string, message: string, sample: string]> = [];

    let priceTier = normalisePriceTier(raw.price_tier);
    if (priceTier === null || !KNOWN_PRICE_TIERS.has(priceTier)) {
      notes.push([
        'unknown_price_tier',
        'Rows name a price tier the app has no prices for. Their tokens are counted but not valued. Known tiers: standard, batch, fast, long_context, priority, flex.',
        sampleOf(raw.price_tier),
      ]);
      priceTier ??= UNCATEGORISED_TIER;
    }

    const totalOnly = itemised === 0 && total !== null && total > 0;
    if (totalOnly) {
      // Input and output tokens have different prices, so a bare total cannot be valued.
      // It is kept in the input column under a tier that has no price, never under "standard".
      input = total;
      priceTier = UNCATEGORISED_TIER;
      notes.push([
        'total_only',
        'Rows that only have a token total, without the split into input and output, are counted but never priced: the two are billed at different rates.',
        `${total} tokens`,
      ]);
    } else if (total !== null && total !== itemised) {
      notes.push(['total_mismatch', this.advice.totalMismatch, `total ${total}, ${this.advice.tokenCounts} add up to ${itemised}`]);
    }

    // ── bucket ──
    let bucketSeconds = time.dateOnly ? 86400 : 0;
    const bucket = parseCount(raw.bucket_seconds, INT32_MAX);
    if (bucket.ok) bucketSeconds = bucket.value ?? bucketSeconds;
    else {
      // Not worth losing the row's tokens over: the width only says how coarse the row is.
      notes.push(['invalid_bucket_seconds', 'Bucket widths that are not a whole number of seconds were ignored.', sampleOf(raw.bucket_seconds)]);
    }

    // ── a period of several days ──
    // A row that adds up more than a day (a monthly total) covers whole UTC days, like a dated row.
    const firstDay = Math.floor(time.ms / DAY_MS);
    const periodEnd = bucketSeconds > 86400 ? Math.floor((time.ms + bucketSeconds * 1000 - 1) / DAY_MS) : firstDay;
    // Usage of a period that is still running (this month's total so far) lies on its days up to today.
    const today = Math.floor((this.options.maxTimeMs - DAY_MS) / DAY_MS);
    const lastDay = Math.max(firstDay, Math.min(periodEnd, today));
    const days = lastDay - firstDay + 1;
    if (periodEnd - firstDay + 1 > MAX_PERIOD_DAYS) {
      return skip(
        'period_too_long',
        `Rows that add up more than ten years were skipped: a period that long says nothing about when the usage was. Check the bucket width, which is in seconds (a day is 86400).`,
        `${sampleOf(raw.bucket_seconds)} seconds from ${sampleOf(raw.timestamp)}`,
      );
    }
    if (days > 1) {
      notes.push([
        'spread_over_days',
        'Rows that add up more than one day are stored as one row for each day, with their counts divided evenly over the days: the file does not say how the usage was distributed. ' +
          'Totals are unchanged. A figure for a single day or week inside such a period is an even share, not a measurement.',
        `${days} days from ${new Date(firstDay * DAY_MS).toISOString().slice(0, 10)}`,
      ]);
    }

    // ── model ──
    let modelKey: string | null = null;
    const model = typeof raw.model === 'string' ? raw.model.trim() : raw.model;
    if (typeof model === 'string' && looksLikeModelId(model)) {
      modelKey = await this.models.resolve(model);
      if (this.models.unknownCount > MAX_UNKNOWN_MODELS) {
        throw new ImportError(this.advice.tooManyModels(this.models.unknownKeys[0]), 'too_many_models');
      }
    } else if (model !== '' && model !== null && model !== undefined) {
      notes.push(['invalid_model', 'Values that do not look like a model identifier were ignored; those rows are imported without a model.', sampleOf(raw.model)]);
    }

    // ── conversation ──
    const conversation = readId(raw.conversation_id);
    let conversationId = conversation.text;
    if (conversationId.length > 200) conversationId = `sha256:${sha256Hex(conversationId)}`;
    const conversationKey = conversationId === '' ? null : `generic:${this.sourceRef}:${conversationId}`;

    // ── identity ──
    const occurredAt = new Date(time.ms).toISOString();
    const requests = counts.requests ?? 0;
    const own = readId(raw.id);
    const id = own.text;
    if (own.inexact || conversation.inexact) {
      // The row is worth keeping: it is told apart by its content, like a row without an id, and joins no conversation.
      notes.push([
        'inexact_numeric_id',
        'Ids written as numbers above 9,007,199,254,740,991, or as numbers with a fraction, were not used: such a number is not read exactly, so different ids can look the same. ' +
          'The rows were imported and are identified by their content instead; a conversation id of this kind was left out, so those rows belong to no conversation. ' +
          'Write ids of this size as text, in quotation marks.',
        own.inexact ? `id read as ${String(raw.id)}` : `conversation_id read as ${String(raw.conversation_id)}`,
      ]);
    }
    let dedupKey: string;
    let remembered: string | number;
    if (id !== '') {
      const scope = this.sourceRef === '' ? 'generic:' : `generic:${this.sourceRef}:`;
      dedupKey = scope + (id.length <= 120 ? id : `sha256:${sha256Hex(id)}`);
      remembered = dedupKey;
    } else {
      // Without an id, a record is identified by everything it says. Confidence and the
      // conversation title are left out: changing them must not turn a row into a new one.
      // The model goes in as the file spells it, so that a later catalog which knows
      // the identifier under another key still recognises the row.
      const hash = sha256Hex(
        JSON.stringify([this.sourceRef, occurredAt, bucketSeconds, typeof model === 'string' && model !== '' ? model : null, priceTier, input, output, cacheRead, cacheWrite5m, cacheWrite1h, requests, conversationId]),
      );
      dedupKey = `generic:${hash}`;
      // 52 bits of the hash are plenty to spot a repeat and cost a fraction of the memory of the string.
      remembered = parseInt(hash.slice(0, 13), 16);
    }
    if (this.keys.has(remembered)) {
      return id !== '' ? skip('duplicate_ids', this.advice.duplicateIds, sampleOf(id)) : skip('duplicate_rows', this.advice.duplicateRows, sampleOf(raw.timestamp));
    }
    if (this.keys.size < MAX_REMEMBERED_KEYS) this.keys.add(remembered);
    for (const [code, message, sample] of notes) this.warnings.add(code, message, `${sample} (${where})`);

    const usage: StagedUsage = {
      conversationKey,
      modelKey,
      occurredAt,
      bucketSeconds,
      priceTier,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cacheWrite5m,
      cacheWrite1hTokens: cacheWrite1h,
      requestCount: requests,
      userMessageCount: 0,
      assistantMessageCount: 0,
      webSearchRequests: 0,
      confidence: this.options.confidence,
      dedupKey,
    };
    if (days === 1) await this.sink.usage(usage);
    else {
      // One row per day. Each count is divided so that the days add up to exactly what the row states:
      // what does not divide evenly goes to the first days, one unit each.
      const share = (value: number, day: number) => Math.floor(value / days) + (day < value % days ? 1 : 0);
      for (let day = 0; day < days; day++) {
        const part: StagedUsage = {
          ...usage,
          occurredAt: new Date((firstDay + day) * DAY_MS).toISOString(),
          bucketSeconds: 86400,
          inputTokens: share(input, day),
          outputTokens: share(output, day),
          cacheReadTokens: share(cacheRead, day),
          cacheWrite5mTokens: share(cacheWrite5m, day),
          cacheWrite1hTokens: share(cacheWrite1h, day),
          requestCount: share(requests, day),
          dedupKey: `${dedupKey}#${day + 1}`,
        };
        // A count smaller than the number of days leaves days with nothing on them; those get no row.
        if (part.inputTokens + part.outputTokens + part.cacheReadTokens + part.cacheWrite5mTokens + part.cacheWrite1hTokens + part.requestCount > 0) {
          await this.sink.usage(part);
        }
      }
    }

    this.emitted++;
    if (modelKey !== null) this.rowsWithModel++;
    if (totalOnly) this.totalOnlyRows++;
    this.tokens += input + output + cacheRead + cacheWrite5m + cacheWrite1h;
    if (time.ms < this.firstMs) this.firstMs = time.ms;
    // The last day a row of several days covers, not the day it starts on.
    const endMs = days === 1 ? time.ms : lastDay * DAY_MS;
    if (endMs > this.lastMs) this.lastMs = endMs;

    if (conversationKey !== null) {
      const title = typeof raw.conversation_title === 'string' && raw.conversation_title.trim() !== '' ? raw.conversation_title.trim().slice(0, 500) : null;
      const known = this.conversations.get(conversationId);
      if (known === undefined) {
        this.conversations.set(conversationId, { title, modelKey, firstMs: time.ms, lastMs: time.ms });
      } else {
        // The latest title wins (conversations get renamed); the first model stays.
        if (title !== null) known.title = title;
        known.modelKey ??= modelKey;
        if (time.ms < known.firstMs) known.firstMs = time.ms;
        if (time.ms > known.lastMs) known.lastMs = time.ms;
      }
    }
  }

  /**
   * Writes the conversations the records referred to. They are held back until the
   * end so that each one is written once, with its full time span; memory use is
   * proportional to the number of different conversations, not of rows.
   */
  async finish(): Promise<void> {
    for (const [id, c] of this.conversations) {
      await this.sink.conversation({
        dedupKey: `generic:${this.sourceRef}:${id}`,
        kind: 'usage_bucket',
        externalId: id,
        title: c.title,
        projectLabel: null,
        modelKey: c.modelKey,
        createdAt: new Date(c.firstMs).toISOString(),
        updatedAt: new Date(c.lastMs).toISOString(),
      });
    }
  }

  get resolvedSourceRef(): string {
    return this.sourceRef;
  }

  get confidence(): string {
    return this.options.confidence;
  }
}

export interface GenericResultParts {
  files: ImportFile[];
  meter: InputMeter;
  builder: GenericUsageBuilder;
  models: ModelRegistry;
  format: string;
  formatLabel: string;
  sourceLabel: string;
  /** Said when the input has no records at all. */
  emptyMessage: string;
  /** Appended when records were found but none was usable. */
  shapeHint: string;
  stats: Record<string, number | string | boolean>;
}

/** The ParsedImport of a generic import, or the error that explains why there is nothing to import. */
export function finishGenericImport(p: GenericResultParts): ParsedImport {
  const { builder, meter } = p;
  meter.records = builder.seen;
  meter.report();

  if (builder.seen === 0) throw new ImportError(p.emptyMessage, 'no_rows');
  if (builder.emitted === 0) {
    const reason = builder.mainSkipReason;
    throw new ImportError(
      `None of the ${builder.seen} row${builder.seen === 1 ? '' : 's'} could be imported.` +
        (reason ? ` ${reason.message}${reason.sample ? ` For example: ${reason.sample}.` : ''}` : '') +
        ` ${p.shapeHint}`,
      'no_valid_rows',
    );
  }

  const missingFields: string[] = [];
  if (builder.rowsWithModel === 0) missingFields.push('model');
  if (builder.totalOnlyRows === builder.emitted) missingFields.push('input_tokens', 'output_tokens');

  return {
    format: p.format,
    formatLabel: p.formatLabel,
    parserVersion: GENERIC_PARSER_VERSION,
    source: { kind: builder.kind, label: p.sourceLabel, externalRef: builder.resolvedSourceRef },
    ...describeFiles(p.files),
    contentHash: meter.contentHash(),
    recordsSeen: builder.seen,
    recordsSkipped: builder.skipped,
    missingFields,
    warnings: builder.warnings.toArray(),
    stats: {
      rows: builder.emitted,
      tokens: builder.tokens,
      conversations: builder.conversationCount,
      totalOnlyRows: builder.totalOnlyRows,
      unknownModels: p.models.unknownCount,
      firstTimestamp: new Date(builder.firstMs).toISOString(),
      lastTimestamp: new Date(builder.lastMs).toISOString(),
      confidence: builder.confidence,
      bytesRead: meter.bytesRead,
      ...p.stats,
    },
  };
}
