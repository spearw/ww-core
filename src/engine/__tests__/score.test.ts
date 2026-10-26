import { scoreAll } from '../score';
import { defaultConfig, type EngineConfig, type ProjectInput } from '../types';

const AS_OF = '2026-09-11';
const CFG: EngineConfig = defaultConfig(['a']);
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
const byId = (ps: ProjectInput[], cfg: EngineConfig = CFG) =>
  new Map(scoreAll(ps, cfg, AS_OF).map((r) => [r.id, r]));

describe('scoreAll: statuses and dependencies', () => {
  it('ignores dropped projects entirely', () => {
    const out = byId([plain('x', { status: 'dropped' }), plain('y', { dependsOn: ['x'] })]);
    expect(out.has('x')).toBe(false);
    expect(out.get('y')!.blocked).toBe(false);
  });

  it('scores in-progress projects, and they still block', () => {
    const out = byId([plain('p', { status: 'in_progress' }), plain('c', { dependsOn: ['p'] })]);
    expect(out.has('p')).toBe(true);
    expect(out.get('c')!.blocked).toBe(true);
  });

  it('a done prerequisite satisfies the dependency and is not scored', () => {
    const out = byId([plain('p', { status: 'done' }), plain('c', { dependsOn: ['p'] })]);
    expect(out.has('p')).toBe(false);
    expect(out.get('c')!.blocked).toBe(false);
  });

  it('derives E from active dependents only', () => {
    const out = byId([
      plain('parent'),
      plain('kid-open', { dependsOn: ['parent'] }),
      plain('kid-dropped', { dependsOn: ['parent'], status: 'dropped' }),
    ]);
    expect(out.get('parent')!.E).toBe(7);
    expect(out.get('parent')!.blocks).toEqual(['kid-open']);
  });

  it('ignores unknown prerequisites (review focus 3)', () => {
    expect(byId([plain('p', { dependsOn: ['ghost'] })]).get('p')!.blocked).toBe(false);
  });

  it('handles self-links and cycles without hanging (review focus 3)', () => {
    const out = byId([
      plain('a', { dependsOn: ['b'] }),
      plain('b', { dependsOn: ['a'] }),
      plain('s', { dependsOn: ['s'] }),
    ]);
    expect(out.get('a')!.blocked).toBe(true);
    expect(out.get('b')!.blocked).toBe(true);
    expect(out.get('s')!.blocked).toBe(true);
  });

  it('names blockers by title in next moves', () => {
    const out = byId([plain('p1', { title: 'Fix the roof' }), plain('c1', { dependsOn: ['p1'] })]);
    expect(out.get('c1')!.nextMoves).toEqual([{ kind: 'blocked_by', titles: ['Fix the roof'] }]);
  });
});

describe('scoreAll: urgency, projection, bands, order', () => {
  it('treats a missing identified date as today', () => {
    const r = byId([plain('p', { urgency: 'intangible', identified: null })]).get('p')!;
    expect(r.U).toBe(1);
  });

  it('never lets a future identified date lower urgency (F5)', () => {
    const r = byId([plain('p', { urgency: 'constant_benefit', identified: '2046-09-11' })]).get(
      'p',
    )!;
    expect(r.U).toBe(1);
    expect(Object.values(r.projection).every(Number.isFinite)).toBe(true);
  });

  it('projects "if you wait" linearly in U', () => {
    const r = byId([plain('p', { urgency: 'intangible', probability: 4, consequence: 4 })]).get(
      'p',
    )!;
    expect(r.projection.y0).toBe(r.priority);
    expect(r.projection.y5).toBeGreaterThan(r.projection.y1);
    expect(r.projection.y1).toBeGreaterThan(r.projection.y0);
  });

  it('bands a priority exactly on a cut-off into the higher band (review focus 2)', () => {
    const p = byId([plain('p')]).get('p')!.priority;
    const cfg = { ...CFG, bands: { NOW: p + 100, NEXT: p, SOON: p / 2 } };
    expect(byId([plain('p')], cfg).get('p')!.band).toBe('NEXT');
  });

  it('sorts non-negotiable first, then priority down, cost up, id', () => {
    const out = scoreAll(
      [
        plain('high', { probability: 5, consequence: 5 }),
        plain('must', { nonNegotiable: 'legal' }),
        plain('b-same', { cost: 1000 }),
        plain('a-same', { cost: 1000 }),
      ],
      CFG,
      AS_OF,
    );
    expect(out.map((r) => r.id)).toEqual(['must', 'high', 'a-same', 'b-same']);
  });

  it('sorts by band before priority, so a forced-Now deadline stays above Next and Soon', () => {
    const projects = [
      plain('now', { probability: 5, consequence: 5, reach: 10 }),
      plain('next', { probability: 4, consequence: 4 }),
      plain('soon', { probability: 3, consequence: 3 }),
      plain('forced', { urgency: 'hard_deadline', deadline: '2026-09-21' }),
    ];
    const pr = new Map(scoreAll(projects, CFG, AS_OF).map((r) => [r.id, r.priority]));
    // Explicit bands so the test holds whatever the calibrated cut-offs are.
    const cfg = {
      ...CFG,
      bands: { NOW: pr.get('now')!, NEXT: pr.get('next')!, SOON: pr.get('soon')! },
    };
    expect(pr.get('forced')!).toBeLessThan(pr.get('soon')!);
    const out = scoreAll(projects, cfg, AS_OF);
    expect(out.map((r) => [r.id, r.band])).toEqual([
      ['now', 'NOW'],
      ['forced', 'NOW'],
      ['next', 'NEXT'],
      ['soon', 'SOON'],
    ]);
  });
});

