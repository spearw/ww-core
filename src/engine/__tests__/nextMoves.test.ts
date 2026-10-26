import { nextMoves, type NextMoveInput } from '../nextMoves';

const quiet: NextMoveInput = {
  costConfidence: 'quoted',
  cost: 1000,
  blockedBy: [],
  blocks: [],
  disagreement: 0,
  fpr: 1,
  urgency: 'standard',
  U: 1,
  overdue: false,
  pastTarget: false,
};

describe('nextMoves', () => {
  it('suggests nothing for a quiet project', () => {
    expect(nextMoves(quiet, [])).toEqual([]);
  });

  it('asks for a real price only for guesses over $5k', () => {
    expect(nextMoves({ ...quiet, costConfidence: 'guess', cost: 5000 }, [])).toEqual([]);
    expect(nextMoves({ ...quiet, costConfidence: 'guess', cost: 5001 }, [])).toEqual([
      { kind: 'get_real_price', cost: 5001 },
    ]);
  });

  it('names blockers by title, not id', () => {
    expect(nextMoves({ ...quiet, blockedBy: ['p1'] }, ['Fix the roof'])).toEqual([
      { kind: 'blocked_by', titles: ['Fix the roof'] },
    ]);
  });

  it('flags projects that unblock two or more others', () => {
    expect(nextMoves({ ...quiet, blocks: ['a'] }, [])).toEqual([]);
    expect(nextMoves({ ...quiet, blocks: ['a', 'b'] }, [])).toEqual([
      { kind: 'unblocks_many', count: 2 },
    ]);
  });

  it('flags disagreement of 3 or more', () => {
    expect(nextMoves({ ...quiet, disagreement: 2.99 }, [])).toEqual([]);
    expect(nextMoves({ ...quiet, disagreement: 3 }, [])).toEqual([{ kind: 'disagree' }]);
  });

  it('flags spending over $10k with little payback', () => {
    expect(nextMoves({ ...quiet, fpr: 0.49, cost: 10_001 }, [])).toEqual([
      { kind: 'spending_not_investing' },
    ]);
    expect(nextMoves({ ...quiet, fpr: 0.5, cost: 10_001 }, [])).toEqual([]);
  });

  it('flags escalating intangible projects', () => {
    expect(nextMoves({ ...quiet, urgency: 'intangible', U: 1.31 }, [])).toEqual([
      { kind: 'escalating' },
    ]);
    expect(nextMoves({ ...quiet, urgency: 'intangible', U: 1.3 }, [])).toEqual([]);
  });

  it('adds overdue and past_target last', () => {
    expect(nextMoves({ ...quiet, overdue: true }, [])).toEqual([{ kind: 'overdue' }]);
    expect(nextMoves({ ...quiet, pastTarget: true }, [])).toEqual([{ kind: 'past_target' }]);
    expect(
      nextMoves({ ...quiet, urgency: 'intangible', U: 2, overdue: true }, []).map((m) => m.kind),
    ).toEqual(['escalating', 'overdue']);
  });

  it('keeps WW order when several apply', () => {
    const r = nextMoves(
      { ...quiet, costConfidence: 'guess', cost: 20_000, fpr: 0, blockedBy: ['x'] },
      ['X'],
    );
    expect(r.map((m) => m.kind)).toEqual([
      'get_real_price',
      'blocked_by',
      'spending_not_investing',
    ]);
  });
});
