import fixtureJson from '../__fixtures__/conformance-app.json';
import { scoreAll } from '../score';
import { defaultConfig, type EngineConfig } from '../types';
import { fromApp, mismatches, type AppFixture } from './appFixture';

const FIXTURE = fixtureJson as unknown as AppFixture;

it("the engine's default cut-offs are the calibrated ones in the fixture", () => {
  expect(defaultConfig([]).bands).toEqual(FIXTURE.bands);
});

describe.each(FIXTURE.suites.map((s) => [s.name, s] as const))('app contract: %s', (_n, suite) => {
  const cfg: EngineConfig = {
    ...defaultConfig(suite.members),
    weights: FIXTURE.weights,
    horizonYears: FIXTURE.horizon_years,
    bands: FIXTURE.bands!,
  };
  const scored = new Map(
    scoreAll(
      suite.cases.map((c) => fromApp(c.input)),
      cfg,
      FIXTURE.as_of,
    ).map((r) => [r.id, r]),
  );

  it.each(suite.cases.map((c) => [c.id, c] as const))('%s', (id, c) => {
    const rec = scored.get(id);
    if (c.expect.scored === false) {
      expect(rec).toBeUndefined();
      return;
    }
    if (!rec) throw new Error(`${id} was not scored`);
    expect(mismatches(c.expect, rec)).toEqual([]);
  });
});
