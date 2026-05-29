/**
 * KS-3407 / ADR-086 §9 (S2) — unit-тесты compareGuessMove.
 * Покрытие: вердикты strongest/betterThanPlayer/asPlayer/weaker,
 * POV-инверсия (white/black выбранная сторона), promotion, same-move.
 */
import { describe, it, expect } from 'vitest';
import {
  compareGuessMove,
  decideVerdict,
  GUESS_VERDICT_EPSILON,
  type GuessMoveEvals,
} from './guess-move.js';

// Хелпер: raw WDL POV side-to-move.
const wdl = (w: number, d: number, l: number) => ({ w, d, l });

describe('decideVerdict (ADR-086 §3.5, KS-3426 переупорядочено)', () => {
  // KS-3426: asPlayer ПРИОРИТЕТ — если оба сыграли близко, неважно
  // идеально ли. strongest требует юзер идеален И реальный заметно хуже.

  it('KS-3426: оба идеальны (lossUser=0, lossPlayer=0.001) → asPlayer, НЕ strongest', () => {
    // Главный баг: дебютные топ-ходы. |0 − 0.001| = 0.001 ≤ 0.02 → asPlayer.
    expect(decideVerdict(0, 0.001)).toBe('asPlayer');
  });

  it('KS-3426: оба строго ноль → asPlayer', () => {
    expect(decideVerdict(0, 0)).toBe('asPlayer');
  });

  it('strongest: юзер идеален И реальный заметно хуже', () => {
    // |0 − 0.10| = 0.10 > 0.02 → не asPlayer; lossUser(0)≤0.02 И
    // lossPlayer(0.10) − lossUser(0) = 0.10 > 0.02 → strongest.
    expect(decideVerdict(0, 0.10)).toBe('strongest');
    // Граница: lossUser=0.02 (на пороге), lossPlayer=0.30 → strongest.
    expect(decideVerdict(0.02, 0.30)).toBe('strongest');
  });

  it('strongest НЕ срабатывает если разница ≤ ε (хоть юзер и идеален)', () => {
    // lossUser=0, lossPlayer=0.02 → |0−0.02|=0.02 ≤ 0.02 → asPlayer.
    expect(decideVerdict(0, 0.02)).toBe('asPlayer');
    // lossUser=0, lossPlayer=0.025 → |0.025|>0.02 → не asPlayer;
    // 0.025-0=0.025 > 0.02 → strongest (минимально-возможный strongest).
    expect(decideVerdict(0, 0.025)).toBe('strongest');
  });

  it('betterThanPlayer: юзер не строго идеален, но заметно лучше реального', () => {
    // lossUser=0.05 > ε → не strongest. |0.05−0.30|=0.25>0.02 → не asPlayer.
    // 0.05 < 0.30−0.02 = 0.28 → betterThanPlayer.
    expect(decideVerdict(0.05, 0.30)).toBe('betterThanPlayer');
  });

  it('asPlayer: разница в пределах ε (включая большие loss)', () => {
    expect(decideVerdict(0.10, 0.10)).toBe('asPlayer');
    expect(decideVerdict(0.10, 0.11)).toBe('asPlayer');
    expect(decideVerdict(0.11, 0.10)).toBe('asPlayer');
  });

  it('weaker: юзер хуже реального', () => {
    expect(decideVerdict(0.30, 0.05)).toBe('weaker');
  });
});

