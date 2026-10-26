import {
  adjust,
  ANSWERS,
  archetypeId,
  archetypeOf,
  CAP,
  CRITERIA,
  DEFAULT_WEIGHTS,
  duelTarget,
  estimate,
  FLOOR,
  needsRecheck,
  priorFromCards,
  scaleClamp,
  snapTarget,
  TIER_STEP,
  TIERS,
  type Answer,
  type DuelObservation,
} from '../weights';

const cards = { best: 'risk', worst: 'enablement' } as const;
const pairs = [
  ['risk', 'value'],
  ['risk', 'finance'],
  ['risk', 'enablement'],
  ['value', 'enablement'],
  ['finance', 'enablement'],
] as const;
const duels = (answers: readonly Answer[]): DuelObservation[] =>
  pairs.map(([a, b], k) => ({ a, b, answer: answers[k]! }));
const sum = (w: Record<string, number>) => Object.values(w).reduce((s, x) => s + x, 0);

describe('priorFromCards', () => {
  it('is 0.44 / 0.225 / 0.225 / 0.11 and needs two different cards', () => {
    expect(priorFromCards(cards)).toEqual({
      risk: 0.44,
      value: 0.225,
      finance: 0.225,
      enablement: 0.11,
    });
    expect(() => priorFromCards({ best: 'risk', worst: 'risk' })).toThrow(
      'best and worst must differ',
    );
  });
});

describe('estimate', () => {
  it('keeps card order and lands between prior and equal for all toss-ups', () => {
    const e = estimate(cards, duels(Array(5).fill('tossUp')));
    const w = e.weights;
    expect(w.risk).toBeGreaterThan(w.value);
    expect(w.value).toBeCloseTo(w.finance, 12);
    expect(w.value).toBeGreaterThan(w.enablement);
    for (const c of CRITERIA) {
      const [lo, hi] = [e.prior[c], 0.25].sort((x, y) => x - y) as [number, number];
      expect(w[c]).toBeGreaterThan(lo);
      expect(w[c]).toBeLessThan(hi);
    }
  });

  it('sums to 1 and stays within 5–50% for every answer pattern', () => {
    const all: Answer[][] = [[]];
    for (let k = 0; k < 5; k++) {
      const next: Answer[][] = [];
      for (const prefix of all) for (const a of ANSWERS) next.push([...prefix, a]);
      all.splice(0, all.length, ...next);
    }
    expect(all).toHaveLength(3125);
    for (const combo of all) {
      const w = estimate(cards, duels(combo)).weights;
      expect(Math.abs(sum(w) - 1)).toBeLessThan(1e-12);
      for (const v of Object.values(w)) {
        expect(v).toBeGreaterThanOrEqual(FLOOR - 1e-12);
        expect(v).toBeLessThanOrEqual(CAP + 1e-12);
      }
    }
  });

  it('flags an intransitive set for a re-check and not a consistent one', () => {
    expect(needsRecheck(estimate(cards, duels(Array(5).fill('definitelyA'))))).toBe(false);
    const cycle = estimate(
      cards,
      duels(['definitelyA', 'tossUp', 'definitelyB', 'definitelyA', 'tossUp']),
    );
    expect(needsRecheck(cycle)).toBe(true);
    expect(cycle.worstIndex).toBe(2);
  });

  it('with no duels there is nothing to re-check', () => {
    expect(needsRecheck(estimate(cards, []))).toBe(false);
  });
});

