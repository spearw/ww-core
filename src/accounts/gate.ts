/** Where the app sends a person at start-up. The rule itself is app policy and stays in the app. */

export type GateRule = 'strict' | 'aiOnly';

export type Ownership = 'noProfile' | 'claim' | 'mine' | 'other';

/** Who owns the profile on this phone, relative to the signed-in user. */
export function ownership(owner: string | null | undefined, userId: string): Ownership {
  if (owner === undefined) return 'noProfile';
  if (owner === null) return 'claim';
  return owner === userId ? 'mine' : 'other';
}

export type Gate = 'wait' | 'app' | 'onboarding' | 'signIn' | 'switch';

export function appGate(i: {
  rule: GateRule;
  signedIn: boolean;
  hasProfile: boolean;
  ownership: Ownership | null;
}): Gate {
  if (!i.signedIn) {
    if (!i.hasProfile) return 'onboarding';
    return i.rule === 'strict' ? 'signIn' : 'app';
  }
  switch (i.ownership) {
    case 'noProfile':
      return 'onboarding';
    case 'mine':
      return 'app';
    case 'other':
      return 'switch';
    case 'claim':
    case null:
      return 'wait';
  }
}

/** Whether the onboarding quiz ends with a sign-in. */
export function quizNeedsSignIn(rule: GateRule, signedIn: boolean): boolean {
  return rule === 'strict' && !signedIn;
}
