/**
 * KS-2456. Smoke-тест dispatcher'а: проверяем, что `explainDrill()`
 * корректно делегирует каждый из 7 drill-типов в соответствующий
 * by-type модуль (и что неизвестный тип возвращает empty-explanation).
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData, TacticDrillType } from '@kingside/shared';
import { explainDrill } from './explainDrill';

function buildInput(
  drillType: TacticDrillType,
  fen: string,
  correctAnswer: AnswerData,
  meta: TacticDrillDto['meta'] = undefined,
  shape: TacticDrillDto['answerShape'] = correctAnswer.shape,
): {
  drill: TacticDrillDto;
  correctAnswer: AnswerData;
  userAnswer: AnswerData;
  solved: boolean;
} {
  return {
    drill: {
      id: 'd-test',
      drillType,
      fen,
      sideToMove: 'w',
      answerShape: shape,
      difficulty: 1,
      ...(meta ? { meta } : {}),
    },
    correctAnswer,
    userAnswer: correctAnswer,
    solved: true,
  };
}

describe('explainDrill (dispatcher)', () => {
  it('count-attackers — делегирует и возвращает correct-attack стрелку', () => {
    const r = explainDrill(
      buildInput(
        'count-attackers',
        '4k3/8/8/4p3/3P1P2/8/8/4K3 w - - 0 1',
        { shape: 'number', value: 2 },
        { highlightedSquare: 'e5', attackerColor: 'w' },
      ),
    );
    expect(r.arrows.length).toBe(2);
    expect(r.arrows[0].role).toBe('correct-attack');
  });

  it('find-pin — делегирует и возвращает pin-line стрелку', () => {
    const r = explainDrill(
      buildInput(
        'find-pin',
        '4k3/4r3/8/8/4Q3/8/8/4K3 w - - 0 1',
        { shape: 'square', square: 'e7' },
      ),
    );
    expect(r.arrows[0]?.role).toBe('pin-line');
  });

  it('find-fork — делегирует, возвращает correct-move + correct-attack', () => {
    const r = explainDrill(
      buildInput(
        'find-fork',
        'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1',
        { shape: 'move', from: 'd5', to: 'c7' },
      ),
    );
    expect(r.arrows.find((a) => a.role === 'correct-move')).toBeDefined();
    expect(r.arrows.filter((a) => a.role === 'correct-attack').length).toBeGreaterThanOrEqual(2);
  });

  it('неизвестный drillType — возвращает пустой explanation', () => {
    const r = explainDrill({
      drill: {
        id: 'x',
        // @ts-expect-error: проверяем устойчивость к unknown типу.
        drillType: 'unknown-type',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1',
        sideToMove: 'w',
        answerShape: 'square',
        difficulty: 1,
      },
      correctAnswer: { shape: 'square', square: 'e4' },
      userAnswer: null,
      solved: false,
    });
    expect(r.arrows).toEqual([]);
    expect(r.highlights).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});