describe('scoreAll: degenerate inputs', () => {
  it('returns [] for no projects (review focus 5)', () => {
    expect(scoreAll([], CFG, AS_OF)).toEqual([]);
  });

  it('keeps a zero-cost project finite (review focus 4)', () => {
    const r = byId([plain('free', { cost: 0, effort: 1 })]).get('free')!;
    expect(Number.isFinite(r.priority)).toBe(true);
    expect(r.size).toBeCloseTo(Math.log10(40) * 1.15, 3); // sized as the $30 chip (P5c-6)
  });

  it('throws on a malformed date instead of scoring NaN (review focus 1)', () => {
    expect(() => scoreAll([plain('p', { identified: '2026-02-30' })], CFG, AS_OF)).toThrow(
      'no such day',
    );
  });

  it('names the project, the field and the cause in a date error (F4)', () => {
    expect(() => scoreAll([plain('p', { identified: '2026-02-30' })], CFG, AS_OF)).toThrow(
      'Project "p": invalid identified date — Invalid date "2026-02-30": no such day',
    );
    expect(() => scoreAll([plain('q', { deadline: 'soon' })], CFG, AS_OF)).toThrow(
      'Project "q": invalid deadline date — Invalid date "soon": expected YYYY-MM-DD',
    );
  });

  it('treats an empty date string as malformed for both fields, null as no date (F4)', () => {
    expect(() => scoreAll([plain('p', { identified: '' })], CFG, AS_OF)).toThrow(
      'Project "p": invalid identified date',
    );
    expect(() =>
      scoreAll([plain('p', { urgency: 'hard_deadline', deadline: '' })], CFG, AS_OF),
    ).toThrow('Project "p": invalid deadline date');
    expect(() =>
      scoreAll([plain('p', { identified: null, deadline: null })], CFG, AS_OF),
    ).not.toThrow();
  });

  it('validates every project up front, even a standard-urgency deadline (F4)', () => {
    expect(() =>
      scoreAll([plain('ok'), plain('p', { deadline: '2026-13-01' })], CFG, AS_OF),
    ).toThrow('Project "p": invalid deadline date');
  });
});

describe('scoreAll: members (D33)', () => {
  it('counts every member, at impact 1 if they have not rated it', () => {
    const cfg = defaultConfig(['a', 'b']);
    const r = byId([plain('p', { reach: 3, impacts: { a: 3 } })], cfg).get('p')!;
    expect(r.perPerson).toEqual({ a: 3, b: 1 });
  });

  it("ignores impact keys for people who aren't members", () => {
    const r = byId([plain('p', { reach: 3, impacts: { a: 1, stranger: 3 } })]).get('p')!;
    expect(r.perPerson).toEqual({ a: 1 });
    expect(r.V).toBe(1);
  });

  it('scores V as 0 for a list with no members (review focus 5)', () => {
    const r = byId([plain('p')], defaultConfig([])).get('p')!;
    expect(r.V).toBe(0);
    expect(Number.isFinite(r.priority)).toBe(true);
  });
});

describe('scoreAll: quick win', () => {
  it('is cost under $200 and effort 2 or less', () => {
    const out = byId([
      plain('in', { cost: 199, effort: 2 }),
      plain('cost', { cost: 200, effort: 1 }),
      plain('effort', { cost: 100, effort: 3 }),
    ]);
    expect([
      out.get('in')!.quickWin,
      out.get('cost')!.quickWin,
      out.get('effort')!.quickWin,
    ]).toEqual([true, false, false]);
  });
});

describe('scoreAll: costs under $50 rank alike (P5c-6)', () => {
  it('$0, $20 and $30 get the same priority; $50 does not', () => {
    const out = byId([
      plain('zero', { cost: 0 }),
      plain('twenty', { cost: 20 }),
      plain('thirty', { cost: 30 }),
      plain('fifty', { cost: 50 }),
    ]);
    const p = (id: string) => out.get(id)!.priority;
    expect(p('zero')).toBe(p('thirty'));
    expect(p('twenty')).toBe(p('thirty'));
    expect(p('fifty')).toBeLessThan(p('thirty'));
  });

  it('keeps the entered cost for the quick-win test and the shown cost', () => {
    const out = byId([plain('zero', { cost: 0, effort: 1 })]);
    expect(out.get('zero')!.cost).toBe(0);
    expect(out.get('zero')!.quickWin).toBe(true);
  });
});
