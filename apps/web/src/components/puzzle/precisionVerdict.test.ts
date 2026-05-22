import { describe, it, expect } from 'vitest';
import {
  shouldFinishLose,
  isWinDropExcessive,
  meetsFinalObjective,
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

  /**
   * KS-3248: saveEquality-пазл (Telegram /tmp/telegram/326129994_0.jpg)
   * завершался после 1 хода (26... Nxe4) как `lose-wdl`. В saveEquality
   * стартовый baseline уже близок к нулю / отрицательный — любой
   * промежуточный полуход спокойно попадал под `effWdl < failThreshold`
   * и пазл закрывался, не дав сыграть серию из 3+ ходов.
   *
   * Фикс: при `objective='saveEquality'` shouldFinishLose ВСЕГДА
   * возвращает false. Финал решает `meetsFinalObjective` на последнем
   * полуходе.
   */
  describe('saveEquality (KS-3248)', () => {
    it('saveEquality + effWdl < failThreshold → НЕ потеря (главный кейс KS-3248)', () => {
      // Тот самый кейс с прода: лучший ход в проигрышной позиции,
      // signed просел до -0.5, в convertAdvantage это finishLose.
      const snapshot = { bestUci: 'a2b4', playedUci: 'a2b4' };
      expect(
        shouldFinishLose(snapshot, -0.5, FAIL_THRESHOLD, 'saveEquality'),
      ).toBe(false);
    });

    it('saveEquality + plyed != best + просел в минус → ВСЁ РАВНО НЕ потеря (серия должна доиграться)', () => {
      // Промежуточный плохой ход в saveEquality — финал решит
      // meetsFinalObjective. shouldFinishLose не выкидывает.
      const snapshot = { bestUci: 'a2b4', playedUci: 'e2e4' };
      expect(
        shouldFinishLose(snapshot, -0.9, FAIL_THRESHOLD, 'saveEquality'),
      ).toBe(false);
    });

    it('saveEquality + snapshot=null + signed=-0.9 → НЕ потеря', () => {
      expect(
        shouldFinishLose(null, -0.9, FAIL_THRESHOLD, 'saveEquality'),
      ).toBe(false);
    });

    it('convertAdvantage сохраняет старое поведение (regression-guard)', () => {
      const snapshot = { bestUci: 'a2b4', playedUci: 'e2e4' };
      expect(
        shouldFinishLose(snapshot, -0.5, FAIL_THRESHOLD, 'convertAdvantage'),
      ).toBe(true);
    });

    it('objective=null (legacy) ведёт себя как convertAdvantage', () => {
      const snapshot = { bestUci: 'a2b4', playedUci: 'e2e4' };
      expect(shouldFinishLose(snapshot, -0.5, FAIL_THRESHOLD, null)).toBe(true);
      expect(shouldFinishLose(snapshot, -0.5, FAIL_THRESHOLD)).toBe(true);
    });
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

/**
 * KS-3169: финальный успех решателя зависит от жанра пазла.
 *
 * Жалоба пользователя (Telegram, 2026-05-21): saveEquality-пазл, точность
 * 100%, блок «Ничья удержана идеально», но звук «неправильно». Корень —
 * `effWdl >= winThreshold` для ничейного финала (signed≈0 < 0.5) выпадал
 * в `lose-wdl`, отсюда звук `puzzle-incorrect`. `meetsFinalObjective`
 * выправляет вердикт по objective; звук/state/reasonLabel выравниваются
 * автоматически.
 */
describe('meetsFinalObjective (KS-3169)', () => {
  const WIN_THR = 0.5;

  it('saveEquality + (w=0, d=1000, l=0) → успех (главный кейс жалобы)', () => {
    // Идеальная ничья: (w+d)/1000 = 1.0 ≥ 0.5.
    const wdl = { w: 0, d: 1000, l: 0 };
    expect(meetsFinalObjective(wdl, 0, 'saveEquality', WIN_THR)).toBe(true);
  });

  it('saveEquality + (w=10, d=970, l=20) → успех (мизерный риск проигрыша)', () => {
    // (10 + 970)/1000 = 0.98 ≥ 0.5.
    const wdl = { w: 10, d: 970, l: 20 };
    expect(meetsFinalObjective(wdl, 0, 'saveEquality', WIN_THR)).toBe(true);
  });

  it('saveEquality + (w=0, d=300, l=700) → провал (солвер скатился в проигрыш)', () => {
    // (0 + 300)/1000 = 0.3 < 0.5 → не удержал.
    const wdl = { w: 0, d: 300, l: 700 };
    expect(meetsFinalObjective(wdl, -0.7, 'saveEquality', WIN_THR)).toBe(false);
  });

  it('saveEquality без wdlObj: signed≈0 → fallback на signed ≥ -winThreshold → успех', () => {
    expect(meetsFinalObjective(null, 0, 'saveEquality', WIN_THR)).toBe(true);
    expect(meetsFinalObjective(null, -0.49, 'saveEquality', WIN_THR)).toBe(true);
  });

  it('saveEquality без wdlObj: signed < -winThreshold → провал', () => {
    expect(meetsFinalObjective(null, -0.6, 'saveEquality', WIN_THR)).toBe(false);
  });

  it('convertAdvantage + signed≥winThreshold → успех (без регрессии)', () => {
    const wdl = { w: 800, d: 150, l: 50 };
    expect(meetsFinalObjective(wdl, 0.75, 'convertAdvantage', WIN_THR)).toBe(true);
  });

  it('convertAdvantage + ничья signed≈0 → провал (старое поведение)', () => {
    // Конкретно тот кейс, который ломал saveEquality, для
    // convertAdvantage ДОЛЖЕН оставаться провалом — солвер не реализовал
    // преимущество.
    const wdl = { w: 0, d: 1000, l: 0 };
    expect(meetsFinalObjective(wdl, 0, 'convertAdvantage', WIN_THR)).toBe(false);
  });

  it('objective=null (legacy-пазлы без жанра) → ведёт себя как convertAdvantage', () => {
    expect(meetsFinalObjective(null, 0, null, WIN_THR)).toBe(false);
    expect(meetsFinalObjective(null, 0.6, null, WIN_THR)).toBe(true);
  });

  it('objective=undefined → ведёт себя как convertAdvantage', () => {
    expect(meetsFinalObjective(null, 0, undefined, WIN_THR)).toBe(false);
    expect(meetsFinalObjective(null, 0.6, undefined, WIN_THR)).toBe(true);
  });

  it('saveEquality на границе: (w+d)/1000 = winThreshold → успех (нестрогое ≥)', () => {
    const wdl = { w: 100, d: 400, l: 500 };
    // (100+400)/1000 = 0.5 == winThreshold.
    expect(meetsFinalObjective(wdl, -0.4, 'saveEquality', WIN_THR)).toBe(true);
  });

  it('saveEquality на грани снизу: (w+d)/1000 = 0.499 → провал', () => {
    const wdl = { w: 99, d: 400, l: 501 };
    // (99+400)/1000 = 0.499 < 0.5.
    expect(meetsFinalObjective(wdl, -0.402, 'saveEquality', WIN_THR)).toBe(false);
  });
});
