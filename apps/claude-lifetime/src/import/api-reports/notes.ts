import type { WarningList } from '../generic/shared';

/**
 * Warnings that apply to exact usage whatever file it came from (API response or
 * Console export), worded once.
 */

/** A product or workspace name that means Claude Code. */
export const looksLikeClaudeCode = (value: unknown): boolean => typeof value === 'string' && /claude[\s_-]?code/i.test(value);

export function noteClaudeCodeOverlap(warnings: WarningList, rows: number): void {
  if (rows === 0) return;
  warnings.add(
    'possible_overlap_claude_code',
    'Part of this usage was made with Claude Code. If Claude Code transcripts from the same period are imported too, that usage is present in both sources and counted twice. ' +
      'In that case leave one of the two sources out of the totals.',
    undefined,
    rows,
  );
}

export function noteHaikuLongContext(warnings: WarningList, rows: number): void {
  if (rows === 0) return;
  warnings.add(
    'haiku_long_context_unknown',
    'Claude Haiku 5.5 costs more for prompts over 100,000 tokens, but usage reports only separate prompts at 200,000 tokens. ' +
      'Its usage is valued at the standard price throughout, which can understate its equivalent API value.',
    undefined,
    rows,
  );
}

export function noteUsOnlyInference(warnings: WarningList, rows: number): void {
  if (rows === 0) return;
  warnings.add(
    'us_inference_premium',
    'Rows with inference_geo "us" are billed at 1.1 times the standard price on Claude 4.6 and later models. Their equivalent API value is calculated at the standard price and is up to 10% too low.',
    undefined,
    rows,
  );
}
