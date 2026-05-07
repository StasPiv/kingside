/**
 * KS-2456 §5.2. Тесты `explainFindLoosePiece` — правильный ответ
 * (loose-фигура без защитников) + неверный (выбрана защищённая).
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData } from '@kingside/shared';
import { explainFindLoosePiece } from './findLoosePiece';

function drill(over: Partial<TacticDrillDto>): TacticDrillDto {
  return {
    id: 'd-test',
    drillType: 'find-loose-piece',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    answerShape: 'square',
    difficulty: 1,
    ...over,
  };
}

describe('explainFindLoosePiece', () => {
  // Позиция: a5 — чёрная ладья (loose, нет защитников); a6 — чёрная пешка
  // (защитник a6 = ладья a5, потому ладья a5 атакует a6 геометрически).
  const fen = '4k3/8/p7/r7/8/8/8/4K3 w - - 0 1';

  it('правильный ответ: target + correct на loose-клетке, без стрелок', () => {
    const correct: AnswerData = { shape: 'square', square: 'a5' };
    const result = explainFindLoosePiece({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: correct,
      solved: true,
    });
    expect(result.arrows).toEqual([]);
    expect(result.highlights).toContainEqual({ square: 'a5', role: 'target' });
    expect(result.highlights).toContainEqual({ square: 'a5', role: 'correct' });
    expect(result.notes[0].key).toBe('drills.explanation.findLoosePiece.correct');
    expect(result.notes[0].tone).toBe('success');
  });

  it('неверный ответ: на ошибочной клетке защитник → context + wrong note', () => {
    const correct: AnswerData = { shape: 'square', square: 'a5' };
    const user: AnswerData = { shape: 'square', square: 'a6' };
    const result = explainFindLoosePiece({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: user,
      solved: false,
    });
    expect(result.highlights).toContainEqual({ square: 'a6', role: 'wrong' });
    expect(result.highlights).toContainEqual({ square: 'a5', role: 'context' });
    const wrongNote = result.notes.find((n) => n.key.endsWith('.wrong'));
    expect(wrongNote).toBeDefined();
    expect(wrongNote?.tone).toBe('wrong');
    expect(wrongNote?.params).toMatchObject({ square: 'a6' });
  });
});
