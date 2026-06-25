/**
 * KS-2700 — тесты `computeBroadcastClock` и `formatBroadcastClock`.
 *
 * Хук `useBroadcastClock` тестируется через `renderHook` из @testing-library
 * — здесь покрываем pure-функции, чтобы поведение было детерминированным
 * и не зависело от happy-dom-таймеров.
 */
import { describe, it, expect } from 'vitest';
import {
  computeBroadcastClock,
  formatBroadcastClock,
} from './useBroadcastClock';

const NOW = new Date('2026-05-10T12:00:00Z').getTime();
const T_5S_AGO = new Date(NOW - 5_000).toISOString();
const T_30S_AGO = new Date(NOW - 30_000).toISOString();

describe('computeBroadcastClock KS-2700', () => {
  it('null входы → hasClocks=false, оба null, urgency/mode normal', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: null,
        blackClockMs: null,
        clockUpdatedAt: null,
        isBlackTurn: false,
      },
      NOW,
    );
    expect(r.whiteRemainingMs).toBeNull();
    expect(r.blackRemainingMs).toBeNull();
    expect(r.hasClocks).toBe(false);
    expect(r.whiteUrgency).toBe('normal');
    expect(r.blackUrgency).toBe('normal');
    expect(r.whiteMode).toBe('normal');
    expect(r.blackMode).toBe('normal');
  });

  it('только один из clockMs null → hasClocks=false', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: 60_000,
        blackClockMs: null,
        clockUpdatedAt: T_5S_AGO,
        isBlackTurn: false,
      },
      NOW,
    );
    expect(r.hasClocks).toBe(false);
  });

  it('clockUpdatedAt null → hasClocks=false', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: 60_000,
        blackClockMs: 60_000,
        clockUpdatedAt: null,
        isBlackTurn: false,
      },
      NOW,
    );
    expect(r.hasClocks).toBe(false);
  });

  it('активные белые (isBlackTurn=false) тикают, чёрные статичны', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: 60_000,
        blackClockMs: 90_000,
        clockUpdatedAt: T_5S_AGO,
        isBlackTurn: false,
      },
      NOW,
    );
    // Прошло 5 секунд с clockUpdatedAt → у белых − 5000.
    expect(r.whiteRemainingMs).toBe(55_000);
    // Чёрные не на ходу → значение из DTO без отсчёта.
    expect(r.blackRemainingMs).toBe(90_000);
    expect(r.hasClocks).toBe(true);
  });

  it('активные чёрные (isBlackTurn=true) тикают, белые статичны', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: 60_000,
        blackClockMs: 90_000,
        clockUpdatedAt: T_30S_AGO,
        isBlackTurn: true,
      },
      NOW,
    );
    expect(r.whiteRemainingMs).toBe(60_000);
    expect(r.blackRemainingMs).toBe(60_000); // 90s − 30s
  });

  it('clockMs истекло → не уходим в минус, остаёмся на 0', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: 1_000,
        blackClockMs: 60_000,
        clockUpdatedAt: T_30S_AGO,
        isBlackTurn: false,
      },
      NOW,
    );
    expect(r.whiteRemainingMs).toBe(0);
  });

  it('isFinished=true → активная сторона не тикает (фриз на DTO-значении)', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: 1_000,
        blackClockMs: 60_000,
        clockUpdatedAt: T_30S_AGO,
        isBlackTurn: false,
        isFinished: true,
      },
      NOW,
    );
    // 1000 − 0 = 1000, не 0.
    expect(r.whiteRemainingMs).toBe(1_000);
    expect(r.blackRemainingMs).toBe(60_000);
  });

  it('невалидный ISO clockUpdatedAt → hasClocks=false', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: 60_000,
        blackClockMs: 60_000,
        clockUpdatedAt: 'not-a-date',
        isBlackTurn: false,
      },
      NOW,
    );
    expect(r.hasClocks).toBe(false);
  });
});

describe('formatBroadcastClock KS-2700', () => {
  it('null → null (не рендерим)', () => {
    expect(formatBroadcastClock(null)).toBeNull();
  });
  it('< 1 минуты → m:ss с padding секунды', () => {
    expect(formatBroadcastClock(5_000)).toBe('0:05');
    expect(formatBroadcastClock(0)).toBe('0:00');
  });
  it('< 1 часа → m:ss', () => {
    expect(formatBroadcastClock(60_000)).toBe('1:00');
    expect(formatBroadcastClock(125_500)).toBe('2:05'); // округляется вниз
  });
  it('≥ 1 часа → h:mm:ss', () => {
    // 1ч 23м 45с = 5025000 мс.
    expect(formatBroadcastClock(5_025_000)).toBe('1:23:45');
    expect(formatBroadcastClock(3_600_000)).toBe('1:00:00');
  });
  it('отрицательное → 0:00 (clamp)', () => {
    expect(formatBroadcastClock(-1_000)).toBe('0:00');
  });
  // KS-4656: формат с десятыми/сотыми через второй аргумент `mode`.
  it('mode=tenths → mm:ss.t', () => {
    expect(formatBroadcastClock(9_400, 'tenths')).toBe('0:09.4');
  });
  it('mode=hundredths → ss.tt без минут пока < 60 с', () => {
    expect(formatBroadcastClock(9_430, 'hundredths')).toBe('9.43');
  });
});

describe('computeBroadcastClock — urgency/mode KS-4656', () => {
  it('активная сторона при низком времени → low/tenths; неактивная — нормальный mode', () => {
    // Прошло 30 секунд — белым 5000-30000<0, clamp 0; чёрные неактивны.
    // Возьмём другой расклад: белые активны, осталось 7000 мс.
    const r = computeBroadcastClock(
      {
        whiteClockMs: 7_000,
        blackClockMs: 60_000,
        clockUpdatedAt: new Date(NOW).toISOString(),
        isBlackTurn: false,
      },
      NOW,
    );
    expect(r.whiteRemainingMs).toBe(7_000);
    // С fallback initialMs=null: emergency1=30_000, emergency2=8_000.
    // 7_000 <= 8_000 → critical.
    expect(r.whiteUrgency).toBe('critical');
    expect(r.whiteMode).toBe('hundredths');
    // Чёрные неактивны — mode='normal' независимо от urgency.
    expect(r.blackMode).toBe('normal');
  });

  it('isFinished=true → mode у обоих normal, даже при низком времени', () => {
    const r = computeBroadcastClock(
      {
        whiteClockMs: 500,
        blackClockMs: 500,
        clockUpdatedAt: new Date(NOW).toISOString(),
        isBlackTurn: false,
        isFinished: true,
      },
      NOW,
    );
    // Урgency считается по числу — оба critical (≤8000 при fallback),
    // но mode normal — часы остановлены.
    expect(r.whiteUrgency).toBe('critical');
    expect(r.whiteMode).toBe('normal');
    expect(r.blackMode).toBe('normal');
  });

  it('initialMs учитывается при расчёте порогов', () => {
    // Bullet 1+0: initialMs=60_000 → emergency1=clamp(0.10*60_000,
    // 8_000, 30_000)=8_000; emergency2=clamp(0.025*60_000, 2_000,
    // 8_000)=2_000. 5_000 → low (между 8_000 и 2_000).
    const r = computeBroadcastClock(
      {
        whiteClockMs: 5_000,
        blackClockMs: 60_000,
        clockUpdatedAt: new Date(NOW).toISOString(),
        isBlackTurn: false,
        initialMs: 60_000,
      },
      NOW,
    );
    expect(r.whiteUrgency).toBe('low');
    expect(r.whiteMode).toBe('tenths');
  });
});
