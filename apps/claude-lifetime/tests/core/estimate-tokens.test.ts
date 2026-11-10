import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from '@anthropic-ai/tokenizer';
import { describe, expect, it } from 'vitest';
import { ESTIMATE_MODEL_VERSION, estimateBaseTokens } from '@/core/tokens/estimate';

// Accuracy bounds that the shipped model meets on tests/fixtures/tokens, with headroom. The measured values
// come from `node scripts/calibrate-tokens.mjs`; half of every fixture (the even six-line blocks) was part of
// the fitting data, the report of that script also lists the other half on its own.

/** Any single fixture. Worst measured: lang-ko.txt at -7.8%. */
const MAX_ERROR_ANY_FIXTURE = 0.1;
/** Fixtures of at least 2,000 characters. Worst measured: code.sql.txt at +6.4%, then urls.hex-base64.txt at -4.0%. */
const MAX_ERROR_FIXTURE_2000_CHARS = 0.08;
/** All fixtures of one class pooled. Worst measured outside Korean: Ukrainian and Italian at -3.0%. */
const MAX_ERROR_PER_CLASS = 0.06;
/** Known weak spot: Korean everyday prose (measured -7.8%). */
const MAX_ERROR_PER_CLASS_OVERRIDES: Record<string, number> = { 'lang-ko': 0.1 };
/** All fixtures pooled, weighted by tokens. Measured: -0.13%. */
const MAX_ERROR_POOLED = 0.02;

/** est(a + b) versus est(a) + est(b), in tokens. Measured maxima: 1 (whole files), 2 (cut after a newline), 4 (cut anywhere). */
const ADDITIVITY_WHOLE_TEXTS = 2;
const ADDITIVITY_AT_LINE_BREAK = 3;
const ADDITIVITY_ANYWHERE = 6;

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/tokens');

/** Report class of a fixture: the part of the file name before the first dot. */
function fixtureClass(file: string): string {
  const head = file.split('.')[0];
  return head === 'urls' ? 'urls-hex-base64' : head;
}

const EXPECTED_CLASSES = [
  'en-prose', 'en-chat', 'markdown', 'code', 'json', 'tables', 'logs', 'urls-hex-base64', 'numbers', 'emoji',
  'lang-es', 'lang-fr', 'lang-de', 'lang-pt', 'lang-it', 'lang-ru', 'lang-uk', 'lang-el', 'lang-ar', 'lang-he',
  'lang-hi', 'lang-bn', 'lang-th', 'lang-zh', 'lang-ja', 'lang-ko',
];

interface Fixture {
  file: string;
  cls: string;
  text: string;
  actual: number;
  estimate: number;
}

const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.txt'))
  .sort()
  .map((file) => {
    const text = readFileSync(join(FIXTURE_DIR, file), 'utf8');
    return { file, cls: fixtureClass(file), text, actual: countTokens(text), estimate: estimateBaseTokens(text) };
  });

const relativeError = (estimate: number, actual: number) => estimate / actual - 1;

describe('estimateBaseTokens: invariants', () => {
  it('exposes the model version', () => {
    expect(ESTIMATE_MODEL_VERSION).toBe('heuristic-v1');
  });

  it('returns 0 for the empty string and a non-negative integer for everything else', () => {
    expect(estimateBaseTokens('')).toBe(0);
    for (const text of ['a', ' ', '\n', 'hello world', '0', '.', 'é', '日本語', '😀', '\u0000', 'a'.repeat(1000)]) {
      const n = estimateBaseTokens(text);
      expect(Number.isInteger(n), JSON.stringify(text)).toBe(true);
      expect(n, JSON.stringify(text)).toBeGreaterThanOrEqual(1);
    }
  });

  it('prices whitespace-only strings like the tokenizer does', () => {
    for (const text of [' ', '\n', '\n\n', '    ', '\t', '\t\t', '\n    ', '  \n', '\r\n', ' '.repeat(64), ' '.repeat(100), '\n'.repeat(5)]) {
      expect(estimateBaseTokens(text), JSON.stringify(text)).toBe(countTokens(text));
    }
    // long runs stay small: a run of blanks never costs more than two tokens
    expect(estimateBaseTokens(' '.repeat(100_000))).toBeLessThanOrEqual(2);
    expect(estimateBaseTokens('\n'.repeat(100_000))).toBeLessThanOrEqual(2);
  });

  it('is within one token on short everyday strings', () => {
    const samples = ['hello world', 'Hello, world!', "don't", "it's", 'a\nb', 'a\n\nb', 'foo_bar', 'x = 1;', '{"a": 1}', '日本語', '😀', 'Привет', 'é'];
    for (const text of samples) {
      expect(Math.abs(estimateBaseTokens(text) - countTokens(text)), JSON.stringify(text)).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic and keeps no state between calls', () => {
    const a = fixtures[0].text;
    const b = fixtures[fixtures.length - 1].text;
    const first = estimateBaseTokens(a);
    estimateBaseTokens(b);
    estimateBaseTokens('línea sin terminar con ñ y sin salto de línea');
    expect(estimateBaseTokens(a)).toBe(first);
    expect(estimateBaseTokens(a.slice())).toBe(first);
  });

  it('survives lone surrogates, emoji sequences and every UTF-16 code unit', () => {
    const everyCodeUnit = Array.from({ length: 0x10000 }, (_, i) => String.fromCharCode(i)).join('');
    const samples = [
      '\ud83d', '\udc00', 'a\ud83db', 'a\udc00b', '\udc00\ud83d', '\ud83d😀', 'x\ud83d',
      '👍🏽', '🇯🇵', '🤦‍♀️', '👨‍👩‍👧‍👦', '☀️', '𝗯𝗼𝗹𝗱', '𠀀', '​‍﻿',
      'é', 'ｆｕｌｌ　ｗｉｄｔｈ１２３', 'a b', everyCodeUnit, everyCodeUnit.split('').reverse().join(''),
    ];
    for (const text of samples) {
      const n = estimateBaseTokens(text);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6 * text.length + 2);
    }
    // an emoji is priced as a whole, not as two unknown halves
    expect(estimateBaseTokens('😀')).toBe(countTokens('😀'));
  });

  it('scales linearly on one very long line', () => {
    const unit = 'The export contains every conversation, including attachments and tool results. ';
    const short = estimateBaseTokens(unit.repeat(1000));
    const long = estimateBaseTokens(unit.repeat(40_000)); // 3.2 million characters without a line break
    expect(long / (40 * short)).toBeGreaterThan(0.995);
    expect(long / (40 * short)).toBeLessThan(1.005);
    // One sentence repeated is not a representative sample (this one is +16%: long common English words are
    // single tokens, the model prices them by length). Only the order of magnitude is checked here.
    expect(Math.abs(relativeError(short, countTokens(unit.repeat(1000))))).toBeLessThan(0.25);
  });
});

