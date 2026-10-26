import type { PullPage, PushResult, RpcLike, SyncTransport } from './types';

export const SYNC_CALL_TIMEOUT_MS = 30_000;

/** Calls one RPC; a non-null error throws `ww_sync: <code> <message>`, a call that has not
 *  settled after `timeoutMs` rejects (the request itself is left to finish or fail unseen). */
async function call<T>(rpc: RpcLike, fn: string, args: object, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ww_sync: timeout ${fn} after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    const { data, error } = await Promise.race([Promise.resolve(rpc.rpc(fn, args)), timeout]);
    if (error) throw new Error(`ww_sync: ${error.code ?? 'unknown'} ${error.message}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

/** The sync transport over Supabase's `ww_push` / `ww_pull` RPCs (a supabase-js client is an
 *  `RpcLike`). */
export function createSupabaseTransport(
  rpc: RpcLike,
  opts: { timeoutMs?: number } = {},
): SyncTransport {
  const timeoutMs = opts.timeoutMs ?? SYNC_CALL_TIMEOUT_MS;
  return {
    push: (changes) => call<PushResult>(rpc, 'ww_push', { p_changes: changes }, timeoutMs),
    pull: (cursors, limit) =>
      call<PullPage>(rpc, 'ww_pull', { p_cursors: cursors, p_limit: limit }, timeoutMs),
  };
}
