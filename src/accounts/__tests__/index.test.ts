it('exports the account helpers and not the app policy', async () => {
  const mod = await import('..');
  expect(Object.keys(mod)).toEqual(
    expect.arrayContaining([
      'appGate',
      'createAccount',
      'makeAuthPort',
      'makeTokenSource',
      'makeSessionCheck',
      'isSignedIn',
    ]),
  );
  expect('GATE_RULE' in mod).toBe(false);
});
