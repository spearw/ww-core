import { createFakeServer, serverColumnsOf } from '../fakeServer';
import type { FakeServer } from '../fakeServer';
import { testItem, testPair } from './testSchema';

const T = 'ww_test_item';
const WILL = { userId: 'w', displayName: 'Will' };
const KATIE = { userId: 'k', displayName: 'Katie' };

function setup(now?: () => Date) {
  const s = createFakeServer({
    tables: { [T]: serverColumnsOf(testItem), ww_test_pair: serverColumnsOf(testPair) },
    ownColumns: { ww_test_pair: 'a_id' },
    now,
  });
  const L = s.createList('w', 'Home', [WILL, KATIE]);
  return { s, L, w: s.transportFor('w'), k: s.transportFor('k') };
}

describe('fake server', () => {
  it('serverColumnsOf lists the local column names', () => {
    expect(serverColumnsOf(testItem)).toEqual(
      expect.arrayContaining(['id', 'title', 'list_id', 'updated_at', 'updated_by', 'deleted_at']),
    );
  });

  it('R1 unknown_table', async () => {
    const { w, L } = setup();
    const res = await w.push([{ table: 'nope', row: { id: 'x', list_id: L } }]);
    expect(res.rejected).toEqual([{ table: 'nope', id: 'x', reason: 'unknown_table' }]);
    expect(res.accepted).toEqual([]);
  });

  it('R2 not_allowed for a non-member, on insert and on update', async () => {
    const { s, w, L } = setup();
    const o = s.transportFor('outsider');
    let res = await o.push([{ table: T, row: { id: 'i1', list_id: L, title: 'A' } }]);
    expect(res.rejected[0]!.reason).toBe('not_allowed');
    await w.push([{ table: T, row: { id: 'i1', list_id: L, title: 'A' } }]);
    const L2 = s.createList('o', 'Other', [{ userId: 'o', displayName: 'O' }]);
    res = await s
      .transportFor('o')
      .push([{ table: T, row: { id: 'i1', list_id: L2, title: 'X' } }]);
    expect(res.rejected[0]!.reason).toBe('not_allowed'); // not a member of the stored row's list
    expect(s.row(T, 'i1')).toMatchObject({ title: 'A', list_id: L });
  });

  it('R3 member_id must be the caller', async () => {
    const { w, L } = setup();
    const res = await w.push([
      { table: 'ww_test_pair', row: { id: 'p1', list_id: L, a_id: 'k', b_id: 'b', value: 1 } },
      { table: 'ww_test_pair', row: { id: 'p2', list_id: L, a_id: 'w', b_id: 'b', value: 1 } },
    ]);
    expect(res.rejected).toEqual([{ table: 'ww_test_pair', id: 'p1', reason: 'not_allowed' }]);
    expect(res.accepted.map((a) => a.id)).toEqual(['p2']);
  });

  it('R4 unknown_column (colour, ww_seq)', async () => {
    const { w, L, s } = setup();
    const res = await w.push([
      { table: T, row: { id: 'a', list_id: L, title: 'A', colour: 'red' } },
      { table: T, row: { id: 'b', list_id: L, title: 'B', ww_seq: 99 } },
    ]);
    expect(res.rejected.map((r) => r.reason)).toEqual(['unknown_column', 'unknown_column']);
    expect(s.row(T, 'a')).toBeNull();
  });

  it('R4 ww_seq is invalid even when a caller lists it as a column', async () => {
    const s = createFakeServer({ tables: { [T]: ['id', 'list_id', 'title', 'ww_seq'] } });
    const L = s.createList('w', 'H', [WILL]);
    const res = await s
      .transportFor('w')
      .push([{ table: T, row: { id: 'a', list_id: L, ww_seq: 5 } }]);
    expect(res.rejected[0]!.reason).toBe('unknown_column');
  });

  it('R5 list_moved', async () => {
    const { s, w, L } = setup();
    const L2 = s.createList('w', 'Two', [WILL]);
    await w.push([{ table: T, row: { id: 'i1', list_id: L, title: 'A' } }]);
    const res = await w.push([{ table: T, row: { id: 'i1', list_id: L2, title: 'B' } }]);
    expect(res.rejected[0]!.reason).toBe('list_moved');
    expect(s.row(T, 'i1')).toMatchObject({ list_id: L, title: 'A' });
  });

  it('invalid: a change without a string id or list_id', async () => {
    const { w } = setup();
    const res = await w.push([{ table: T, row: { title: 'A' } }]);
    expect(res.rejected[0]!.reason).toBe('invalid');
  });

  it('R6 re-stamps a tombstone instead of reviving it (R9 answer)', async () => {
    const { s, w, k, L } = setup();
    await w.push([
      {
        table: T,
        row: { id: 'i1', list_id: L, title: 'A', deleted_at: '2026-10-25T10:00:00.000Z' },
      },
    ]);
    const res = await k.push([
      { table: T, row: { id: 'i1', list_id: L, title: 'B', deleted_at: null } },
    ]);
    expect(res.accepted[0]!.seq).toBe(2);
    expect(res.accepted[0]!.row).toMatchObject({
      title: 'A',
      deleted_at: '2026-10-25T10:00:00.000Z',
      updated_by: 'k',
    });
    expect(s.row(T, 'i1')).toMatchObject({ title: 'A', deleted_at: '2026-10-25T10:00:00.000Z' });
  });

  it('R7 absent keys keep the stored value', async () => {
    const { s, w, L } = setup();
    await w.push([{ table: T, row: { id: 'i1', list_id: L, title: 'A', position: 3 } }]);
    await w.push([{ table: T, row: { id: 'i1', list_id: L, title: 'B' } }]);
    expect(s.row(T, 'i1')).toMatchObject({ title: 'B', position: 3 });
    expect(s.row(T, 'i1')!['done']).toBeUndefined(); // insert: no defaults in the fake
  });

  it('R8 each accepted write gets a new seq, server time and caller', async () => {
    const { w, k, L } = setup(() => new Date('2026-10-25T12:00:00.000Z'));
    const r1 = await w.push([
      { table: T, row: { id: 'i1', list_id: L, title: 'A', updated_at: 'x', updated_by: 'evil' } },
    ]);
    const r2 = await k.push([{ table: T, row: { id: 'i1', list_id: L, title: 'B' } }]);
    expect(r1.accepted[0]!.seq).toBe(1);
    expect(r2.accepted[0]!.seq).toBe(2);
    expect(r1.accepted[0]!.row).toMatchObject({
      updated_at: '2026-10-25T12:00:00.000Z',
      updated_by: 'w',
    });
    expect(r2.accepted[0]!.row['updated_by']).toBe('k');
    expect(r2.accepted[0]!.row).not.toHaveProperty('ww_seq');
  });

  it('R9 rows are deep-copied in and out', async () => {
    const { s, w, L } = setup();
    const tags = ['a'];
    const res = await w.push([{ table: T, row: { id: 'i1', list_id: L, title: 'A', tags } }]);
    tags.push('b');
    (res.accepted[0]!.row['tags'] as string[]).push('c');
    expect(s.row(T, 'i1')!['tags']).toEqual(['a']);
  });

  it('R10 pull pages by seq with limit and more', async () => {
    const { w, k, L } = setup();
    await w.push(
      [1, 2, 3, 4, 5].map((n) => ({ table: T, row: { id: `i${n}`, list_id: L, title: `${n}` } })),
    );
    let page = await k.pull({}, 2);
    let c = page.changes[0]!;
    expect(c.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect([c.cursor, c.more]).toEqual([2, true]);
    page = await k.pull({ [L]: c.cursor }, 2);
    c = page.changes[0]!;
    expect(c.rows.map((r) => r.seq)).toEqual([3, 4]);
    expect([c.cursor, c.more]).toEqual([4, true]);
    page = await k.pull({ [L]: c.cursor }, 2);
    c = page.changes[0]!;
    expect(c.rows.map((r) => r.seq)).toEqual([5]);
    expect([c.cursor, c.more]).toEqual([5, false]);
    expect(c.rows[0]!.row).not.toHaveProperty('ww_seq');
    page = await k.pull({ [L]: 5 }, 2);
    expect(page.changes[0]).toMatchObject({ rows: [], cursor: 5, more: false });
    page = await k.pull({}, 2);
    expect(page.lists[0]).toMatchObject({ id: L, name: 'Home', ownerId: 'w' });
  });

  it('R10 spans tables', async () => {
    const { w, L } = setup();
    await w.push([
      { table: T, row: { id: 'i1', list_id: L, title: 'A' } },
      { table: 'ww_test_pair', row: { id: 'p1', list_id: L, a_id: 'w', b_id: 'b', value: 1 } },
    ]);
    const c = (await w.pull({}, 10)).changes[0]!;
    expect(c.rows.map((r) => r.table)).toEqual([T, 'ww_test_pair']);
  });

  it('R12 a push carries at most 500 changes', async () => {
    const { w, L } = setup();
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        table: T,
        row: { id: `i${i}`, list_id: L, title: 't' },
      }));
    await expect(w.push(mk(501))).rejects.toThrow(/500/);
    const ok = await w.push(mk(500));
    expect(ok.accepted).toHaveLength(500);
  });

  describe('R13 members', () => {
    const three = (s: FakeServer) =>
      s.createList('w', 'Trio', [
        { userId: 'w', displayName: 'W' },
        { userId: 'z', displayName: 'Z' },
        { userId: 'a', displayName: 'A' },
      ]);

    it('owner removal moves ownership to the earliest joined (ties by user id)', async () => {
      const { s } = setup(() => new Date('2026-10-25T12:00:00.000Z'));
      const id = three(s);
      s.removeMember(id, 'w');
      const snap = (await s.transportFor('a').pull({}, 1)).lists.find((l) => l.id === id)!;
      expect(snap.ownerId).toBe('a'); // joined in the same instant: 'a' < 'z'
      expect(snap.members.map((m) => m.userId).sort()).toEqual(['a', 'z']);
    });

    it('a non-owner leaving keeps the owner', async () => {
      const { s } = setup();
      const id = three(s);
      s.removeMember(id, 'z');
      const snap = (await s.transportFor('w').pull({}, 1)).lists.find((l) => l.id === id)!;
      expect(snap.ownerId).toBe('w');
    });

    it('removing someone else needs the owner', () => {
      const { s } = setup();
      const id = three(s);
      expect(() => s.removeMember(id, 'a', 'z')).toThrow(/owner/);
      expect(() => s.removeMember(id, 'a', 'w')).not.toThrow();
    });

    it('the last member leaving removes the list and its rows', async () => {
      const { s } = setup();
      const id = s.createList('w', 'Solo', [WILL]);
      await s.transportFor('w').push([{ table: T, row: { id: 'gone', list_id: id, title: 'A' } }]);
      s.removeMember(id, 'w');
      expect(s.row(T, 'gone')).toBeNull();
      expect(
        (await s.transportFor('w').pull({}, 10)).lists.find((l) => l.id === id),
      ).toBeUndefined();
    });

    it("a removed member's pull omits the list and they can no longer write", async () => {
      const { s, w, k, L } = setup();
      await w.push([{ table: T, row: { id: 'i1', list_id: L, title: 'A' } }]);
      s.removeMember(L, 'k');
      const page = await k.pull({ [L]: 0 }, 10);
      expect(page.lists).toEqual([]);
      expect(page.changes).toEqual([]);
      const res = await k.push([{ table: T, row: { id: 'i1', list_id: L, title: 'B' } }]);
      expect(res.rejected[0]!.reason).toBe('not_allowed');
    });
  });
});
