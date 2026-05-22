import { describe, it, expect } from 'vitest';

import {
  isForfeitGame,
  isForfeitTermination,
  readPgnHeader,
} from './forfeitTermination';

/**
 * KS-3258: проверка детектора forfeit-партий.
 *
 * Реальный кейс с прода: lichessGameId=NZDd3BWL (GCT Romania R7,
 * Firouzja — Van Foreest), PGN содержит `[Termination "Unplayed"]`
 * + `[Result "0-1"]` без movetext.
 */

describe('readPgnHeader', () => {
  it('извлекает значение в любом регистре', () => {
    const pgn = '[Termination "Unplayed"]\n[Result "0-1"]\n\n*';
    expect(readPgnHeader(pgn, 'Termination')).toBe('Unplayed');
    expect(readPgnHeader(pgn, 'termination')).toBe('Unplayed');
    expect(readPgnHeader(pgn, 'Result')).toBe('0-1');
  });
  it('null если header отсутствует', () => {
    expect(readPgnHeader('[White "A"]', 'Termination')).toBeNull();
    expect(readPgnHeader('', 'Termination')).toBeNull();
  });
});

describe('isForfeitTermination', () => {
  it('распознаёт стандартные термины (case-insensitive)', () => {
    expect(isForfeitTermination('Unplayed')).toBe(true);
    expect(isForfeitTermination('unplayed')).toBe(true);
    expect(isForfeitTermination('Forfeit')).toBe(true);
    expect(isForfeitTermination('Default')).toBe(true);
    expect(isForfeitTermination('Walkover')).toBe(true);
    expect(isForfeitTermination('Rules infraction')).toBe(true);
    expect(isForfeitTermination('Abandoned')).toBe(true);
  });
  it('не-forfeit терминалы → false', () => {
    expect(isForfeitTermination('Normal')).toBe(false);
    expect(isForfeitTermination('Time forfeit')).toBe(false); // не путать с Forfeit
    expect(isForfeitTermination(null)).toBe(false);
    expect(isForfeitTermination(undefined)).toBe(false);
    expect(isForfeitTermination('')).toBe(false);
  });
});

describe('isForfeitGame', () => {
  it('главный кейс KS-3258: Termination=Unplayed + Result=0-1 без ходов → true', () => {
    const pgn =
      '[Event "GCT Romania 2026"]\n' +
      '[White "Firouzja, Alireza"]\n' +
      '[Black "Van Foreest, Jorden"]\n' +
      '[Result "0-1"]\n' +
      '[Termination "Unplayed"]\n' +
      '\n*';
    expect(isForfeitGame(pgn, 0)).toBe(true);
  });

  it('Termination отсутствует, но Result != "*" с пустой историей → fallback true', () => {
    const pgn =
      '[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n*';
    expect(isForfeitGame(pgn, 0)).toBe(true);
  });

  it('Result="*" + пустая история → false (live, ещё не началась)', () => {
    const pgn = '[White "A"]\n[Black "B"]\n[Result "*"]\n\n*';
    expect(isForfeitGame(pgn, 0)).toBe(false);
  });

  it('historyLen > 0 → всегда false (партия сыграна)', () => {
    const pgn =
      '[Result "0-1"]\n[Termination "Unplayed"]\n\n1. e4 e5 *';
    expect(isForfeitGame(pgn, 1)).toBe(false);
  });

  it('пустой / null PGN + 0 ходов → false (нет данных, не forfeit)', () => {
    expect(isForfeitGame('', 0)).toBe(false);
    expect(isForfeitGame(null, 0)).toBe(false);
    expect(isForfeitGame(undefined, 0)).toBe(false);
  });

  it('forfeit с любым результатом (1-0/0-1/1/2-1/2) определяется', () => {
    for (const result of ['1-0', '0-1', '1/2-1/2']) {
      const pgn = `[Result "${result}"]\n[Termination "Walkover"]\n\n*`;
      expect(isForfeitGame(pgn, 0)).toBe(true);
    }
  });
});
