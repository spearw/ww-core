import {
  bandOf,
  combineFactors,
  dateFlags,
  scoreEnablement,
  scoreFinance,
  scoreRisk,
  scoreValue,
  urgencyAt,
} from '../score';
import { defaultConfig, type ProjectInput } from '../types';

const AS_OF = '2026-09-11';
const cfg = defaultConfig(['a']);
const base: ProjectInput = {
  id: 'p',
  cost: 1000,
  costConfidence: 'quoted',
  effort: 3,
  probability: 1,
  consequence: 1,
  reach: 1,
  impacts: { a: 1 },
  identified: AS_OF,
};

describe('scoreRisk', () => {
  it('is 10·P·Cq/25', () => {
    expect(scoreRisk({ ...base, probability: 3, consequence: 2 })).toBeCloseTo(2.4, 12);
    expect(scoreRisk({ ...base, probability: 5, consequence: 5 })).toBe(10);
  });
});

describe('scoreValue', () => {
  it('averages min(10, reach·impact/3) over people; a missing impact counts as 1', () => {
    const r = scoreValue({ ...base, reach: 5, impacts: { a: 3 } }, ['a', 'b']);
    expect(r.perPerson).toEqual({ a: 5, b: 5 / 3 });
    expect(r.V).toBeCloseTo((5 + 5 / 3) / 2, 12);
    expect(r.spread).toBeCloseTo(5 - 5 / 3, 12);
  });

  it('clamps each person at 10', () => {
    expect(scoreValue({ ...base, reach: 10, impacts: { a: 3 } }, ['a']).V).toBe(10);
  });

  it('is 0 with nobody (review focus 5)', () => {
    expect(scoreValue(base, [])).toEqual({ V: 0, perPerson: {}, spread: 0 });
  });
});

describe('scoreFinance', () => {
  it('interpolates the payback anchors', () => {
    expect(scoreFinance({ ...base, annualSavings: 200 }, cfg)).toEqual({ F: 8.5, fpr: 2 });
    expect(scoreFinance({ ...base, annualSavings: 25 }, cfg).F).toBeCloseTo(1.5, 12);
    expect(scoreFinance({ ...base, recoupPct: 0.6 }, cfg).F).toBeCloseTo(3.6, 12);
  });

  it('saturates at 10', () => {
    expect(scoreFinance({ ...base, annualSavings: 1000 }, cfg).F).toBe(10);
  });

  it('stays finite and non-negative for zero cost and net losses (review focus 4)', () => {
    expect(scoreFinance({ ...base, cost: 0, annualSavings: 300 }, cfg)).toEqual({
      F: 10,
      fpr: 3000,
    });
    const loss = scoreFinance({ ...base, annualCarryingCost: 500 }, cfg);
    expect(loss.F).toBe(0);
    expect(loss.fpr).toBeCloseTo(-5, 12);
  });
});

describe('scoreEnablement', () => {
  it('is 0 / 7 / 10 by active dependents', () => {
    expect([0, 1, 2, 5].map(scoreEnablement)).toEqual([0, 7, 10, 10]);
  });
});

describe('urgencyAt', () => {
  it('handles the flat profiles', () => {
    expect(urgencyAt({ ...base, urgency: 'expedite' }, AS_OF, 0)).toBe(2);
    expect(urgencyAt({ ...base, urgency: 'standard' }, AS_OF, 0)).toBe(1);
    expect(urgencyAt(base, AS_OF, 0)).toBe(1);
  });

  it('escalates intangible by 8% a year, capped at 2.5', () => {
    const p = { ...base, urgency: 'intangible' as const, identified: '2023-09-11' };
    expect(urgencyAt(p, AS_OF, 0)).toBeCloseTo(1 + 0.08 * (1096 / 365.25), 12);
    expect(urgencyAt({ ...p, identified: '2000-01-01' }, AS_OF, 0)).toBe(2.5);
  });

  it('escalates constant_benefit by 5% a year, capped at 1.5', () => {
    const p = { ...base, urgency: 'constant_benefit' as const, identified: '2000-01-01' };
    expect(urgencyAt(p, AS_OF, 0)).toBe(1.5);
  });

  it('treats a missing identified date as today', () => {
    expect(urgencyAt({ ...base, urgency: 'intangible', identified: null }, AS_OF, 0)).toBe(1);
  });
});

