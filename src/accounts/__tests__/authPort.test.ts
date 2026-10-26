import {
  CALL_FUNCTION_TIMEOUT_MS,
  SESSION_READ_TIMEOUT_MS,
  makeAuthPort,
  type SupabaseAuthLike,
} from '../authPort';

const URL = 'https://example.supabase.co';
const KEY = 'sb_publishable_fake';

type Session = { access_token: string; user: Record<string, unknown> };

const appleUser = {
  id: 'u-apple',
  email: 'abc123@privaterelay.appleid.com',
  is_anonymous: false,
  app_metadata: { provider: 'apple' },
};
const googleUser = {
  id: 'u-google',
  email: 'person@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'google' },
};
const anonUser = { id: 'u-anon', is_anonymous: true, app_metadata: {} };

function fakeAuth(over: Partial<SupabaseAuthLike> = {}): SupabaseAuthLike & {
  signInWithIdToken: jest.Mock;
  signOut: jest.Mock;
} {
  return {
    getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
    signInWithIdToken: jest.fn(async () => ({
      data: { user: appleUser, session: null },
      error: null,
    })),
    signInAnonymously: jest.fn(async () => ({
      data: { user: anonUser, session: null },
      error: null,
    })),
    signOut: jest.fn(async () => ({ error: null })),
    onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    ...over,
  } as never;
}

function sessionOf(user: Record<string, unknown>, token = 'tok-1'): Session {
  return { access_token: token, user };
}

function build(
  auth: SupabaseAuthLike,
  opts: { stored?: { user: Record<string, unknown> } | null; fetch?: jest.Mock } = {},
) {
  const fetchMock = opts.fetch ?? jest.fn(async () => ({ ok: true, status: 200 }));
  const port = makeAuthPort(auth, {
    url: URL,
    key: KEY,
    fetch: fetchMock as never,
    readStored: async () => (opts.stored ?? null) as never,
  });
  return { port, fetchMock };
}

