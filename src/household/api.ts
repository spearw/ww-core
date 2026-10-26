import type { RpcLike } from '../sync/types';

/** How long an invite link works (the server's `ww_create_invite` sets the same). */
export const INVITE_DAYS = 7;
export type InviteError = 'expired' | 'used' | 'unknown';

export interface HouseholdApi {
  create(name: string, displayName: string): Promise<string>;
  invite(listId: string): Promise<{ token: string; expiresAt: string }>;
  accept(
    token: string,
    displayName: string,
  ): Promise<{ ok: true; listId: string } | { ok: false; error: InviteError }>;
  leave(listId: string): Promise<void>;
  remove(listId: string, userId: string): Promise<void>;
  rename(listId: string, name: string): Promise<void>;
  setDisplayName(listId: string, displayName: string): Promise<void>;
}

const INVITE_ERRORS: Readonly<Record<string, InviteError>> = {
  WW010: 'expired',
  WW011: 'used',
  WW012: 'unknown',
};

class HouseholdError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(`ww_household: ${code ?? 'unknown'} ${message}`);
  }
}

/** The household RPCs of the Postgres migration (a supabase-js client is an `RpcLike`). */
export function createHouseholdApi(rpc: RpcLike): HouseholdApi {
  async function call(fn: string, args: object): Promise<unknown> {
    const { data, error } = await rpc.rpc(fn, args);
    if (error) throw new HouseholdError(error.code, error.message);
    return data;
  }
  return {
    async create(name, displayName) {
      return (await call('ww_create_household', {
        p_name: name,
        p_display_name: displayName,
      })) as string;
    },
    async invite(listId) {
      const data = await call('ww_create_invite', { p_list: listId });
      const row = (Array.isArray(data) ? data[0] : data) as
        { token: string; expires_at: string } | undefined;
      if (!row) throw new HouseholdError(undefined, 'ww_create_invite answered no row');
      return { token: row.token, expiresAt: row.expires_at };
    },
    async accept(token, displayName) {
      try {
        const listId = (await call('ww_accept_invite', {
          p_token: token,
          p_display_name: displayName,
        })) as string;
        return { ok: true, listId };
      } catch (e) {
        const mapped = e instanceof HouseholdError ? INVITE_ERRORS[e.code ?? ''] : undefined;
        if (mapped) return { ok: false, error: mapped };
        throw e;
      }
    },
    async leave(listId) {
      await call('ww_leave_list', { p_list: listId });
    },
    async remove(listId, userId) {
      await call('ww_remove_member', { p_list: listId, p_user: userId });
    },
    async rename(listId, name) {
      await call('ww_rename_list', { p_list: listId, p_name: name });
    },
    async setDisplayName(listId, displayName) {
      await call('ww_set_display_name', { p_list: listId, p_name: displayName });
    },
  };
}

export function inviteLink(base: string, token: string): string {
  return `${base}/join/${token}`;
}

/** The token of a `…/join/<token>` link, else null. String-only: no `URL` (React Native). */
export function tokenFromLink(url: string): string | null {
  const m = /\/join\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(url);
  return m?.[1] ?? null;
}
