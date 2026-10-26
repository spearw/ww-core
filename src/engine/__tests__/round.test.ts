import { pyRound } from '../round';

describe('pyRound matches Python round() (review focus 2)', () => {
  const table: [number, number, number][] = [
    [0.125, 2, 0.12],
    [0.375, 2, 0.38],
    [2.675, 2, 2.67],
    [0.25, 1, 0.2],
    [0.35, 1, 0.3],
    [2.5, 0, 2],
    [3.5, 0, 4],
    [-2.5, 0, -2],
    [101.45, 1, 101.5],
    [19.2149998677612, 1, 19.2],
    [8.526306063770424, 1, 8.5],
    [1.8249999999999997, 3, 1.825],
    [59.65, 1, 59.6],
    [0, 1, 0],
    [-0.05, 1, -0.1],
    [1e-7, 3, 0],
    [124724361596636.25, 2, 124724361596636.25], // q exceeds 2^53
  ];

  it.each(table)('round(%p, %p) = %p', (x, n, want) => {
    expect(pyRound(x, n)).toBe(want);
  });

  it('leaves integers and non-finite values alone', () => {
    expect(pyRound(5, 1)).toBe(5);
    expect(pyRound(Infinity, 1)).toBe(Infinity);
    expect(pyRound(NaN, 1)).toBeNaN();
  });
});
