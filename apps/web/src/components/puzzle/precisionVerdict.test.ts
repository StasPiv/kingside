import { describe, it, expect } from 'vitest';
import { shouldFinishLose } from './precisionVerdict';

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
