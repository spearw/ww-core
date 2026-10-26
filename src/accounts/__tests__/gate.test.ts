import { appGate, ownership, quizNeedsSignIn } from '../gate';

describe('ownership', () => {
  it('is noProfile when there is no profile', () => {
    expect(ownership(undefined, 'u1')).toBe('noProfile');
  });
  it('is claim when the profile has no owner yet', () => {
    expect(ownership(null, 'u1')).toBe('claim');
  });
  it('is mine for the same user and other for a different one', () => {
    expect(ownership('u1', 'u1')).toBe('mine');
    expect(ownership('u2', 'u1')).toBe('other');
  });
});

describe('appGate strict', () => {
  const rule = 'strict' as const;
  it('signed out with a profile asks to sign in', () => {
    expect(appGate({ rule, signedIn: false, hasProfile: true, ownership: null })).toBe('signIn');
  });
  it('signed out with no profile starts onboarding', () => {
    expect(appGate({ rule, signedIn: false, hasProfile: false, ownership: null })).toBe(
      'onboarding',
    );
  });
  it('signed in with ownership not yet known waits', () => {
    expect(appGate({ rule, signedIn: true, hasProfile: true, ownership: null })).toBe('wait');
  });
  it.each([
    ['noProfile', 'onboarding'],
    ['claim', 'wait'],
    ['mine', 'app'],
    ['other', 'switch'],
  ] as const)('signed in, %s -> %s', (own, gate) => {
    expect(appGate({ rule, signedIn: true, hasProfile: true, ownership: own })).toBe(gate);
  });
});

describe('appGate aiOnly', () => {
  const rule = 'aiOnly' as const;
  it('signed out with a profile goes straight to the app', () => {
    expect(appGate({ rule, signedIn: false, hasProfile: true, ownership: null })).toBe('app');
  });
  it('signed out with no profile starts onboarding', () => {
    expect(appGate({ rule, signedIn: false, hasProfile: false, ownership: null })).toBe(
      'onboarding',
    );
  });
  it.each([
    ['noProfile', 'onboarding'],
    ['claim', 'wait'],
    ['mine', 'app'],
    ['other', 'switch'],
  ] as const)('signed in, %s -> %s', (own, gate) => {
    expect(appGate({ rule, signedIn: true, hasProfile: true, ownership: own })).toBe(gate);
  });
});

describe('quizNeedsSignIn', () => {
  it('is true only for strict and signed out', () => {
    expect(quizNeedsSignIn('strict', false)).toBe(true);
    expect(quizNeedsSignIn('strict', true)).toBe(false);
    expect(quizNeedsSignIn('aiOnly', false)).toBe(false);
    expect(quizNeedsSignIn('aiOnly', true)).toBe(false);
  });
});
