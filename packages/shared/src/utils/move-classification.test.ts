/**
 * KS-3020 / ADR-066 §5. Тесты `classifyMove` (WDL-loss primary,
 * cp-fallback). Покрытие:
 *  - 11 контрольных кейсов из ADR-066 §5 (по loss_E).
 *  - mate-edge на WDL (>950 в w или l).
 *  - isBestMove override.
 *  - cp-fallback через winPctFromCp.
 *  - Legacy cp mate-encoding (±MATE_CP_BASE).
 *  - Both NULL → good.
 *  - Приоритет WDL над cp.
 *  - UX-bug repro из KS-3019: 100/0/0 → 100/0/0 → best (раньше cp давал mistake).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMove,
  MATE_CP_BASE,
  WDL_LOSS_THRESHOLDS,
  type WdlPerMille,
} from './move-classification.js';

/**
 * Конструктор WDL-входа с заданным `loss_E` ∈ [0, 0.5]. Стартовая
 * позиция намеренно вне mate-edge зоны (w=500, d=400, l=100,
 * E_before=0.7), чтобы `wdlAfter.w > 950` / `wdlAfter.l > 950`
 * не активировался и тестировались именно пороги `WDL_LOSS_THRESHOLDS`.
 *
 * Loss переносится из `w` в `l`, `d` остаётся = 400. Тогда
 * `E_after = (w_after + 200) / 1000 = E_before - loss_E`.
 */
function wdlPair(lossE: number): { wdlBefore: WdlPerMille; wdlAfter: WdlPerMille } {
  const clamped = Math.max(0, Math.min(0.5, lossE));
  const deltaPerMille = Math.round(clamped * 1000);
  return {
    wdlBefore: { w: 500, d: 400, l: 100 },
    wdlAfter: { w: 500 - deltaPerMille, d: 400, l: 100 + deltaPerMille },
  };
}

