import { daysBetween, toDayNumber } from '../dates';
import { toDayNumber as fromIndex } from '..';

describe('daysBetween', () => {
  it('counts calendar days, negative when the target is earlier', () => {
    expect(daysBetween('2026-09-11', '2026-11-10')).toBe(60);
    expect(daysBetween('2026-09-11', '2026-09-01')).toBe(-10);
    expect(daysBetween('2020-09-11', '2026-09-11')).toBe(2191);
  });

  it('handles leap days and daylight-saving changes', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });
});

describe('toDayNumber (review focus 1)', () => {
  it('rejects malformed dates, naming them', () => {
    expect(() => toDayNumber('2026-9-1')).toThrow('Invalid date "2026-9-1": expected YYYY-MM-DD');
    expect(() => toDayNumber('')).toThrow('expected YYYY-MM-DD');
  });

  it('rejects days that do not exist', () => {
    expect(() => toDayNumber('2026-02-30')).toThrow('Invalid date "2026-02-30": no such day');
    expect(() => toDayNumber('2026-13-01')).toThrow('no such day');
  });
});

it('exports toDayNumber from the engine index', () => {
  expect(fromIndex('1970-01-02')).toBe(1);
});
