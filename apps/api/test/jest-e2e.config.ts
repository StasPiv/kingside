import type { Config } from 'jest';

/**
 * Конфиг для e2e-тестов `apps/api` (KS-1834, BE-7).
 *
 * Принципиальные отличия от обычного `jest.config.ts`:
 *
 *  1. `rootDir: 'test'` — e2e-тесты живут в `apps/api/test/`, а unit —
 *     в `apps/api/src/`. Два отдельных прогоны, чтобы unit не требовал
 *     БД/Redis, а e2e — наоборот, использовал реальные.
 *
 *  2. НЕТ `moduleNameMapper` на `.../generated/prisma/client` — в unit
 *     он подменяет Prisma на мок, чтобы тесты не требовали
 *     `prisma generate`. Для e2e нужен настоящий Prisma Client против
 *     локальной PostgreSQL.
 *
 *  3. `testTimeout` увеличен — boot-up `AppModule` с полным DI-графом +
 *     Prisma connect + возможные Redis-задержки суммарно могут
 *     занимать > 5 сек. на холодном старте.
 *
 * Запуск: `npm run test:e2e` из `apps/api`. Требует поднятых локально
 * PostgreSQL и Redis (см. `.env`).
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  // rootDir — директория тестов (где лежит этот config: `apps/api/test/`).
  // jest разрешает его относительно файла конфигурации.
  rootDir: '.',
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    // rootDir = apps/api/test — до корня монорепо два уровня вверх.
    '^@kingside/shared$': '<rootDir>/../../../packages/shared/src',
    '^(\\.\\.?/.*)\\.js$': '$1',
  },
  testTimeout: 30_000,
  // Один раннер: e2e гоняет реальный `AppModule`, конкурентные прогоны
  // схлестнутся на общей БД. Быстрее и стабильнее один worker.
  maxWorkers: 1,
};

export default config;
