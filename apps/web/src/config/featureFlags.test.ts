import { describe, it, expect } from 'vitest';
import {
  isLessonsEnabled,
  areDevRoutesEnabled,
  type FeatureEnv,
} from './featureFlags';

describe('isLessonsEnabled', () => {
  it('включено при явном "true"', () => {
    expect(isLessonsEnabled({ VITE_FEATURE_LESSONS: 'true' })).toBe(true);
    expect(
      isLessonsEnabled({ VITE_FEATURE_LESSONS: 'true', DEV: false }),
    ).toBe(true);
  });

  it('выключено при явном "false"', () => {
    expect(isLessonsEnabled({ VITE_FEATURE_LESSONS: 'false' })).toBe(false);
    expect(
      isLessonsEnabled({ VITE_FEATURE_LESSONS: 'false', DEV: true }),
    ).toBe(false);
  });

  it('выключено при любом «не-true» значении (включая пустую строку)', () => {
    expect(isLessonsEnabled({ VITE_FEATURE_LESSONS: '' })).toBe(false);
    expect(isLessonsEnabled({ VITE_FEATURE_LESSONS: '1' })).toBe(false);
    expect(isLessonsEnabled({ VITE_FEATURE_LESSONS: 'yes' })).toBe(false);
  });

  it('не задано + DEV=true → включено (dev-умолчание)', () => {
    const env: FeatureEnv = { DEV: true };
    expect(isLessonsEnabled(env)).toBe(true);
  });

  it('не задано + DEV=false (prod-build) → выключено', () => {
    expect(isLessonsEnabled({ DEV: false, PROD: true })).toBe(false);
    expect(isLessonsEnabled({})).toBe(false);
  });
});

describe('areDevRoutesEnabled', () => {
  it('DEV=true → включено', () => {
    expect(areDevRoutesEnabled({ DEV: true })).toBe(true);
  });

  it('DEV=false (prod-build) → выключено', () => {
    expect(areDevRoutesEnabled({ DEV: false })).toBe(false);
    expect(areDevRoutesEnabled({ PROD: true })).toBe(false);
    expect(areDevRoutesEnabled({})).toBe(false);
  });

  it('игнорирует VITE_FEATURE_LESSONS (независимый флаг)', () => {
    expect(
      areDevRoutesEnabled({ VITE_FEATURE_LESSONS: 'true', DEV: false }),
    ).toBe(false);
    expect(
      areDevRoutesEnabled({ VITE_FEATURE_LESSONS: 'false', DEV: true }),
    ).toBe(true);
  });
});
