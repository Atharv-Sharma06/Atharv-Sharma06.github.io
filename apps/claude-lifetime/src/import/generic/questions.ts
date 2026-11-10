import type { ParserKey } from '../formats';

/**
 * What the import has to ask the person before it reads a file of their own making:
 *
 *  - 'mapping'     which column of a CSV table holds what (the same step asks how
 *                  reliable the counts are and what the source is called)
 *  - 'confidence'  whether the token counts of a JSON usage file were metered
 *
 * Decided from what was detected and from the options the import was started with.
 * This module has no parser code, so the import page can use it without loading one.
 */
export type QuestionBeforeReading = 'mapping' | 'confidence';

export function questionBeforeReading(parser: ParserKey, options: Record<string, unknown> = {}): QuestionBeforeReading | null {
  // No table somebody made says which of its columns is which.
  if (parser === 'generic-csv') return 'mapping';
  // The JSON format has no field for how its counts were obtained, and nothing vouches
  // for a file somebody made. Unanswered, every such file would be stored as an estimate,
  // so the person is asked, unless whoever started the import has answered already.
  if (parser === 'generic-json' && options.confidence === undefined) return 'confidence';
  return null;
}
