import type { PriceRow, UserPriceInput } from '@/analytics/settings';
import { addDays, formatDay } from '@/lib/format';

/**
 * The parts of the Settings page that are plain logic: what counts as a usable
 * timezone, how a price row is worded, which built-in price a user-entered one
 * replaces, and the checks a form or a backup file has to pass. Nothing here touches
 * the DOM or the database, so all of it is unit-tested.
 */

// ── Timezone ────────────────────────────────────────────────────────────────────

/** IANA zones this browser can format, for the suggestion list. Empty where the browser cannot enumerate them. */
export function listTimezones(): string[] {
  let zones: string[] = [];
  try {
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // older engines cannot list zones; a typed name is still accepted
  }
  // Engines differ on whether the list carries UTC itself.
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export type TimezoneCheck = { ok: true; timezone: string } | { ok: false; message: string };

/**
 * Whether a typed value can be saved as the timezone, and under which spelling.
 *
 * Day boundaries are computed by PostgreSQL and dates are formatted by the browser, so
 * both must read the name the same way. They only agree on full IANA names: an
 * abbreviation such as "PST" is a fixed offset to PostgreSQL but a daylight-saving
 * zone to the browser, and an offset such as "+02:00" even has opposite signs.
 * Those are turned away here; a name PostgreSQL does not know is rejected on saving.
 */
export function checkTimezone(input: string, known: readonly string[] = []): TimezoneCheck {
  const typed = input.trim();
  if (typed === '') return { ok: false, message: 'Enter a timezone, for example Europe/Berlin.' };
  const lower = typed.toLowerCase();
  const listed = known.find((zone) => zone.toLowerCase() === lower);
  if (listed) return { ok: true, timezone: listed };
  if (lower !== 'utc' && !/^[a-z][a-z0-9_+-]*(\/[a-z0-9_+-]+)+$/i.test(typed)) {
    return {
      ok: false,
      message: `"${typed}" is not a full timezone name. Abbreviations and offsets can mean different things, so use an IANA name such as America/New_York.`,
    };
  }
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: typed }).resolvedOptions().timeZone;
    // Only the capitalisation is taken over: an alias (Asia/Kolkata) keeps the name the user chose.
    return { ok: true, timezone: resolved.toLowerCase() === lower ? resolved : typed };
  } catch {
    return { ok: false, message: `"${typed}" is not a timezone this browser knows. Use an IANA name such as America/New_York.` };
  }
}

/** "UTC+01:00" for a zone at a given moment, or null when the browser cannot tell. */
export function utcOffsetLabel(timezone: string, at: Date = new Date()): string | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!name) return null;
    return name.replace(/^GMT/, 'UTC').replace('-', '−');
  } catch {
    return null;
  }
}

/**
 * A suggestion picked from the list (or a pasted name) arrives as one whole value and
 * is saved at once; a name typed letter by letter is saved when the field is left or
 * Enter is pressed, so "Etc/GMT" is not saved on the way to "Etc/GMT+5".
 */
export function isWholeValueInput(inputType: string | undefined): boolean {
  return inputType === undefined || inputType === 'insertReplacementText' || inputType === 'insertFromPaste' || inputType === 'insertFromDrop';
}

// ── Prices ──────────────────────────────────────────────────────────────────────

export const PRICE_TIERS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'standard', label: 'Standard', hint: 'Regular API requests' },
  { value: 'batch', label: 'Batch API', hint: 'Asynchronous batches' },
  { value: 'fast', label: 'Fast mode', hint: 'Faster output at a premium' },
  { value: 'long_context', label: 'Long context', hint: 'Prompts over the model’s threshold' },
];

