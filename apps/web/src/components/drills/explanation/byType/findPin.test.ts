/**
 * KS-2456 §5.3. Тесты `explainFindPin` — absolute и relative.
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData } from '@kingside/shared';
import { explainFindPin } from './findPin';

function drill(over: Partial<TacticDrillDto>): TacticDrillDto {
  return {
    id: 'd-test',
    drillType: 'find-pin',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: null,
    answerShape: 'square',
    difficulty: 1,
    ...over,
  };
}

describe('explainFindPin', () => {
  it('absolute pin: pin-line attacker→anchor=king, note correctAbsolute', () => {
    // Q e4 связывает чёрную ладью e7 с чёрным королём e8 (вертикаль).
    const fen = '4k3/4r3/8/8/4Q3/8/8/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'square', square: 'e7' };
    const result = explainFindPin({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: correct,
      solved: true,
    });
    expect(result.arrows).toEqual([
      { from: 'e4', to: 'e8', role: 'pin-line' },
    ]);
    expect(result.highlights).toContainEqual({ square: 'e7', role: 'target' });
    expect(result.highlights).toContainEqual({ square: 'e7', role: 'correct' });
    expect(result.highlights).toContainEqual({ square: 'e8', role: 'context' });
    expect(result.highlights).toContainEqual({ square: 'e4', role: 'context' });
    expect(result.notes[0].key).toBe(
      'drills.explanation.findPin.correctAbsolute',
    );
    expect(result.notes[0].tone).toBe('success');
  });

  it('relative pin: anchor=queen → note correctRelative', () => {
    // R e2 связывает чёрного слона e3 с чёрным ферзём e4 (вертикаль).
    // anchorType='q', не 'k' → relative.
    const fen = '4k3/8/8/8/4q3/4b3/4R3/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'square', square: 'e3' };
    const result = explainFindPin({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: correct,
      solved: true,
    });
    expect(result.arrows).toEqual([
      { from: 'e2', to: 'e4', role: 'pin-line' },
    ]);
    expect(result.notes[0].key).toBe(
      'drills.explanation.findPin.correctRelative',
    );
    expect(result.notes[0].params).toMatchObject({
      attackerKey: 'chess.pieces.r',
      anchorKey: 'chess.pieces.q',
      pinnedKey: 'chess.pieces.b',
    });
  });

  it('неверный ответ: wrong highlight + wrong note', () => {
    const fen = '4k3/4r3/8/8/4Q3/8/8/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'square', square: 'e7' };
    const user: AnswerData = { shape: 'square', square: 'e8' };
    const result = explainFindPin({
      drill: drill({ fen }),
      correctAnswer: correct,
      userAnswer: user,
      solved: false,
    });
    expect(result.highlights).toContainEqual({ square: 'e8', role: 'wrong' });
    const wrongNote = result.notes.find((n) => n.key.endsWith('.wrong'));
    expect(wrongNote).toBeDefined();
    expect(wrongNote?.tone).toBe('wrong');
    expect(wrongNote?.params).toMatchObject({ square: 'e8' });
  });
});
