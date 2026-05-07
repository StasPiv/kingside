/**
 * KS-2456 §5.7. Тесты `explainFindAllChecks` — direct + missed +
 * discovered/double теги.
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData } from '@kingside/shared';
import { explainFindAllChecks } from './findAllChecks';

function drill(over: Partial<TacticDrillDto>): TacticDrillDto {
  return {
    id: 'd-test',
    drillType: 'find-all-checks',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    answerShape: 'squares',
    difficulty: 1,
    ...over,
  };
}

describe('explainFindAllChecks', () => {
  it('один direct check: correct-move стрелка + target=king', () => {
    // Только Ra1-a8+ — direct check.
    const fen = '4k3/8/8/8/8/8/8/R3K3 w - - 0 1';
    const correct: AnswerData = { shape: 'squares', squares: ['a8'] };
    const result = explainFindAllChecks({
      drill: drill({
        fen,
        meta: { expectedMoves: [{ from: 'a1', to: 'a8' }] },
      }),
      correctAnswer: correct,
      userAnswer: correct,
      solved: true,
    });
    expect(result.arrows).toEqual([
      // KS-2460: FAC использует `correct-attack` (атака на короля), не
      // `correct-move` — методически точнее, см. findAllChecks.ts.
      { from: 'a1', to: 'a8', role: 'correct-attack' },
    ]);
    expect(result.highlights).toContainEqual({ square: 'e8', role: 'target' });
    expect(result.highlights).toContainEqual({ square: 'a8', role: 'correct' });
    expect(result.notes.find((n) => n.key.endsWith('.correct'))).toBeDefined();
    // direct → нет discovered/double тэгов
    expect(
      result.notes.find((n) => n.key.endsWith('.tagDiscovered')),
    ).toBeUndefined();
    expect(
      result.notes.find((n) => n.key.endsWith('.tagDouble')),
    ).toBeUndefined();
  });

  it('пропущенный шах: missed highlight + missed note (tone=missed)', () => {
    const fen = '4k3/8/8/8/8/8/8/R3K3 w - - 0 1';
    const correct: AnswerData = { shape: 'squares', squares: ['a8'] };
    const user: AnswerData = { shape: 'squares', squares: [] };
    const result = explainFindAllChecks({
      drill: drill({
        fen,
        meta: { expectedMoves: [{ from: 'a1', to: 'a8' }] },
      }),
      correctAnswer: correct,
      userAnswer: user,
      solved: false,
    });
    expect(result.highlights).toContainEqual({ square: 'a8', role: 'missed' });
    expect(
      result.arrows.find((a) => a.from === 'a1' && a.to === 'a8'),
    ).toMatchObject({ role: 'missed-attack' });
    const missedNote = result.notes.find((n) => n.key.endsWith('.missed'));
    expect(missedNote).toBeDefined();
    expect(missedNote?.tone).toBe('missed');
  });

  it('double check: тег tagDouble в notes (Ne6-c7+ открывает Re5 + сам атакует e8)', () => {
    // 4k3/8/4N3/4R3/...: Ne6 + Re5 на одной линии с черным королём e8.
    // Ne6→c7+ : конь c7 атакует e8 (direct) и одновременно открывает
    // линию ладьи e5→e8 → double check.
    const fen = '4k3/8/4N3/4R3/8/8/8/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'squares', squares: ['c7'] };
    const result = explainFindAllChecks({
      drill: drill({
        fen,
        meta: { expectedMoves: [{ from: 'e6', to: 'c7' }] },
      }),
      correctAnswer: correct,
      userAnswer: correct,
      solved: true,
    });
    const tagDouble = result.notes.find((n) => n.key.endsWith('.tagDouble'));
    expect(tagDouble).toBeDefined();
    expect(tagDouble?.params).toMatchObject({ from: 'e6', to: 'c7' });
  });
});
