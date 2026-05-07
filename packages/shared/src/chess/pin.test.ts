/**
 * Unit-тесты pin-helpers (KS-2455).
 *
 * Покрытие:
 *   - чистая абсолютная связка (anchor=king);
 *   - относительная связка (anchor=queen);
 *   - случай «нет связки» (за P пустота / за P enemy);
 *   - target вне линии связки vs все targets коллинеарны.
 *
 * NB: chess.js требует обоих королей в FEN — каждый тест добавляет
 * чёрного короля в дальний угол.
 */

import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
  findPinAnchor,
  pseudoTargets,
  existsTargetOffPinLine,
} from './pin.js';

describe('findPinAnchor', () => {
  it('абсолютная связка коня e4 ладьёй с белым королём за конём', () => {
    // Чёрная ладья e8 → белый конь e4 → белый король e1 (вертикаль).
    const fen = '4r2k/8/8/8/4N3/8/8/4K3 w - - 0 1';
    const chess = new Chess(fen);
    const anchor = findPinAnchor(chess, 'e4', 'w');
    expect(anchor).not.toBeNull();
    expect(anchor!.sliderSq).toBe('e8');
    expect(anchor!.anchorSq).toBe('e1');
    expect(anchor!.anchorType).toBe('k');
    expect(anchor!.dx).toBe(0);
    expect(anchor!.dy).toBe(1);
  });

  it('относительная связка слона ферзём (anchor=ферзь, ценнее слона)', () => {
    // Чёрная ладья a8 → белый слон a4 → белый ферзь a1 (вертикаль).
    const fen = 'r6k/8/8/8/B7/8/8/Q3K3 w - - 0 1';
    const chess = new Chess(fen);
    const anchor = findPinAnchor(chess, 'a4', 'w');
    expect(anchor).not.toBeNull();
    expect(anchor!.anchorSq).toBe('a1');
    expect(anchor!.anchorType).toBe('q');
  });

  it('нет связки: за фигурой пустота', () => {
    // Чёрная ладья e8 → белый конь e4 → ничего.
    const fen = '4r2k/8/8/8/4N3/8/8/7K w - - 0 1';
    const chess = new Chess(fen);
    expect(findPinAnchor(chess, 'e4', 'w')).toBeNull();
  });

  it('нет связки: первой за P встречается enemy-фигура', () => {
    // Чёрная ладья e8 → белый конь e4 → чёрный конь e2.
    const fen = '4r2k/8/8/8/4N3/8/4n3/4K3 w - - 0 1';
    const chess = new Chess(fen);
    expect(findPinAnchor(chess, 'e4', 'w')).toBeNull();
  });

  it('диагональная связка слоном на чёрном коне, anchor=king', () => {
    // Белый слон a1, чёрный конь d4, чёрный король h8 (диагональ a1-h8).
    const fen = '7k/8/8/8/3n4/8/8/B6K w - - 0 1';
    const chess = new Chess(fen);
    const anchor = findPinAnchor(chess, 'd4', 'b');
    expect(anchor).not.toBeNull();
    expect(anchor!.sliderSq).toBe('a1');
    expect(anchor!.anchorSq).toBe('h8');
    expect(anchor!.anchorType).toBe('k');
  });
});

describe('pseudoTargets', () => {
  it('конь на e4 в пустой позиции — 8 ходов', () => {
    const fen = '4k3/8/8/8/4N3/8/8/4K3 w - - 0 1';
    const chess = new Chess(fen);
    const targets = pseudoTargets(chess, 'e4', 'n', 'w');
    expect(targets.sort()).toEqual(
      ['c3', 'c5', 'd2', 'd6', 'f2', 'f6', 'g3', 'g5'].sort(),
    );
  });

  it('пешка e2 — 2 хода вперёд + 2 капчи', () => {
    // d3 и f3 — чёрные пешки для капч.
    const fen = '4k3/8/8/8/8/3p1p2/4P3/4K3 w - - 0 1';
    const chess = new Chess(fen);
    const targets = pseudoTargets(chess, 'e2', 'p', 'w');
    expect(targets.sort()).toEqual(['d3', 'e3', 'e4', 'f3'].sort());
  });

  it('ладья на a1 — лучами до края/фигуры', () => {
    // Ладья a1, своя пешка a3 → ладья видит a2, не доходит до a3.
    // По горизонтали — пусто до e1 (свой король).
    const fen = '4k3/8/8/8/8/P7/8/R3K3 w - - 0 1';
    const chess = new Chess(fen);
    const targets = pseudoTargets(chess, 'a1', 'r', 'w');
    expect(targets).toContain('a2');
    expect(targets).not.toContain('a3');
    expect(targets).toContain('b1');
    expect(targets).toContain('d1');
    expect(targets).not.toContain('e1'); // король свой
  });
});

describe('existsTargetOffPinLine', () => {
  it('конь связан абсолютно — у коня все ходы вне линии вертикали', () => {
    // Чёрная ладья e8 → белый конь e4 → белый король e1.
    const fen = '4r2k/8/8/8/4N3/8/8/4K3 w - - 0 1';
    const chess = new Chess(fen);
    const off = existsTargetOffPinLine(chess, 'e4', 'n', 'w', 'e8', 'e1');
    // У коня e4 ни один из 8 ходов не лежит на e-вертикали → off-line.
    expect(off).toBe(true);
  });

  it('ладья на e4 связана — единственные ходы по вертикали e (collinear)', () => {
    // Ладья e8 → ладья e4 → король e1. На 4-й горизонтали все клетки
    // соседние с e4 закрыты своими пешками (d4 и f4) → ладья по
    // горизонтали никуда не ходит. По вертикали — все ходы collinear
    // с линией связки.
    const fen = '4r2k/8/8/8/PPPPRPPP/8/8/4K3 w - - 0 1';
    const chess = new Chess(fen);
    const off = existsTargetOffPinLine(chess, 'e4', 'r', 'w', 'e8', 'e1');
    // pseudoTargets ладьи: e5,e6,e7,e8 (capture), e3,e2 — все по
    // вертикали e, collinear с (e8, e1). Off-line targets нет.
    expect(off).toBe(false);
  });
});
