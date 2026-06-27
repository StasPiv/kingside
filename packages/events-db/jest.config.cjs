// KS-4691: jest для пакета events-db. CommonJS-конфиг (не .ts), чтобы не
// требовать дополнительных transformer'ов под TS-config.
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  // Сгенерированный prisma-клиент не нужен тайпчекать в тестах —
  // только импортируется.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/src/generated/'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          // Тестовый tsconfig: совместим с основным, но без composite.
          module: 'CommonJS',
          moduleResolution: 'Node',
          target: 'ES2022',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      },
    ],
  },
};
