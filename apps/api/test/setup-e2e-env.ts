/**
 * KS-4762 / ADR-150 T4. Setup-файл для Jest e2e-прогона.
 * Выставляет env-vars ДО загрузки AppModule:
 *   - HINTS_TEST_MODE=1 — открывает /test/* endpoints (KS-4759 T1).
 *   - HINTS_ENABLED=1 — глобальный killswitch (HintsLimitsService).
 *   - HINTS_DEFAULTS_OVERRIDE_JSON — отключаем throttle + поднимаем
 *     sessionMaxShows, чтобы лимиты не блокировали e2e (KS-4760 T2).
 *   - ANALYTICS_CONSENT_BYPASS=1 — fixture user без consent проходит
 *     (KS-4760 T2). Работает только под NODE_ENV=test.
 *   - NODE_ENV=test — нужен для consent-bypass.
 *
 * Подключение: `setupFiles: ['<rootDir>/setup-e2e-env.ts']` в
 * jest-e2e.config.ts.
 */
process.env.NODE_ENV = 'test';
process.env.HINTS_TEST_MODE = '1';
process.env.HINTS_ENABLED = '1';
process.env.HINTS_DEFAULTS_OVERRIDE_JSON = JSON.stringify({
  enabled: true,
  globalThrottleSec: 0,
  sessionMaxShows: 10000,
  smartDismissWindowH: 24,
});
process.env.ANALYTICS_CONSENT_BYPASS = '1';
