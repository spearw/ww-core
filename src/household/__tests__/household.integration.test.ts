import { randomUUID } from 'node:crypto';

import { listsOnPhone } from '../../sync';
import {
  adminClient,
  disposeLive,
  makeDevice,
  makeUsers,
  sweepStaleUsers,
} from '../../sync/__tests__/localSupabase';

afterEach(disposeLive);
afterAll(sweepStaleUsers);

async function membersOf(listId: string): Promise<string[]> {
  const { data, error } = await adminClient()
    .from('ww_list_member')
    .select('user_id')
    .eq('list_id', listId);
  if (error) throw new Error(error.message);
  return (data as { user_id: string }[]).map((m) => m.user_id).sort();
}

describe('household on local Supabase', () => {
  it('invite then accept: both phones show the two members by display name', async () => {
    const { users } = await makeUsers(['will', 'katie']);
    const will = users['will']!;
    const katie = users['katie']!;
    const listId = await will.household.create('Home', 'Will');
    const { token, expiresAt } = await will.household.invite(listId);
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    expect(await katie.household.accept(token, 'Katie')).toEqual({ ok: true, listId });
    for (const user of [will, katie]) {
      const phone = await makeDevice(user);
      try {
        await phone.sync.run();
        const home = listsOnPhone(phone.db).find((l) => l.id === listId);
        expect(home?.ownerId).toBe(will.userId);
        expect(home?.members.map((m) => [m.userId, m.displayName])).toEqual([
          [will.userId, 'Will'],
          [katie.userId, 'Katie'],
        ]);
      } finally {
        phone.close();
      }
    }
  });

  it('a second accept of the same token by a third user is used', async () => {
    const { users } = await makeUsers(['will', 'katie', 'third']);
    const listId = await users['will']!.household.create('Home', 'Will');
    const { token } = await users['will']!.household.invite(listId);
    expect(await users['katie']!.household.accept(token, 'Katie')).toEqual({ ok: true, listId });
    expect(await users['third']!.household.accept(token, 'Third')).toEqual({
      ok: false,
      error: 'used',
    });
    expect(await membersOf(listId)).toEqual([users['will']!.userId, users['katie']!.userId].sort());
  });

  it('an invite past its expiry is expired', async () => {
    const { users } = await makeUsers(['will', 'katie']);
    const listId = await users['will']!.household.create('Home', 'Will');
    const { token } = await users['will']!.household.invite(listId);
    const { error } = await adminClient()
      .from('ww_list_invite')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('list_id', listId);
    expect(error).toBeNull();
    expect(await users['katie']!.household.accept(token, 'Katie')).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(await membersOf(listId)).toEqual([users['will']!.userId]);
  });

  it('an unknown token is unknown', async () => {
    const { users } = await makeUsers(['katie']);
    expect(await users['katie']!.household.accept('no-such-token', 'Katie')).toEqual({
      ok: false,
      error: 'unknown',
    });
  });

  it('two accepts of one token at once: exactly one joins, the other is used', async () => {
    const { users } = await makeUsers(['will', 'katie', 'third']);
    const will = users['will']!;
    const listId = await will.household.create('Home', 'Will');
    const { token } = await will.household.invite(listId);
    const answers = await Promise.all([
      users['katie']!.household.accept(token, 'Katie'),
      users['third']!.household.accept(token, 'Third'),
    ]);
    expect(answers.filter((a) => a.ok)).toEqual([{ ok: true, listId }]);
    expect(answers.filter((a) => !a.ok)).toEqual([{ ok: false, error: 'used' }]);
    const members = await membersOf(listId);
    expect(members).toHaveLength(2);
    expect(members).toContain(will.userId);
  });

  it('the last two members leaving at once take the list and its rows with them', async () => {
    const { users } = await makeUsers(['will', 'katie']);
    const will = users['will']!;
    const katie = users['katie']!;
    const listId = await will.household.create('Home', 'Will');
    const { token } = await will.household.invite(listId);
    expect(await katie.household.accept(token, 'Katie')).toEqual({ ok: true, listId });
    const { error } = await adminClient()
      .from('ww_test_item')
      .insert({ id: randomUUID(), list_id: listId, title: 'left behind?' });
    expect(error).toBeNull();
    await Promise.all([will.household.leave(listId), katie.household.leave(listId)]);
    const lists = await adminClient().from('ww_list').select('id').eq('id', listId);
    expect(lists.error).toBeNull();
    expect(lists.data).toEqual([]);
    const items = await adminClient().from('ww_test_item').select('id').eq('list_id', listId);
    expect(items.error).toBeNull();
    expect(items.data).toEqual([]);
  });
});
