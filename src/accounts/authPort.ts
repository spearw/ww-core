/**
 * The account `AuthPort` over Supabase Auth. Structural, like `session.ts`: it types only the slice
 * of `supabase.auth` it uses, so tests pass fakes and nothing here imports Supabase.
 */
import type { AccountUser, AuthPort, Provider, SessionInfo } from './types';

/** The user fields this port reads. */
export interface AuthUserLike {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
  app_metadata?: { provider?: string };
}

/** What supabase-js persists (and `getSession` returns). */
export interface StoredSession {
  access_token?: string;
  user: AuthUserLike;
}

interface UserResult {
  data: { user: AuthUserLike | null };
  error: unknown;
}

/** The slice of `supabase.auth` this port uses. */
export interface SupabaseAuthLike {
  getSession(): Promise<{ data: { session: StoredSession | null }; error: unknown }>;
  signInWithIdToken(p: {
    provider: 'apple' | 'google';
    token: string;
    nonce?: string;
  }): Promise<UserResult>;
  signInAnonymously(): Promise<UserResult>;
  signOut(opts: { scope: 'local' }): Promise<{ error: unknown }>;
  onAuthStateChange(cb: () => void): { data: { subscription: { unsubscribe(): void } } };
}

/**
 * How long a function call waits for an answer before it is aborted and rejects. A sign-in waits
 * as long (supabase-js's own request has no timeout).
 */
export const CALL_FUNCTION_TIMEOUT_MS = 15_000;

/** How long `current()` waits for the session read (which may retry offline) before using storage. */
export const SESSION_READ_TIMEOUT_MS = 3_000;

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function providerOf(user: AuthUserLike, requested?: Provider): Provider {
  if (user.is_anonymous) return 'dev';
  const p = user.app_metadata?.provider;
  if (p === 'apple' || p === 'google') return p;
  return requested ?? 'dev';
}

function toAccountUser(user: AuthUserLike, requested?: Provider): AccountUser {
  return { id: user.id, provider: providerOf(user, requested), email: user.email ?? null };
}

export function makeAuthPort(
  auth: SupabaseAuthLike,
  opts: {
    url: string;
    key: string;
    fetch: typeof fetch;
    readStored: () => Promise<StoredSession | null>;
  },
): AuthPort {
  function info(user: AuthUserLike, accessToken: string | null): SessionInfo {
    return { user: toAccountUser(user), anonymous: user.is_anonymous === true, accessToken };
  }

  async function fromStorage(): Promise<SessionInfo | null> {
    try {
      const stored = await opts.readStored();
      return stored ? info(stored.user, null) : null;
    } catch {
      return null;
    }
  }

  async function current(): Promise<SessionInfo | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SESSION_READ_TIMEOUT_MS);
    });
    let result;
    try {
      result = await Promise.race([auth.getSession(), timedOut]);
    } catch {
      return fromStorage();
    } finally {
      clearTimeout(timer);
    }
    if (result === 'timeout' || result.error) return fromStorage();
    const session = result.data.session;
    return session ? info(session.user, session.access_token ?? null) : null;
  }

  /** Rejects when the sign-in has not answered within the bound (the panel says it failed). */
  async function bounded(promise: Promise<UserResult>): Promise<UserResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Sign-in timed out')), CALL_FUNCTION_TIMEOUT_MS);
    });
    try {
      return await Promise.race([promise, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function userFrom(promise: Promise<UserResult>, requested?: Provider) {
    const { data, error } = await bounded(promise);
    if (error) throw asError(error, 'Sign-in failed');
    if (!data.user) throw new Error('Sign-in returned no user');
    return toAccountUser(data.user, requested);
  }

  return {
    current,
    signInWithIdToken({ provider, idToken, nonce }) {
      return userFrom(
        auth.signInWithIdToken({
          provider,
          token: idToken,
          ...(nonce !== undefined ? { nonce } : {}),
        }),
        provider,
      );
    },
    signInDev() {
      return userFrom(auth.signInAnonymously(), 'dev');
    },
    async signOut() {
      const { error } = await auth.signOut({ scope: 'local' });
      if (error) throw asError(error, 'Sign-out failed');
    },
    onChange(cb) {
      const { data } = auth.onAuthStateChange(() => cb());
      return () => data.subscription.unsubscribe();
    },
    async callFunction(name, body, token) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${name} timed out`));
        }, CALL_FUNCTION_TIMEOUT_MS);
      });
      // Token lookup and the request are both inside the bound.
      async function send(): Promise<{ ok: boolean; status: number }> {
        // Read at call time, so a token from a sign-in that just replaced the session is used.
        const bearer = token ?? (await current())?.accessToken;
        if (!bearer) throw new Error('no session');
        const res = await opts.fetch(`${opts.url}/functions/v1/${name}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: opts.key,
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return { ok: res.ok, status: res.status };
      }
      try {
        return await Promise.race([send(), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
