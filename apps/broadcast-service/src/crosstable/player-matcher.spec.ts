import {
  normalizePlayerName,
  matchGameToPlayers,
  composeGameRefs,
  parseRoundNumber,
  type MatcherMetrics,
  type BroadcastGameInput,
  type BroadcastRoundInput,
} from './player-matcher';
import type { CrosstablePlayer } from '@kingside/shared';

/**
 * KS-1732 — спека на player-matcher и composeGameRefs.
 */

function makePlayer(
  rank: number,
  name: string,
  opts: { elo?: number } = {},
): CrosstablePlayer {
  return {
    rank,
    name,
    normalizedName: normalizePlayerName(name),
    elo: opts.elo,
    points: 0,
    gamesPlayed: 0,
  };
}

function makeFakeMetrics() {
  const ambiguous: Array<{ reason: string }> = [];
  const unmatched: Array<{ side: string }> = [];
  const metrics: MatcherMetrics = {
    recordAmbiguousMatch: (opts) => ambiguous.push(opts),
    recordUnmatchedPlayer: (opts) => unmatched.push(opts),
  };
  return { metrics, ambiguous, unmatched };
}

describe('normalizePlayerName', () => {
  it('lowercase + strip diacritics', () => {
    expect(normalizePlayerName('Magnus Carlsen')).toBe('magnus carlsen');
    expect(normalizePlayerName('Anish Giri')).toBe('anish giri');
    expect(normalizePlayerName('Wéi Yi')).toBe('wei yi');
    expect(normalizePlayerName('Néstor Hernández')).toBe('nestor hernandez');
  });

  it('сворачивает множественные пробелы и trim', () => {
    expect(normalizePlayerName('  Magnus   Carlsen  ')).toBe('magnus carlsen');
  });

  it('"Last, First" → "First Last" (chess-results форма)', () => {
    expect(normalizePlayerName('Carlsen, Magnus')).toBe('magnus carlsen');
    expect(normalizePlayerName('CARLSEN, MAGNUS')).toBe('magnus carlsen');
  });

  it('запятая в неоднозначных позициях НЕ ломает (двойная запятая = treat as is)', () => {
    // Если запятых >1, перестановка не делается — нормализуем как есть.
    expect(normalizePlayerName('A, B, C')).toBe('a b c');
  });

  it('null / undefined / "" → ""', () => {
    expect(normalizePlayerName(null)).toBe('');
    expect(normalizePlayerName(undefined)).toBe('');
    expect(normalizePlayerName('')).toBe('');
  });

  it('убирает не-alphanumeric (точки, дефисы)', () => {
    expect(normalizePlayerName('Carlsen, M.')).toBe('m carlsen');
    expect(normalizePlayerName('Jean-Pierre Dupont')).toBe('jeanpierre dupont');
  });
});

describe('parseRoundNumber', () => {
  it('"Round 1" → 1', () => {
    expect(parseRoundNumber('Round 1')).toBe(1);
  });
  it('"Round 12" → 12', () => {
    expect(parseRoundNumber('Round 12')).toBe(12);
  });
  it('"Final" → null', () => {
    expect(parseRoundNumber('Final')).toBeNull();
  });
  it('"" → null', () => {
    expect(parseRoundNumber('')).toBeNull();
  });
  it('"Round 0" → null (>0 invariant)', () => {
    expect(parseRoundNumber('Round 0')).toBeNull();
  });
});

describe('matchGameToPlayers — точное совпадение', () => {
  const players: CrosstablePlayer[] = [
    makePlayer(1, 'Carlsen, Magnus', { elo: 2839 }),
    makePlayer(2, 'Caruana, Fabiano', { elo: 2786 }),
    makePlayer(3, 'Nepomniachtchi, Ian', { elo: 2776 }),
  ];

  it('PGN-форма "First Last" → match по нормализованному', () => {
    const game = {
      whitePlayer: 'Magnus Carlsen',
      blackPlayer: 'Fabiano Caruana',
      whiteElo: 2839,
      blackElo: 2786,
    };
    const m = matchGameToPlayers(game, players);
    expect(m).toEqual({ whiteRank: 1, blackRank: 2 });
  });

  it('chess-results-форма "Last, First" в players, "First Last" в game', () => {
    const game = {
      whitePlayer: 'Ian Nepomniachtchi',
      blackPlayer: 'Magnus Carlsen',
      whiteElo: null,
      blackElo: null,
    };
    const m = matchGameToPlayers(game, players);
    expect(m).toEqual({ whiteRank: 3, blackRank: 1 });
  });

  it('диакритика снимается с обеих сторон', () => {
    const ps = [makePlayer(1, 'Hernández, Néstor', { elo: 2500 })];
    const game = {
      whitePlayer: 'Nestor Hernandez',
      blackPlayer: null,
      whiteElo: 2500,
      blackElo: null,
    };
    const m = matchGameToPlayers(game, ps);
    expect(m.whiteRank).toBe(1);
  });
});

