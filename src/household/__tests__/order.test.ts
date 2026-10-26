import { moveWrites, renumber, stableOrder } from '../order';

const five = ['a', 'b', 'c', 'd', 'e'].map((id, position) => ({ id, position }));

describe('order', () => {
  it('moveWrites returns only rows whose position changes', () => {
    expect(moveWrites(five, 'c', 0)).toEqual([
      { id: 'c', position: 0 },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ]);
    expect(moveWrites(five, 'c', 2)).toEqual([]);
  });
  it('moveWrites ignores an unknown id and clamps the index', () => {
    expect(moveWrites(five, 'zz', 0)).toEqual([]);
    expect(moveWrites(five, 'a', 99)).toEqual([
      { id: 'b', position: 0 },
      { id: 'c', position: 1 },
      { id: 'd', position: 2 },
      { id: 'e', position: 3 },
      { id: 'a', position: 4 },
    ]);
  });
  it('stableOrder breaks position ties by id, so two phones agree', () => {
    expect(
      stableOrder([
        { id: 'b', position: 1 },
        { id: 'a', position: 1 },
        { id: 'c', position: 0 },
      ]).map((r) => r.id),
    ).toEqual(['c', 'a', 'b']);
  });
  it('renumber returns only the rows needed to make positions 0..n-1 in stable order', () => {
    expect(
      renumber([
        { id: 'a', position: 0 },
        { id: 'b', position: 0 },
        { id: 'c', position: 1 },
      ]),
    ).toEqual([
      { id: 'b', position: 1 },
      { id: 'c', position: 2 },
    ]);
  });
});
