/**
 * KS-2456 §5.6. Тесты `explainFindUndefendedAttack` — новая угроза +
 * ошибка пользователя.
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData } from '@kingside/shared';
import { explainFindUndefendedAttack } from './findUndefendedAttack';

function drill(over: Partial<TacticDrillDto>): TacticDrillDto {
  return {
    id: 'd-test',
    drillType: 'find-undefended-attack',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    answerShape: 'move',
    difficulty: 1,
    ...over,
  };
}

describe('explainFindUndefendedAttack', () => {
  // Bc1-b2: до хода чёрный конь e5 не атакован, защитников нет.
  // После Bb2 — слон атакует e5, защитников по-прежнему нет → новая
  // висящая угроза.
  const fen = '4k3/8/8/4n3/8/8/8/2B1K3 w - - 0 1';

  it('правильный ход: correct-move + threat-target arrows + correct note', () => {
    const correct: AnswerData = { shape: 'move', from: 'c1', to: 'b2' };
    const result = explainFindUndefendedAttack({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: correct,
      solved: true,
    });
    expect(result.arrows).toContainEqual({
      from: 'c1',
      to: 'b2',
      role: 'correct-move',
    });
    expect(result.arrows).toContainEqual({
      from: 'b2',
      to: 'e5',
      role: 'threat-target',
    });
    expect(result.highlights).toContainEqual({ square: 'b2', role: 'correct' });
    expect(result.highlights).toContainEqual({ square: 'c1', role: 'context' });
    expect(result.highlights).toContainEqual({ square: 'e5', role: 'target' });
    expect(result.notes[0].key).toBe(
      'drills.explanation.findUndefendedAttack.correct',
    );
    // KS-2482: ход correctAnswer выводится как SAN — Bb2.
    expect(result.notes[0].params).toMatchObject({
      square: 'e5',
      san: 'Bb2',
    });
    expect(result.notes[0].tone).toBe('success');
  });

  it('неверный ход: wrong highlight + wrong note', () => {
    const correct: AnswerData = { shape: 'move', from: 'c1', to: 'b2' };
    const user: AnswerData = { shape: 'move', from: 'c1', to: 'a3' };
    const result = explainFindUndefendedAttack({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: user,
      solved: false,
    });
    expect(result.highlights).toContainEqual({ square: 'a3', role: 'wrong' });
    const wrongNote = result.notes.find((n) => n.key.endsWith('.wrong'));
    expect(wrongNote?.tone).toBe('wrong');
    // KS-2482: SAN-нотация ошибочного хода.
    expect(wrongNote?.params).toMatchObject({ san: 'Ba3' });
  });
});
