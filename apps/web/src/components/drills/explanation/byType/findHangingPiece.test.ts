/**
 * KS-2456 §5.4. Тесты `explainFindHangingPiece` — взятие зависшей
 * (`shape='move'`, KS-2335).
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData } from '@kingside/shared';
import { explainFindHangingPiece } from './findHangingPiece';

function drill(over: Partial<TacticDrillDto>): TacticDrillDto {
  return {
    id: 'd-test',
    drillType: 'find-hanging-piece',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    answerShape: 'move',
    difficulty: 1,
    ...over,
  };
}

describe('explainFindHangingPiece', () => {
  // Чёрная ладья e5 атакована белой пешкой d4. Защитников у e5 нет →
  // hanging. Правильный ход — d4xe5.
  const fen = '4k3/8/8/4r3/3P4/8/8/4K3 w - - 0 1';

  it('правильный ход: correct-attack стрелка, note correctUndefended (нет защитников)', () => {
    const correct: AnswerData = { shape: 'move', from: 'd4', to: 'e5' };
    const result = explainFindHangingPiece({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: correct,
      solved: true,
    });
    expect(result.arrows).toContainEqual({
      from: 'd4',
      to: 'e5',
      role: 'correct-attack',
    });
    // Нет defense-стрелок (нет защитников)
    expect(result.arrows.filter((a) => a.role === 'defense')).toEqual([]);
    expect(result.highlights).toContainEqual({ square: 'e5', role: 'target' });
    expect(result.highlights).toContainEqual({ square: 'd4', role: 'context' });
    expect(result.notes[0].key).toBe(
      'drills.explanation.findHangingPiece.correctUndefended',
    );
    expect(result.notes[0].tone).toBe('success');
  });

  it('неверный ответ: wrong highlight на userAnswer.to + wrong note', () => {
    const correct: AnswerData = { shape: 'move', from: 'd4', to: 'e5' };
    // KS-2482: используем легальный король-ход Kd1 (e1→d1 пустая клетка
    // вне атаки чёрной ладьи на e-line) — chess.js даёт SAN=`Kd1`.
    const user: AnswerData = { shape: 'move', from: 'e1', to: 'd1' };
    const result = explainFindHangingPiece({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: user,
      solved: false,
    });
    expect(result.highlights).toContainEqual({ square: 'd1', role: 'wrong' });
    const wrongNote = result.notes.find((n) => n.key.endsWith('.wrong'));
    expect(wrongNote?.tone).toBe('wrong');
    expect(wrongNote?.params).toMatchObject({ san: 'Kd1' });
  });
});
