import type { AuthPort, NativeSignIn, PhoneData, SessionInfo, AccountUser } from './types';

export interface FakeAccountOptions {
  /** The session `auth.current()` returns. */
  session?: SessionInfo | null;
  /** What the native sheets give; 'cancelled' for both. Default: fake tokens. */
  nativeResult?: 'cancelled';
  nativeError?: Error;
  signInError?: Error;
  /** Makes `signInWithIdToken` and `signInDev` never settle. */
  signInHangs?: boolean;
  /** What `callFunction` resolves with (default ok). */
  functionResult?: { ok: boolean; status: number };
  /** Makes `callFunction` reject. */
  functionError?: Error;
  /** Makes `callFunction` never settle. */
  functionHangs?: boolean;
  wipeError?: Error;
  signOutError?: Error;
  owner?: string | null | undefined;
  appleAvailable?: boolean;
  googleAvailable?: boolean;
}

/** Fakes for the three account ports; `calls` records every call in order, as plain strings. */
export function createFakeAccountPorts(opts: FakeAccountOptions = {}) {
  const calls: string[] = [];
  const functionCalls: { name: string; body: object; token: string | undefined }[] = [];
  const listeners = new Set<() => void>();
  let session: SessionInfo | null = opts.session ?? null;
  let owner = opts.owner;

  const signedInUser = (provider: AccountUser['provider']): AccountUser => ({
    id: `${provider}-user`,
    provider,
    email: null,
  });

  const auth: AuthPort = {
    async current() {
      calls.push('auth.current');
      return session;
    },
    async signInWithIdToken(p) {
      calls.push(`auth.signInWithIdToken:${p.provider}:${p.idToken}:${p.nonce ?? ''}`);
      if (opts.signInHangs) return new Promise(() => undefined);
      if (opts.signInError) throw opts.signInError;
      const u = signedInUser(p.provider);
      session = { user: u, anonymous: false, accessToken: 'new-token' };
      listeners.forEach((cb) => cb());
      return u;
    },
    async signInDev() {
      calls.push('auth.signInDev');
      if (opts.signInHangs) return new Promise(() => undefined);
      if (opts.signInError) throw opts.signInError;
      const u = signedInUser('dev');
      session = { user: u, anonymous: false, accessToken: 'new-token' };
      listeners.forEach((cb) => cb());
      return u;
    },
    async signOut() {
      calls.push('auth.signOut');
      if (opts.signOutError) throw opts.signOutError;
      session = null;
      listeners.forEach((cb) => cb());
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async callFunction(name, body, token) {
      calls.push(`auth.callFunction:${name}`);
      functionCalls.push({ name, body, token });
      if (opts.functionHangs) return new Promise(() => undefined);
      if (opts.functionError) throw opts.functionError;
      return opts.functionResult ?? { ok: true, status: 200 };
    },
  };

  const native: NativeSignIn = {
    async appleAvailable() {
      return opts.appleAvailable ?? true;
    },
    googleAvailable() {
      return opts.googleAvailable ?? true;
    },
    async apple() {
      calls.push('native.apple');
      if (opts.nativeError) throw opts.nativeError;
      if (opts.nativeResult === 'cancelled') return 'cancelled';
      return { idToken: 'a-id-token', nonce: 'a-nonce', authorizationCode: 'a-auth-code' };
    },
    async google() {
      calls.push('native.google');
      if (opts.nativeError) throw opts.nativeError;
      if (opts.nativeResult === 'cancelled') return 'cancelled';
      return { idToken: 'g-id-token' };
    },
  };

  const phone: PhoneData = {
    async owner() {
      calls.push('phone.owner');
      return owner;
    },
    async setOwner(id) {
      calls.push(`phone.setOwner:${id}`);
      owner = id;
    },
    async wipe() {
      calls.push('phone.wipe');
      if (opts.wipeError) throw opts.wipeError;
      owner = undefined;
    },
  };

  return { auth, native, phone, calls, functionCalls, session: () => session };
}
