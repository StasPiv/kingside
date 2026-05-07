/**
 * KS-2456 §5.1. Тесты `explainCountAttackers` — обычный режим
 * (атакующие) + defenders-режим (KS-2452, своя фигура на target).
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData } from '@kingside/shared';
import { explainCountAttackers } from './countAttackers';

function drill(over: Partial<TacticDrillDto>): TacticDrillDto {
  return {
    id: 'd-test',
    drillType: 'count-attackers',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: null,
    answerShape: 'number',
    difficulty: 1,
    ...over,
  };
}

describe('explainCountAttackers', () => {
  it('attackers mode: правильный ответ — две стрелки и target/correct highlights', () => {
    // На e5 — чёрная пешка. Белые d4 и f4 атакуют e5.
    const fen = '4k3/8/8/4p3/3P1P2/8/8/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'number', value: 2 };
    const result = explainCountAttackers({
      drill: drill({
        fen,
        meta: { highlightedSquare: 'e5', attackerColor: 'w' },
      }),
      correctAnswer: correct,
      userAnswer: { shape: 'number', value: 2 },
      solved: true,
    });

    // Две стрелки, обе correct-attack, обе → e5
    expect(result.arrows).toHaveLength(2);
    for (const a of result.arrows) {
      expect(a.role).toBe('correct-attack');
      expect(a.to).toBe('e5');
    }
    const fromSquares = result.arrows.map((a) => a.from).sort();
    expect(fromSquares).toEqual(['d4', 'f4']);

    // target + correct highlights
    expect(result.highlights).toContainEqual({ square: 'e5', role: 'target' });
    expect(result.highlights).toContainEqual({ square: 'd4', role: 'correct' });
    expect(result.highlights).toContainEqual({ square: 'f4', role: 'correct' });

    // успех — countAttackers, не countDefenders
    expect(result.notes[0].key).toBe('drills.explanation.countAttackers.correct');
    expect(result.notes[0].tone).toBe('success');
    expect(result.notes[0].params).toMatchObject({ count: 2, square: 'e5' });
  });

  it('attackers mode: неверный ответ — добавляется userAnswer note (tone=wrong)', () => {
    const fen = '4k3/8/8/4p3/3P1P2/8/8/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'number', value: 2 };
    const user: AnswerData = { shape: 'number', value: 1 };
    const result = explainCountAttackers({
      drill: drill({
        fen,
        meta: { highlightedSquare: 'e5', attackerColor: 'w' },
      }),
      correctAnswer: correct,
      userAnswer: user,
      solved: false,
    });
    const userNote = result.notes.find((n) => n.key.endsWith('.userAnswer'));
    expect(userNote).toBeDefined();
    expect(userNote?.tone).toBe('wrong');
    expect(userNote?.params).toMatchObject({ userCount: 1 });
    // основной note tone теперь info (не success)
    const correctNote = result.notes.find((n) =>
      n.key.endsWith('.countAttackers.correct'),
    );
    expect(correctNote?.tone).toBe('info');
  });

  it('defenders mode (KS-2452): своя фигура на target → role=defense, namespace countDefenders', () => {
    // e5 — чёрная пешка; e6 — чёрная ладья (защищает e5). attackerColor=b →
    // считаем чёрных «атакующих» свою же клетку = defenders.
    const fen = '4k3/8/4r3/4p3/8/8/8/4K3 w - - 0 1';
    const correct: AnswerData = { shape: 'number', value: 1 };
    const result = explainCountAttackers({
      drill: drill({
        fen,
        meta: { highlightedSquare: 'e5', attackerColor: 'b' },
      }),
      correctAnswer: correct,
      userAnswer: { shape: 'number', value: 1 },
      solved: true,
    });
    expect(result.arrows).toEqual([
      { from: 'e6', to: 'e5', role: 'defense' },
    ]);
    expect(result.notes[0].key).toBe('drills.explanation.countDefenders.correct');
  });
});
