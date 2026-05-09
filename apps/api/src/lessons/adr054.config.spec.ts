/**
 * KS-2642 / ADR-054 §4 Phase C — тесты feature-flag и URL-rewriter'а.
 */

import {
  ADR054_UNIFIED_API_ENV_VAR,
  isAdr054UnifiedApi,
  rewriteAdr054AliasUrl,
} from './adr054.config';

describe('ADR-054 Phase C — feature flag', () => {
  const originalEnv = process.env[ADR054_UNIFIED_API_ENV_VAR];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ADR054_UNIFIED_API_ENV_VAR];
    } else {
      process.env[ADR054_UNIFIED_API_ENV_VAR] = originalEnv;
    }
  });

  it('default (env unset) → false', () => {
    delete process.env[ADR054_UNIFIED_API_ENV_VAR];
    expect(isAdr054UnifiedApi()).toBe(false);
  });

  it('"true" → true', () => {
    process.env[ADR054_UNIFIED_API_ENV_VAR] = 'true';
    expect(isAdr054UnifiedApi()).toBe(true);
  });

  it('"false" → false', () => {
    process.env[ADR054_UNIFIED_API_ENV_VAR] = 'false';
    expect(isAdr054UnifiedApi()).toBe(false);
  });

  it('"1" → false (не whitelisted, осознанная strict-семантика)', () => {
    // Чтобы случайные опечатки не врубали миграцию в проде, признаём
    // только литеральный 'true'. См. шапку adr054.config.ts.
    process.env[ADR054_UNIFIED_API_ENV_VAR] = '1';
    expect(isAdr054UnifiedApi()).toBe(false);
  });

  it('"TRUE" (uppercase) → false (whitelist, не case-insensitive)', () => {
    process.env[ADR054_UNIFIED_API_ENV_VAR] = 'TRUE';
    expect(isAdr054UnifiedApi()).toBe(false);
  });
});

describe('ADR-054 Phase C — rewriteAdr054AliasUrl', () => {
  it.each<[string, string]>([
    ['/lessons/user-courses', '/lessons/courses'],
    ['/lessons/user-courses/', '/lessons/courses/'],
    ['/lessons/user-courses/abc', '/lessons/courses/abc'],
    ['/lessons/user-courses/enrolled', '/lessons/courses/enrolled'],
    ['/lessons/user-courses/authors', '/lessons/courses/authors'],
    [
      '/lessons/user-courses/c1/lessons',
      '/lessons/courses/c1/lessons',
    ],
    [
      '/lessons/user-courses/c1/lessons/reorder',
      '/lessons/courses/c1/lessons/reorder',
    ],
    ['/lessons/user-lessons', '/lessons/lessons'],
    ['/lessons/user-lessons/L1', '/lessons/lessons/L1'],
    ['/lessons/user-lessons/L1/steps', '/lessons/lessons/L1/steps'],
    ['/lessons/user-lessons/L1/steps/reorder', '/lessons/lessons/L1/steps/reorder'],
    ['/lessons/user-lesson-steps/S1', '/lessons/steps/S1'],
    ['/lessons/user-progress/courses/C1', '/lessons/progress/courses/C1'],
    ['/lessons/user-progress/lessons/L1', '/lessons/progress/lessons/L1'],
    ['/lessons/user-progress/lessons/L1/step', '/lessons/progress/lessons/L1/step'],
    ['/lessons/user-progress/lessons/L1/complete', '/lessons/progress/lessons/L1/complete'],
  ])('переписывает %s → %s', (input, expected) => {
    expect(rewriteAdr054AliasUrl(input)).toBe(expected);
  });

  it('сохраняет query-string при переписывании', () => {
    expect(rewriteAdr054AliasUrl('/lessons/user-courses?mine=1&limit=10')).toBe(
      '/lessons/courses?mine=1&limit=10',
    );
  });

  it('возвращает null для не-alias URL', () => {
    expect(rewriteAdr054AliasUrl('/lessons/courses')).toBeNull();
    expect(rewriteAdr054AliasUrl('/users/123')).toBeNull();
    expect(rewriteAdr054AliasUrl('/')).toBeNull();
  });
});
