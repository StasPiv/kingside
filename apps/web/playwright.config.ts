import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright-конфиг для e2e-тестов (KS-1871).
 *
 * Не пересекается с vitest: vitest ищет `*.test.ts(x)` по всему `src/`;
 * playwright — `*.spec.ts` в `tests/e2e/`. Два разных test-runner'а
 * живут вместе без конфликтов.
 *
 * Dev-сервер предполагается поднятым на `http://localhost:5173`
 * (Kingside web с прокси на прод API по `/__proxy-broadcasts` — если
 * нужен broadcast-сервис; для user-courses достаточно
 * `VITE_API_URL=http://localhost:3001` и локальный API).
 */

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.+\.spec\.ts$/,
  timeout: 120_000,
  retries: 0,
  // Одновременный параллелизм выключаем — e2e создаёт/удаляет
  // реальные записи в БД, гонка переиспользовала бы slug'и.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // dev_bypass передаётся в localStorage, а не через query —
    // login-fixture подкидывает tokens до первого navigate.
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
    },
  ],
});
