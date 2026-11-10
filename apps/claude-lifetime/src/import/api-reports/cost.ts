import { Decimal } from '@/core/decimal';
import type { ImportFile, ImportParser, ImportSink, ParseContext, ParsedImport, StagedCost } from '@/core/types';
import { clip } from '../generic/values';
import { ReportReader, type ReportKind } from './report';

/**
 * Importer for Anthropic's API cost reports: what was actually billed, per day.
 * Actual spend is kept apart from the "equivalent API value" the app calculates
 * from token counts; this importer only feeds the former.
 *
 *  - GET /v1/organizations/cost_report      legacy Usage and Cost API
 *      data[]: { starting_at, ending_at, results[] }; a result has `amount`,
 *      `currency` and, when grouped by description, `description`, `cost_type`,
 *      `token_type`, `model`, `service_tier`, `context_window`, `inference_geo`,
 *      `speed`; when grouped by workspace, `workspace_id`.
 *  - GET /v1/organizations/analytics/cost   Usage and Cost Analytics API
 *      data[]: { starting_at, ending_at, group{…}, cost{ currency, amount,
 *      list_amount, requests } }. There is no description; `cost_type` and
 *      `token_type` are dimensions in `group`.
 *
 * Unit of the amounts — cents in both APIs, as decimal strings:
 *  - legacy reference: "Cost amount in lowest currency units (e.g. cents) as a
 *    decimal string. For example, "123.45" in "USD" represents $1.23."
 *  - Analytics guide: "Amounts are decimal strings in cents with six decimal
 *    places: "41280.000000" is $412.80 USD."
 * `amount` of the Analytics API is "the cost after discounts and before any credits
 * are applied" and is what is imported; `list_amount` (the cost at list prices) is
 * only added up for the import's statistics.
 *
 * Like usage reports, cost reports restate a period: an import replaces the cost
 * rows imported earlier inside the time range it covers.
 */
const COST_REPORT: ReportKind = {
  kind: 'cost',
  source: { kind: 'api_cost_report', label: 'Anthropic API cost report', externalRef: '' },
  formats: { legacy: 'anthropic/cost-report', analytics: 'anthropic/analytics-cost' },
  labels: {
    legacy: 'Anthropic API cost report (Usage and Cost API)',
    analytics: 'Anthropic API cost report (Usage and Cost Analytics API)',
  },
  keyPrefix: 'cost',
  // Text values of a legacy result that say how much, not what for.
  measurementFields: new Set(['amount', 'currency', 'list_amount']),
  phase: 'Reading cost report',
};

/** A plain decimal number: optional sign, digits, optional fraction, optional exponent. */
const DECIMAL_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function decimalText(value: unknown): string | null {
  // The APIs send strings. A number is accepted in its shortest exact spelling
  // ("123.45"), never through binary arithmetic.
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return DECIMAL_TEXT.test(text) ? text : null;
}

/**
 * Converts an amount in cents to US dollars, exactly: "123.45" -> "1.2345".
 * Null when the value is not a decimal number. Fixed-point arithmetic with twelve
 * fractional digits; the APIs send at most six.
 */
export function centsToUsd(cents: unknown): string | null {
  const text = decimalText(cents);
  return text === null ? null : Decimal.from(text).div(100).toString();
}

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export const apiCostReportParser: ImportParser = {
  async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
    const reader = new ReportReader(files, sink, ctx, COST_REPORT);
    const groupedBy = new Set<string>();
    let rowsWithModel = 0;
    let rowsWithCostType = 0;
    let total = Decimal.zero;
    let listTotal = Decimal.zero;
    let hasListAmounts = false;

    for await (const row of reader.rows()) {
      const metrics = row.metrics;
      const dims = row.dims;

      // "Currently always USD" according to the reference. Anything else cannot be added to dollar amounts.
      const currency = typeof metrics.currency === 'string' ? metrics.currency.trim().toUpperCase() : '';
      if (currency !== '' && currency !== 'USD') {
        reader.skip('non_usd_currency', 'Rows in a currency other than US dollars were skipped: amounts are kept in USD and are not converted.', `${currency} (${row.startIso})`);
        continue;
      }
      const amountUsd = centsToUsd(metrics.amount);
      if (amountUsd === null) {
        reader.skip('invalid_amount', 'Rows whose amount is not a decimal number were skipped.', `${clip(metrics.amount, 40)} (${row.startIso})`);
        continue;
      }

      const modelKey = await reader.models.resolve(dims.model);
      const cost: StagedCost = {
        modelKey,
        occurredAt: row.startIso,
        bucketSeconds: row.bucketSeconds,
        costType: textOrNull(dims.cost_type),
        tokenType: textOrNull(dims.token_type),
        description: textOrNull(dims.description),
        amountUsd,
        dedupKey: row.dedupKey,
      };
      await sink.cost(cost);
      reader.emitted();

      for (const name of row.dimensionNames) groupedBy.add(name);
      if (modelKey !== null) rowsWithModel++;
      if (cost.costType !== null) rowsWithCostType++;
      total = total.add(amountUsd);
      const listUsd = centsToUsd(metrics.list_amount);
      if (listUsd !== null) {
        hasListAmounts = true;
        listTotal = listTotal.add(listUsd);
      }
    }

    const missingFields: string[] = [];
    if (rowsWithCostType === 0) missingFields.push('cost_type');
    if (rowsWithModel === 0) missingFields.push('model');
    if (rowsWithCostType === 0 && rowsWithModel === 0) {
      reader.warnings.add(
        'cost_not_itemised',
        'This cost report is not broken down by what was billed. The amounts are imported as totals per period and cannot be attributed to a model or to tokens, web search or code execution. ' +
          'For an itemised report, request it again with group_by[]=description (cost_report) or with group_by[]=model&group_by[]=cost_type&group_by[]=token_type (analytics/cost).',
        undefined,
        reader.emittedCount,
      );
    }

    return reader.finish({
      missingFields,
      stats: {
        groupedBy: [...groupedBy].sort().join(', '),
        totalUsd: total.toString(),
        ...(hasListAmounts ? { listTotalUsd: listTotal.toString() } : {}),
        unknownModels: reader.models.unknownCount,
      },
    });
  },
};
