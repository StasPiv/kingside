/**
 * KS-3610. Тесты `isCheckOrCapture` — детектор forcing-move'ов
 * для stabilized-line продления (ADR-101 §3.3).
 */
import { describe, it, expect } from 'vitest';

import { isCheckOrCapture } from './moveFlags';

const STARTPOS =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('isCheckOrCapture', () => {
  it('обычный ход (e2e4) → false', () => {
    expect(isCheckOrCapture(STARTPOS, 'e2e4')).toBe(false);
  });

  it('взятие (exd5) → true', () => {
    // После 1. e4 e5 2. d4 exd4 — 3-й ход `e5xd4` это capture.
    // Подберём более простой: после 1. e4 d5 — 2. exd5 (e4 берёт d5).
    const afterE4D5 =
      'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    expect(isCheckOrCapture(afterE4D5, 'e4d5')).toBe(true);
  });

  it('простой шах ладьёй (e1-e7+) → true', () => {
    // Король чёрных на e8, ладья белых на e1, между ними пусто —
    // ход e1e7 даёт шах (та же линия по вертикали).
    const fen = '4k3/8/8/8/8/8/8/4R2K w - - 0 1';
    expect(isCheckOrCapture(fen, 'e1e7')).toBe(true);
  });

  it('шах с взятием (ладья ест пешку и встаёт в линию с королём) → true', () => {
    // Король чёрных e8, чёрная пешка e6, ладья белых e4. Ход e4xe6
    // — capture + check.
    const fen = '4k3/8/4p3/8/4R3/8/8/7K w - - 0 1';
    expect(isCheckOrCapture(fen, 'e4e6')).toBe(true);
  });

  it('en-passant capture → true', () => {
    // 1. e4 a6 2. e5 d5 — позиция перед взятием на проходе exd6.
    const beforeEp =
      'rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
    expect(isCheckOrCapture(beforeEp, 'e5d6')).toBe(true);
  });

  it('некорректный UCI → false (defensive)', () => {
    expect(isCheckOrCapture(STARTPOS, '')).toBe(false);
    expect(isCheckOrCapture(STARTPOS, 'xx')).toBe(false);
    expect(isCheckOrCapture(STARTPOS, 'z9z9')).toBe(false);
  });

  it('некорректный FEN → false', () => {
    expect(isCheckOrCapture('garbage', 'e2e4')).toBe(false);
  });

  it('превращение без шаха/взятия → false', () => {
    // Позиция: белая пешка на e7, ход e7-e8=Q без взятия и без шаха.
    const promoFen = '8/4P3/8/8/8/8/8/4K2k w - - 0 1';
    expect(isCheckOrCapture(promoFen, 'e7e8q')).toBe(false);
  });
});
