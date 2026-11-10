/**
 * Exact fixed-point decimals for money. Prices and costs are never held in binary
 * floating point: the database computes them in NUMERIC, and the few places that
 * need arithmetic in TypeScript (seeding derived prices, summing results for display)
 * use this BigInt-backed type with 12 fractional digits.
 */
const SCALE = 12n;
const ONE = 10n ** SCALE;

export class Decimal {
  private constructor(private readonly units: bigint) {}

  static zero = new Decimal(0n);

  static from(value: string | number | bigint | Decimal | null | undefined): Decimal {
    if (value instanceof Decimal) return value;
    if (value === null || value === undefined || value === '') return Decimal.zero;
    if (typeof value === 'bigint') return new Decimal(value * ONE);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError(`Not a finite decimal: ${value}`);
      if (Number.isInteger(value)) return new Decimal(BigInt(value) * ONE);
      value = value.toFixed(Number(SCALE));
    }
    const text = value.trim();
    const m = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new SyntaxError(`Not a decimal: "${value}"`);
    const negative = m[1] === '-';
    let int = m[2] || '0';
    let frac = m[3] ?? '';
    const exp = m[4] ? Number(m[4]) : 0;
    if (exp > 0) {
      frac = frac.padEnd(exp, '0');
      int += frac.slice(0, exp);
      frac = frac.slice(exp);
    } else if (exp < 0) {
      int = int.padStart(-exp + 1, '0');
      frac = int.slice(exp) + frac;
      int = int.slice(0, exp);
    }
    const scaled = BigInt(int) * ONE + BigInt(frac.slice(0, Number(SCALE)).padEnd(Number(SCALE), '0'));
    return new Decimal(negative ? -scaled : scaled);
  }

  add(other: Decimal | string | number): Decimal {
    return new Decimal(this.units + Decimal.from(other).units);
  }

  sub(other: Decimal | string | number): Decimal {
    return new Decimal(this.units - Decimal.from(other).units);
  }

  mul(other: Decimal | string | number): Decimal {
    const product = this.units * Decimal.from(other).units;
    // round half away from zero at the 12th fractional digit
    const half = product >= 0n ? ONE / 2n : -(ONE / 2n);
    return new Decimal((product + half) / ONE);
  }

  div(other: Decimal | string | number): Decimal {
    const divisor = Decimal.from(other).units;
    if (divisor === 0n) throw new RangeError('Division by zero');
    const numerator = this.units * ONE;
    const half = (numerator >= 0n) === (divisor >= 0n) ? divisor / 2n : -(divisor / 2n);
    return new Decimal((numerator + half) / divisor);
  }

  cmp(other: Decimal | string | number): -1 | 0 | 1 {
    const o = Decimal.from(other).units;
    return this.units < o ? -1 : this.units > o ? 1 : 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  /** Plain decimal string with up to `digits` fractional digits, trailing zeros trimmed. */
  toString(digits = Number(SCALE)): string {
    return this.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  /**
   * Rounded (half away from zero) to exactly `digits` fractional digits. The value holds
   * 12 of them; asking for more appends zeros.
   */
  toFixed(digits = 2): string {
    const wanted = Math.max(0, Math.floor(digits));
    const kept = Math.min(Number(SCALE), wanted);
    const factor = 10n ** (SCALE - BigInt(kept));
    const negative = this.units < 0n;
    const abs = negative ? -this.units : this.units;
    const rounded = (abs + factor / 2n) / factor;
    const text = rounded.toString().padStart(kept + 1, '0');
    const head = kept === 0 ? text : text.slice(0, -kept);
    const fraction = (kept === 0 ? '' : text.slice(-kept)).padEnd(wanted, '0');
    return (negative && rounded !== 0n ? '-' : '') + head + (wanted === 0 ? '' : '.' + fraction);
  }

  /** For display only (charts, compact formatting). Never feed the result back into money math. */
  toNumber(): number {
    return Number(this.toFixed(Number(SCALE)));
  }
}

/** Sum decimal strings coming back from SQL NUMERIC columns. */
export function sumDecimals(values: Array<string | number | null | undefined>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.add(Decimal.from(v)), Decimal.zero);
}