describe('current', () => {
  it('maps an Apple user with a private relay email', async () => {
    const auth = fakeAuth({
      getSession: async () => ({ data: { session: sessionOf(appleUser) }, error: null }),
    } as never);
    const { port } = build(auth);
    expect(await port.current()).toEqual({
      user: { id: 'u-apple', provider: 'apple', email: 'abc123@privaterelay.appleid.com' },
      anonymous: false,
      accessToken: 'tok-1',
    });
  });

  it('maps a Google user', async () => {
    const auth = fakeAuth({
      getSession: async () => ({ data: { session: sessionOf(googleUser) }, error: null }),
    } as never);
    const { port } = build(auth);
    const s = await port.current();
    expect(s?.user).toEqual({ id: 'u-google', provider: 'google', email: 'person@example.com' });
  });

  it('maps an anonymous user to the dev provider with no email', async () => {
    const auth = fakeAuth({
      getSession: async () => ({ data: { session: sessionOf(anonUser) }, error: null }),
    } as never);
    const { port } = build(auth);
    expect(await port.current()).toEqual({
      user: { id: 'u-anon', provider: 'dev', email: null },
      anonymous: true,
      accessToken: 'tok-1',
    });
  });

  it('returns the stored user when the refresh fails offline', async () => {
    const auth = fakeAuth({
      getSession: async () => ({
        data: { session: null },
        error: new Error('AuthRetryableFetchError: Failed to fetch'),
      }),
    } as never);
    const { port } = build(auth, { stored: { user: googleUser } });
    expect(await port.current()).toEqual({
      user: { id: 'u-google', provider: 'google', email: 'person@example.com' },
      anonymous: false,
      accessToken: null,
    });
  });

  it('returns the stored user when reading the session throws', async () => {
    const auth = fakeAuth({
      getSession: async () => {
        throw new Error('Network request failed');
      },
    } as never);
    const { port } = build(auth, { stored: { user: appleUser } });
    expect((await port.current())?.accessToken).toBeNull();
  });

  it('is null when the refresh fails and nothing is stored', async () => {
    const auth = fakeAuth({
      getSession: async () => ({ data: { session: null }, error: new Error('offline') }),
    } as never);
    const { port } = build(auth, { stored: null });
    expect(await port.current()).toBeNull();
  });

  it('uses the stored user when the session read never settles, at 3 seconds', async () => {
    jest.useFakeTimers();
    try {
      const auth = fakeAuth({ getSession: () => new Promise(() => undefined) } as never);
      const { port } = build(auth, { stored: { user: googleUser } });
      let result: unknown = 'pending';
      void port.current().then((r) => {
        result = r;
      });
      await jest.advanceTimersByTimeAsync(SESSION_READ_TIMEOUT_MS - 1);
      expect(result).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(result).toEqual({
        user: { id: 'u-google', provider: 'google', email: 'person@example.com' },
        anonymous: false,
        accessToken: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('is null at the session timeout when nothing is stored', async () => {
    jest.useFakeTimers();
    try {
      const auth = fakeAuth({ getSession: () => new Promise(() => undefined) } as never);
      const { port } = build(auth, { stored: null });
      const p = port.current();
      await jest.advanceTimersByTimeAsync(SESSION_READ_TIMEOUT_MS);
      expect(await p).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the timer when the session read wins', async () => {
    jest.useFakeTimers();
    try {
      const auth = fakeAuth({
        getSession: async () => ({ data: { session: sessionOf(appleUser) }, error: null }),
      } as never);
      const { port } = build(auth);
      await port.current();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('is null when there is no session and no error', async () => {
    const { port } = build(fakeAuth(), { stored: { user: appleUser } });
    expect(await port.current()).toBeNull();
  });
});

describe('sign-in and sign-out', () => {
  it('signInWithIdToken passes the nonce and returns the user', async () => {
    const auth = fakeAuth();
    const { port } = build(auth);
    const user = await port.signInWithIdToken({ provider: 'apple', idToken: 'id', nonce: 'raw' });
    expect(auth.signInWithIdToken).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'id',
      nonce: 'raw',
    });
    expect(user).toEqual({
      id: 'u-apple',
      provider: 'apple',
      email: 'abc123@privaterelay.appleid.com',
    });
  });

  it('signInWithIdToken sends no nonce for Google', async () => {
    const auth = fakeAuth({
      signInWithIdToken: jest.fn(async () => ({
        data: { user: googleUser, session: null },
        error: null,
      })),
    } as never);
    const { port } = build(auth);
    await port.signInWithIdToken({ provider: 'google', idToken: 'id' });
    expect(auth.signInWithIdToken).toHaveBeenCalledWith({ provider: 'google', token: 'id' });
  });

  it('signInWithIdToken throws when Supabase refuses', async () => {
    const auth = fakeAuth({
      signInWithIdToken: jest.fn(async () => ({
        data: { user: null, session: null },
        error: new Error('bad token'),
      })),
    } as never);
    const { port } = build(auth);
    await expect(port.signInWithIdToken({ provider: 'google', idToken: 'x' })).rejects.toThrow(
      'bad token',
    );
  });

  it.each([
    ['signInWithIdToken', { signInWithIdToken: () => new Promise(() => undefined) }],
    ['signInDev', { signInAnonymously: () => new Promise(() => undefined) }],
  ] as const)('%s rejects at the timeout when Supabase never answers', async (method, over) => {
    jest.useFakeTimers();
    try {
      const { port } = build(fakeAuth(over as never));
      const call =
        method === 'signInDev'
          ? port.signInDev()
          : port.signInWithIdToken({ provider: 'google', idToken: 'id' });
      let settled = false;
      const assertion = expect(call).rejects.toThrow('Sign-in timed out');
      void call.catch(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(CALL_FUNCTION_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('a sign-in that answers in time clears its timer', async () => {
    jest.useFakeTimers();
    try {
      const { port } = build(fakeAuth());
      await port.signInDev();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('signInDev signs in anonymously and reports the dev provider', async () => {
    const { port } = build(fakeAuth());
    expect(await port.signInDev()).toEqual({ id: 'u-anon', provider: 'dev', email: null });
  });

  it('signOut uses the local scope', async () => {
    const auth = fakeAuth();
    const { port } = build(auth);
    await port.signOut();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('onChange calls back on auth changes and unsubscribes', () => {
    const unsubscribe = jest.fn();
    let listener: (() => void) | undefined;
    const auth = fakeAuth({
      onAuthStateChange: jest.fn((cb: () => void) => {
        listener = cb;
        return { data: { subscription: { unsubscribe } } };
      }),
    } as never);
    const { port } = build(auth);
    const cb = jest.fn();
    const off = port.onChange(cb);
    listener?.();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe('callFunction', () => {
  it('posts JSON to the function with the given token', async () => {
    const { port, fetchMock } = build(fakeAuth());
    const res = await port.callFunction('claim-anonymous', { anonymousToken: 't' }, 'given');
    expect(res).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${URL}/functions/v1/claim-anonymous`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      apikey: KEY,
      Authorization: 'Bearer given',
    });
    expect(init.body).toBe(JSON.stringify({ anonymousToken: 't' }));
  });

  it('defaults to the current session token, read at call time', async () => {
    let token = 'before';
    const auth = fakeAuth({
      getSession: async () => ({ data: { session: sessionOf(appleUser, token) }, error: null }),
    } as never);
    const { port, fetchMock } = build(auth);
    token = 'after-sign-in';
    await port.callFunction('delete-account', {});
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer after-sign-in');
  });

  it('rejects with no session instead of sending the public key', async () => {
    const { port, fetchMock } = build(fakeAuth());
    await expect(port.callFunction('delete-account', {})).rejects.toThrow('no session');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects with no session when the session has no access token (offline)', async () => {
    const auth = fakeAuth({
      getSession: async () => ({ data: { session: null }, error: new Error('offline') }),
    } as never);
    const { port, fetchMock } = build(auth, { stored: { user: appleUser } });
    await expect(port.callFunction('delete-account', {})).rejects.toThrow('no session');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects at the timeout when the session read never settles (default token path)', async () => {
    jest.useFakeTimers();
    try {
      const auth = fakeAuth({ getSession: () => new Promise(() => undefined) } as never);
      const fetchMock = jest.fn();
      const port = makeAuthPort(auth, {
        url: URL,
        key: KEY,
        fetch: fetchMock as never,
        readStored: () => new Promise(() => undefined),
      });
      let settled = false;
      const call = port.callFunction('delete-account', {});
      const assertion = expect(call).rejects.toThrow('timed out');
      void call.catch(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(CALL_FUNCTION_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await assertion;
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolves ok false with the status for a non-2xx answer', async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 403 }));
    const { port } = build(fakeAuth(), { fetch: fetchMock });
    expect(await port.callFunction('claim-anonymous', {}, 't')).toEqual({
      ok: false,
      status: 403,
    });
  });

  it('aborts and rejects after the timeout', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchMock = jest.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            signal = init.signal ?? undefined;
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const { port } = build(fakeAuth(), { fetch: fetchMock as never });
      const call = port.callFunction('delete-account', {}, 't');
      const assertion = expect(call).rejects.toThrow();
      await jest.advanceTimersByTimeAsync(CALL_FUNCTION_TIMEOUT_MS + 1);
      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the timeout is 15 seconds', () => {
    expect(CALL_FUNCTION_TIMEOUT_MS).toBe(15_000);
  });
});
