/**
 * Known limitations of a token estimate, stored as a bitmask on every estimate
 * (token_estimates.limitation_flags) so the reasons a number may be off are never lost.
 */
export const Limitation = {
  /** The source does not say which model answered; the tokenizer generation was assumed from the date. */
  MODEL_UNKNOWN: 1,
  /** System prompt, tool definitions, project knowledge, memory and styles are not in the export. */
  HIDDEN_CONTEXT_EXCLUDED: 2,
  /** The message references images or other binary files whose token cost cannot be measured. */
  BINARY_FILES_EXCLUDED: 4,
  /** Visible thinking can be a summary; billed thinking tokens may be higher. */
  THINKING_PARTIAL: 8,
  /** Tools were used; tool definitions and server-side tool processing are not measurable. */
  TOOL_OVERHEAD_EXCLUDED: 16,
  /** The message had no usable timestamp; a neighbouring timestamp was used. */
  TIMESTAMP_INFERRED: 32,
  /** Modelled context replay was capped at the assumed context window. */
  CONTEXT_CAPPED: 64,
  /** The conversation has edits or retries; replay assumes the listed order is one thread. */
  BRANCHES_LINEARISED: 128,
  /** An attachment had no extracted text in the export. */
  ATTACHMENT_TEXT_MISSING: 256,
} as const;

export type LimitationName = keyof typeof Limitation;

export const LIMITATION_TEXT: Record<LimitationName, { short: string; detail: string }> = {
  MODEL_UNKNOWN: {
    short: 'Model not recorded',
    detail:
      'The source does not record which model answered. The tokenizer generation was assumed from the message date, and no model-specific price can be applied.',
  },
  HIDDEN_CONTEXT_EXCLUDED: {
    short: 'Hidden context excluded',
    detail:
      'System prompts, tool definitions, project knowledge, memory and styles are sent to the model but are not part of the export, so they are not counted.',
  },
  BINARY_FILES_EXCLUDED: {
    short: 'Images and files excluded',
    detail:
      'Images, PDFs and other binary uploads cost tokens, but the export only lists their file names. Their tokens are unavailable.',
  },
  THINKING_PARTIAL: {
    short: 'Thinking may be summarised',
    detail:
      'Exported thinking text can be a summary of longer reasoning. Billed thinking tokens may be higher than the estimate.',
  },
  TOOL_OVERHEAD_EXCLUDED: {
    short: 'Tool overhead excluded',
    detail:
      'Tool calls and results in the export are counted, but tool definitions and server-side processing are not visible.',
  },
  TIMESTAMP_INFERRED: {
    short: 'Timestamp inferred',
    detail: 'The message had no valid timestamp, so the nearest known timestamp in the conversation was used.',
  },
  CONTEXT_CAPPED: {
    short: 'Context capped',
    detail:
      'Re-sent context was capped at the assumed context window, because a real request cannot exceed it.',
  },
  BRANCHES_LINEARISED: {
    short: 'Edits treated as one thread',
    detail:
      'The conversation contains edited or regenerated messages. Without reliable branch information, re-sent context is modelled on the listed order.',
  },
  ATTACHMENT_TEXT_MISSING: {
    short: 'Attachment text missing',
    detail: 'An attachment had no extracted text in the export, so its tokens are not counted.',
  },
};

export function decodeLimitations(flags: number): LimitationName[] {
  return (Object.keys(Limitation) as LimitationName[]).filter((name) => (flags & Limitation[name]) !== 0);
}
