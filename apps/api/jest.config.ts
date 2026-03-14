import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
  },
  collectCoverageFrom: ['**/*.ts', '!**/*.module.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@kingside/shared$': '<rootDir>/../../../packages/shared/src',
    '^(\\.\\.?/.*)\\.js$': '$1',
    '^.*/generated/prisma/client$': '<rootDir>/__mocks__/prisma-client.mock.ts',
  },
};

export default config;
