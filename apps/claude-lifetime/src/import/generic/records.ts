import { sha256Hex } from '@/core/sha256';
import {
  ImportError,
  type Confidence,
  type ImportFile,
  type ImportSink,
  type ParseContext,
  type ParsedImport,
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

/** What a model identifier looks like: starts with a letter or digit, no control characters, not a sentence. */
const MODEL_ID = /^[\p{L}\p{N}][\p{L}\p{N} ._:@/[\]()+-]{0,99}$/u;

/** More different unknown "models" than this means the column holds something else. */
const MAX_UNKNOWN_MODELS = 200;

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

interface ConversationSummary {
  title: string | null;
  modelKey: string | null;
  firstMs: number;
  lastMs: number;
}

const idText = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

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
  private readonly conversations = new Map<string, ConversationSummary>();
  private readonly keys = new Set<string | number>();

  constructor(
    private readonly sink: ImportSink,
    private readonly options: GenericOptions,
    readonly warnings: WarningList,
    private readonly models: ModelRegistry,
  ) {
    this.sourceRef = options.sourceRef ?? '';
  }

  /**
   * The source reference scopes deduplication keys, so it has to be settled before
   * the first record. Returns false when records were already read.
   */
  setSourceRef(ref: string): boolean {
    if (this.seen > 0) return false;
    this.sourceRef = ref;
    return true;
  }

  get conversationCount(): number {
    return this.conversations.size;
  }

  /** A record that is not usable at all (not an object, say). */
  reject(code: string, message: string, sample?: string): void {
    this.seen++;
    this.skipped++;
    this.warnings.add(code, message, sample);
  }

  /** `where` locates the record for the user: "line 12", "record 3". */
  async add(raw: RawRecord, where: string): Promise<void> {
    this.seen++;
    const skip = (code: string, message: string, sample: string): void => {
      this.skipped++;
      this.warnings.add(code, message, `${sample} (${where})`);
    };

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
      return skip(
        'timestamp_out_of_range',
        'Rows dated before 2021 or in the future were skipped: no Claude usage can have happened then. If the column holds something other than the time of the usage, choose another column.',
        sampleOf(raw.timestamp),
      );
    }

    // ── how much ──
    const counts: Partial<Record<GenericField, number | null>> = {};
    for (const [field, max] of COUNT_FIELDS) {
      const count = parseCount(raw[field], max);
      if (!count.ok) {
        return count.reason === 'negative'
          ? skip('negative_value', 'Rows with a negative token or request count were skipped: a count cannot be below zero.', `${field}: ${sampleOf(raw[field])}`)
          : skip('invalid_number', 'Rows with a token or request count that is not a whole number were skipped.', `${field}: ${sampleOf(raw[field])}`);
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
      notes.push([
        'total_mismatch',
        'In some rows total_tokens differs from the sum of the individual token columns. The individual columns were imported; if a kind of token is missing, check the column mapping.',
        `total ${total}, columns add up to ${itemised}`,
      ]);
    }

    // ── bucket ──
    let bucketSeconds = time.dateOnly ? 86400 : 0;
    const bucket = parseCount(raw.bucket_seconds, INT32_MAX);
    if (bucket.ok) bucketSeconds = bucket.value ?? bucketSeconds;
    else {
      // Not worth losing the row's tokens over: the width only says how coarse the row is.
      notes.push(['invalid_bucket_seconds', 'Bucket widths that are not a whole number of seconds were ignored.', sampleOf(raw.bucket_seconds)]);
    }

    // ── model ──
    let modelKey: string | null = null;
    const model = typeof raw.model === 'string' ? raw.model.trim() : raw.model;
    if (typeof model === 'string' && MODEL_ID.test(model)) {
      modelKey = await this.models.resolve(model);
      if (this.models.unknownCount > MAX_UNKNOWN_MODELS) {
        throw new ImportError(
          `The model column holds more than ${MAX_UNKNOWN_MODELS} different values that are not known models (for example "${this.models.unknownKeys[0]}"). ` +
            'It probably is not a column of model names; check the column mapping.',
          'too_many_models',
        );
      }
    } else if (model !== '' && model !== null && model !== undefined) {
      notes.push(['invalid_model', 'Values that do not look like a model identifier were ignored; those rows are imported without a model.', sampleOf(raw.model)]);
    }

    // ── conversation ──
    let conversationId = idText(raw.conversation_id);
    if (conversationId.length > 200) conversationId = `sha256:${sha256Hex(conversationId)}`;
    const conversationKey = conversationId === '' ? null : `generic:${this.sourceRef}:${conversationId}`;

    // ── identity ──
    const occurredAt = new Date(time.ms).toISOString();
    const requests = counts.requests ?? 0;
    const id = idText(raw.id);
    let dedupKey: string;
    let remembered: string | number;
    if (id !== '') {
      const scope = this.sourceRef === '' ? 'generic:' : `generic:${this.sourceRef}:`;
      dedupKey = scope + (id.length <= 120 ? id : `sha256:${sha256Hex(id)}`);
      remembered = dedupKey;
    } else {
      // Without an id, a record is identified by everything it says. Confidence and the
      // conversation title are left out: changing them must not turn a row into a new one.
      const hash = sha256Hex(
        JSON.stringify([this.sourceRef, occurredAt, bucketSeconds, modelKey, priceTier, input, output, cacheRead, cacheWrite5m, cacheWrite1h, requests, conversationId]),
      );
      dedupKey = `generic:${hash}`;
      // 52 bits of the hash are plenty to spot a repeat and cost a fraction of the memory of the string.
      remembered = parseInt(hash.slice(0, 13), 16);
    }
    if (this.keys.has(remembered)) {
      return id !== ''
        ? skip(
            'duplicate_ids',
            'Rows whose id already occurred earlier in the import were skipped, so each id is counted once. If the id column does not identify single records, remove it from the column mapping.',
            sampleOf(id),
          )
        : skip(
            'duplicate_rows',
            'Rows identical to an earlier row in every field were skipped, so they are counted once. If they are separate records, add a column that identifies each record and map it as "id".',
            sampleOf(raw.timestamp),
          );
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
    await this.sink.usage(usage);

    this.emitted++;
    if (modelKey !== null) this.rowsWithModel++;
    if (totalOnly) this.totalOnlyRows++;
    this.tokens += input + output + cacheRead + cacheWrite5m + cacheWrite1h;
    if (time.ms < this.firstMs) this.firstMs = time.ms;
    if (time.ms > this.lastMs) this.lastMs = time.ms;

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
  kind: Extract<SourceKind, 'generic_csv' | 'generic_json'>;
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
    const first = builder.warnings.toArray()[0];
    throw new ImportError(
      `None of the ${builder.seen} row${builder.seen === 1 ? '' : 's'} could be imported.` +
        (first ? ` ${first.message}${first.sample ? ` For example: ${first.sample}.` : ''}` : '') +
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
    source: { kind: p.kind, label: p.sourceLabel, externalRef: builder.resolvedSourceRef },
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
