import { describe, expect, it } from 'vitest';
import { MODELS } from '@/core/catalog';
import { normaliseModelId, resolveModel } from '@/core/models';

/**
 * A model arrives under many spellings. They are reduced to the catalog's key, and an
 * identifier the catalog does not know is kept as it is: no model is ever guessed.
 */
describe('model identifiers', () => {
  it('reduces the spellings of one snapshot to the same key, whichever provider wrote it', () => {
    const spellings: Array<[string, string]> = [
      ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet'],
      ['claude-3-5-sonnet-latest', 'claude-3-5-sonnet'],
      // Amazon Bedrock: provider prefix, version after the date
      ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'claude-3-5-sonnet'],
      ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'claude-3-5-sonnet'],
      // Google Vertex AI: version before the date
      ['claude-3-5-sonnet-v2@20241022', 'claude-3-5-sonnet'],
      ['claude-3-5-sonnet@20240620', 'claude-3-5-sonnet'],
      ['claude-opus-4-5@20251101', 'claude-opus-4-5'],
      ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'claude-opus-4-1'],
      ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
      // Claude Code marks the long-context variant
      ['claude-sonnet-4-5[1m]', 'claude-sonnet-4-5'],
      ['  Claude-Sonnet-4-5  ', 'claude-sonnet-4-5'],
      ['models/claude-haiku-4-5', 'claude-haiku-4-5'],
    ];
    for (const [raw, key] of spellings) expect(normaliseModelId(raw), raw).toBe(key);
    // every one of them is a model the catalog knows
    for (const [raw] of spellings) expect(resolveModel(raw)?.known, raw).toBe(true);
  });

  it('keeps what it does not know, and treats placeholders as no model at all', () => {
    expect(resolveModel('gpt-4o')).toMatchObject({ key: 'gpt-4o', known: false });
    expect(normaliseModelId('my-proxy-model-v3')).toBe('my-proxy-model');
    for (const none of [null, undefined, '', '  ', '<synthetic>', 'unknown', 'null', 'None', 'N/A']) expect(normaliseModelId(none)).toBeNull();
  });

  it('resolves every catalog key and alias to its own model', () => {
    for (const model of MODELS) {
      expect(resolveModel(model.key)).toMatchObject({ key: model.key, known: true });
      for (const alias of model.aliases) expect(resolveModel(alias)?.key, alias).toBe(model.key);
    }
  });
});
