/**
 * KS-4763 / ADR-150. Конфиг Playwright для e2e-теста контекстных подсказок.
 *
 * Запуск — на изолированном test-окружении docker-compose.test-hints.yml
 * (KS-4761 / T3). Порты test-окружения:
 *   web → 5174   api → 3101   postgres → 5433   redis → 6380
 *
 * Без HINTS_TEST_MODE=1 (KS-4759 / T1) тесты сразу падают: helper
 * `seedEvents` упрётся в 404 на /test/seed/events.
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_HINTS_BASE_URL || 'http://localhost:5174';
const API_URL = process.env.E2E_HINTS_API_URL || 'http://localhost:3101';

// Дефолт совпадает с docker-compose.test-hints.yml (KS-4761). Это не
// production-секрет — он только для изолированного test-стека. Хардкод-
// дефолт нужен, чтобы `npm run e2e:hints` работал без отдельного export
// в shell (test_hints action не пробрасывает env).
const INTERNAL_EVENTS_SECRET =
  process.env.INTERNAL_EVENTS_SECRET ||
  'test-hints-internal-events-secret-shared';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  // Сценарии оперируют состоянием actor'а в БД (seed/clean) — параллельный
  // запуск разных правил на одном tester-actor создаёт race. Если в будущем
  // дадим каждому spec'у свой actor-id (через worker-uuid), можно включить.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    extraHTTPHeaders: {
      // Internal endpoints (POST /test/seed/events, /test/clean-actor)
      // требуют общий secret — пробрасываем во все requests, на public
      // endpoint'ы он ignored.
      'X-Internal-Events-Secret': INTERNAL_EVENTS_SECRET,
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // В CI окружение поднимает workflow (см. docs/dev/e2e-hints.md), локально —
  // вручную через `bash scripts/test-hints-up.sh`. Сам Playwright не должен
  // дёргать docker-compose из тестов — слишком медленно и хрупко.
  webServer: undefined,

  // Для удобства helper'ам — API-URL прокинут через метаданные конфига.
  metadata: { apiUrl: API_URL },
});
