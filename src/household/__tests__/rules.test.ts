import { notWeighedIn, recipientsFor } from '../rules';

describe('rules', () => {
  it('someone else setting your impact is not you weighing in', () => {
    expect(
      notWeighedIn(
        [
          { memberId: 'k', setBy: 'w' },
          { memberId: 'w', setBy: 'w' },
        ],
        ['w', 'k'],
      ),
    ).toEqual(['k']);
  });
  it('a member with no impact row has not weighed in', () =>
    expect(notWeighedIn([], ['w', 'k'])).toEqual(['w', 'k']));
  it('an assignee gets it; together and unassigned go to everyone (spec §4.3)', () => {
    expect(recipientsFor('k', ['w', 'k'])).toEqual(['k']);
    expect(recipientsFor('together', ['w', 'k'])).toEqual(['w', 'k']);
    expect(recipientsFor(null, ['w', 'k'])).toEqual(['w', 'k']);
    expect(recipientsFor('gone', ['w', 'k'])).toEqual(['w', 'k']);
  });
});
