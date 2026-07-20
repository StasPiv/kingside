/**
 * KS-4981 / ADR-167 §2, §4 — unit-тесты генераторов и валидаторов челленджей.
 */
import { describe, it, expect } from 'vitest';
import type { VisionConcreteMode } from '../../types/vision.js';
import {
  checkAnswer,
  computeRelation,
  generateChallenge,
  generateChallengeForMode,
  pieceAttacksSquare,
  randomSquare,
  validateChallenge,
  type VisionRng,
} from './challenge.js';

/** Детерминированный LCG (без Math.random) для воспроизводимости. */
function seededRng(seed: number): VisionRng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const MODES: VisionConcreteMode[] = ['color', 'find', 'name', 'relation', 'geometry'];

describe('validateChallenge — генераторы всегда согласованы', () => {
  it('каждый режим: 500 челленджей проходят валидацию', () => {
    for (const mode of MODES) {
      const rng = seededRng(mode.length * 7919 + 1);
      for (let i = 0; i < 500; i++) {
        const ch = generateChallengeForMode(mode, rng);
        expect(ch.mode).toBe(mode);
        expect(validateChallenge(ch)).toBe(true);
      }
    }
  });

  it('mixed: 1000 челленджей валидны и покрывают все режимы', () => {
    const rng = seededRng(42);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const ch = generateChallenge('mixed', rng);
      expect(validateChallenge(ch)).toBe(true);
      seen.add(ch.mode);
    }
    for (const mode of MODES) expect(seen.has(mode)).toBe(true);
  });
});

describe('validateChallenge — ловит испорченный ответ', () => {
  it('color с перевёрнутым ответом не проходит', () => {
    const rng = seededRng(3);
    const ch = generateChallengeForMode('color', rng);
    if (ch.mode !== 'color') throw new Error('mode');
    const broken = { ...ch, answer: ch.answer === 'dark' ? 'light' as const : 'dark' as const };
    expect(validateChallenge(broken)).toBe(false);
  });

  it('geometry с инвертированным ответом не проходит', () => {
    const rng = seededRng(9);
    const ch = generateChallengeForMode('geometry', rng);
    if (ch.mode !== 'geometry') throw new Error('mode');
    expect(validateChallenge({ ...ch, answer: !ch.answer })).toBe(false);
  });

  it('relation с инвертированным ответом не проходит', () => {
    const rng = seededRng(11);
    const ch = generateChallengeForMode('relation', rng);
    if (ch.mode !== 'relation') throw new Error('mode');
    expect(validateChallenge({ ...ch, answer: !ch.answer })).toBe(false);
  });
});

describe('computeRelation', () => {
  it('одна клетка сама с собой — false для любого вида', () => {
    expect(computeRelation('e4', 'e4', 'file')).toBe(false);
    expect(computeRelation('e4', 'e4', 'color')).toBe(false);
  });
  it('file / rank', () => {
    expect(computeRelation('e2', 'e7', 'file')).toBe(true);
    expect(computeRelation('e2', 'f7', 'file')).toBe(false);
    expect(computeRelation('a4', 'h4', 'rank')).toBe(true);
    expect(computeRelation('a4', 'h5', 'rank')).toBe(false);
  });
  it('diagonal', () => {
    expect(computeRelation('c1', 'h6', 'diagonal')).toBe(true);
    expect(computeRelation('a1', 'h8', 'diagonal')).toBe(true);
    expect(computeRelation('a1', 'h7', 'diagonal')).toBe(false);
  });
  it('color', () => {
    expect(computeRelation('a1', 'h8', 'color')).toBe(true); // обе тёмные
    expect(computeRelation('a1', 'h1', 'color')).toBe(false); // тёмная / светлая
  });
});

describe('pieceAttacksSquare (на move-gen)', () => {
  it('конь b1 бьёт c3, a3, d2; не бьёт b3', () => {
    expect(pieceAttacksSquare('N', 'b1', 'c3')).toBe(true);
    expect(pieceAttacksSquare('N', 'b1', 'a3')).toBe(true);
    expect(pieceAttacksSquare('N', 'b1', 'd2')).toBe(true);
    expect(pieceAttacksSquare('N', 'b1', 'b3')).toBe(false);
  });
  it('слон c1 бьёт по диагонали h6, не бьёт c3', () => {
    expect(pieceAttacksSquare('B', 'c1', 'h6')).toBe(true);
    expect(pieceAttacksSquare('B', 'c1', 'c3')).toBe(false);
  });
  it('ладья a1 бьёт по вертикали и горизонтали, не по диагонали', () => {
    expect(pieceAttacksSquare('R', 'a1', 'a8')).toBe(true);
    expect(pieceAttacksSquare('R', 'a1', 'h1')).toBe(true);
    expect(pieceAttacksSquare('R', 'a1', 'b2')).toBe(false);
  });
  it('ферзь d4 бьёт линии и диагонали', () => {
    expect(pieceAttacksSquare('Q', 'd4', 'd8')).toBe(true);
    expect(pieceAttacksSquare('Q', 'd4', 'a1')).toBe(true);
    expect(pieceAttacksSquare('Q', 'd4', 'e6')).toBe(false);
  });
});

describe('checkAnswer', () => {
  it('верный/неверный ответ пользователя', () => {
    const ch = generateChallengeForMode('color', seededRng(1));
    expect(checkAnswer(ch, ch.answer)).toBe(true);
    expect(checkAnswer(ch, ch.answer === 'dark' ? 'light' : 'dark')).toBe(false);
  });
});

describe('randomSquare', () => {
  it('всегда валидная клетка a1..h8', () => {
    const rng = seededRng(5);
    for (let i = 0; i < 200; i++) {
      const sq = randomSquare(rng);
      expect(sq).toMatch(/^[a-h][1-8]$/);
    }
  });
});
