/** Account types and the three ports the account logic runs over. No React, Expo or Supabase here. */

export type Provider = 'apple' | 'google' | 'dev';

export interface AccountUser {
  id: string;
  provider: Provider;
  email: string | null;
}

export interface SessionInfo {
  user: AccountUser;
  anonymous: boolean;
  /** Null when the stored session could not be refreshed (offline). */
  accessToken: string | null;
}

export interface AuthPort {
  /**
   * The stored session's user, even when its token cannot be refreshed offline (`accessToken` is
   * null then). Null only when nothing is stored.
   */
  current(): Promise<SessionInfo | null>;
  signInWithIdToken(p: {
    provider: 'apple' | 'google';
    idToken: string;
    nonce?: string;
  }): Promise<AccountUser>;
  signInDev(): Promise<AccountUser>;
  signOut(): Promise<void>;
  onChange(cb: () => void): () => void;
  callFunction(
    name: 'delete-account' | 'claim-anonymous',
    body: object,
    token?: string,
  ): Promise<{ ok: boolean; status: number }>;
}

export interface NativeSignIn {
  appleAvailable(): Promise<boolean>;
  googleAvailable(): boolean;
  apple(): Promise<{ idToken: string; nonce: string; authorizationCode: string } | 'cancelled'>;
  google(): Promise<{ idToken: string } | 'cancelled'>;
}

export interface PhoneData {
  /** The owner recorded on the phone's profile; `undefined` means there is no profile. */
  owner(): Promise<string | null | undefined>;
  setOwner(id: string): Promise<void>;
  wipe(): Promise<void>;
}
