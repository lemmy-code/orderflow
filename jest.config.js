const base = {
  rootDir: '.',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@app/contracts$': '<rootDir>/libs/contracts/src',
    '^@app/contracts/(.*)$': '<rootDir>/libs/contracts/src/$1',
    '^@app/messaging$': '<rootDir>/libs/messaging/src',
    '^@app/messaging/(.*)$': '<rootDir>/libs/messaging/src/$1',
  },
};

module.exports = {
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['apps/**/src/**/*.ts', 'libs/**/src/**/*.ts', '!**/main.ts', '!**/migrations/**'],
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/{apps,libs}/**/*.spec.ts'] },
    { ...base, displayName: 'int', testMatch: ['<rootDir>/test/int/**/*.int-spec.ts'], setupFilesAfterEnv: ['<rootDir>/test/support/timeout.ts'] },
    { ...base, displayName: 'e2e', testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'], setupFilesAfterEnv: ['<rootDir>/test/support/timeout.ts'] },
  ],
};
