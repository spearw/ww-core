module.exports = {
  testMatch: ['**/?(*.)+(test).ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.integration\\.test\\.ts$', '<rootDir>/tools/'],
  testEnvironment: 'node',
};
