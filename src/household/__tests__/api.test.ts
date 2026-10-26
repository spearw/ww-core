import { createSupabaseTransport } from '../../sync/supabaseTransport';
import type { RpcLike } from '../../sync/types';
import { INVITE_DAYS, createHouseholdApi, inviteLink, tokenFromLink } from '../api';

type Answer = { data: unknown; error: { code?: string; message: string } | null };

function stub(answer: Answer | (() => PromiseLike<Answer>)) {
  const calls: { fn: string; args: object }[] = [];
  const rpc: RpcLike = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    },
  };
  return { rpc, calls };
}

const failing = (code: string) => stub({ data: null, error: { code, message: `boom ${code}` } });

describe('household api', () => {
  it('invites last seven days', () => {
    expect(INVITE_DAYS).toBe(7);
  });

  it.each([
    ['WW010', 'expired'],
    ['WW011', 'used'],
    ['WW012', 'unknown'],
  ])('accept maps %s to %s', async (code, error) => {
    const { rpc, calls } = failing(code);
    await expect(createHouseholdApi(rpc).accept('tok', 'Katie')).resolves.toEqual({
      ok: false,
      error,
    });
    expect(calls).toEqual([
      { fn: 'ww_accept_invite', args: { p_token: 'tok', p_display_name: 'Katie' } },
    ]);
  });

  it('accept rethrows any other error', async () => {
    await expect(createHouseholdApi(failing('42501').rpc).accept('tok', 'K')).rejects.toThrow(
      '42501',
    );
    await expect(createHouseholdApi(failing('WW014').rpc).accept('tok', '')).rejects.toThrow(
      'WW014',
    );
  });

  it('accept answers the list id', async () => {
    const { rpc } = stub({ data: 'list-uuid', error: null });
    await expect(createHouseholdApi(rpc).accept('tok', 'K')).resolves.toEqual({
      ok: true,
      listId: 'list-uuid',
    });
  });

  it('create calls ww_create_household with p_name and p_display_name', async () => {
    const { rpc, calls } = stub({ data: 'list-uuid', error: null });
    await expect(createHouseholdApi(rpc).create('Home', 'Will')).resolves.toBe('list-uuid');
    expect(calls).toEqual([
      { fn: 'ww_create_household', args: { p_name: 'Home', p_display_name: 'Will' } },
    ]);
  });

  it('invite reads the one row ww_create_invite returns', async () => {
    const { rpc, calls } = stub({
      data: [{ token: 'abc', expires_at: '2026-11-02T10:00:00+00:00' }],
      error: null,
    });
    await expect(createHouseholdApi(rpc).invite('L')).resolves.toEqual({
      token: 'abc',
      expiresAt: '2026-11-02T10:00:00+00:00',
    });
    expect(calls).toEqual([{ fn: 'ww_create_invite', args: { p_list: 'L' } }]);
  });

  it('the other calls name their RPCs and arguments and throw on an error', async () => {
    const { rpc, calls } = stub({ data: null, error: null });
    const api = createHouseholdApi(rpc);
    await api.leave('L');
    await api.remove('L', 'U');
    await api.rename('L', 'New');
    await api.setDisplayName('L', 'Kat');
    expect(calls).toEqual([
      { fn: 'ww_leave_list', args: { p_list: 'L' } },
      { fn: 'ww_remove_member', args: { p_list: 'L', p_user: 'U' } },
      { fn: 'ww_rename_list', args: { p_list: 'L', p_name: 'New' } },
      { fn: 'ww_set_display_name', args: { p_list: 'L', p_name: 'Kat' } },
    ]);
    await expect(createHouseholdApi(failing('WW013').rpc).remove('L', 'U')).rejects.toThrow(
      'WW013',
    );
  });

  it('invite links carry the token', () => {
    expect(inviteLink('https://x.app', 't0k-_')).toBe('https://x.app/join/t0k-_');
    expect(tokenFromLink(inviteLink('https://x.app', 't0k-_'))).toBe('t0k-_');
    expect(tokenFromLink('https://x.app/other')).toBeNull();
    expect(tokenFromLink('https://x.app/join/')).toBeNull();
  });
});

describe('supabase transport', () => {
  it('push and pull call the RPCs with their argument names', async () => {
    const { rpc, calls } = stub({ data: { accepted: [], rejected: [] }, error: null });
    const t = createSupabaseTransport(rpc);
    await expect(t.push([{ table: 'x', row: { id: 'a' } }])).resolves.toEqual({
      accepted: [],
      rejected: [],
    });
    await t.pull({ L: 3 }, 500);
    expect(calls).toEqual([
      { fn: 'ww_push', args: { p_changes: [{ table: 'x', row: { id: 'a' } }] } },
      { fn: 'ww_pull', args: { p_cursors: { L: 3 }, p_limit: 500 } },
    ]);
  });

  it('a non-null error throws ww_sync: <code> <message>', async () => {
    const t = createSupabaseTransport(failing('54000').rpc);
    await expect(t.push([])).rejects.toThrow('ww_sync: 54000 boom 54000');
  });

  it('a call that never settles rejects after timeoutMs', async () => {
    const { rpc } = stub(() => new Promise<Answer>(() => {}));
    const t = createSupabaseTransport(rpc, { timeoutMs: 20 });
    await expect(t.pull({}, 10)).rejects.toThrow('ww_sync: timeout');
  });
});
