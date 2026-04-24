/**
 * Unit-тесты bracket-классификатора (KS-1813).
 *
 * Покрытие:
 *   - `parseBracketStage` по разным названиям раундов;
 *   - `computeMatchScore` — ведущий, отстающий, ничьи, ½, незавершённые;
 *   - `classifyBrackets` — пары получают один `bracketPairId`, stage
 *     один на раунд, незнакомые имена не участвуют.
 */

import {
  classifyBrackets,
  computeMatchScore,
  parseBracketStage,
  type ClassifyGameInput,
} from './bracket-classifier';
import { pairKey } from './detect-round-tournament-type';

function mk(
  id: string,
  white: string,
  black: string,
  result: string | null,
): ClassifyGameInput {
  return { id, whitePlayer: white, blackPlayer: black, result };
}

describe('parseBracketStage', () => {
  it('Quarterfinal → quarter', () => {
    expect(parseBracketStage('Quarterfinal')).toBe('quarter');
  });

  it('Semifinal → semi', () => {
    expect(parseBracketStage('Semifinal')).toBe('semi');
  });

  it('Grand Final → grand_final', () => {
    expect(parseBracketStage('Grand Final')).toBe('grand_final');
  });

  it('Final → final', () => {
    expect(parseBracketStage('Final')).toBe('final');
  });

  it('Round of 16 → round_of_16', () => {
    expect(parseBracketStage('Round of 16')).toBe('round_of_16');
  });

  it('Winners | Semifinal → winners_semi', () => {
    expect(parseBracketStage('Winners | Semifinal')).toBe('winners_semi');
  });

  it('Losers | Final → losers_final', () => {
    expect(parseBracketStage('Losers | Final')).toBe('losers_final');
  });

  it('Winners Bracket без этапа → winners', () => {
    expect(parseBracketStage('Winners Bracket')).toBe('winners');
  });

  it('Playoffs (без этапа) → playoff fallback', () => {
    expect(parseBracketStage('Playoffs')).toBe('playoff');
  });

  it('пустая строка → playoff', () => {
    expect(parseBracketStage('')).toBe('playoff');
  });
});

describe('computeMatchScore', () => {
  const pair = pairKey('Alice', 'Bob');

  it('0-0 когда нет завершённых партий', () => {
    expect(
      computeMatchScore(pair, [mk('1', 'Alice', 'Bob', null), mk('2', 'Bob', 'Alice', '*')]),
    ).toBe('0-0');
  });

  it('2-1 при двух победах первого и одной у второго', () => {
    // Alice: 2, Bob: 1
    const score = computeMatchScore(pair, [
      mk('1', 'Alice', 'Bob', '1-0'), // Alice белая, выиграла
      mk('2', 'Bob', 'Alice', '0-1'), // Alice чёрная, выиграла
      mk('3', 'Bob', 'Alice', '1-0'), // Bob белый, выиграл
    ]);
    expect(score).toBe('2-1');
  });

  it('2½-1½ при ничьих (половинки)', () => {
    const score = computeMatchScore(pair, [
      mk('1', 'Alice', 'Bob', '1-0'), // 1-0
      mk('2', 'Bob', 'Alice', '1/2-1/2'), // +0.5 каждому → 1.5-0.5
      mk('3', 'Alice', 'Bob', '1/2-1/2'), // +0.5 каждому → 2-1
      mk('4', 'Bob', 'Alice', '0-1'), // Alice чёрная, победа → 3-1
      mk('5', 'Alice', 'Bob', '1/2-1/2'), // +0.5 каждому → 3.5-1.5
    ]);
    expect(score).toBe('3½-1½');
  });

  it('незавершённые и битые результаты игнорируются', () => {
    const score = computeMatchScore(pair, [
      mk('1', 'Alice', 'Bob', '1-0'),
      mk('2', 'Alice', 'Bob', '*'),
      mk('3', 'Alice', 'Bob', null),
    ]);
    expect(score).toBe('1-0');
  });

  it('пустой pairId → 0-0', () => {
    expect(computeMatchScore('', [])).toBe('0-0');
  });

  it('порядок в паре из pairKey определяет, кто слева в счёте', () => {
    // pairKey('Alice','Bob') → 'alice|bob' → слева Alice
    const score = computeMatchScore(pair, [mk('1', 'Bob', 'Alice', '1-0')]);
    // Bob выиграл, Alice первая в ключе, поэтому счёт 0-1
    expect(score).toBe('0-1');
  });
});

describe('classifyBrackets', () => {
  it('групирует две партии матча под один bracketPairId', () => {
    const games = [
      mk('g1', 'Alice', 'Bob', '1-0'),
      mk('g2', 'Bob', 'Alice', '0-1'),
      mk('g3', 'Carol', 'Dan', '1/2-1/2'),
    ];
    const result = classifyBrackets('Winners | Semifinal', games);

    expect(result.get('g1')?.bracketStage).toBe('winners_semi');
    expect(result.get('g2')?.bracketStage).toBe('winners_semi');
    expect(result.get('g1')?.bracketPairId).toBe(result.get('g2')?.bracketPairId);
    expect(result.get('g1')?.bracketPairId).not.toBe(result.get('g3')?.bracketPairId);
  });

  it('счёт считается по паре, а не по общему набору', () => {
    const result = classifyBrackets('Semifinal', [
      mk('g1', 'Alice', 'Bob', '1-0'),
      mk('g2', 'Bob', 'Alice', '0-1'),
      mk('g3', 'Carol', 'Dan', '1-0'),
    ]);
    expect(result.get('g1')?.matchScore).toBe('2-0'); // Alice обе
    expect(result.get('g2')?.matchScore).toBe('2-0');
    // Carol первая в pairKey (lex-сортировка 'carol|dan'), играет белыми и
    // выигрывает → счёт 1-0.
    expect(result.get('g3')?.matchScore).toBe('1-0');
  });

  it('название раунда без этапа даёт fallback bracketStage="playoff"', () => {
    const result = classifyBrackets('Playoffs', [mk('g1', 'A', 'B', '1-0')]);
    expect(result.get('g1')?.bracketStage).toBe('playoff');
  });
});
