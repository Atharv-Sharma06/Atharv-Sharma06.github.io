import { describe, expect, it } from 'vitest';
import { Decimal, sumDecimals } from '@/core/decimal';

/** Money is computed in exact decimals, never in binary floating point. */
describe('Decimal', () => {
  it('parses the forms that come back from the database and from the catalog', () => {
    expect(Decimal.from('3').toString()).toBe('3');
    expect(Decimal.from('0.25').toString()).toBe('0.25');
    expect(Decimal.from('.5').toString()).toBe('0.5');
    expect(Decimal.from('12.').toString()).toBe('12');
    expect(Decimal.from('-1.50').toString()).toBe('-1.5');
    expect(Decimal.from('+7').toString()).toBe('7');
    expect(Decimal.from('1e3').toString()).toBe('1000');
    expect(Decimal.from('2.5e-3').toString()).toBe('0.0025');
    expect(Decimal.from('1.5E2').toString()).toBe('150');
    expect(Decimal.from(42).toString()).toBe('42');
    expect(Decimal.from(0.1).toString()).toBe('0.1');
    expect(Decimal.from(10n).toString()).toBe('10');
    expect(Decimal.from(null).isZero()).toBe(true);
    expect(Decimal.from('').isZero()).toBe(true);
    expect(Decimal.from(undefined).isZero()).toBe(true);
    const same = Decimal.from('1');
    expect(Decimal.from(same)).toBe(same);
  });

  it('refuses what is not a number', () => {
    for (const bad of ['abc', '1,5', '1.2.3', '.', '--1', '$3']) expect(() => Decimal.from(bad), bad).toThrow(SyntaxError);
    expect(() => Decimal.from(Number.NaN)).toThrow(RangeError);
    expect(() => Decimal.from(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('adds, subtracts and compares without the errors of floating point', () => {
    expect(Decimal.from('0.1').add('0.2').toString()).toBe('0.3');
    expect(Decimal.from('1').sub('0.9').toString()).toBe('0.1');
    expect(Decimal.from('0.3').cmp(Decimal.from('0.1').add('0.2'))).toBe(0);
    expect(Decimal.from('2').cmp('3')).toBe(-1);
    expect(Decimal.from('-2').cmp('-3')).toBe(1);
    expect(sumDecimals(['0.1', '0.2', null, undefined, 0.3, '']).toString()).toBe('0.6');
    expect(sumDecimals([]).isZero()).toBe(true);
  });

  it('multiplies and divides to 12 fractional digits, rounding half away from zero', () => {
    // 1,234,567 tokens at $3 per million
    expect(Decimal.from(1_234_567).mul('3').div(1_000_000).toString()).toBe('3.703701');
    expect(Decimal.from('1').div('3').toString()).toBe('0.333333333333');
    expect(Decimal.from('2').div('3').toString()).toBe('0.666666666667');
    expect(Decimal.from('-2').div('3').toString()).toBe('-0.666666666667');
    expect(Decimal.from('0.000000000001').mul('0.5').toString()).toBe('0.000000000001');
    expect(Decimal.from('-0.000000000001').mul('0.5').toString()).toBe('-0.000000000001');
    expect(() => Decimal.from('1').div(0)).toThrow(RangeError);
  });

  it('formats with a fixed number of digits, rounding half away from zero', () => {
    expect(Decimal.from('2.345').toFixed(2)).toBe('2.35');
    expect(Decimal.from('2.344').toFixed(2)).toBe('2.34');
    expect(Decimal.from('-2.345').toFixed(2)).toBe('-2.35');
    expect(Decimal.from('0.005').toFixed(2)).toBe('0.01');
    expect(Decimal.from('-0.004').toFixed(2)).toBe('0.00');
    expect(Decimal.from('19.999').toFixed(2)).toBe('20.00');
    expect(Decimal.from('1234.5').toFixed(0)).toBe('1235');
    expect(Decimal.from('0').toFixed(2)).toBe('0.00');
    expect(Decimal.from('20').toFixed()).toBe('20.00');
    expect(Decimal.from('3.10').toString(6)).toBe('3.1');
    expect(Decimal.from('3.0000004').toString(6)).toBe('3');
    expect(Decimal.from('1234.5').toString(0)).toBe('1235');
  });

  it('appends zeros when asked for more digits than it holds, and never moves the decimal point', () => {
    expect(Decimal.from('20').toFixed(13)).toBe('20.0000000000000');
    expect(Decimal.from('1').toFixed(15)).toBe('1.000000000000000');
    expect(Decimal.from('0.5').toString(13)).toBe('0.5');
    expect(Decimal.from('3.14159').toFixed(20)).toBe('3.14159000000000000000');
    expect(Decimal.from('-0.25').toFixed(14)).toBe('-0.25000000000000');
    expect(Decimal.from('7').toFixed(12)).toBe('7.000000000000');
    // a fractional or negative digit count is read as a whole number of digits, at least none
    expect(Decimal.from('1.26').toFixed(1.9)).toBe('1.3');
    expect(Decimal.from('1.26').toFixed(-3)).toBe('1');
  });

  it('gives a number for display only', () => {
    expect(Decimal.from('0.1').add('0.2').toNumber()).toBe(0.3);
    expect(Decimal.from('-12.5').toNumber()).toBe(-12.5);
  });
});
