/**
 * KS-4806 / ADR-153 §2.4. Тесты `isQuietPage` + `quietPagePatternToRegex`.
 * Pattern'ы — те, что в `HINT_QUIET_PAGES` (`/live/*`, `/broadcast/*`,
 * `/lecture/:id`, `/admin/*`). `/play/:gameId` — `low-time-focus`, не
 * always-quiet → НЕ в whitelist'е `isQuietPage`.
 */
import { describe, it, expect } from 'vitest';
import {
  HINT_QUIET_PAGE_PATTERNS_ALWAYS,
  isQuietPage,
  quietPagePatternToRegex,
} from './hint-quiet-pages.js';

describe('isQuietPage', () => {
  it('тихие страницы: /live/, /broadcast/, /lecture/:id, /admin/', () => {
    expect(isQuietPage('/live/round-1')).toBe(true);
    expect(isQuietPage('/live/round-1/game-3')).toBe(true); // greedy * через `/`
    expect(isQuietPage('/broadcast/abc')).toBe(true);
    expect(isQuietPage('/lecture/123')).toBe(true);
    expect(isQuietPage('/admin/users')).toBe(true);
    expect(isQuietPage('/admin/feature-flags/x')).toBe(true);
  });

  it('страницы, которые НЕ всегда тихие — false', () => {
    expect(isQuietPage('/play/abc')).toBe(false); // condition='low-time-focus'
    expect(isQuietPage('/game/uuid')).toBe(false);
    expect(isQuietPage('/puzzle/123')).toBe(false);
    expect(isQuietPage('/lessons/caro-kann/intro')).toBe(false);
    expect(isQuietPage('/analysis/x')).toBe(false);
    expect(isQuietPage('/')).toBe(false);
    expect(isQuietPage('/settings')).toBe(false);
  });

  it('/lecture/:id — один сегмент: /lecture/abc → true, /lecture/abc/def → false', () => {
    expect(isQuietPage('/lecture/abc')).toBe(true);
    expect(isQuietPage('/lecture/abc/def')).toBe(false);
  });

  it('пустая строка / не-строка → false (defensive)', () => {
    expect(isQuietPage('')).toBe(false);
    // @ts-expect-error — намеренно проверяем рантайм-устойчивость
    expect(isQuietPage(null)).toBe(false);
    // @ts-expect-error
    expect(isQuietPage(undefined)).toBe(false);
    // @ts-expect-error
    expect(isQuietPage(42)).toBe(false);
  });

  it('partial-match защищён `^…$`: /live (без /) и /admin (без /) ', () => {
    // pattern /live/* требует хотя бы один символ после /live/
    expect(isQuietPage('/live')).toBe(false);
    expect(isQuietPage('/live/')).toBe(false); // .+ требует ≥1
    expect(isQuietPage('/livespan')).toBe(false); // не /live/
    expect(isQuietPage('/livefeed/abc')).toBe(false); // /live/ — литерал, не префикс
  });
});

describe('quietPagePatternToRegex', () => {
  it('`*` → `.+` (greedy через /)', () => {
    const re = quietPagePatternToRegex('/live/*');
    expect(re.test('/live/round-1')).toBe(true);
    expect(re.test('/live/round-1/game-2')).toBe(true);
    expect(re.test('/live/')).toBe(false);
    expect(re.test('/livespan')).toBe(false);
  });

  it('`:name` → `[^/]+` (один сегмент)', () => {
    const re = quietPagePatternToRegex('/lecture/:id');
    expect(re.test('/lecture/abc')).toBe(true);
    expect(re.test('/lecture/abc-123_x')).toBe(true);
    expect(re.test('/lecture/abc/def')).toBe(false);
    expect(re.test('/lecture/')).toBe(false);
  });

  it('regex-specials в литерале экранируются', () => {
    const re = quietPagePatternToRegex('/path.with.dots');
    expect(re.test('/path.with.dots')).toBe(true);
    expect(re.test('/pathXwithXdots')).toBe(false); // `.` не любой символ
  });

  it('anchor `^…$` — pattern должен полностью совпадать', () => {
    const re = quietPagePatternToRegex('/admin/*');
    expect(re.test('/prefix/admin/users')).toBe(false);
    expect(re.test('/admin/users/suffix')).toBe(true); // под /admin/, OK
  });
});

describe('HINT_QUIET_PAGE_PATTERNS_ALWAYS — синхронизация с isQuietPage', () => {
  it('каждый pattern из ALWAYS-списка должен matchиться сам собой через resolver', () => {
    for (const pattern of HINT_QUIET_PAGE_PATTERNS_ALWAYS) {
      // Подставляем правдоподобные плейсхолдеры.
      const sample = pattern
        .replace(/\*/g, 'x')
        .replace(/:[a-zA-Z][a-zA-Z0-9_]*/g, 'sample');
      expect(isQuietPage(sample), `${pattern} → ${sample}`).toBe(true);
    }
  });
});