describe('matchGameToPlayers — дизамбигуация по Elo', () => {
  // Два игрока с одинаковым именем ("Smith, John") но разным Elo.
  const players: CrosstablePlayer[] = [
    makePlayer(1, 'Smith, John', { elo: 2400 }),
    makePlayer(2, 'Smith, John', { elo: 2200 }),
  ];

  it('Elo в game есть — выбирает ближайшего в пределах ±50', () => {
    const game = {
      whitePlayer: 'John Smith',
      blackPlayer: null,
      whiteElo: 2410,
      blackElo: null,
    };
    const m = matchGameToPlayers(game, players);
    expect(m.whiteRank).toBe(1); // 2410 ближе к 2400 (delta=10), чем к 2200 (delta=210).
  });

  it('Elo в game есть, второй игрок ближе → выбирает второго', () => {
    const game = {
      whitePlayer: 'John Smith',
      blackPlayer: null,
      whiteElo: 2210,
      blackElo: null,
    };
    const m = matchGameToPlayers(game, players);
    expect(m.whiteRank).toBe(2);
  });

  it('Elo вне ±50 от обоих → берёт первого + метрика elo-out-of-range', () => {
    const { metrics, ambiguous } = makeFakeMetrics();
    const game = {
      whitePlayer: 'John Smith',
      blackPlayer: null,
      whiteElo: 1800, // далеко от 2400 и 2200
      blackElo: null,
    };
    const m = matchGameToPlayers(game, players, metrics);
    expect(m.whiteRank).toBe(1);
    expect(ambiguous).toEqual([{ reason: 'elo-out-of-range' }]);
  });

  it('Elo в game отсутствует → берёт первого + метрика no-elo', () => {
    const { metrics, ambiguous } = makeFakeMetrics();
    const game = {
      whitePlayer: 'John Smith',
      blackPlayer: null,
      whiteElo: null,
      blackElo: null,
    };
    const m = matchGameToPlayers(game, players, metrics);
    expect(m.whiteRank).toBe(1);
    expect(ambiguous).toEqual([{ reason: 'no-elo' }]);
  });
});

describe('matchGameToPlayers — substring fallback по фамилии', () => {
  const players: CrosstablePlayer[] = [
    makePlayer(1, 'Carlsen, Magnus', { elo: 2839 }),
    makePlayer(2, 'Caruana, Fabiano', { elo: 2786 }),
  ];

  it('PGN с одной фамилией ("Carlsen") → match по unique substring', () => {
    const game = {
      whitePlayer: 'Carlsen',
      blackPlayer: null,
      whiteElo: null,
      blackElo: null,
    };
    const m = matchGameToPlayers(game, players);
    expect(m.whiteRank).toBe(1);
  });

  it('фамилия неоднозначна (две Smiths) → не fallback-ится, returns null', () => {
    const ps = [
      makePlayer(1, 'Smith, John', { elo: 2400 }),
      makePlayer(2, 'Smith, Jane', { elo: 2200 }),
    ];
    const { metrics, unmatched } = makeFakeMetrics();
    const game = {
      whitePlayer: 'Smith',
      blackPlayer: null,
      whiteElo: null,
      blackElo: null,
    };
    const m = matchGameToPlayers(game, ps, metrics);
    expect(m.whiteRank).toBeNull();
    expect(unmatched).toEqual([{ side: 'white' }]);
  });
});

describe('matchGameToPlayers — unmatched', () => {
  const players: CrosstablePlayer[] = [
    makePlayer(1, 'Carlsen, Magnus', { elo: 2839 }),
  ];

  it('игрок отсутствует в chess-results → null + метрика unmatched', () => {
    const { metrics, unmatched } = makeFakeMetrics();
    const game = {
      whitePlayer: 'Player X',
      blackPlayer: 'Magnus Carlsen',
      whiteElo: 2500,
      blackElo: 2839,
    };
    const m = matchGameToPlayers(game, players, metrics);
    expect(m).toEqual({ whiteRank: null, blackRank: 1 });
    expect(unmatched).toEqual([{ side: 'white' }]);
  });

  it('обе стороны null → unmatched пишется по обоим только если имена не пустые', () => {
    const { metrics, unmatched } = makeFakeMetrics();
    const game = {
      whitePlayer: null,
      blackPlayer: null,
      whiteElo: null,
      blackElo: null,
    };
    const m = matchGameToPlayers(game, players, metrics);
    expect(m).toEqual({ whiteRank: null, blackRank: null });
    // Имён нет — не считаем как unmatched (это просто "no data").
    expect(unmatched).toHaveLength(0);
  });
});