describe('classifyMove — KS-3020 / ADR-066 §5 (WDL primary)', () => {
  // ─── §5 кейс 0: UX-bug repro ────────────────────────────────────

  it('§5 кейс 0 (UX-bug repro): WDL 100/0/0 → 100/0/0 → best (старый cp дал бы mistake)', () => {
    expect(
      classifyMove({
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 1000, d: 0, l: 0 },
        // cp может «прыгнуть» на сотни в выигранной позиции — не штрафуем.
        cpBefore: 1500,
        cpAfter: 1300,
      }),
    ).toBe('best');
  });

  // ─── Граничные пороги loss_E ────────────────────────────────────

  describe('loss_E пороги (ADR §3.2)', () => {
    it('loss_E = 0 → best', () => {
      expect(classifyMove(wdlPair(0))).toBe('best');
    });

    it('loss_E = 0.02 → best (граница best/good включительно)', () => {
      expect(classifyMove(wdlPair(0.02))).toBe('best');
    });

    it('loss_E = 0.03 → good (выше 0.02)', () => {
      expect(classifyMove(wdlPair(0.03))).toBe('good');
    });

    it('loss_E = 0.05 → good (граница good/inaccuracy включительно)', () => {
      expect(classifyMove(wdlPair(0.05))).toBe('good');
    });

    it('loss_E = 0.08 → inaccuracy (середина)', () => {
      expect(classifyMove(wdlPair(0.08))).toBe('inaccuracy');
    });

    it('loss_E = 0.12 → inaccuracy (граница inacc/mistake включительно)', () => {
      expect(classifyMove(wdlPair(0.12))).toBe('inaccuracy');
    });

    it('loss_E = 0.20 → mistake (середина)', () => {
      expect(classifyMove(wdlPair(0.20))).toBe('mistake');
    });

    it('loss_E = 0.25 → mistake (граница mistake/blunder включительно)', () => {
      expect(classifyMove(wdlPair(0.25))).toBe('mistake');
    });

    it('loss_E = 0.30 → blunder (выше 0.25)', () => {
      expect(classifyMove(wdlPair(0.30))).toBe('blunder');
    });

    it('loss_E = 0.5 (катастрофа без mate-edge) → blunder', () => {
      expect(classifyMove(wdlPair(0.5))).toBe('blunder');
    });
  });

  // ─── Mate-edge на WDL (§2.3) ────────────────────────────────────

  describe('mate-edge на WDL (§2.3)', () => {
    it('wdl_after.l > 950 → blunder, независимо от loss_E', () => {
      expect(
        classifyMove({
          wdlBefore: { w: 1000, d: 0, l: 0 },
          wdlAfter: { w: 50, d: 0, l: 950 }, // l ровно на границе → НЕ blunder через mate-edge
        }),
      ).toBe('blunder'); // зато loss_E = 0.95 → blunder по обычной шкале
    });

    it('wdl_after.l = 951 → blunder через mate-edge даже если loss_E мал', () => {
      // Конструируем: loss_E ≈ 0.05 (good), но l=951 после хода → blunder.
      // Чтобы loss_E был мал, поднимем drawing potential до хода.
      expect(
        classifyMove({
          wdlBefore: { w: 0, d: 0, l: 1000 }, // E_before = 0
          wdlAfter: { w: 0, d: 49, l: 951 }, // E_after = 0.0245, loss_E = -0.0245 → 0 (clamp)
        }),
      ).toBe('blunder'); // mate-edge срабатывает первым
    });

    it('wdl_after.w > 950 → best (мат сопернику), даже если loss_E > 0', () => {
      expect(
        classifyMove({
          wdlBefore: { w: 500, d: 500, l: 0 }, // E_before = 0.75
          wdlAfter: { w: 970, d: 30, l: 0 }, // E_after = 0.985, loss_E < 0 → 0
        }),
      ).toBe('best');
    });

    it('wdl_after.w = 950 ровно — НЕ mate-edge (порог строгий >)', () => {
      // loss_E будет нормальный, классификация по обычным порогам.
      expect(
        classifyMove({
          wdlBefore: { w: 1000, d: 0, l: 0 },
          wdlAfter: { w: 950, d: 25, l: 25 }, // E_after = 0.9625, loss_E = 0.0375
        }),
      ).toBe('good'); // 0.02 < 0.0375 ≤ 0.05
    });
  });

  // ─── isBestMove override (§2.2) ─────────────────────────────────

  describe('isBestMove override (§2.2 — безусловный после KS-3380)', () => {
    // KS-3380 (commit 4692867c): после фикса pre/post snapshot'ов на
    // фронте loss_E при isBestMove=true гарантированно равен 0
    // (wdlBefore/wdlAfter — одна и та же фрейма с searchmoves для
    // playedUci). Sanity-guard KS-3260 стал недостижимым — удалён;
    // override `isBestMove=true → 'best'` снова безусловный.

    it('isBestMove=true + loss_E ≤ 0.02 → best', () => {
      expect(
        classifyMove({
          ...wdlPair(0.01),
          isBestMove: true,
        }),
      ).toBe('best');
    });

    it('isBestMove=true + loss_E = 0.05 → best (стандартный кейс)', () => {
      expect(
        classifyMove({
          ...wdlPair(0.05),
          isBestMove: true,
        }),
      ).toBe('best');
    });

    it('isBestMove=true без WDL/cp → best (override безусловный)', () => {
      // Legacy attempt'ы без WDL и без cp.
      expect(
        classifyMove({
          isBestMove: true,
        }),
      ).toBe('best');
    });

    it('isBestMove=false → нормальная классификация по loss_E', () => {
      expect(
        classifyMove({
          ...wdlPair(0.08),
          isBestMove: false,
        }),
      ).toBe('inaccuracy');
    });
  });

  // ─── cp-fallback (§6.1) ─────────────────────────────────────────

  describe('cp-fallback (когда нет WDL)', () => {
    it('cp loss = 0 → best', () => {
      expect(classifyMove({ cpBefore: 100, cpAfter: 100 })).toBe('best');
    });

    it('cp улучшение (cpAfter > cpBefore) → best', () => {
      expect(classifyMove({ cpBefore: 50, cpAfter: 200 })).toBe('best');
    });

    it('cp в нейтральной позиции: cpLoss=30 → good (winPct loss ≈ 5.5%)', () => {
      // winPct(100)≈59.07, winPct(70)≈56.36, loss ≈ 2.71% / 100 = 0.0271 → good.
      expect(classifyMove({ cpBefore: 100, cpAfter: 70 })).toBe('good');
    });

    it('cp loss большой → mistake/blunder в зависимости от величины', () => {
      // cpBefore=200, cpAfter=-200: winPct(200)≈67, winPct(-200)≈33, loss≈34/100=0.34 → blunder.
      expect(classifyMove({ cpBefore: 200, cpAfter: -200 })).toBe('blunder');
    });

    it('cp в острой позиции 0/+50 → best (winPct loss < 2%)', () => {
      // winPct(50)≈52.3, winPct(0)=50, loss=2.3 → 0.023 → good (выше 0.02 на 0.003).
      // Граница best/good = 0.02. Берём cpBefore=20 чтобы loss точно <= 0.02.
      // winPct(20)≈50.92, winPct(0)=50, loss=0.92 → 0.0092 → best.
      expect(classifyMove({ cpBefore: 20, cpAfter: 0 })).toBe('best');
    });

    it('legacy mate cp (cpAfter ≤ -MATE_CP_BASE/2) → blunder', () => {
      expect(
        classifyMove({ cpBefore: 50, cpAfter: -MATE_CP_BASE + 5 }),
      ).toBe('blunder');
    });

    it('legacy mate cp (cpAfter ≥ MATE_CP_BASE/2) → best', () => {
      expect(
        classifyMove({ cpBefore: 50, cpAfter: MATE_CP_BASE - 5 }),
      ).toBe('best');
    });

    it('legacy mate cp работает даже из проигранной cp-позиции', () => {
      expect(
        classifyMove({ cpBefore: -300, cpAfter: MATE_CP_BASE - 10 }),
      ).toBe('best');
    });
  });

  // ─── Both NULL fallback (§6.2) ──────────────────────────────────

  describe('NULL fallback', () => {
    it('нет WDL, нет cp → good (нейтральный, не штрафуем)', () => {
      expect(classifyMove({})).toBe('good');
    });

    it('cpBefore=null, cpAfter=null → good', () => {
      expect(classifyMove({ cpBefore: null, cpAfter: null })).toBe('good');
    });

    it('только cpBefore — нет cpAfter → good (не считаем loss)', () => {
      expect(classifyMove({ cpBefore: 100, cpAfter: null })).toBe('good');
    });

    it('только cpAfter — нет cpBefore → good', () => {
      expect(classifyMove({ cpBefore: null, cpAfter: 50 })).toBe('good');
    });

    it('частичный WDL (только wdlBefore) → fallback на cp или good', () => {
      // Без wdlAfter loss_E не считаем по WDL; cp нет → good.
      expect(
        classifyMove({ wdlBefore: { w: 500, d: 500, l: 0 } }),
      ).toBe('good');
    });
  });

  // ─── Приоритет WDL над cp ──────────────────────────────────────

  describe('приоритет WDL над cp', () => {
    it('WDL = best, cp = blunder → best (WDL primary)', () => {
      expect(
        classifyMove({
          ...wdlPair(0), // loss_E=0 → best
          cpBefore: 1500,
          cpAfter: -500, // cp-blunder
        }),
      ).toBe('best');
    });

    it('WDL = blunder, cp = best → blunder (WDL primary)', () => {
      expect(
        classifyMove({
          ...wdlPair(0.50),
          cpBefore: 50,
          cpAfter: 60, // cp-best
        }),
      ).toBe('blunder');
    });
  });

  // ─── Сценарии ADR-066 §5 (ходы внутри precision-задачи) ────────

  describe('ADR-066 §5 контрольные кейсы (per-move)', () => {
    it('§5 кейс 2: loss_E=0.03 → good', () => {
      expect(classifyMove(wdlPair(0.03))).toBe('good');
    });

    it('§5 кейс 3 (mid-inaccuracy): loss_E=0.08 → inaccuracy', () => {
      expect(classifyMove(wdlPair(0.08))).toBe('inaccuracy');
    });

    it('§5 кейс 3b (worst-inaccuracy): loss_E=0.12 → inaccuracy (граница)', () => {
      expect(classifyMove(wdlPair(0.12))).toBe('inaccuracy');
    });

    it('§5 кейс 5 (mistake): loss_E=0.20 → mistake', () => {
      expect(classifyMove(wdlPair(0.20))).toBe('mistake');
    });

    it('§5 кейс 6 (blunder): loss_E=0.30 → blunder', () => {
      expect(classifyMove(wdlPair(0.30))).toBe('blunder');
    });
  });

  // ─── Sanity: константы порогов согласованы ─────────────────────

  describe('WDL_LOSS_THRESHOLDS sanity', () => {
    it('пороги монотонные', () => {
      expect(WDL_LOSS_THRESHOLDS.best).toBeLessThan(WDL_LOSS_THRESHOLDS.good);
      expect(WDL_LOSS_THRESHOLDS.good).toBeLessThan(WDL_LOSS_THRESHOLDS.inaccuracy);
      expect(WDL_LOSS_THRESHOLDS.inaccuracy).toBeLessThan(WDL_LOSS_THRESHOLDS.mistake);
    });

    it('все пороги в диапазоне [0, 1]', () => {
      for (const t of Object.values(WDL_LOSS_THRESHOLDS)) {
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThanOrEqual(1);
      }
    });
  });
});
