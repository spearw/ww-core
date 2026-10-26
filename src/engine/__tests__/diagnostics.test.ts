import { correlationCheck, MIN_CORRELATION_PROJECTS, sensitivity, spearman } from '../diagnostics';
import { scoreAll } from '../score';
import { defaultConfig, type ProjectInput } from '../types';

const AS_OF = '2026-09-11';
const CFG = defaultConfig(['a']);
const plain = (id: string, extra: Partial<ProjectInput> = {}): ProjectInput => ({
  id,
  cost: 1000,
  costConfidence: 'quoted',
  effort: 3,
  probability: 1,
  consequence: 1,
  reach: 1,
  impacts: { a: 1 },
  identified: AS_OF,
  ...extra,
});

describe('spearman', () => {
  it('is 1 for the same order, -1 for the reverse, 0 when one side is constant', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 9);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 9);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBe(0);
  });

  it('is 0 for fewer than two items (review focus 5)', () => {
    expect(spearman([], [])).toBe(0);
    expect(spearman([1], [2])).toBe(0);
  });
});

describe('correlationCheck', () => {
  it('flags R and V when they move together', () => {
    const recs = scoreAll(
      [
        plain('a'),
        plain('b', { probability: 3, consequence: 3, reach: 5 }),
        plain('c', { probability: 4, consequence: 4, reach: 7 }),
        plain('d', { probability: 5, consequence: 4, reach: 9 }),
        plain('e', { probability: 5, consequence: 5, reach: 10 }),
      ],
      CFG,
      AS_OF,
    );
    expect(recs).toHaveLength(MIN_CORRELATION_PROJECTS);
    const rv = correlationCheck(recs).find((c) => c.pair === 'R~V')!;
    expect(rv.flag).toBe(true);
    expect(rv.rho).toBeGreaterThan(0.8);
  });

  it('returns no pairs for an empty list (review focus 5)', () => {
    expect(correlationCheck([])).toEqual([]);
  });

  it('returns no pairs below five projects, however correlated (F2)', () => {
    const recs = scoreAll(
      [
        plain('a'),
        plain('b', { probability: 3, consequence: 3, reach: 5 }),
        plain('c', { probability: 4, consequence: 4, reach: 7 }),
        plain('d', { probability: 5, consequence: 5, reach: 10 }),
      ],
      CFG,
      AS_OF,
    );
    expect(recs).toHaveLength(4);
    expect(correlationCheck(recs)).toEqual([]);
  });
});

describe('sensitivity', () => {
  it('marks a project sitting on a cut-off unstable and a safe one stable', () => {
    const edge = plain('edge', { probability: 3, consequence: 4, reach: 8 });
    const safe = plain('safe');
    const p = scoreAll([edge], CFG, AS_OF)[0]!.priority;
    const cfg = { ...CFG, bands: { NOW: 1000, NEXT: p, SOON: 1 } };
    expect(sensitivity([edge, safe], cfg, AS_OF)).toEqual({ edge: true, safe: false });
  });
});
