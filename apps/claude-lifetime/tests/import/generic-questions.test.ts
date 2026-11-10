import { describe, expect, it } from 'vitest';
import { FORMATS, type ParserKey } from '@/import/formats';
import { genericJsonParser } from '@/import/generic';
import { questionBeforeReading } from '@/import/generic/questions';
import { collectingSink, fileOf } from '../helpers/sink';

/**
 * What the import asks the person before it reads a file. A JSON usage file has no
 * field that says whether its counts were metered, so without the question every
 * such file would be stored as an estimate, whatever its counts are.
 */
describe('questionBeforeReading', () => {
  it('asks how reliable the counts of a JSON usage file are', () => {
    expect(questionBeforeReading('generic-json', {})).toBe('confidence');
    // options that say nothing about it change nothing
    expect(questionBeforeReading('generic-json', { sourceLabel: 'Proxy', sourceRef: 'proxy' })).toBe('confidence');
  });

  it('does not ask when the import was started with the answer', () => {
    expect(questionBeforeReading('generic-json', { confidence: 'exact' })).toBeNull();
    expect(questionBeforeReading('generic-json', { confidence: 'estimated' })).toBeNull();
  });

  it('shows the mapping step for a CSV table, which asks the same question', () => {
    expect(questionBeforeReading('generic-csv', {})).toBe('mapping');
    expect(questionBeforeReading('generic-csv', { confidence: 'exact' })).toBe('mapping');
  });

  it('asks nothing for the formats whose counts come from Anthropic or are estimated by the app', () => {
    for (const parser of Object.keys(FORMATS) as ParserKey[]) {
      if (parser === 'generic-csv' || parser === 'generic-json') continue;
      expect(questionBeforeReading(parser, {}), parser).toBeNull();
    }
  });

  it('is answered with the option the JSON importer reads', async () => {
    const file = fileOf('usage.json', JSON.stringify([{ timestamp: '2026-03-01T09:15:00Z', model: 'claude-sonnet-4-6', input_tokens: 1200, output_tokens: 350 }]));
    for (const confidence of ['exact', 'estimated'] as const) {
      // what the step hands to the import: the options it was started with, and the answer
      const options = { now: Date.UTC(2026, 10, 10), confidence };
      expect(questionBeforeReading('generic-json', options)).toBeNull();
      const { out, sink } = collectingSink();
      const parsed = await genericJsonParser.parse([file], sink, { options });
      expect(out.usage.map((u) => u.confidence)).toEqual([confidence]);
      expect(parsed.stats.confidence).toBe(confidence);
    }
  });
});
