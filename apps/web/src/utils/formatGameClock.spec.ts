/**
 * KS-4651 / ADR-144 §3.2-§3.3 — тесты `formatGameClock` и
 * `computeClockUrgency`. Покрывают:
 *  - три режима формата (normal/tenths/hundredths);
 *  - граничные значения (60 001 мс, 0 мс, отрицательные, NaN/Infinity);
 *  - переключение `H:MM:SS` ровно на 1 ч (3 600 000 / 3 599 999);
 *  - таблицу порогов §3.2 (bullet 1+0, blitz 3+0/5+0, rapid 15+10,
 *    classical 30+0) и fallback `initialMs == null`.
 */
import { describe, it, expect } from 'vitest';
import { formatGameClock, computeClockUrgency } from './formatGameClock';

describe('formatGameClock — режим "normal" (mm:ss / H:MM:SS)', () => {
  it('секундный округлённый формат для значений < 1 ч', () => {
    expect(formatGameClock(0, 'normal')).toBe('0:00');
    expect(formatGameClock(999, 'normal')).toBe('0:00');
    expect(formatGameClock(1000, 'normal')).toBe('0:01');
    expect(formatGameClock(59_999, 'normal')).toBe('0:59');
    expect(formatGameClock(60_000, 'normal')).toBe('1:00');
    // KS-4651 §3.3 — граница 60 001 мс: дробь отбрасывается, остаётся `1:00`.
    expect(formatGameClock(60_001, 'normal')).toBe('1:00');
    expect(formatGameClock(60_999, 'normal')).toBe('1:00');
    expect(formatGameClock(61_000, 'normal')).toBe('1:01');
    expect(formatGameClock(5 * 60_000 + 23_000, 'normal')).toBe('5:23');
    expect(formatGameClock(12 * 60_000, 'normal')).toBe('12:00');
    expect(formatGameClock(59 * 60_000 + 59_000, 'normal')).toBe('59:59');
  });

  it('переключение на H:MM:SS ровно с 1 часа', () => {
    // 3 599 999 мс → 59:59 (часов ещё нет).
    expect(formatGameClock(3_599_999, 'normal')).toBe('59:59');
    // 3 600 000 мс → 1:00:00.
    expect(formatGameClock(3_600_000, 'normal')).toBe('1:00:00');
    expect(formatGameClock(1 * 3_600_000 + 2 * 60_000 + 45_000, 'normal')).toBe(
      '1:02:45',
    );
    expect(formatGameClock(3_661_000, 'normal')).toBe('1:01:01');
  });

  it('отрицательные и нечисловые входы нормализуются в 0:00', () => {
    expect(formatGameClock(-1, 'normal')).toBe('0:00');
    expect(formatGameClock(-10_000, 'normal')).toBe('0:00');
    expect(formatGameClock(Number.NaN, 'normal')).toBe('0:00');
    expect(formatGameClock(Number.POSITIVE_INFINITY, 'normal')).toBe('0:00');
    expect(formatGameClock(Number.NEGATIVE_INFINITY, 'normal')).toBe('0:00');
  });
});

describe('formatGameClock — режим "tenths" (mm:ss.t)', () => {
  it('одна цифра десятых, округление вниз', () => {
    expect(formatGameClock(9_400, 'tenths')).toBe('0:09.4');
    // Floor: 9 499 мс → 9.4, не 9.5.
    expect(formatGameClock(9_499, 'tenths')).toBe('0:09.4');
    expect(formatGameClock(9_500, 'tenths')).toBe('0:09.5');
    expect(formatGameClock(60_500, 'tenths')).toBe('1:00.5');
    expect(formatGameClock(0, 'tenths')).toBe('0:00.0');
  });

  it('отрицательные и нечисловые → 0:00.0', () => {
    expect(formatGameClock(-1, 'tenths')).toBe('0:00.0');
    expect(formatGameClock(Number.NaN, 'tenths')).toBe('0:00.0');
  });

  it('страховка ≥1 ч в tenths сохраняет H:MM:SS.t', () => {
    expect(formatGameClock(3_600_500, 'tenths')).toBe('1:00:00.5');
  });
});

