import { fromWire, toWire } from '../codec';
import { testItem, testItemWithColour } from './testSchema';

const raw = {
  id: 'i1',
  list_id: 'L',
  title: 'A',
  position: 2,
  done: 1,
  tags: '["x"]',
  updated_at: 'local',
  updated_by: null,
  deleted_at: null,
};

describe('wire codec', () => {
  it('toWire turns booleans and json into JSON values and leaves server-set columns out', () => {
    expect(toWire(testItem, raw)).toEqual({
      id: 'i1',
      list_id: 'L',
      title: 'A',
      position: 2,
      done: true,
      tags: ['x'],
      deleted_at: null,
    });
  });

  it('fromWire normalises server timestamps to ISO milliseconds and drops unknown keys', () => {
    expect(
      fromWire(testItem, {
        ...toWire(testItem, raw),
        updated_at: '2026-10-25T10:00:00.123456+00:00',
        updated_by: 'u1',
        ww_seq: 9,
        extra: 1,
      }),
    ).toEqual({ ...raw, updated_at: '2026-10-25T10:00:00.123Z', updated_by: 'u1' });
  });

  it('toWire sends every column the phone has, including one the server may lack', () => {
    expect(toWire(testItemWithColour, { ...raw, colour: 'red' })).toHaveProperty('colour', 'red');
  });

  it('round-trips a null json column', () => {
    expect(
      fromWire(testItem, {
        ...toWire(testItem, { ...raw, tags: null }),
        updated_at: '2026-10-25T10:00:00Z',
      }).tags,
    ).toBeNull();
  });

  it('normalises a non-null deleted_at', () => {
    expect(
      fromWire(testItem, { id: 'i1', deleted_at: '2026-10-25T10:00:00.5+00:00' }).deleted_at,
    ).toBe('2026-10-25T10:00:00.500Z');
  });
});
