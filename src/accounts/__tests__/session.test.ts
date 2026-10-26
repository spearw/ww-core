import { makeSessionCheck, makeTokenSource, type AuthLike } from '../session';

function fakeAuth(session: string | null, reads = { count: 0 }) {
  const auth: AuthLike = {
    getSession: async () => {
      reads.count++;
      await new Promise((r) => setTimeout(r, 5));
      return { data: { session: session ? { access_token: session } : null }, error: null };
    },
  };
  return { auth, reads };
}

describe('makeTokenSource', () => {
  it('gives the stored session token', async () => {
    const { auth } = fakeAuth('stored');
    expect(await makeTokenSource(auth)()).toBe('stored');
  });

  it('gives null when no session is stored, and never signs in', async () => {
    const { auth } = fakeAuth(null);
    expect(Object.keys(auth)).toEqual(['getSession']);
    const token = makeTokenSource(auth);
    expect(await token()).toBeNull();
    expect(await token()).toBeNull();
  });

  it('shares one read between concurrent calls, then forgets it', async () => {
    const { auth, reads } = fakeAuth('stored');
    const token = makeTokenSource(auth);
    expect(await Promise.all([token(), token(), token()])).toEqual(['stored', 'stored', 'stored']);
    expect(reads.count).toBe(1);
    expect(await token()).toBe('stored');
    expect(reads.count).toBe(2);
  });

  it('throws when the session cannot be read, and the next call tries again', async () => {
    let reads = 0;
    const auth: AuthLike = {
      getSession: async () => {
        reads++;
        return { data: { session: null }, error: new Error('refresh failed: offline') };
      },
    };
    const token = makeTokenSource(auth);
    await expect(token()).rejects.toThrow('refresh failed');
    await expect(token()).rejects.toThrow('refresh failed');
    expect(reads).toBe(2);
  });

  it('picks up a session that appears after a null answer', async () => {
    let session: string | null = null;
    const auth: AuthLike = {
      getSession: async () => ({
        data: { session: session ? { access_token: session } : null },
        error: null,
      }),
    };
    const token = makeTokenSource(auth);
    expect(await token()).toBeNull();
    session = 'signed-in';
    expect(await token()).toBe('signed-in');
  });
});

describe('makeSessionCheck', () => {
  it('is true when a session is stored', async () => {
    const has = makeSessionCheck({
      getSession: async () => ({ data: { session: { access_token: 't' } }, error: null }),
    });
    expect(await has()).toBe(true);
  });
  it('is false with no session, an error, or a throw', async () => {
    expect(
      await makeSessionCheck({
        getSession: async () => ({ data: { session: null }, error: null }),
      })(),
    ).toBe(false);
    expect(
      await makeSessionCheck({
        getSession: async () => ({ data: { session: null }, error: new Error('x') }),
      })(),
    ).toBe(false);
    expect(
      await makeSessionCheck({
        getSession: async () => {
          throw new Error('offline');
        },
      })(),
    ).toBe(false);
  });
});
