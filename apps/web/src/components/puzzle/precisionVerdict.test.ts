import { describe, it, expect } from 'vitest';
import {
  shouldFinishLose,
  isWinDropExcessive,
  PRESERVED_WIN_DROP_THRESHOLD_PERMILLE,
} from './precisionVerdict';

/**
 * KS-2955: тест на helper «преимущество удержано / потеряно».
 *
 * Жалоба пользователя на проде: precision-задача `b8a07cc6-…`, ход
 * Qxf7+ помечен `!` (лучший ход), но UI показывал «преимущество
 * потеряно» из-за того что в исходной позиции у белых уже было -1.15.
 * Helper не должен квалифицировать лучший ход как «потерянный»,
 * независимо от абсолютной оценки.
 */
describe('shouldFinishLose (KS-2955)', () => {
  const FAIL_THRESHOLD = 0;

  it('лучший ход в проигранной позиции → НЕ потеря (главный кейс жалобы)', () => {
    // Юзер сыграл Qxf7+ (h5f7), engine считает это лучшим, но позиция
    // после хода всё ещё -1.15 (effWdlUser ≈ -0.5).
    const snapshot = { bestUci: 'h5f7', playedUci: 'h5f7' };
    expect(shouldFinishLose(snapshot, -0.5, FAIL_THRESHOLD)).toBe(false);
  });

  it('лучший ход с promotion (5-char bestUci) сравнивается без суффикса', () => {
    // engine: e7e8q (promotion в ферзя); onPieceDrop собрал playedUci=e7e8.
    const snapshot = { bestUci: 'e7e8q', playedUci: 'e7e8' };
    expect(shouldFinishLose(snapshot, -0.3, FAIL_THRESHOLD)).toBe(false);
  });

  it('не лучший ход + WDL ниже порога → потеря', () => {
    const snapshot = { bestUci: 'h5f7', playedUci: 'a2a3' };
    expect(shouldFinishLose(snapshot, -0.5, FAIL_THRESHOLD)).toBe(true);
  });

  it('не лучший ход, но WDL выше порога → НЕ потеря', () => {
    const snapshot = { bestUci: 'h5f7', playedUci: 'd1d8' };
    expect(shouldFinishLose(snapshot, 0.3, FAIL_THRESHOLD)).toBe(false);
  });

  it('snapshot=null (pre-analyze упал) → фолбэк на абсолютный порог', () => {
    expect(shouldFinishLose(null, -0.5, FAIL_THRESHOLD)).toBe(true);
    expect(shouldFinishLose(null, 0.5, FAIL_THRESHOLD)).toBe(false);
  });

  it('кастомный failThreshold уважается фолбэком', () => {
    expect(shouldFinishLose(null, -0.4, -0.5)).toBe(false);
    expect(shouldFinishLose(null, -0.6, -0.5)).toBe(true);
  });
});

/**
 * KS-2968: тесты на helper `isWinDropExcessive` — критерий потери
 * преимущества по дельте win% baseline → final. Жалоба с прода
 * (скриншот пользователя): start 92/8/0 → final 50/50/0, UI ставил
 * «преимущество удержано», хотя win% упал на 42 п.п. — это явная
 * потеря преимущества.
 *
 * Порог: PRESERVED_WIN_DROP_THRESHOLD_PERMILLE = 150 промилле = 15 п.п.
 */
describe('isWinDropExcessive (KS-2968)', () => {
  it('live-кейс жалобы (start 92/8/0 → final 50/50/0): drop=42 п.п. → потеря', () => {
    // Скриншот пользователя на проде. signed-WDL финала ≈ 0.5
    // (winThreshold), формально в плюсе → раньше плашка была
    // «удержано». С drop-критерием — становится «потеряно».
    const start = { w: 920, d: 80, l: 0 };
    const final = { w: 500, d: 500, l: 0 };
    expect(isWinDropExcessive(start, final)).toBe(true);
  });

  it('обратный кейс (start 92/8/0 → final 90/10/0): drop=2 п.п. → удержано', () => {
    // Лёгкая просадка в пределах SF-noise — это удержание.
    const start = { w: 920, d: 80, l: 0 };
    const final = { w: 900, d: 100, l: 0 };
    expect(isWinDropExcessive(start, final)).toBe(false);
  });

  it('классическая потеря (start 50/50/0 → final 0/0/100): drop=50 п.п. → потеря', () => {
    // Знак сменился, всё уехало в проигрыш. Очевидно потеря.
    const start = { w: 500, d: 500, l: 0 };
    const final = { w: 0, d: 0, l: 1000 };
    expect(isWinDropExcessive(start, final)).toBe(true);
  });

  it('drop ровно на пороге (150 ‰): НЕ потеря (нестрогое <=)', () => {
    const start = { w: 600, d: 400, l: 0 };
    const final = { w: 450, d: 550, l: 0 };
    expect(final.w).toBe(start.w - PRESERVED_WIN_DROP_THRESHOLD_PERMILLE);
    expect(isWinDropExcessive(start, final)).toBe(false);
  });

  it('drop на 1 ‰ больше порога → потеря', () => {
    const start = { w: 600, d: 400, l: 0 };
    const final = { w: 449, d: 551, l: 0 };
    expect(isWinDropExcessive(start, final)).toBe(true);
  });

  it('start=null (baseline нет) → false, не активируем фикс', () => {
    expect(isWinDropExcessive(null, { w: 100, d: 0, l: 900 })).toBe(false);
    expect(isWinDropExcessive(undefined, { w: 100, d: 0, l: 900 })).toBe(false);
  });

  it('final=null (final wdl не пришёл) → false', () => {
    expect(isWinDropExcessive({ w: 920, d: 80, l: 0 }, null)).toBe(false);
    expect(isWinDropExcessive({ w: 920, d: 80, l: 0 }, undefined)).toBe(false);
  });

  it('кастомный порог уважается', () => {
    // Порог 50 ‰ = 5 п.п. — более строгий.
    const start = { w: 920, d: 80, l: 0 };
    const final = { w: 900, d: 100, l: 0 };
    expect(isWinDropExcessive(start, final, 50)).toBe(false); // drop=20, ровно > 50? нет, 20 <= 50.
    expect(isWinDropExcessive(start, final, 10)).toBe(true); // drop=20 > 10.
  });

  it('win вырос (улучшение позиции): не потеря', () => {
    const start = { w: 400, d: 500, l: 100 };
    const final = { w: 900, d: 100, l: 0 };
    expect(isWinDropExcessive(start, final)).toBe(false);
  });
});
