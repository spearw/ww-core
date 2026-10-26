import type {
  AccountUser,
  AuthPort,
  NativeSignIn,
  PhoneData,
  Provider,
  SessionInfo,
} from './types';

export interface Account {
  /** `onSigningIn` runs once the native sheet is done and the sign-in itself starts. */
  signIn(provider: Provider, onSigningIn?: () => void): Promise<'signedIn' | 'cancelled'>;
  signOut(): Promise<void>;
  claim(userId: string): Promise<void>;
  startFresh(): Promise<void>;
  deleteAccount(user: AccountUser): Promise<'deleted' | 'cancelled'>;
}

/** How long sign-in waits for the anonymous carry-over before giving up on it. */
export const CARRY_OVER_TIMEOUT_MS = 10_000;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'unknown error';
}

/** A session that is anonymous counts as signed in only for the development sign-in. */
export function isSignedIn(s: SessionInfo | null, devSignIn: boolean): boolean {
  if (!s) return false;
  return !s.anonymous || devSignIn;
}

export function createAccount(deps: {
  auth: AuthPort;
  native: NativeSignIn;
  phone: PhoneData;
  devSignIn: boolean;
  /** Never pass tokens to this. */
  log?: (message: string) => void;
}): Account {
  const { auth, native, phone, devSignIn } = deps;
  const log = deps.log ?? (() => undefined);

  async function carryOver(anonymousToken: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CARRY_OVER_TIMEOUT_MS);
    });
    try {
      const res = await Promise.race([
        auth.callFunction('claim-anonymous', { anonymousToken }),
        timedOut,
      ]);
      if (res === 'timeout') log('claim-anonymous timed out');
      else if (!res.ok) log(`claim-anonymous was refused (status ${res.status})`);
    } catch (e) {
      log(`claim-anonymous failed: ${messageOf(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async signIn(provider, onSigningIn) {
      if (provider === 'dev' && !devSignIn) throw new Error('This build cannot sign in as dev');
      const prior = await auth.current();
      const anonymousToken = prior?.anonymous && prior.accessToken ? prior.accessToken : null;

      if (provider === 'dev') {
        onSigningIn?.();
        await auth.signInDev();
      } else if (provider === 'apple') {
        const result = await native.apple();
        if (result === 'cancelled') return 'cancelled';
        onSigningIn?.();
        await auth.signInWithIdToken({
          provider: 'apple',
          idToken: result.idToken,
          nonce: result.nonce,
        });
      } else {
        const result = await native.google();
        if (result === 'cancelled') return 'cancelled';
        onSigningIn?.();
        await auth.signInWithIdToken({ provider: 'google', idToken: result.idToken });
      }

      if (anonymousToken) await carryOver(anonymousToken);
      return 'signedIn';
    },

    signOut: () => auth.signOut(),

    claim: (userId) => phone.setOwner(userId),

    startFresh: () => phone.wipe(),

    async deleteAccount(user) {
      let body: object = {};
      if (user.provider === 'apple') {
        const result = await native.apple();
        if (result === 'cancelled') return 'cancelled';
        body = { appleAuthorizationCode: result.authorizationCode };
      }
      const res = await auth.callFunction('delete-account', body);
      if (!res.ok) throw new Error(`Could not delete the account (status ${res.status})`);
      // The account is gone on the server; the phone must finish even if a step here fails.
      try {
        await phone.wipe();
      } catch (e) {
        log(`wipe after delete failed: ${messageOf(e)}`);
      }
      try {
        await auth.signOut();
      } catch (e) {
        log(`sign-out after delete failed: ${messageOf(e)}`);
      }
      return 'deleted';
    },
  };
}