describe('estimateBaseTokens: additivity', () => {
  it('whole texts add up', () => {
    for (let i = 0; i < fixtures.length; i++) {
      for (const j of [(i + 1) % fixtures.length, (i + 7) % fixtures.length]) {
        const a = fixtures[i], b = fixtures[j];
        const joined = estimateBaseTokens(a.text + b.text);
        expect(Math.abs(joined - a.estimate - b.estimate), `${a.file} + ${b.file}`).toBeLessThanOrEqual(ADDITIVITY_WHOLE_TEXTS);
        // adding text never makes the estimate drop (beyond rounding)
        expect(joined).toBeGreaterThanOrEqual(Math.max(a.estimate, b.estimate) - ADDITIVITY_WHOLE_TEXTS);
      }
    }
  });

  it('a text cut after any line break adds up', () => {
    for (const f of fixtures) {
      let worst = 0;
      for (let p = f.text.indexOf('\n') + 1; p > 0 && p < f.text.length; p = f.text.indexOf('\n', p) + 1) {
        worst = Math.max(worst, Math.abs(estimateBaseTokens(f.text.slice(0, p)) + estimateBaseTokens(f.text.slice(p)) - f.estimate));
      }
      expect(worst, f.file).toBeLessThanOrEqual(ADDITIVITY_AT_LINE_BREAK);
    }
  });

  it('a text cut anywhere, even inside a word, is off by a few tokens at most', () => {
    let sum = 0;
    let cuts = 0;
    for (const f of fixtures) {
      for (let p = 1; p < f.text.length; p += 13) {
        const c = f.text.charCodeAt(p);
        if (c >= 0xdc00 && c <= 0xdfff) continue; // not inside a surrogate pair
        const diff = Math.abs(estimateBaseTokens(f.text.slice(0, p)) + estimateBaseTokens(f.text.slice(p)) - f.estimate);
        expect(diff, `${f.file} at ${p}`).toBeLessThanOrEqual(ADDITIVITY_ANYWHERE);
        sum += diff;
        cuts++;
      }
    }
    expect(sum / cuts).toBeLessThan(1.5); // measured mean: 0.7 tokens
  });
});

describe('estimateBaseTokens: accuracy against @anthropic-ai/tokenizer', () => {
  it('has fixtures for every class and language', () => {
    const present = new Set(fixtures.map((f) => f.cls));
    for (const cls of EXPECTED_CLASSES) expect(present.has(cls), cls).toBe(true);
    for (const f of fixtures) expect(f.actual, f.file).toBeGreaterThan(100);
  });

  it.each(fixtures.map((f) => [f.file, f] as const))('%s is within the per-fixture bound', (_file, f) => {
    const error = Math.abs(relativeError(f.estimate, f.actual));
    expect(error).toBeLessThanOrEqual(MAX_ERROR_ANY_FIXTURE);
    if (f.text.length >= 2000) expect(error).toBeLessThanOrEqual(MAX_ERROR_FIXTURE_2000_CHARS);
  });

  it.each(EXPECTED_CLASSES.map((cls) => [cls] as const))('class %s is within the per-class bound', (cls) => {
    const members = fixtures.filter((f) => f.cls === cls);
    const actual = members.reduce((sum, f) => sum + f.actual, 0);
    const estimate = members.reduce((sum, f) => sum + f.estimate, 0);
    expect(Math.abs(relativeError(estimate, actual))).toBeLessThanOrEqual(MAX_ERROR_PER_CLASS_OVERRIDES[cls] ?? MAX_ERROR_PER_CLASS);
  });

  it('all fixtures pooled are within the aggregate bound', () => {
    const actual = fixtures.reduce((sum, f) => sum + f.actual, 0);
    const estimate = fixtures.reduce((sum, f) => sum + f.estimate, 0);
    expect(Math.abs(relativeError(estimate, actual))).toBeLessThanOrEqual(MAX_ERROR_POOLED);
  });
});

describe('estimateBaseTokens: speed', () => {
  it('handles 5 million characters of mixed text well under 1.5 seconds', () => {
    let mixed = fixtures.map((f) => f.text).join('\n');
    while (mixed.length < 5_000_000) mixed += mixed;
    mixed = mixed.slice(0, 5_000_000);
    estimateBaseTokens(mixed.slice(0, 200_000)); // let the JIT see the code once
    const start = performance.now();
    const n = estimateBaseTokens(mixed);
    const elapsed = performance.now() - start;
    expect(n).toBeGreaterThan(1_000_000);
    expect(elapsed).toBeLessThan(1500); // typically 50-100 ms: 50-100 million characters per second
  });
});
