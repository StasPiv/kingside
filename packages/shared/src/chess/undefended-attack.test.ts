/**
 * Unit-тесты `computeNewThreatsAfterMove` (KS-2455).
 */

import { describe, it, expect } from 'vitest';
import { computeNewThreatsAfterMove } from './undefended-attack.js';

describe('computeNewThreatsAfterMove', () => {
  it('новая угроза: ладья переходит на a-вертикаль и атакует висящую пешку', () => {
    // Белая ладья на h1 (атакует h-линию и 1-горизонталь), чёрная
    // пешка a7 без защитников. Ход Rh1-a1 → ладья теперь видит a7
    // через пустую a-линию. До хода a7 не была под боем (нет
    // attacker'ов нашего цвета).
    const fen = '7k/p7/8/8/8/8/8/K6R w - - 0 1';
    const r = computeNewThreatsAfterMove(fen, { from: 'h1', to: 'h7' });
    // Ход Rh1-h7: ладья теперь на 7-горизонтали и атакует пешку a7
    // (горизонталь свободна).
    expect(r.newThreats).toContain('a7');
  });

  it('фигура уже была под боем без защиты — не считается новой угрозой', () => {
    // Белая ладья a1 уже атакует чёрного пешку a7 (без блока). Ход
    // Kh1-h2 (никак не меняет угрозу) → newThreats пуст.
    const fen = '7k/p7/8/8/8/8/8/R6K w - - 0 1';
    const r = computeNewThreatsAfterMove(fen, { from: 'h1', to: 'h2' });
    expect(r.newThreats).toEqual([]);
  });

  it('atakуемая фигура с защитником — не висит, не считается', () => {
    // Белая ладья a1 → чёрная пешка a7, но рядом b8 = чёрная ладья
    // (защитник). Ход вскрытия не помогает.
    const fen = '1r5k/p7/8/8/8/P7/8/R6K w - - 0 1';
    const r = computeNewThreatsAfterMove(fen, { from: 'a3', to: 'a4' });
    expect(r.newThreats).toEqual([]);
  });

  it('некорректный ход → пустой результат', () => {
    const fen = '7k/p7/8/8/8/P7/8/R6K w - - 0 1';
    const r = computeNewThreatsAfterMove(fen, { from: 'h7', to: 'h6' });
    expect(r.newThreats).toEqual([]);
  });

  it('некорректный FEN → пустой результат', () => {
    const r = computeNewThreatsAfterMove('garbage', { from: 'a1', to: 'a2' });
    expect(r.newThreats).toEqual([]);
  });

  // ─── KS-2617: вскрытая атака после ухода блокирующей фигуры ────────
  it('KS-2617: Nf6→g8 вскрывает атаку чёрного ферзя d8 на белого слона g5', () => {
    // Минимальная позиция discovered attack:
    //   Чёрные: K a8, Q d8, n f6.
    //   Белые: K e1, B g5.
    // Диагональ d8-h4 проходит через d8, e7, f6, g5, h4. Конь на f6
    // блокирует. После Nf6→g8 диагональ открывается → ферзь атакует
    // g5; защитников у g5 нет (ни одной белой фигуры рядом). Helper
    // обязан добавить g5 в newThreats — это ключевая семантика
    // тренажёра «найди ход, создающий угрозу» (KS-2227): угроза
    // считается «новой», даже если её источник — другая фигура,
    // открытая ходом (вскрытая атака).
    const fen = 'k2q4/8/5n2/6B1/8/8/8/4K3 b - - 0 1';
    const r = computeNewThreatsAfterMove(fen, { from: 'f6', to: 'g8' });
    expect(r.newThreats).toContain('g5');
  });

  it('KS-2617: любой уход коня f6 с диагонали d8-h4 вскрывает ту же атаку', () => {
    // Та же позиция: с диагонали уходит даже Nf6→d5 (любой knight-
    // move). Поведение helper'а должно быть симметричным — для
    // тренажёра это означает «несколько ходов создают одну и ту же
    // угрозу», и predicate уровня выше отбраковывает позицию как
    // неоднозначную (тут это OK).
    const fen = 'k2q4/8/5n2/6B1/8/8/8/4K3 b - - 0 1';
    const r1 = computeNewThreatsAfterMove(fen, { from: 'f6', to: 'd5' });
    const r2 = computeNewThreatsAfterMove(fen, { from: 'f6', to: 'h7' });
    expect(r1.newThreats).toContain('g5');
    expect(r2.newThreats).toContain('g5');
  });
});
