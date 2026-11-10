/**
 * The fields of a generic usage record, and how the columns of a CSV file are
 * matched to them. Kept free of any parsing so the import UI can call it with
 * nothing but the header row and show a mapping step before the file is read.
 */
export const GENERIC_FIELDS = [
  'timestamp',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
  'total_tokens',
  'requests',
  'conversation_id',
  'conversation_title',
  'id',
  'price_tier',
  'bucket_seconds',
] as const;

export type GenericField = (typeof GENERIC_FIELDS)[number];

/** Our field name -> the header of the column that holds it, spelled as in the file. */
export type GenericMapping = Partial<Record<GenericField, string>>;

/** Fields that hold token counts. A file needs at least one of them. */
export const TOKEN_FIELDS: readonly GenericField[] = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
  'total_tokens',
];

interface FieldSpec {
  /** Name for the mapping screen. */
  label: string;
  /** One line on what the field means and which values it accepts. */
  hint: string;
  /**
   * Header names recognised without asking, most specific first. Compared without
   * regard to case, spaces, underscores and punctuation ("Input Tokens" matches
   * "input_tokens"). Names that often head a column of free text ("input",
   * "output", "conversation") or of money ("total") are left out on purpose: such a
   * column has to be chosen by the user.
   */
  aliases: string[];
}

export const GENERIC_FIELD_SPECS: Record<GenericField, FieldSpec> = {
  timestamp: {
    label: 'Timestamp',
    hint: 'When the usage happened: ISO 8601 date-time (UTC unless it has an offset), a date (YYYY-MM-DD, the whole UTC day), or Unix epoch seconds or milliseconds. Required.',
    aliases: [
      'timestamp', 'datetime', 'time', 'date', 'day', 'created_at', 'created', 'occurred_at', 'started_at',
      'start_time', 'starting_at', 'start', 'bucket_start', 'usage_date', 'usage_date_utc', 'request_time', 'ts',
    ],
  },
  model: {
    label: 'Model',
    hint: 'Model identifier, for example claude-sonnet-4-5-20250929. Without it the tokens are counted but cannot be priced.',
    aliases: ['model', 'model_id', 'model_name', 'model_version', 'model_key'],
  },
  input_tokens: {
    label: 'Input tokens',
    hint: 'Input tokens that were neither read from nor written to the prompt cache.',
    aliases: [
      'input_tokens', 'prompt_tokens', 'uncached_input_tokens', 'input_token_count', 'tokens_in', 'tokens_input',
      'usage_input_tokens_no_cache',
    ],
  },
  output_tokens: {
    label: 'Output tokens',
    hint: 'Tokens the model generated.',
    aliases: ['output_tokens', 'completion_tokens', 'output_token_count', 'tokens_out', 'tokens_output', 'usage_output_tokens'],
  },
  cache_read_tokens: {
    label: 'Cache read tokens',
    hint: 'Input tokens served from the prompt cache.',
    aliases: [
      'cache_read_tokens', 'cache_read_input_tokens', 'cache_read', 'cached_tokens', 'cached_input_tokens', 'cache_hit_tokens',
      'usage_input_tokens_cache_read',
    ],
  },
  cache_write_tokens: {
    label: 'Cache write tokens',
    hint: 'Input tokens written to the prompt cache when the cache lifetime is not known. Counted as 5-minute cache writes.',
    aliases: [
      'cache_write_tokens', 'cache_creation_input_tokens', 'cache_creation_tokens', 'cache_write', 'cache_creation',
      'usage_input_tokens_cache_write',
    ],
  },
  cache_write_5m_tokens: {
    label: 'Cache write tokens (5 minutes)',
    hint: 'Input tokens written to the 5-minute prompt cache.',
    aliases: [
      'cache_write_5m_tokens', 'cache_write_5m', 'cache_creation_5m_tokens', 'ephemeral_5m_input_tokens',
      'cache_creation_ephemeral_5m_input_tokens', 'usage_input_tokens_cache_write_5m',
    ],
  },
  cache_write_1h_tokens: {
    label: 'Cache write tokens (1 hour)',
    hint: 'Input tokens written to the 1-hour prompt cache.',
    aliases: [
      'cache_write_1h_tokens', 'cache_write_1h', 'cache_creation_1h_tokens', 'ephemeral_1h_input_tokens',
      'cache_creation_ephemeral_1h_input_tokens', 'usage_input_tokens_cache_write_1h',
    ],
  },
  total_tokens: {
    label: 'Total tokens',
    hint: 'Used only for rows that have no input/output split. Such tokens are counted but never priced.',
    aliases: ['total_tokens', 'tokens', 'token_count', 'total_token_count'],
  },
  requests: {
    label: 'Requests',
    hint: 'Number of API requests the row stands for.',
    aliases: ['requests', 'request_count', 'num_requests', 'n_requests', 'api_calls', 'calls'],
  },
  conversation_id: {
    label: 'Conversation id',
    hint: 'Groups rows that belong to one conversation or session.',
    aliases: ['conversation_id', 'conversation_uuid', 'chat_id', 'session_id', 'thread_id'],
  },
  conversation_title: {
    label: 'Conversation title',
    hint: 'Title shown for the conversation. Needs a conversation id.',
    aliases: ['conversation_title', 'conversation_name', 'title', 'chat_title', 'session_title'],
  },
  id: {
    label: 'Record id',
    hint: 'A value that identifies each row. Importing a row with an id that is already stored adds nothing.',
    aliases: ['id', 'record_id', 'request_id', 'row_id', 'event_id', 'uuid'],
  },
  price_tier: {
    label: 'Price tier',
    hint: 'standard (the default), batch, fast, long_context, priority or flex.',
    aliases: ['price_tier', 'tier', 'service_tier', 'pricing_tier', 'usage_type'],
  },
  bucket_seconds: {
    label: 'Bucket width (seconds)',
    hint: 'Length of the period a row adds up, for example 3600 for an hour. Rows dated with a day only default to 86400.',
    aliases: ['bucket_seconds', 'bucket_width_seconds', 'bucket_size_seconds', 'duration_seconds', 'interval_seconds'],
  },
};

