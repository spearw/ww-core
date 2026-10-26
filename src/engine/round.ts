/**
 * Python's `round(x, n)`: rounds the exact binary value of `x` half-to-even.
 * WW takes the band from the rounded priority, so the port must round identically.
 */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const { mant, exp } = decompose(Math.abs(x));
  if (exp >= 0) return x; // already an integer
  const num = mant * BigInt(10) ** BigInt(n);
  const den = 1n << BigInt(-exp);
  let q = num / den;
  const twice = (num % den) * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  // Parse the decimal string: Number(q) / 10 ** n double-rounds once q passes 2^53.
  const out = Number(`${q}e-${n}`);
  return x < 0 ? -out : out;
}

/** Exact decomposition of a positive finite double: x = mant · 2^exp. */
function decompose(x: number): { mant: bigint; exp: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased === 0) return { mant: frac, exp: -1074 };
  return { mant: frac | (1n << 52n), exp: biased - 1075 };
}
