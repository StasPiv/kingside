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
});
