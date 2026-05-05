import { describe, it, expect, beforeEach } from 'vitest';
import {
  DRILL_ONBOARDING_STORAGE_KEY,
  hasSeenDrillOnboarding,
  markDrillOnboardingSeen,
  resetDrillOnboarding,
} from './drillOnboarding';

/**
 * KS-2418 — helper для онбординга drill-типов.
 * Чистый юнит-тест: write/read/reset поверх реального localStorage в jsdom.
 */
describe('drillOnboarding helper (KS-2418)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('hasSeenDrillOnboarding по умолчанию false для всех типов', () => {
    expect(hasSeenDrillOnboarding('find-fork')).toBe(false);
    expect(hasSeenDrillOnboarding('find-all-checks')).toBe(false);
  });

  it('markDrillOnboardingSeen сохраняет факт в localStorage', () => {
    markDrillOnboardingSeen('find-pin');
    expect(hasSeenDrillOnboarding('find-pin')).toBe(true);
    // Другие типы остаются не отмеченными.
    expect(hasSeenDrillOnboarding('find-fork')).toBe(false);
    const raw = window.localStorage.getItem(DRILL_ONBOARDING_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ 'find-pin': true });
  });

  it('mark можно вызывать несколько раз — состояние накапливается', () => {
    markDrillOnboardingSeen('find-pin');
    markDrillOnboardingSeen('count-attackers');
    expect(hasSeenDrillOnboarding('find-pin')).toBe(true);
    expect(hasSeenDrillOnboarding('count-attackers')).toBe(true);
  });

  it('resetDrillOnboarding очищает все флаги', () => {
    markDrillOnboardingSeen('find-pin');
    markDrillOnboardingSeen('find-fork');
    resetDrillOnboarding();
    expect(hasSeenDrillOnboarding('find-pin')).toBe(false);
    expect(hasSeenDrillOnboarding('find-fork')).toBe(false);
    expect(
      window.localStorage.getItem(DRILL_ONBOARDING_STORAGE_KEY),
    ).toBeNull();
  });

  it('кривое значение в localStorage не ломает чтение', () => {
    window.localStorage.setItem(DRILL_ONBOARDING_STORAGE_KEY, 'not-json{');
    expect(hasSeenDrillOnboarding('find-pin')).toBe(false);
    // Поверх кривого значения mark всё равно работает.
    markDrillOnboardingSeen('find-pin');
    expect(hasSeenDrillOnboarding('find-pin')).toBe(true);
  });
});
