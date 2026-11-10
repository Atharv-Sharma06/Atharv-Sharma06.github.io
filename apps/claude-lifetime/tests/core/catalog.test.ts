import { describe, expect, it } from 'vitest';
import { MODELS, PRICES, splitTier, tierForGeography, tierLabel } from '@/core/catalog';
import { Decimal } from '@/core/decimal';

const price = (model: string, tier: string) => PRICES.find((p) => p.model === model && p.tier === tier);

describe('price tiers for US-only inference', () => {
  it('prices every tier of a model that accepts inference_geo at 1.1 times, in all five token categories', () => {
    expect(price('claude-opus-5-5', 'standard_us')).toMatchObject({ input: '4.4', output: '22', cacheRead: '0.22', cacheWrite5m: '5.5', cacheWrite1h: '8.8' });
    expect(price('claude-opus-5-5', 'batch_us')).toMatchObject({ input: '2.2', output: '11', cacheRead: '0.11', cacheWrite5m: '2.75', cacheWrite1h: '4.4' });
    expect(price('claude-opus-5-5', 'fast_us')).toMatchObject({ input: '8.8', output: '44' });
    expect(price('claude-haiku-5-5', 'long_context_us')).toMatchObject({ input: '0.55', output: '2.75' });
    for (const p of PRICES.filter((x) => splitTier(x.tier).usOnly)) {
      const base = price(p.model, splitTier(p.tier).base)!;
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) {
        expect(`${p.model} ${p.tier} ${field} ${p[field]}`).toBe(`${p.model} ${p.tier} ${field} ${Decimal.from(base[field]).mul('1.1').toString(6)}`);
      }
      expect(p.note).toContain('US-only inference');
      expect(p.sourceUrl).toBe(base.sourceUrl);
    }
  });

  it('exists for Claude 4.6 and later models only', () => {
    const withUsPrice = [...new Set(PRICES.filter((p) => p.tier === 'standard_us').map((p) => p.model))].sort();
    expect(withUsPrice).toEqual([
      'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2',
      'claude-haiku-5-5',
      'claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-5-2',
      'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
      'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5',
    ]);
    // every one of them was released on or after the day Claude Opus 4.6 was
    for (const key of withUsPrice) expect((MODELS.find((m) => m.key === key)?.releasedOn ?? '') >= '2026-02-05').toBe(true);
    for (const earlier of ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet']) expect(price(earlier, 'standard_us')).toBeUndefined();
  });

  it('no two prices describe the same model, tier and start date', () => {
    const seen = new Set<string>();
    for (const p of PRICES) {
      const key = `${p.model}|${p.tier}|${p.effectiveFrom ?? ''}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('derives the tier from the inference geography and names it', () => {
    expect(tierForGeography('standard', 'us')).toBe('standard_us');
    expect(tierForGeography('batch', ' US ')).toBe('batch_us');
    for (const other of ['global', 'not_available', '', null, undefined]) expect(tierForGeography('fast', other)).toBe('fast');
    expect(splitTier('long_context_us')).toEqual({ base: 'long_context', usOnly: true });
    expect(splitTier('standard')).toEqual({ base: 'standard', usOnly: false });
    expect(splitTier('_us')).toEqual({ base: '_us', usOnly: false });
    expect(tierLabel('standard_us')).toBe('Standard, US-only inference');
    expect(tierLabel('batch_us')).toBe('Batch API, US-only inference');
    expect(tierLabel('priority_us')).toBe('Priority, US-only inference');
    expect(tierLabel('long_context')).toBe('Long context');
    expect(tierLabel('flex_batch')).toBe('Flex batch');
    expect(tierLabel('')).toBe('Standard');
  });
});
