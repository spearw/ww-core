module.exports = {
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/tools/'],
  testEnvironment: 'node',
  testTimeout: 30000,
};