describe('formatGameClock — режим "hundredths" (ss.tt / mm:ss.tt)', () => {
  it('без минут пока < 60 секунд', () => {
    expect(formatGameClock(9_430, 'hundredths')).toBe('9.43');
    expect(formatGameClock(9_499, 'hundredths')).toBe('9.49');
    expect(formatGameClock(59_990, 'hundredths')).toBe('59.99');
    expect(formatGameClock(0, 'hundredths')).toBe('0.00');
  });

  it('с минутами при ≥ 60 секунд', () => {
    expect(formatGameClock(60_000, 'hundredths')).toBe('1:00.00');
    expect(formatGameClock(65_430, 'hundredths')).toBe('1:05.43');
    expect(formatGameClock(59 * 60_000 + 59_990, 'hundredths')).toBe(
      '59:59.99',
    );
  });

  it('с часами при ≥ 1 ч', () => {
    expect(formatGameClock(3_600_000, 'hundredths')).toBe('1:00:00.00');
    expect(formatGameClock(3_661_430, 'hundredths')).toBe('1:01:01.43');
  });

  it('отрицательные/нечисловые → 0.00', () => {
    expect(formatGameClock(-50, 'hundredths')).toBe('0.00');
    expect(formatGameClock(Number.NaN, 'hundredths')).toBe('0.00');
    expect(formatGameClock(Number.POSITIVE_INFINITY, 'hundredths')).toBe(
      '0.00',
    );
  });

  it('округление сотых — вниз', () => {
    // 9 439 мс → 9.43 (а не 9.44).
    expect(formatGameClock(9_439, 'hundredths')).toBe('9.43');
    expect(formatGameClock(9_499, 'hundredths')).toBe('9.49');
  });
});

describe('computeClockUrgency — таблица §3.2', () => {
  it('bullet 1+0 (initialMs=60_000): emergency1=8_000, emergency2=2_000', () => {
    const init = 60_000;
    // normal — всё что выше 8 000.
    expect(computeClockUrgency(60_000, init)).toBe('normal');
    expect(computeClockUrgency(8_001, init)).toBe('normal');
    // low — 2_001..8_000.
    expect(computeClockUrgency(8_000, init)).toBe('low');
    expect(computeClockUrgency(2_001, init)).toBe('low');
    // critical — ≤ 2_000.
    expect(computeClockUrgency(2_000, init)).toBe('critical');
    expect(computeClockUrgency(0, init)).toBe('critical');
  });

  it('blitz 3+0 (initialMs=180_000): emergency1=18_000, emergency2=4_500', () => {
    const init = 180_000;
    expect(computeClockUrgency(18_001, init)).toBe('normal');
    expect(computeClockUrgency(18_000, init)).toBe('low');
    expect(computeClockUrgency(4_501, init)).toBe('low');
    expect(computeClockUrgency(4_500, init)).toBe('critical');
  });

  it('blitz 5+0 (initialMs=300_000): emergency1=30_000 (clamp), emergency2=7_500', () => {
    const init = 300_000;
    expect(computeClockUrgency(30_001, init)).toBe('normal');
    expect(computeClockUrgency(30_000, init)).toBe('low');
    expect(computeClockUrgency(7_501, init)).toBe('low');
    expect(computeClockUrgency(7_500, init)).toBe('critical');
  });

  it('rapid 15+10 (initialMs=900_000): clamp обоих порогов в максимум', () => {
    const init = 900_000;
    // 0.10*900_000=90_000 → clamp → 30_000.
    // 0.025*900_000=22_500 → clamp → 8_000.
    expect(computeClockUrgency(30_001, init)).toBe('normal');
    expect(computeClockUrgency(30_000, init)).toBe('low');
    expect(computeClockUrgency(8_001, init)).toBe('low');
    expect(computeClockUrgency(8_000, init)).toBe('critical');
  });

  it('classical 30+0 (initialMs=1_800_000): тоже оба порога в clamp-максимум', () => {
    const init = 1_800_000;
    expect(computeClockUrgency(30_001, init)).toBe('normal');
    expect(computeClockUrgency(30_000, init)).toBe('low');
    expect(computeClockUrgency(8_001, init)).toBe('low');
    expect(computeClockUrgency(8_000, init)).toBe('critical');
  });

  it('initialMs == null → fallback emergency1=30_000, emergency2=8_000', () => {
    expect(computeClockUrgency(30_001, null)).toBe('normal');
    expect(computeClockUrgency(30_000, null)).toBe('low');
    expect(computeClockUrgency(8_001, null)).toBe('low');
    expect(computeClockUrgency(8_000, null)).toBe('critical');
  });

  it('NaN/Infinity initialMs трактуем как unknown → fallback', () => {
    expect(computeClockUrgency(30_000, Number.NaN)).toBe('low');
    expect(computeClockUrgency(8_000, Number.POSITIVE_INFINITY)).toBe(
      'critical',
    );
  });

  it('отрицательный/NaN remainingMs → critical (флаг падает)', () => {
    expect(computeClockUrgency(-1, 60_000)).toBe('critical');
    expect(computeClockUrgency(Number.NaN, 60_000)).toBe('critical');
    expect(computeClockUrgency(Number.NEGATIVE_INFINITY, 60_000)).toBe(
      'critical',
    );
  });

  it('экстремально низкий initialMs не ломает пороги (clamp в минимум)', () => {
    // 0.10*5_000=500 → clamp → 8_000; 0.025*5_000=125 → clamp → 2_000.
    expect(computeClockUrgency(9_000, 5_000)).toBe('normal');
    expect(computeClockUrgency(8_000, 5_000)).toBe('low');
    expect(computeClockUrgency(2_000, 5_000)).toBe('critical');
  });
});
