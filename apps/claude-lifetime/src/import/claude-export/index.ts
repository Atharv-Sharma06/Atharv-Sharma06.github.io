import { estimateBaseTokens } from '@/core/tokens/estimate';
import { createClaudeExportParser } from './parser';

/** The claude.ai export parser with the app's token estimator plugged in. */
export const claudeExportParser = createClaudeExportParser(estimateBaseTokens);
export { CLAUDE_EXPORT_PARSER_VERSION } from './parser';
