/**
 * KS-2123. Тесты резолвера таймаутов archive-importer.
 *
 * Проверяет:
 *   - default'ы соответствуют ADR-020 (post-KS-2123): 30 мин tickOnce / 35 мин backstop;
 *   - env-переменная переопределяет default;
 *   - невалидный env (NaN, пустая строка, ≤0, нечисловой) → fallback на default.
 */
import {
  DEFAULT_TICK_ONCE_TIMEOUT_MS,
  DEFAULT_BACKSTOP_TIMEOUT_MS,
  IMPORTER_TIMEOUT_ENV_NAMES,
  resolveBackstopTimeoutMs,
  resolveTickOnceTimeoutMs,
  resolveTimeoutMs,
} from './importer-timeouts';

describe('importer-timeouts (KS-2123)', () => {
  // Сохраняем исходные env, чтобы каждый тест работал в гермосреде.
  const originalEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of Object.values(IMPORTER_TIMEOUT_ENV_NAMES)) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('defaults (KS-2123)', () => {
    it('tickOnce default — 30 мин (1 800 000 мс)', () => {
      expect(DEFAULT_TICK_ONCE_TIMEOUT_MS).toBe(30 * 60 * 1000);
      expect(DEFAULT_TICK_ONCE_TIMEOUT_MS).toBe(1_800_000);
    });

    it('backstop default — 35 мин (2 100 000 мс) и больше tickOnce default', () => {
      expect(DEFAULT_BACKSTOP_TIMEOUT_MS).toBe(35 * 60 * 1000);
      expect(DEFAULT_BACKSTOP_TIMEOUT_MS).toBe(2_100_000);
      expect(DEFAULT_BACKSTOP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TICK_ONCE_TIMEOUT_MS);
    });

    it('resolve без env возвращает default', () => {
      expect(resolveTickOnceTimeoutMs()).toBe(DEFAULT_TICK_ONCE_TIMEOUT_MS);
      expect(resolveBackstopTimeoutMs()).toBe(DEFAULT_BACKSTOP_TIMEOUT_MS);
    });
  });

  describe('env override', () => {
    it('IMPORTER_TICK_TIMEOUT_MS=2400000 → resolveTickOnceTimeoutMs() = 40 мин', () => {
      process.env.IMPORTER_TICK_TIMEOUT_MS = '2400000';
      expect(resolveTickOnceTimeoutMs()).toBe(2_400_000);
    });

    it('IMPORTER_BACKSTOP_TIMEOUT_MS=2700000 → resolveBackstopTimeoutMs() = 45 мин', () => {
      process.env.IMPORTER_BACKSTOP_TIMEOUT_MS = '2700000';
      expect(resolveBackstopTimeoutMs()).toBe(2_700_000);
    });

    it('дробное значение округляется вниз (Math.floor)', () => {
      process.env.IMPORTER_TICK_TIMEOUT_MS = '1800000.9';
      expect(resolveTickOnceTimeoutMs()).toBe(1_800_000);
    });
  });

  describe('fallback на default при невалидном env', () => {
    it.each([
      ['пустая строка', ''],
      ['пробелы', '   '],
      ['нечисловое', 'thirty'],
      ['ноль', '0'],
      ['отрицательное', '-1000'],
      ['NaN-литерал', 'NaN'],
      ['Infinity', 'Infinity'],
    ])('%s → fallback на default', (_label, raw) => {
      process.env.IMPORTER_TICK_TIMEOUT_MS = raw;
      expect(resolveTickOnceTimeoutMs()).toBe(DEFAULT_TICK_ONCE_TIMEOUT_MS);
    });

    it('usedDefault=true возвращается при отсутствии env', () => {
      const r = resolveTimeoutMs('IMPORTER_TICK_TIMEOUT_MS', 1234);
      expect(r).toEqual({ value: 1234, usedDefault: true, rawEnv: undefined });
    });

    it('usedDefault=false при валидном env', () => {
      process.env.IMPORTER_TICK_TIMEOUT_MS = '5000';
      const r = resolveTimeoutMs('IMPORTER_TICK_TIMEOUT_MS', 1234);
      expect(r).toEqual({ value: 5000, usedDefault: false, rawEnv: '5000' });
    });

    it('usedDefault=true при невалидном env (диагностика)', () => {
      process.env.IMPORTER_TICK_TIMEOUT_MS = 'bogus';
      const r = resolveTimeoutMs('IMPORTER_TICK_TIMEOUT_MS', 1234);
      expect(r).toEqual({ value: 1234, usedDefault: true, rawEnv: 'bogus' });
    });
  });
});