/** A readable name for a price tier. Tiers the app has no name for (they come from imported reports) are shown as written. */
export function tierLabel(tier: string): string {
  const known = PRICE_TIERS.find((t) => t.value === tier);
  if (known) return known.label;
  const words = tier.replace(/[_-]+/g, ' ').trim();
  return words === '' ? 'Standard' : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A price per million tokens from its exact decimal string: "$3.00", "$0.25",
 * "$0.005". Digits are never rounded away; a missing price is a dash, not a zero.
 */
export function formatPrice(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') return '–';
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return `$${value.trim()}`;
  const whole = Number(match[1]).toLocaleString('en-US');
  const fraction = (match[2] ?? '').replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${fraction}`;
}

/** When a price applies. `to` is exclusive in the database; the last day in effect is shown. */
export function effectiveLabel(from: string | null, to: string | null): string {
  if (!from && !to) return 'Since launch';
  if (from && !to) return `From ${formatDay(from)}`;
  const last = formatDay(addDays(to!, -1));
  return from ? `${formatDay(from)} – ${last}` : `Until ${last}`;
}

/**
 * The catalog's model order (newest first) with each model's tiers in a fixed order,
 * standard first. Rows of the same model and tier keep the order they came in, oldest price first.
 */
export function sortPrices<T extends Pick<PriceRow, 'modelKey' | 'priceTier'>>(rows: T[]): T[] {
  const modelRank = new Map<string, number>();
  for (const row of rows) if (!modelRank.has(row.modelKey)) modelRank.set(row.modelKey, modelRank.size);
  const tierRank = (tier: string) => {
    const index = PRICE_TIERS.findIndex((t) => t.value === tier);
    return index === -1 ? PRICE_TIERS.length : index;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        modelRank.get(a.row.modelKey)! - modelRank.get(b.row.modelKey)! || tierRank(a.row.priceTier) - tierRank(b.row.priceTier) || a.index - b.index,
    )
    .map((entry) => entry.row);
}

/** Rows whose model name or identifier contains every word of the query. */
export function filterPrices<T extends Pick<PriceRow, 'displayName' | 'modelKey'>>(rows: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = `${row.displayName} ${row.modelKey}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export type Replacement = { scope: 'all' } | { scope: 'part'; from: string | null };

/**
 * Which built-in prices a user-entered price takes the place of, keyed by the id of
 * the built-in row. Mirrors the rule the valuation query applies: for a model and tier
 * on a given day, a user-entered row in effect that day wins over a built-in one.
 */
export function replacedByUserPrices(rows: PriceRow[]): Map<number, Replacement> {
  const out = new Map<number, Replacement>();
  const own = rows.filter((r) => !r.isBuiltin);
  if (own.length === 0) return out;
  // Open ends compare as the earliest and the latest possible day.
  const start = (r: PriceRow) => r.effectiveFrom ?? '0000-00-00';
  const end = (r: PriceRow) => r.effectiveTo ?? '9999-99-99';
  for (const builtin of rows) {
    if (!builtin.isBuiltin) continue;
    const overlapping = own.filter(
      (u) => u.modelKey === builtin.modelKey && u.priceTier === builtin.priceTier && start(u) < end(builtin) && start(builtin) < end(u),
    );
    if (overlapping.length === 0) continue;
    if (overlapping.some((u) => start(u) <= start(builtin) && end(u) >= end(builtin))) {
      out.set(builtin.id, { scope: 'all' });
    } else {
      const single = overlapping.length === 1 && overlapping[0].effectiveTo === null ? overlapping[0] : null;
      out.set(builtin.id, { scope: 'part', from: single?.effectiveFrom ?? null });
    }
  }
  return out;
}

/** The site a price was read from, for the link text. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface PriceFormValues {
  modelKey: string;
  priceTier: string;
  effectiveFrom: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite5m: string;
  cacheWrite1h: string;
  sourceUrl: string;
  sourceNote: string;
}

export const EMPTY_PRICE_FORM: PriceFormValues = {
  modelKey: '',
  priceTier: 'standard',
  effectiveFrom: '',
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite5m: '',
  cacheWrite1h: '',
  sourceUrl: '',
  sourceNote: '',
};

export type PriceFormErrors = Partial<Record<keyof PriceFormValues, string>>;

/** The same shape saveUserPrice accepts: up to six digits on either side of the point. */
const PRICE = /^\d{1,6}(\.\d{1,6})?$/;

/** A decimal comma is what many keyboards produce; the database wants a point. */
export function normalisePrice(value: string): string {
  const trimmed = value.trim();
  return /^\d+,\d+$/.test(trimmed) ? trimmed.replace(',', '.') : trimmed;
}

/**
 * Checks the "Add a price" form field by field, so each problem is shown next to the
 * field it belongs to. saveUserPrice checks again and has the final word.
 */
export function checkPriceForm(values: PriceFormValues): { errors: PriceFormErrors; input: UserPriceInput | null } {
  const errors: PriceFormErrors = {};
  if (values.modelKey === '') errors.modelKey = 'Choose the model this price is for.';

  const price = (field: 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h', required: boolean): string | null => {
    const value = normalisePrice(values[field]);
    if (value === '') {
      if (required) errors[field] = 'Enter a price in US dollars per million tokens, for example 3 or 0.25.';
      return null;
    }
    if (!PRICE.test(value)) {
      errors[field] = 'Use a plain number such as 3 or 0.25, with at most six decimals.';
      return null;
    }
    return value;
  };
  const input = price('input', true);
  const output = price('output', true);
  const cacheRead = price('cacheRead', false);
  const cacheWrite5m = price('cacheWrite5m', false);
  const cacheWrite1h = price('cacheWrite1h', false);

  const from = values.effectiveFrom.trim();
  if (from !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)))) {
    errors.effectiveFrom = 'Enter a valid date, or leave it empty.';
  }

  const url = values.sourceUrl.trim();
  if (url === '') errors.sourceUrl = 'Add the web address where you found this price, so the figure stays traceable.';
  else if (!/^https?:\/\/\S+$/.test(url)) errors.sourceUrl = 'Enter a full web address that starts with https://.';

  if (Object.keys(errors).length > 0 || input === null || output === null) return { errors, input: null };
  return {
    errors,
    input: {
      modelKey: values.modelKey,
      priceTier: values.priceTier || 'standard',
      effectiveFrom: from === '' ? null : from,
      input,
      output,
      cacheRead,
      cacheWrite5m,
      cacheWrite1h,
      sourceUrl: url,
      sourceNote: values.sourceNote.trim() === '' ? null : values.sourceNote.trim(),
    },
  };
}

