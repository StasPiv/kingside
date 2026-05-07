/**
 * KS-2456 §5.5. Тесты `explainFindFork` — обычная вилка + вилка с шахом
 * (король отдельно от обычных целей).
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData } from '@kingside/shared';
import { explainFindFork } from './findFork';

function drill(over: Partial<TacticDrillDto>): TacticDrillDto {
  return {
    id: 'd-test',
    drillType: 'find-fork',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    answerShape: 'move',
    difficulty: 1,
    ...over,
  };
}

describe('explainFindFork', () => {
  it('fork с шахом: kingSq отдельно, note correctWithCheck (Nd5-c7+)', () => {
    // Конь c7 атакует ke8 (шах) и ra8 (ладью). Royal fork.
    const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'move', from: 'd5', to: 'c7' };
    const result = explainFindFork({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: correct,
      solved: true,
    });
    // correct-move + correct-attack стрелки от форкера
    expect(result.arrows).toContainEqual({
      from: 'd5',
      to: 'c7',
      role: 'correct-move',
    });
    expect(result.arrows).toContainEqual({
      from: 'c7',
      to: 'a8',
      role: 'correct-attack',
    });
    expect(result.arrows).toContainEqual({
      from: 'c7',
      to: 'e8',
      role: 'correct-attack',
    });
    expect(result.highlights).toContainEqual({ square: 'c7', role: 'target' });
    expect(result.highlights).toContainEqual({ square: 'd5', role: 'context' });
    expect(result.highlights).toContainEqual({ square: 'a8', role: 'context' });
    expect(result.highlights).toContainEqual({ square: 'e8', role: 'context' });
    const note = result.notes.find((n) =>
      n.key.endsWith('findFork.correctWithCheck'),
    );
    expect(note).toBeDefined();
    // KS-2482: ход в SAN — Nc7+ (royal fork, конь бьёт короля и ладью).
    expect(note?.params).toMatchObject({
      san: 'Nc7+',
      king: 'e8',
      targets: 'a8',
    });
  });

  it('неверный ход: wrong highlight + wrong note', () => {
    const fen = 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'move', from: 'd5', to: 'c7' };
    // Любой другой ход (даже не вилка), для tests важна реакция функции.
    const user: AnswerData = { shape: 'move', from: 'd5', to: 'b6' };
    const result = explainFindFork({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: user,
      solved: false,
    });
    expect(result.highlights).toContainEqual({ square: 'b6', role: 'wrong' });
    const wrongNote = result.notes.find((n) => n.key.endsWith('.wrong'));
    expect(wrongNote?.tone).toBe('wrong');
    // KS-2482: SAN-нотация ошибочного хода.
    expect(wrongNote?.params).toMatchObject({ san: 'Nb6' });
  });
});
