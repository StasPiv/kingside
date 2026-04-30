/**
 * KS-2164. Тесты scheduler-логики.
 *
 * Acceptance scenarios покрыты:
 *   1. base curve: 19:00 UTC, среда, blitz → 15.
 *   2. адаптация: 15 desired − 3 live × 2 = 9.
 *   3. kill-switch: live ≥ 3 → 0.
 *   4. delta>0 → enqueue из idle pool;
 *      delta<0 → dequeue.
 */
import {
  syntheticBaseCurveAt,
  syntheticAdaptedDesired,
  SYNTHETIC_BASE_CURVE_DEFAULT,
} from '@kingside/shared';
import { tickPure, mergeCurve } from './synthetic-scheduler.service';

describe('syntheticBaseCurveAt — KS-2164 §4.1', () => {
  it('среда 19:00 UTC, blitz → 15 (weekday peak)', () => {
    // Среда = day 3 (0=Sun..6=Sat). 2026-04-29 — среда.
    const wed19 = new Date(Date.UTC(2026, 3, 29, 19, 0, 0));
    expect(wed19.getUTCDay()).toBe(3);
    expect(syntheticBaseCurveAt(wed19, 'blitz')).toBe(15);
  });

  it('суббота 19:00 UTC, blitz → 25 (weekend peak)', () => {
    // 2026-04-25 — суббота.
    const sat19 = new Date(Date.UTC(2026, 3, 25, 19, 0, 0));
    expect(sat19.getUTCDay()).toBe(6);
    expect(syntheticBaseCurveAt(sat19, 'blitz')).toBe(25);
  });

  it('понедельник 03:00 UTC, classical → 1 (weekday night)', () => {
    const mon03 = new Date(Date.UTC(2026, 3, 27, 3, 0, 0));
    expect(mon03.getUTCDay()).toBe(1);
    expect(syntheticBaseCurveAt(mon03, 'classical')).toBe(1);
  });

  it('воскресенье 14:00 UTC, rapid → 5', () => {
    const sun14 = new Date(Date.UTC(2026, 3, 26, 14, 0, 0));
    expect(sun14.getUTCDay()).toBe(0);
    expect(syntheticBaseCurveAt(sun14, 'rapid')).toBe(5);
  });

  it('границы часовых полос: 06:00 → "06-11", 12:00 → "12-17", 18:00 → "18-23"', () => {
    const wed = (h: number) => new Date(Date.UTC(2026, 3, 29, h, 0, 0));
    expect(syntheticBaseCurveAt(wed(5), 'bullet')).toBe(3); // 00-05
    expect(syntheticBaseCurveAt(wed(6), 'bullet')).toBe(5); // 06-11
    expect(syntheticBaseCurveAt(wed(12), 'bullet')).toBe(8); // 12-17
    expect(syntheticBaseCurveAt(wed(18), 'bullet')).toBe(15); // 18-23
  });
});

describe('syntheticAdaptedDesired — KS-2164 §4 adapter', () => {
  it('15 desired − 3 live * 2 = 9', () => {
    expect(syntheticAdaptedDesired(15, 3)).toBe(9);
  });
  it('никогда не отрицателен (clamp 0)', () => {
    expect(syntheticAdaptedDesired(5, 10)).toBe(0);
    expect(syntheticAdaptedDesired(0, 100)).toBe(0);
  });
  it('округляет дробное live_avg', () => {
    // desired=10, liveAvg=2.5 → 10 − 5 = 5.
    expect(syntheticAdaptedDesired(10, 2.5)).toBe(5);
  });
});

describe('tickPure — combined logic', () => {
  it('blitz среда 19:00, 0 live → target=15, delta=15 (если current=0)', () => {
    const d = tickPure({
      category: 'blitz',
      liveNow: 0,
      liveAvg: 0,
      syntheticInQueue: 0,
      killSwitchThreshold: 3,
      curve: SYNTHETIC_BASE_CURVE_DEFAULT,
      now: new Date(Date.UTC(2026, 3, 29, 19, 0, 0)),
    });
    expect(d.desired).toBe(15);
    expect(d.target).toBe(15);
    expect(d.delta).toBe(15);
    expect(d.killSwitchTriggered).toBe(false);
  });

  it('blitz adapt: 15 desired − 3 liveAvg × 2 → target=9, current=15 → delta=-6', () => {
    const d = tickPure({
      category: 'blitz',
      liveNow: 3,
      liveAvg: 3,
      syntheticInQueue: 15,
      killSwitchThreshold: 999, // выключаем kill-switch для этого теста
      curve: SYNTHETIC_BASE_CURVE_DEFAULT,
      now: new Date(Date.UTC(2026, 3, 29, 19, 0, 0)),
    });
    expect(d.desired).toBe(15);
    expect(d.target).toBe(9);
    expect(d.delta).toBe(-6);
    expect(d.killSwitchTriggered).toBe(false);
  });

  it('kill-switch при live=4 ≥ 3 → target=0, delta=-current', () => {
    const d = tickPure({
      category: 'blitz',
      liveNow: 4,
      liveAvg: 2,
      syntheticInQueue: 12,
      killSwitchThreshold: 3,
      curve: SYNTHETIC_BASE_CURVE_DEFAULT,
      now: new Date(Date.UTC(2026, 3, 29, 19, 0, 0)),
    });
    expect(d.killSwitchTriggered).toBe(true);
    expect(d.target).toBe(0);
    expect(d.delta).toBe(-12);
  });

  it('kill-switch на границе: liveNow=3, threshold=3 → triggered', () => {
    const d = tickPure({
      category: 'blitz',
      liveNow: 3,
      liveAvg: 0,
      syntheticInQueue: 5,
      killSwitchThreshold: 3,
      curve: SYNTHETIC_BASE_CURVE_DEFAULT,
      now: new Date(Date.UTC(2026, 3, 29, 19, 0, 0)),
    });
    expect(d.killSwitchTriggered).toBe(true);
    expect(d.target).toBe(0);
  });

  it('current уже = target → delta=0, никаких действий', () => {
    const d = tickPure({
      category: 'rapid',
      liveNow: 0,
      liveAvg: 0,
      syntheticInQueue: 8,
      killSwitchThreshold: 999,
      curve: SYNTHETIC_BASE_CURVE_DEFAULT,
      now: new Date(Date.UTC(2026, 3, 29, 19, 0, 0)),
    });
    expect(d.target).toBe(8);
    expect(d.delta).toBe(0);
  });
});

describe('mergeCurve — KS-2164 env override', () => {
  it('partial override применяется поверх дефолта', () => {
    const merged = mergeCurve(SYNTHETIC_BASE_CURVE_DEFAULT, {
      '18-23': {
        weekday: { bullet: 99, blitz: 99, rapid: 8, classical: 3 },
      },
    } as never);
    expect(merged['18-23'].weekday.bullet).toBe(99);
    expect(merged['18-23'].weekday.blitz).toBe(99);
    // Не перезаписанные диапазоны остались дефолтными.
    expect(merged['12-17'].weekday.bullet).toBe(8);
    expect(merged['18-23'].weekend.bullet).toBe(25);
  });

  it('пустой override → точная копия дефолта (но не та же ссылка)', () => {
    const merged = mergeCurve(SYNTHETIC_BASE_CURVE_DEFAULT, {});
    expect(merged).toEqual(SYNTHETIC_BASE_CURVE_DEFAULT);
    expect(merged).not.toBe(SYNTHETIC_BASE_CURVE_DEFAULT);
  });
});