describe('composeGameRefs', () => {
  const players: CrosstablePlayer[] = [
    makePlayer(1, 'Carlsen, Magnus', { elo: 2839 }),
    makePlayer(2, 'Caruana, Fabiano', { elo: 2786 }),
    makePlayer(3, 'Nepomniachtchi, Ian', { elo: 2776 }),
  ];

  const round1: BroadcastRoundInput = {
    id: 'round-uuid-1',
    name: 'Round 1',
    startsAt: new Date('2026-01-01T15:00:00Z'),
  };
  const round2: BroadcastRoundInput = {
    id: 'round-uuid-2',
    name: 'Round 2',
    startsAt: new Date('2026-01-02T15:00:00Z'),
  };
  const roundsById = new Map([
    [round1.id, round1],
    [round2.id, round2],
  ]);

  it('собирает refs с ключом "<roundNumber>:<whiteRank>:<blackRank>"', () => {
    const games: BroadcastGameInput[] = [
      {
        id: 'game-1',
        whitePlayer: 'Magnus Carlsen',
        blackPlayer: 'Fabiano Caruana',
        whiteElo: 2839,
        blackElo: 2786,
        roundId: round1.id,
      },
      {
        id: 'game-2',
        whitePlayer: 'Ian Nepomniachtchi',
        blackPlayer: 'Magnus Carlsen',
        whiteElo: 2776,
        blackElo: 2839,
        roundId: round2.id,
      },
    ];

    const refs = composeGameRefs(games, players, roundsById);
    expect(refs.size).toBe(2);

    const r1 = refs.get('1:1:2');
    expect(r1).toEqual({
      gameId: 'game-1',
      roundId: round1.id,
      roundName: 'Round 1',
    });

    const r2 = refs.get('2:3:1');
    expect(r2).toEqual({
      gameId: 'game-2',
      roundId: round2.id,
      roundName: 'Round 2',
    });
  });

  it('игра с unmatched-стороной игнорируется (нет refs)', () => {
    const games: BroadcastGameInput[] = [
      {
        id: 'game-bad',
        whitePlayer: 'Unknown Player',
        blackPlayer: 'Fabiano Caruana',
        whiteElo: null,
        blackElo: 2786,
        roundId: round1.id,
      },
    ];
    const refs = composeGameRefs(games, players, roundsById);
    expect(refs.size).toBe(0);
  });

  it('игра с отсутствующим roundId игнорируется', () => {
    const games: BroadcastGameInput[] = [
      {
        id: 'game-orphan',
        whitePlayer: 'Magnus Carlsen',
        blackPlayer: 'Fabiano Caruana',
        whiteElo: 2839,
        blackElo: 2786,
        roundId: 'unknown-round-id',
      },
    ];
    const refs = composeGameRefs(games, players, roundsById);
    expect(refs.size).toBe(0);
  });

  it('round.name без числа использует name как label-ключ (например "Final")', () => {
    const finalRound: BroadcastRoundInput = {
      id: 'round-final',
      name: 'Final',
      startsAt: null,
    };
    const games: BroadcastGameInput[] = [
      {
        id: 'game-final',
        whitePlayer: 'Magnus Carlsen',
        blackPlayer: 'Fabiano Caruana',
        whiteElo: 2839,
        blackElo: 2786,
        roundId: finalRound.id,
      },
    ];
    const refs = composeGameRefs(
      games,
      players,
      new Map([[finalRound.id, finalRound]]),
    );
    expect(refs.has('Final:1:2')).toBe(true);
  });

  it('инкрементирует metrics при unmatched player в одной из игр', () => {
    const { metrics, unmatched } = makeFakeMetrics();
    const games: BroadcastGameInput[] = [
      {
        id: 'g1',
        whitePlayer: 'Magnus Carlsen',
        blackPlayer: 'Carlsen',
        whiteElo: 2839,
        blackElo: 2839,
        roundId: round1.id,
      },
      {
        id: 'g2',
        whitePlayer: 'Mystery Man',
        blackPlayer: 'Fabiano Caruana',
        whiteElo: null,
        blackElo: 2786,
        roundId: round2.id,
      },
    ];
    composeGameRefs(games, players, roundsById, undefined, metrics);
    expect(unmatched).toEqual([{ side: 'white' }]);
  });
});
