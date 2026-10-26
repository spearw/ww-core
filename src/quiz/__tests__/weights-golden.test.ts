import golden from '../__fixtures__/weights-golden.json';
import {
  adjust,
  archetypeOf,
  BALANCER_SPREAD,
  CAP,
  CRITERIA,
  DEFAULT_WEIGHTS,
  estimate,
  FLAVOUR_MARGIN,
  FLOOR,
  LAMBDA,
  needsRecheck,
  RECHECK_THRESHOLD,
  TIER_STEP,
  type DuelObservation,
} from '../weights';
import type { Criterion, Weights } from '../../engine';

type G = typeof golden;
const TOL = 1e-9;

function expectClose(got: Record<string, number>, want: Record<string, number>) {
  for (const k of Object.keys(want)) expect(Math.abs(got[k]! - want[k]!)).toBeLessThan(TOL);
}

const asDuels = (ds: G['estimates'][number]['duels']) => ds as DuelObservation[];

it('uses the same constants as the oracle', () => {
  expect(golden.constants).toEqual({
    tierStep: TIER_STEP,
    lambda: LAMBDA,
    floor: FLOOR,
    cap: CAP,
    recheckThreshold: RECHECK_THRESHOLD,
    flavourMargin: FLAVOUR_MARGIN,
    balancerSpread: BALANCER_SPREAD,
    defaultWeights: DEFAULT_WEIGHTS,
  });
});

it('covers an adjust where another priority is held at the floor and the rest redistributed', () => {
  const floored = golden.adjusts.filter((c) =>
    CRITERIA.some(
      (k) =>
        k !== c.criterion &&
        Math.abs((c.expect as Weights)[k] - FLOOR) < TOL &&
        (c.weights as Weights)[k] *
          ((1 - (c.expect as Weights)[c.criterion as Criterion]) /
            (1 - (c.weights as Weights)[c.criterion as Criterion])) <
          FLOOR - TOL,
    ),
  );
  expect(floored.length).toBeGreaterThan(0);
});

describe.each(golden.estimates.map((c) => [c.name, c] as const))('estimate: %s', (_n, c) => {
  const e = estimate({ best: c.best as Criterion, worst: c.worst as Criterion }, asDuels(c.duels));
  it('matches prior, utilities and weights', () => {
    expectClose(e.prior, c.expect.prior);
    expectClose(e.v, c.expect.v);
    expectClose(e.weights, c.expect.weights);
  });
  it('matches residuals and the re-check decision', () => {
    e.residuals.forEach((r, k) => expect(Math.abs(r - c.expect.residuals[k]!)).toBeLessThan(TOL));
    expect(e.worstIndex).toBe(c.expect.worstIndex);
    expect(needsRecheck(e)).toBe(c.expect.needsRecheck);
  });
  it('matches the archetype', () => {
    expect(archetypeOf(e.weights)).toEqual({ key: c.expect.archetype, flavour: c.expect.flavour });
  });
});

describe.each(golden.rechecks.map((c) => [c.name, c] as const))('re-check: %s', (_n, c) => {
  it('matches weights and "less sure"', () => {
    const e = estimate({ best: c.best as Criterion, worst: c.worst as Criterion }, [
      ...asDuels(c.duels),
      c.recheck as DuelObservation,
    ]);
    expectClose(e.weights, c.expect.weights);
    expect(needsRecheck(e)).toBe(c.expect.lessSure);
    expect(archetypeOf(e.weights)).toEqual({ key: c.expect.archetype, flavour: c.expect.flavour });
  });
});

describe.each(golden.adjusts.map((c) => [c.name, c] as const))('adjust: %s', (_n, c) => {
  it('matches', () => {
    expectClose(adjust(c.weights as Weights, c.criterion as Criterion, c.target), c.expect);
  });
});

it('skipping is the Balancer', () => {
  expect(archetypeOf(DEFAULT_WEIGHTS, true)).toEqual({
    key: golden.skipped.expect.archetype,
    flavour: golden.skipped.expect.flavour,
  });
});
