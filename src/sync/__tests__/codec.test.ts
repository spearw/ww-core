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

  it('toWire sends only the keys a partial row carries', () => {
    expect(toWire(testItem, { id: 'i1', list_id: 'L', title: 'A' })).toEqual({
      id: 'i1',
      list_id: 'L',
      title: 'A',
    });
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

  it('lowercases the id both ways', () => {
    expect(toWire(testItem, { id: 'AB-CD', list_id: 'L' })).toEqual({ id: 'ab-cd', list_id: 'L' });
    expect(fromWire(testItem, { id: 'AB-CD' })).toEqual({ id: 'ab-cd' });
  });

  it.each([
    ['2026-10-26 10:00:00.123456+00', '2026-10-26T10:00:00.123Z'],
    ['2026-10-26T10:00:00.123456+00:00', '2026-10-26T10:00:00.123Z'],
    ['2026-10-26T10:00:00Z', '2026-10-26T10:00:00.000Z'],
    ['2026-10-26T12:30:00.9999+02:30', '2026-10-26T10:00:00.999Z'],
    ['2026-10-26 05:00:00-05', '2026-10-26T10:00:00.000Z'],
  ])('normalises %s without parsing more than 3 fractional digits', (wire, local) => {
    expect(fromWire(testItem, { id: 'i1', updated_at: wire }).updated_at).toBe(local);
  });

  it('never hands a timestamp string to the Date parser (Hermes rejects microseconds)', () => {
    const RealDate = Date;
    class NoParseDate extends RealDate {
      constructor(...args: unknown[]) {
        if (typeof args[0] === 'string') throw new Error('test: Date parsed a string');
        super(...(args as []));
      }
    }
    global.Date = NoParseDate as DateConstructor;
    try {
      expect(
        fromWire(testItem, { id: 'i1', deleted_at: '2026-10-26 10:00:00.123456+00' }).deleted_at,
      ).toBe('2026-10-26T10:00:00.123Z');
    } finally {
      global.Date = RealDate;
    }
  });
});
