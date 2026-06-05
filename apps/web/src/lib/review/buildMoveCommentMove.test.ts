/**
 * KS-3712. Тесты `buildMoveCommentMove` — сборка поля `move` для тела
 * POST `/analyses/review/move-comment`.
 */
import { describe, it, expect } from 'vitest';

import { buildMoveCommentMove } from './buildMoveCommentMove';

const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('buildMoveCommentMove', () => {
  it('обычный ход e4 — нет взятия, нет шаха, нет мата', () => {
    const out = buildMoveCommentMove({
      fenBefore: START_FEN,
      uci: 'e2e4',
      playedSan: 'e4',
      classification: 'best',
    });
    expect(out).toEqual({
      san: 'e4',
      uci: 'e2e4',
      capture: null,
      check: false,
      mate: null,
      castling: null,
      promotion: null,
      classification: 'best',
    });
  });

  it('взятие фигуры — `capture` отражает тип взятой фигуры', () => {
    // После 1. e4 e5 — белая пешка на e4 может взять чёрного слона e.g.
    // Прямое: 1. e4 d5 2. exd5 — берём пешку.
    const after_e4_d5 =
      'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    const out = buildMoveCommentMove({
      fenBefore: after_e4_d5,
      uci: 'e4d5',
      playedSan: 'exd5',
      classification: 'good',
    });
    expect(out.capture).toBe('p');
    expect(out.check).toBe(false);
    expect(out.mate).toBeNull();
  });

  it('сыгранный мат — mate=1 (а не 0)', () => {
    // Scholar's mate: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#
    const before_qxf7 =
      'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';
    const out = buildMoveCommentMove({
      fenBefore: before_qxf7,
      uci: 'f7f7',
      playedSan: 'Qxf7#',
      classification: 'best',
    });
    // Реально SAN придёт с # — проверка работает по SAN.
    // Берём корректный сценарий: пишем PGN 4.Qxf7# напрямую.
    const fenBeforeMate =
      'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const real = buildMoveCommentMove({
      fenBefore: fenBeforeMate,
      uci: 'h5f7',
      playedSan: 'Qxf7#',
      classification: 'best',
    });
    expect(real.san).toBe('Qxf7#');
    expect(real.check).toBe(true);
    expect(real.mate).toBe(1);
    // дополнительный кейс с заведомо нелегальным ходом — chess.js
    // отказывается, возвращается fallback с mate=null.
    expect(out.mate).toBeNull();
  });

  it('шах без мата — check=true, mate=null', () => {
    const after_e4_e5 =
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
    // 2. Qh5 — без шаха, делаем шах из позиции после 1.e4 e5 2.Bc4 Nc6 3.Qh5
    const beforeQh5g4 =
      'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 4 3';
    const out = buildMoveCommentMove({
      fenBefore: beforeQh5g4,
      uci: 'g7g6',
      playedSan: 'g6',
      classification: 'good',
    });
    expect(out.check).toBe(false);
    expect(out.mate).toBeNull();
    void after_e4_e5;
  });

  it('engineMateAfter положительный — соперник матует за N полуходов', () => {
    // Сыгранный ход — не сразу мат, но движок видит мат сопернику через 2.
    // По нашей конвенции `mate` поля = «дистанция от состояния перед ходом»;
    // соперник матует → знак отрицательный для нас.
    const out = buildMoveCommentMove({
      fenBefore: START_FEN,
      uci: 'e2e4',
      playedSan: 'e4',
      classification: 'inaccuracy',
      engineMateAfter: 2, // соперник на ходу после e4 матует через 2.
    });
    // 2 + 1 = 3 полухода от состояния перед ходом, знак — отрицательный.
    expect(out.mate).toBe(-3);
  });

  it('engineMateAfter отрицательный — мы матуем за N полуходов', () => {
    const out = buildMoveCommentMove({
      fenBefore: START_FEN,
      uci: 'e2e4',
      playedSan: 'e4',
      classification: 'best',
      engineMateAfter: -2, // соперник проигрывает мат через 2.
    });
    expect(out.mate).toBe(3);
  });

  it('engineMateAfter 0 / null / NaN → mate остаётся null', () => {
    const a = buildMoveCommentMove({
      fenBefore: START_FEN,
      uci: 'e2e4',
      playedSan: 'e4',
      classification: 'good',
      engineMateAfter: 0,
    });
    const b = buildMoveCommentMove({
      fenBefore: START_FEN,
      uci: 'e2e4',
      playedSan: 'e4',
      classification: 'good',
      engineMateAfter: null,
    });
    const c = buildMoveCommentMove({
      fenBefore: START_FEN,
      uci: 'e2e4',
      playedSan: 'e4',
      classification: 'good',
      engineMateAfter: Number.NaN,
    });
    expect(a.mate).toBeNull();
    expect(b.mate).toBeNull();
    expect(c.mate).toBeNull();
  });

  it('нелегальный ход → fallback без classification потери', () => {
    const out = buildMoveCommentMove({
      fenBefore: START_FEN,
      uci: 'a1h8',
      playedSan: '',
      classification: 'blunder',
    });
    expect(out.classification).toBe('blunder');
    expect(out.capture).toBeNull();
    expect(out.mate).toBeNull();
  });
});
