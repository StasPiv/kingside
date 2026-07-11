import { describe, it, expect } from 'vitest';
import { sortGamesByLastMove, sortGamesByWhite } from './broadcastGameSort';

/**
 * KS-4893: сортировка досок по времени последнего хода — свежие первыми,
 * партии без lastMoveAt в конце, tiebreak — порядок по фамилии белых.
 */

type G = {
  id: string;
  whitePlayer: string | null;
  blackPlayer: string | null;
  lastMoveAt: string | null;
};

function g(id: string, white: string, lastMoveAt: string | null): G {
  return { id, whitePlayer: white, blackPlayer: 'Opp', lastMoveAt };
}

describe('sortGamesByLastMove (KS-4893)', () => {
  it('свежий ход первым, независимо от алфавита', () => {
    const games = [
      g('a', 'Aronian', '2026-07-11T15:00:00.000Z'),
      g('b', 'Zubov', '2026-07-11T15:30:00.000Z'),
      g('c', 'Carlsen', '2026-07-11T15:10:00.000Z'),
    ];
    const out = sortGamesByLastMove(games);
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('партии без lastMoveAt уходят в конец, между собой — по белым', () => {
    const games = [
      g('n1', 'Zubov', null),
      g('t1', 'Carlsen', '2026-07-11T15:10:00.000Z'),
      g('n2', 'Aronian', null),
    ];
    const out = sortGamesByLastMove(games);
    expect(out.map((x) => x.id)).toEqual(['t1', 'n2', 'n1']);
  });

  it('невалидная дата трактуется как отсутствие времени', () => {
    const games = [
      g('bad', 'Aronian', 'not-a-date'),
      g('ok', 'Zubov', '2026-07-11T15:00:00.000Z'),
    ];
    const out = sortGamesByLastMove(games);
    expect(out.map((x) => x.id)).toEqual(['ok', 'bad']);
  });

  it('исходный массив не мутируется', () => {
    const games = [
      g('a', 'Aronian', '2026-07-11T15:00:00.000Z'),
      g('b', 'Zubov', '2026-07-11T15:30:00.000Z'),
    ];
    const copy = [...games];
    sortGamesByLastMove(games);
    expect(games).toEqual(copy);
  });
});

describe('sortGamesByWhite (регрессия KS-2446)', () => {
  it('сортирует по фамилии белых A→Z, пустые в конец', () => {
    const games = [
      g('z', 'Zubov', null),
      { id: 'x', whitePlayer: null, blackPlayer: null, lastMoveAt: null },
      g('a', 'Aronian', null),
    ];
    const out = sortGamesByWhite(games);
    expect(out.map((x) => x.id)).toEqual(['a', 'z', 'x']);
  });
});
