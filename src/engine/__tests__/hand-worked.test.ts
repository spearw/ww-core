import handJson from '../__fixtures__/hand-worked.json';
import { scoreAll } from '../score';
import { defaultConfig, type EngineConfig } from '../types';
import { fromApp, mismatches, type AppFixture } from './appFixture';

const HAND = handJson as unknown as AppFixture;

describe.each(HAND.suites.map((s) => [s.name, s] as const))('hand-worked: %s', (_name, suite) => {
  const cfg: EngineConfig = {
    ...defaultConfig(suite.members),
    weights: HAND.weights,
    horizonYears: HAND.horizon_years,
  };
  const scored = new Map(
    scoreAll(
      suite.cases.map((c) => fromApp(c.input)),
      cfg,
      HAND.as_of,
    ).map((r) => [r.id, r]),
  );

  it.each(suite.cases.map((c) => [c.id, c] as const))('%s', (id, c) => {
    const rec = scored.get(id);
    if (!rec) throw new Error(`${id} was not scored`);
    expect(mismatches(c.expect, rec)).toEqual([]);
  });
});