// ── Backup ──────────────────────────────────────────────────────────────────────

/**
 * `claude-lifetime-backup-2026-11-10.tar.gz`, dated by this device's calendar. A
 * passphrase-protected backup is no longer a tarball anyone can open, so it gets its
 * own extension: `.clbackup`.
 */
export function backupFileName(now: Date = new Date(), encrypted = false): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `claude-lifetime-backup-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.${encrypted ? 'clbackup' : 'tar.gz'}`;
}

/** A plain backup is a gzip stream; anything else is turned away before the user is asked to confirm a restore. */
export async function looksLikeGzip(file: Blob): Promise<boolean> {
  if (file.size < 18) return false;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

export type PassphraseCheck =
  | { ok: true; passphrase: string | null }
  | { ok: false; field: 'passphrase' | 'repeat'; message: string };

/**
 * The two passphrase fields of "Download backup". Both empty means a plain backup
 * (`passphrase: null`). A passphrase is taken exactly as typed, spaces included: it is
 * the key to the file, and the user will have to type the same thing again to restore.
 */
export function checkPassphrase(passphrase: string, repeat: string, minLength: number): PassphraseCheck {
  if (passphrase === '' && repeat === '') return { ok: true, passphrase: null };
  if (passphrase === '') return { ok: false, field: 'passphrase', message: 'Enter the passphrase here as well, or clear both fields for a backup without one.' };
  if (passphrase.length < minLength) {
    return { ok: false, field: 'passphrase', message: `Use at least ${minLength} characters, or clear both fields for a backup without a passphrase.` };
  }
  if (repeat === '') return { ok: false, field: 'repeat', message: 'Type the passphrase a second time, so a typing mistake cannot lock you out of the backup.' };
  if (repeat !== passphrase) return { ok: false, field: 'repeat', message: 'The two passphrases are not the same.' };
  return { ok: true, passphrase };
}

// ── About ───────────────────────────────────────────────────────────────────────

/** Splits the answer of `SELECT version()` into the server version and the engine that hosts it. */
export function parsePostgresVersion(full: string): { postgres: string | null; engine: string | null } {
  const match = /^PostgreSQL (\S+)(?: \(([^)]+)\))?/.exec(full.trim());
  return { postgres: match?.[1] ?? null, engine: match?.[2] ?? null };
}
