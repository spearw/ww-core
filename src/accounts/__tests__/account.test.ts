import { createFakeAccountPorts } from '../testing';
import { CARRY_OVER_TIMEOUT_MS, createAccount, isSignedIn } from '../account';
import type { AccountUser, SessionInfo } from '../types';

const user: AccountUser = { id: 'u1', provider: 'google', email: 'a@example.com' };
const anonSession: SessionInfo = {
  user: { id: 'anon', provider: 'dev', email: null },
  anonymous: true,
  accessToken: 'anon-token',
};

function setup(opts: Parameters<typeof createFakeAccountPorts>[0] = {}, devSignIn = false) {
  const ports = createFakeAccountPorts(opts);
  const account = createAccount({
    auth: ports.auth,
    native: ports.native,
    phone: ports.phone,
    devSignIn,
  });
  return { ...ports, account };
}

describe('signIn', () => {
  it('signs in with Google', async () => {
    const { account, calls } = setup();
    expect(await account.signIn('google')).toBe('signedIn');
    expect(calls).toEqual([
      'auth.current',
      'native.google',
      'auth.signInWithIdToken:google:g-id-token:',
    ]);
  });

  it('signs in with Apple, passing the nonce', async () => {
    const { account, calls } = setup();
    expect(await account.signIn('apple')).toBe('signedIn');
    expect(calls).toEqual([
      'auth.current',
      'native.apple',
      'auth.signInWithIdToken:apple:a-id-token:a-nonce',
    ]);
  });

  it('a cancelled native sheet is cancelled and never touches auth', async () => {
    const { account, calls } = setup({ nativeResult: 'cancelled', session: anonSession });
    expect(await account.signIn('google')).toBe('cancelled');
    expect(calls).toEqual(['auth.current', 'native.google']);
  });

  it.each(['apple', 'google', 'dev'] as const)(
    'tells the caller once the %s sheet is done, before the sign-in itself',
    async (provider) => {
      const { account, calls } = setup({}, true);
      const onSigningIn = jest.fn(() => calls.push('onSigningIn'));
      expect(await account.signIn(provider, onSigningIn)).toBe('signedIn');
      expect(onSigningIn).toHaveBeenCalledTimes(1);
      const signInCall = calls.findIndex((c) => c.startsWith('auth.signIn'));
      expect(calls.indexOf('onSigningIn')).toBe(signInCall - 1);
    },
  );

  it('a cancelled sheet never says it is signing in', async () => {
    const { account } = setup({ nativeResult: 'cancelled' });
    const onSigningIn = jest.fn();
    expect(await account.signIn('apple', onSigningIn)).toBe('cancelled');
    expect(onSigningIn).not.toHaveBeenCalled();
  });

  it('carries an anonymous prior session over with its token', async () => {
    const { account, calls, functionCalls } = setup({ session: anonSession });
    expect(await account.signIn('google')).toBe('signedIn');
    expect(calls.indexOf('auth.callFunction:claim-anonymous')).toBeGreaterThan(
      calls.indexOf('auth.signInWithIdToken:google:g-id-token:'),
    );
    expect(functionCalls).toEqual([
      { name: 'claim-anonymous', body: { anonymousToken: 'anon-token' }, token: undefined },
    ]);
  });

  it('stays signed in when the carry-over fails', async () => {
    const log = jest.fn();
    const ports = createFakeAccountPorts({ session: anonSession, functionError: new Error('x') });
    const account = createAccount({ ...ports, devSignIn: false, log });
    expect(await account.signIn('google')).toBe('signedIn');
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('anon-token');
  });

  it('stays signed in when the carry-over never answers, after the timeout', async () => {
    jest.useFakeTimers();
    try {
      const log = jest.fn();
      const ports = createFakeAccountPorts({ session: anonSession, functionHangs: true });
      const account = createAccount({ ...ports, devSignIn: false, log });
      let result: string | undefined;
      void account.signIn('google').then((r) => {
        result = r;
      });
      await jest.advanceTimersByTimeAsync(CARRY_OVER_TIMEOUT_MS - 1);
      expect(result).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(result).toBe('signedIn');
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('anon-token');
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the carry-over timer when the call settles first', async () => {
    jest.useFakeTimers();
    try {
      const { account } = setup({ session: anonSession });
      const done = account.signIn('google');
      await jest.advanceTimersByTimeAsync(0);
      expect(await done).toBe('signedIn');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays signed in when the carry-over is not ok', async () => {
    const { account } = setup({ session: anonSession, functionResult: { ok: false, status: 500 } });
    expect(await account.signIn('apple')).toBe('signedIn');
  });

  it('makes no claim call when the prior session was not anonymous', async () => {
    const { account, functionCalls } = setup({
      session: { user, anonymous: false, accessToken: 't' },
    });
    await account.signIn('google');
    expect(functionCalls).toEqual([]);
  });

  it('makes no claim call when the anonymous prior session has no token', async () => {
    const { account, functionCalls } = setup({ session: { ...anonSession, accessToken: null } });
    await account.signIn('google');
    expect(functionCalls).toEqual([]);
  });

  it('refuses dev sign-in when devSignIn is false', async () => {
    const { account, calls } = setup();
    await expect(account.signIn('dev')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('uses signInDev without a native sheet when devSignIn is true', async () => {
    const { account, calls } = setup({}, true);
    expect(await account.signIn('dev')).toBe('signedIn');
    expect(calls).toContain('auth.signInDev');
    expect(calls.some((c) => c.startsWith('native.'))).toBe(false);
  });

  it('throws native errors', async () => {
    const { account } = setup({ nativeError: new Error('sheet failed') });
    await expect(account.signIn('google')).rejects.toThrow('sheet failed');
  });

  it('throws auth errors', async () => {
    const { account } = setup({ signInError: new Error('bad token') });
    await expect(account.signIn('google')).rejects.toThrow('bad token');
  });
});

describe('signOut, claim, startFresh', () => {
  it('signs out', async () => {
    const { account, calls } = setup();
    await account.signOut();
    expect(calls).toEqual(['auth.signOut']);
  });
  it('claim sets the owner', async () => {
    const { account, calls } = setup();
    await account.claim('u1');
    expect(calls).toEqual(['phone.setOwner:u1']);
  });
  it('startFresh wipes the phone', async () => {
    const { account, calls } = setup();
    await account.startFresh();
    expect(calls).toEqual(['phone.wipe']);
  });
});

describe('deleteAccount', () => {
  it('for Google: server, then wipe, then sign out', async () => {
    const { account, calls, functionCalls } = setup();
    expect(await account.deleteAccount(user)).toBe('deleted');
    expect(calls).toEqual(['auth.callFunction:delete-account', 'phone.wipe', 'auth.signOut']);
    expect(functionCalls).toEqual([{ name: 'delete-account', body: {}, token: undefined }]);
  });

  it('for Apple: sends the authorization code', async () => {
    const { account, calls, functionCalls } = setup();
    expect(await account.deleteAccount({ ...user, provider: 'apple' })).toBe('deleted');
    expect(calls).toEqual([
      'native.apple',
      'auth.callFunction:delete-account',
      'phone.wipe',
      'auth.signOut',
    ]);
    expect(functionCalls[0]?.body).toEqual({ appleAuthorizationCode: 'a-auth-code' });
  });

  it('throws when the server says not ok, wiping and signing out nothing', async () => {
    const { account, calls } = setup({ functionResult: { ok: false, status: 500 } });
    await expect(account.deleteAccount(user)).rejects.toThrow();
    expect(calls).not.toContain('phone.wipe');
    expect(calls).not.toContain('auth.signOut');
  });

  it('throws when the server call rejects, wiping and signing out nothing', async () => {
    const { account, calls } = setup({ functionError: new Error('offline') });
    await expect(account.deleteAccount(user)).rejects.toThrow('offline');
    expect(calls).not.toContain('phone.wipe');
    expect(calls).not.toContain('auth.signOut');
  });

  it('still finishes as deleted when the wipe fails, and still signs out', async () => {
    const log = jest.fn();
    const ports = createFakeAccountPorts({ wipeError: new Error('disk') });
    const account = createAccount({ ...ports, devSignIn: false, log });
    expect(await account.deleteAccount(user)).toBe('deleted');
    expect(ports.calls).toEqual(['auth.callFunction:delete-account', 'phone.wipe', 'auth.signOut']);
    expect(log).toHaveBeenCalled();
  });

  it('still finishes as deleted when sign-out fails', async () => {
    const log = jest.fn();
    const ports = createFakeAccountPorts({ signOutError: new Error('storage') });
    const account = createAccount({ ...ports, devSignIn: false, log });
    expect(await account.deleteAccount(user)).toBe('deleted');
    expect(ports.calls).toEqual(['auth.callFunction:delete-account', 'phone.wipe', 'auth.signOut']);
    expect(log).toHaveBeenCalled();
  });

  it('a cancelled Apple sheet is cancelled with no server call', async () => {
    const { account, calls } = setup({ nativeResult: 'cancelled' });
    expect(await account.deleteAccount({ ...user, provider: 'apple' })).toBe('cancelled');
    expect(calls).toEqual(['native.apple']);
  });
});

describe('isSignedIn', () => {
  const real: SessionInfo = { user, anonymous: false, accessToken: 't' };
  it('is false with no session', () => {
    expect(isSignedIn(null, true)).toBe(false);
  });
  it('is true for a real session', () => {
    expect(isSignedIn(real, false)).toBe(true);
  });
  it('counts an anonymous session only with devSignIn', () => {
    expect(isSignedIn(anonSession, false)).toBe(false);
    expect(isSignedIn(anonSession, true)).toBe(true);
  });
});
