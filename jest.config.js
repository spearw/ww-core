module.exports = {
  testMatch: ['**/?(*.)+(test).ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$', '/tools/'],
  testEnvironment: 'node',
};