describe('compareGuessMove — выбранная сторона WHITE', () => {
  // fenBefore: ход белых. raw POV white. После хода — POV black.
  // eBefore высокий (белые выигрывают), после хода смотрим.
  const bestUci = 'd1h5';

  it('пользователь нашёл сильнейший (lossUser≈0, реальный заметно хуже) → strongest', () => {
    const evals: GuessMoveEvals = {
      wdlBefore: wdl(900, 80, 20), // POV white: E≈0.94
      // реальный заметно хуже: POV black (600,200,200) → POV white invert
      // (200,200,600) E=0.30; lossPlayer=0.64.
      wdlAfterPlayed: wdl(600, 200, 200),
      // юзер ≥ best: POV black (30,40,930) → POV white invert (930,40,30)
      // E=(930+20)/1000=0.95; lossUser=max(0,0.94−0.95)=0.
      wdlAfterUser: wdl(30, 40, 930),
      bestUci,
    };
    const r = compareGuessMove('e2e4', bestUci, evals);
    expect(r.eBefore).toBeCloseTo(0.94, 2);
    expect(r.eAfterUser).toBeCloseTo(0.95, 2);
    expect(r.lossUser).toBeLessThanOrEqual(0.02);
    // KS-3426: strongest требует lossUser≤ε И (lossPlayer−lossUser)>ε.
    expect(r.verdict).toBe('strongest');
    // best-override classifyMove (userUci===bestUci) → userClass='best'.
    expect(r.userClass).toBe('best');
  });

  it('пользователь сыграл сильнее реального игрока → betterThanPlayer', () => {
    const evals: GuessMoveEvals = {
      wdlBefore: wdl(900, 80, 20), // E≈0.94
      // реальный: POV black после = (600,200,200) → POV white E=invert→(200,200,600) E=0.30; loss=0.64
      wdlAfterPlayed: wdl(600, 200, 200),
      // юзер: POV black после = (300,100,600) → POV white (600,100,300) E=0.65; loss=0.29
      wdlAfterUser: wdl(300, 100, 600),
      bestUci,
    };
    const r = compareGuessMove('e2e4', 'g1f3', evals);
    expect(r.lossPlayer).toBeGreaterThan(r.lossUser);
    expect(r.verdict).toBe('betterThanPlayer');
  });

  it('пользователь сыграл как игрок (userUci===playedUci, wdlAfterUser опущен) → asPlayer', () => {
    const evals: GuessMoveEvals = {
      wdlBefore: wdl(500, 300, 200),
      wdlAfterPlayed: wdl(400, 300, 300),
      // wdlAfterUser не передан — same move
      bestUci,
    };
    const r = compareGuessMove('e2e4', 'e2e4', evals);
    expect(r.lossUser).toBeCloseTo(r.lossPlayer, 5);
    expect(r.eAfterUser).toBeCloseTo(r.eAfterPlayed, 5);
    // KS-3426: при равных loss всегда asPlayer (в т.ч. когда оба=0).
    expect(r.verdict).toBe('asPlayer');
  });

  it('пользователь сыграл слабее → weaker', () => {
    const evals: GuessMoveEvals = {
      wdlBefore: wdl(900, 80, 20), // E≈0.94
      // реальный почти удержал: POV black после (100,100,800) → POV white E=0.85; loss=0.09
      wdlAfterPlayed: wdl(100, 100, 800),
      // юзер обвалил: POV black после (700,200,100) → POV white (100,200,700) E=0.20; loss=0.74
      wdlAfterUser: wdl(700, 200, 100),
      bestUci,
    };
    const r = compareGuessMove('e2e4', 'a2a3', evals);
    expect(r.lossUser).toBeGreaterThan(r.lossPlayer);
    expect(r.verdict).toBe('weaker');
    expect(r.userClass).toBe('blunder');
  });
});

describe('compareGuessMove — выбранная сторона BLACK (POV-инверсия)', () => {
  // fenBefore: ход чёрных. raw POV black = выбранная сторона.
  // После хода raw POV white (соперник) → инверсия к POV black.
  const bestUci = 'd8h4';

  it('POV black: eBefore берётся прямо (raw POV = выбранная), eAfter инвертируется', () => {
    const evals: GuessMoveEvals = {
      // чёрные выигрывают: raw POV black E≈0.90
      wdlBefore: wdl(850, 100, 50),
      // реальный ход чёрных слабый: после — ход белых, raw POV white (800,150,50)
      // → POV black invert (50,150,800) E=(50+75)/1000=0.125; loss=0.775
      wdlAfterPlayed: wdl(800, 150, 50),
      // юзер сильнее: POV white после (100,100,800) → POV black (800,100,100) E=0.85; loss=0.05
      wdlAfterUser: wdl(100, 100, 800),
      bestUci,
    };
    const r = compareGuessMove('e7e5', 'g8f6', evals);
    expect(r.eBefore).toBeCloseTo(0.90, 2);
    expect(r.eAfterPlayed).toBeCloseTo(0.125, 2);
    expect(r.eAfterUser).toBeCloseTo(0.85, 2);
    expect(r.lossPlayer).toBeGreaterThan(r.lossUser);
    expect(r.verdict).toBe('betterThanPlayer');
  });
});

describe('compareGuessMove — promotion', () => {
  it('promotion UCI (e7e8q) корректно сравнивается, best-override по совпадению', () => {
    const evals: GuessMoveEvals = {
      wdlBefore: wdl(700, 200, 100),
      wdlAfterPlayed: wdl(300, 300, 400), // реальный (не промоция) слабее
      wdlAfterUser: wdl(50, 100, 850), // промоция сильнее: POV after invert → E высок
      bestUci: 'e7e8q',
    };
    const r = compareGuessMove('e7e8n', 'e7e8q', evals);
    // userUci === bestUci (e7e8q) → best-override
    expect(r.userClass).toBe('best');
    // loss юзера мал → лучше игрока
    expect(['strongest', 'betterThanPlayer']).toContain(r.verdict);
  });
});