describe('impact tiers', () => {
  it('exposes three tiers and a step of two', () => {
    expect(TIERS).toEqual([0, 1, 2]);
    expect(TIER_STEP).toBe(2);
  });

  it('shifts a duel target by the tier gap, in steps of ln 2', () => {
    expect(duelTarget({ a: 'risk', b: 'value', answer: 'tossUp' })).toBe(0);
    expect(duelTarget({ a: 'risk', b: 'value', answer: 'tossUp', tierA: 1, tierB: 2 })).toBeCloseTo(
      Math.log(2),
      12,
    );
    expect(duelTarget({ a: 'risk', b: 'value', answer: 'leanA', tierA: 2, tierB: 1 })).toBeCloseTo(
      0,
      12,
    );
  });

  it('reads a toss-up between a medium and a high line as a lean to the first', () => {
    const tiered = pairs.map(([a, b]) => ({
      a,
      b,
      answer: 'tossUp' as const,
      tierA: 1 as const,
      tierB: 2 as const,
    }));
    const plain = duels(Array(5).fill('leanA'));
    const got = estimate(cards, tiered);
    const want = estimate(cards, plain);
    for (const c of CRITERIA) expect(got.weights[c]).toBeCloseTo(want.weights[c], 12);
  });

  it('ignores equal tiers', () => {
    const answers: Answer[] = ['leanA', 'tossUp', 'definitelyB', 'leanA', 'definitelyA'];
    const tiered = duels(answers).map((d) => ({ ...d, tierA: 2 as const, tierB: 2 as const }));
    const got = estimate(cards, tiered);
    const want = estimate(cards, duels(answers));
    for (const c of CRITERIA) expect(got.weights[c]).toBeCloseTo(want.weights[c], 12);
  });

  it('measures residuals against the shifted target', () => {
    const d: DuelObservation = {
      a: 'risk',
      b: 'value',
      answer: 'leanB',
      tierA: 2,
      tierB: 0,
    };
    const e = estimate(cards, [d]);
    expect(Math.abs(e.residuals[0]! - (e.v.risk - e.v.value - duelTarget(d)))).toBeLessThan(1e-12);
  });
});

describe('scaleClamp', () => {
  it('holds the floor and cap and keeps the total', () => {
    const out = scaleClamp([0.97, 0.01, 0.01, 0.01], 1);
    expect(out[0]).toBe(0.5);
    out.slice(1).forEach((v) => expect(v).toBeCloseTo(1 / 6, 12));
  });

  it('rejects impossible totals and non-positive values', () => {
    expect(() => scaleClamp([0.5, 0.5], 1.5)).toThrow(RangeError);
    expect(() => scaleClamp([0, 1], 1)).toThrow(RangeError);
  });
});

describe('adjust', () => {
  it('snaps to 5% steps and clamps the target', () => {
    expect(snapTarget(0.33)).toBeCloseTo(0.35, 12);
    expect(snapTarget(0.125)).toBeCloseTo(0.15, 12);
    expect(snapTarget(0.9)).toBe(0.5);
    expect(snapTarget(-1)).toBe(0.05);
  });

  it('keeps the sum at 1 and every weight within bounds', () => {
    for (const c of CRITERIA) {
      for (let t = -0.1; t <= 0.7; t += 0.01) {
        const w = adjust({ ...DEFAULT_WEIGHTS }, c, t);
        expect(Math.abs(sum(w) - 1)).toBeLessThan(1e-12);
        Object.values(w).forEach((v) => {
          expect(v).toBeGreaterThanOrEqual(FLOOR - 1e-12);
          expect(v).toBeLessThanOrEqual(CAP + 1e-12);
        });
      }
    }
  });

  it('rescales the others in proportion when nothing clamps', () => {
    const w = adjust({ ...DEFAULT_WEIGHTS }, 'enablement', 0.2);
    expect(w.risk / w.value).toBeCloseTo(0.4 / 0.3, 12);
    expect(w.value / w.finance).toBeCloseTo(0.3 / 0.2, 12);
  });
});

describe('archetypeOf', () => {
  it('names the top criterion, adds a close second, and knows the Balancer', () => {
    expect(archetypeOf({ risk: 0.5, value: 0.2, finance: 0.2, enablement: 0.1 })).toEqual({
      key: 'firefighter',
      flavour: null,
    });
    expect(archetypeOf({ risk: 0.4, value: 0.33, finance: 0.17, enablement: 0.1 })).toEqual({
      key: 'firefighter',
      flavour: 'enjoyer',
    });
    expect(archetypeOf({ risk: 0.28, value: 0.25, finance: 0.25, enablement: 0.22 }).key).toBe(
      'balancer',
    );
    expect(archetypeOf({ ...DEFAULT_WEIGHTS }, true)).toEqual({ key: 'balancer', flavour: null });
  });

  it('serialises for storage', () => {
    expect(archetypeId({ key: 'investor', flavour: 'builder' })).toBe('investor:builder');
    expect(archetypeId({ key: 'balancer', flavour: null })).toBe('balancer');
  });
});