describe('real deadlines and target dates (D21)', () => {
  const hard = (deadline: string | null) => ({
    ...base,
    urgency: 'hard_deadline' as const,
    deadline,
  });
  const target = (deadline: string | null) => ({
    ...base,
    urgency: 'target_date' as const,
    deadline,
  });

  it('ramps a real deadline over six months and holds 2.5 once passed', () => {
    expect(urgencyAt(hard('2027-09-11'), AS_OF, 0)).toBe(1);
    expect(urgencyAt(hard('2026-11-10'), AS_OF, 0)).toBeCloseTo(1 + 1.5 * (1 - 60 / 30.44 / 6), 12);
    expect(urgencyAt(hard('2026-09-11'), AS_OF, 0)).toBe(2.5);
    expect(urgencyAt(hard('2026-09-01'), AS_OF, 0)).toBe(2.5);
    expect(urgencyAt(hard('2026-11-10'), AS_OF, 1)).toBe(2.5);
    expect(urgencyAt(hard(null), AS_OF, 0)).toBe(1);
  });

  it('ramps a target over three months and holds 1.5 once passed', () => {
    expect(urgencyAt(target('2027-01-11'), AS_OF, 0)).toBe(1);
    expect(urgencyAt(target('2026-10-11'), AS_OF, 0)).toBeCloseTo(
      1 + 0.5 * (1 - 30 / 30.44 / 3),
      12,
    );
    expect(urgencyAt(target('2026-09-01'), AS_OF, 0)).toBe(1.5);
    expect(urgencyAt(target(null), AS_OF, 0)).toBe(1);
  });

  it('flags overdue, past target and the 30-day forced-Now window', () => {
    expect(dateFlags(hard('2026-10-12'), AS_OF)).toEqual({
      overdue: false,
      pastTarget: false,
      forcedNow: false,
    });
    expect(dateFlags(hard('2026-10-11'), AS_OF)).toEqual({
      overdue: false,
      pastTarget: false,
      forcedNow: true,
    });
    expect(dateFlags(hard('2026-09-11'), AS_OF)).toEqual({
      overdue: false,
      pastTarget: false,
      forcedNow: true,
    });
    expect(dateFlags(hard('2026-09-10'), AS_OF)).toEqual({
      overdue: true,
      pastTarget: false,
      forcedNow: true,
    });
    expect(dateFlags(target('2026-09-10'), AS_OF)).toEqual({
      overdue: false,
      pastTarget: true,
      forcedNow: false,
    });
    expect(dateFlags(hard(null), AS_OF)).toEqual({
      overdue: false,
      pastTarget: false,
      forcedNow: false,
    });
    expect(dateFlags({ ...base, deadline: '2026-09-01' }, AS_OF)).toEqual({
      overdue: false,
      pastTarget: false,
      forcedNow: false,
    });
  });
});

describe('bandOf', () => {
  it('uses inclusive cut-offs (review focus 2)', () => {
    expect(bandOf(121.5, null, false, cfg)).toBe('NOW');
    expect(bandOf(121.4, null, false, cfg)).toBe('NEXT');
    expect(bandOf(85.5, null, false, cfg)).toBe('NEXT');
    expect(bandOf(45, null, false, cfg)).toBe('SOON');
    expect(bandOf(44.9, null, false, cfg)).toBe('SOMEDAY');
  });

  it('forces non-negotiable projects into NOW', () => {
    expect(bandOf(1, 'legal', false, cfg)).toBe('NOW');
  });

  it('forces a real deadline inside 30 days into NOW', () => {
    expect(bandOf(1, null, true, cfg)).toBe('NOW');
  });
});

describe('combineFactors (D20)', () => {
  const w = cfg.weights;

  it('ignores Money back and Unlocks more when they are zero', () => {
    expect(combineFactors({ risk: 5, value: 5, finance: 0, enablement: 0 }, w)).toBeCloseTo(5, 12);
  });

  it('equals the plain weighted sum when all four count', () => {
    const f = { risk: 1, value: 1, finance: 9, enablement: 10 };
    expect(combineFactors(f, w)).toBeCloseTo(0.4 * 1 + 0.3 * 1 + 0.2 * 9 + 0.1 * 10, 12);
  });

  it('never scores below the R/V average', () => {
    const rv = (0.4 * 4.8 + 0.3 * 1.6667) / 0.7;
    for (const finance of [0, 1.5, 3, 8.5, 10]) {
      for (const enablement of [0, 7, 10]) {
        const got = combineFactors({ risk: 4.8, value: 1.6667, finance, enablement }, w);
        expect(got).toBeGreaterThanOrEqual(rv - 1e-12);
      }
    }
  });
});
