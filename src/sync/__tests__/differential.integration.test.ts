import { makeFakeWorld } from './fakeWorld';
import { disposeLive, makeSupabaseWorld, sweepStaleUsers } from './localSupabase';
import { SCENARIOS, collectTranscripts } from './scenarios';

afterEach(disposeLive);
afterAll(sweepStaleUsers);

/** The fake server and local Supabase agree on every scenario's phone-visible outcome and push
 *  answers. It proves no more than that: how the server enforces its rules is pgTAP's job. */
describe('differential: fake server vs local Supabase', () => {
  it('every scenario produces the same transcript on both', async () => {
    const fake = await collectTranscripts(makeFakeWorld);
    const real = await collectTranscripts(makeSupabaseWorld);
    expect(Object.keys(real)).toEqual(SCENARIOS.map((s) => s.name));
    expect(real).toEqual(fake);
  }, 600_000);
});