/** Lower case, letters and digits only: "Input Tokens", "input_tokens" and "input-tokens" are the same name. */
export function normaliseHeader(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface MappingProblem {
  /** Stable code; also the code of the ImportError the parser throws for it. */
  code: 'missing_timestamp_column' | 'no_token_columns' | 'mapping_column_not_found' | 'unknown_mapping_field' | 'column_mapped_twice';
  message: string;
}

export interface MappingResult {
  mapping: GenericMapping;
  /** Fields of ours that no column was found (or chosen) for. */
  missingFields: GenericField[];
  /** Columns of the file that no field reads; their content is ignored. */
  unmappedColumns: string[];
  /** What keeps the file from being imported with this mapping. Empty when it can be. */
  problems: MappingProblem[];
}

const listColumns = (header: readonly string[]): string => {
  const names = header.filter((h) => h.trim() !== '').map((h) => (h.length > 30 ? `${h.slice(0, 29)}…` : h));
  return names.length === 0 ? 'no named columns' : names.slice(0, 12).join(', ') + (names.length > 12 ? ', …' : '');
};

/** Index of the column a mapping entry names: the exact header first, then the same name ignoring case and spacing. */
function findColumn(header: readonly string[], name: string): number {
  let index = header.indexOf(name);
  if (index === -1) index = header.findIndex((h) => h.trim() === name.trim());
  if (index === -1) {
    const wanted = normaliseHeader(name);
    if (wanted !== '') index = header.findIndex((h) => normaliseHeader(h) === wanted);
  }
  return index;
}

function describe(header: readonly string[], mapping: GenericMapping, problems: MappingProblem[]): MappingResult {
  const used = new Set<number>();
  for (const field of GENERIC_FIELDS) {
    const name = mapping[field];
    if (name !== undefined) used.add(findColumn(header, name));
  }
  if (mapping.timestamp === undefined && !problems.some((p) => p.code === 'mapping_column_not_found')) {
    problems.push({
      code: 'missing_timestamp_column',
      message:
        `No column holds the date or time of the usage, so the rows cannot be placed on the timeline. The first row of the file must contain the column names (it has: ${listColumns(header)}). ` +
        'Choose the column to read as "timestamp".',
    });
  }
  if (!TOKEN_FIELDS.some((f) => mapping[f] !== undefined) && !problems.some((p) => p.code === 'mapping_column_not_found')) {
    problems.push({
      code: 'no_token_columns',
      message:
        `No column with token counts was found (the file has: ${listColumns(header)}). ` +
        'Choose at least one column for input_tokens, output_tokens, total_tokens or one of the cache fields.',
    });
  }
  return {
    mapping,
    missingFields: GENERIC_FIELDS.filter((f) => mapping[f] === undefined),
    unmappedColumns: header.filter((h, i) => !used.has(i) && h.trim() !== ''),
    problems,
  };
}

/**
 * Proposes a mapping from the header row alone, by the aliases above. A column is
 * given to at most one field, and a field takes the column matching its most
 * specific alias.
 */
export function detectCsvMapping(header: readonly string[]): MappingResult {
  const normalised = header.map(normaliseHeader);
  const taken = new Set<number>();
  const mapping: GenericMapping = {};
  for (const field of GENERIC_FIELDS) {
    for (const alias of GENERIC_FIELD_SPECS[field].aliases) {
      const wanted = normaliseHeader(alias);
      const index = normalised.findIndex((h, i) => h === wanted && !taken.has(i));
      if (index !== -1) {
        taken.add(index);
        mapping[field] = header[index];
        break;
      }
    }
  }
  return describe(header, mapping, []);
}

/**
 * Checks a mapping the user chose (`ctx.options.mapping`) against the header. A
 * mapping that is given is used as it is: fields it leaves out stay unmapped, they
 * are not filled in by detection, so that a column the user deselected stays out.
 * An entry whose value is empty or null counts as left out.
 */
export function checkCsvMapping(header: readonly string[], chosen: Record<string, unknown>): MappingResult {
  const problems: MappingProblem[] = [];
  const mapping: GenericMapping = {};
  const usedBy = new Map<number, GenericField>();
  const known = new Set<string>(GENERIC_FIELDS);
  for (const [field, value] of Object.entries(chosen)) {
    if (value === null || value === undefined || value === '') continue;
    if (!known.has(field)) {
      problems.push({ code: 'unknown_mapping_field', message: `"${field}" is not a field that columns can be mapped to. The fields are: ${GENERIC_FIELDS.join(', ')}.` });
      continue;
    }
    const index = typeof value === 'string' ? findColumn(header, value) : -1;
    if (index === -1) {
      problems.push({
        code: 'mapping_column_not_found',
        message: `The column "${String(value)}" chosen for "${field}" is not in the file (it has: ${listColumns(header)}).`,
      });
      continue;
    }
    const other = usedBy.get(index);
    if (other !== undefined) {
      problems.push({
        code: 'column_mapped_twice',
        message: `The column "${header[index]}" is chosen for both "${other}" and "${field}". A column can be read as one field only.`,
      });
      continue;
    }
    usedBy.set(index, field as GenericField);
    mapping[field as GenericField] = header[index];
  }
  return describe(header, mapping, problems);
}

/** Column index of every mapped field. */
export function columnIndexes(header: readonly string[], mapping: GenericMapping): Partial<Record<GenericField, number>> {
  const indexes: Partial<Record<GenericField, number>> = {};
  for (const field of GENERIC_FIELDS) {
    const name = mapping[field];
    if (name === undefined) continue;
    const index = findColumn(header, name);
    if (index !== -1) indexes[field] = index;
  }
  return indexes;
}
