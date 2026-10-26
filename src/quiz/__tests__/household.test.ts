import { householdWeights } from '../household';
import { CRITERIA, DEFAULT_WEIGHTS, FLOOR, CAP, clampWeights } from '../weights';

const will = { memberId: 'w', weights: { risk: 0.4, value: 0.3, finance: 0.2, enablement: 0.1 } };
const katie = { memberId: 'k', weights: { risk: 0.1, value: 0.2, finance: 0.3, enablement: 0.4 } };

it('is the mean of current members’ weights (HANDOFF A1)', () => {
  const w = householdWeights([will, katie], ['w', 'k']);
  for (const c of CRITERIA) expect(w[c]).toBeCloseTo(0.25, 12);
});
it('ignores a profile whose person has left', () => {
  expect(householdWeights([will, katie], ['w'])).toEqual(will.weights);
});
it('uses DEFAULT_WEIGHTS when no current member has a profile', () => {
  expect(householdWeights([], ['w', 'k'])).toEqual(DEFAULT_WEIGHTS);
});
it('sums to 1 and stays inside [FLOOR, CAP]', () => {
  const w = householdWeights(
    [
      will,
      katie,
      {
        memberId: 'x',
        weights: clampWeights({ risk: 0.5, value: 0.3, finance: 0.15, enablement: 0.05 }),
      },
    ],
    ['w', 'k', 'x'],
  );
  expect(CRITERIA.reduce((s, c) => s + w[c], 0)).toBeCloseTo(1, 12);
  for (const c of CRITERIA) {
    expect(w[c]).toBeGreaterThanOrEqual(FLOOR);
    expect(w[c]).toBeLessThanOrEqual(CAP);
  }
});
