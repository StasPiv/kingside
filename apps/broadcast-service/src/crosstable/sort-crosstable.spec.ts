/**
 * Unit-тесты `sortCrosstableByPoints` (KS-2477).
 */

import { sortCrosstableByPoints } from './sort-crosstable';
import type {
  CrosstableCell,
  CrosstableRoundRobin,
  CrosstableSwiss,
  CrosstableTeam,
} from '@kingside/shared';

function rrCell(
  result: CrosstableCell['result'],
  opponentRank: number,
  color?: CrosstableCell['color'],
): CrosstableCell {
  return { result, opponentRank, color };
}

describe('sortCrosstableByPoints — round-robin', () => {
  it('A=5/B=3/C=4 → возвращает A, C, B; матрица согласована', () => {
    // Исходный порядок: A(rank=1, 5pts), B(rank=2, 3pts), C(rank=3, 4pts).
    // Ожидаем после сортировки: A(rank=1, 5pts), C(rank=2, 4pts), B(rank=3, 3pts).
    const response: CrosstableRoundRobin = {
      tournamentType: 'round-robin',
      sourceType: 'chess-results',
      sourceUrl: null,
      fetchedAt: null,
      players: [
        { rank: 1, name: 'A', normalizedName: 'a', points: 5, gamesPlayed: 2 },
        { rank: 2, name: 'B', normalizedName: 'b', points: 3, gamesPlayed: 2 },
        { rank: 3, name: 'C', normalizedName: 'c', points: 4, gamesPlayed: 2 },
      ],
      matrix: [
        // A vs B = win (1-0), A vs C = draw (½)
        [{ result: null }, rrCell('win', 2, 'white'), rrCell('draw', 3, 'white')],
        // B vs A = loss, B vs C = loss
        [rrCell('loss', 1, 'black'), { result: null }, rrCell('loss', 3, 'black')],
        // C vs A = draw, C vs B = win
        [rrCell('draw', 1, 'black'), rrCell('win', 2, 'white'), { result: null }],
      ],
    };
    const r = sortCrosstableByPoints(response) as CrosstableRoundRobin;
    expect(r.players.map((p) => p.name)).toEqual(['A', 'C', 'B']);
    expect(r.players.map((p) => p.rank)).toEqual([1, 2, 3]);

    // matrix теперь индексируется как A,C,B.
    // r.matrix[0] = строка A: vs A=null, vs C=draw (old A vs C), vs B=win (old A vs B).
    expect(r.matrix[0][0].result).toBeNull();
    expect(r.matrix[0][1].result).toBe('draw');
    expect(r.matrix[0][1].opponentRank).toBe(2); // C новый rank
    expect(r.matrix[0][2].result).toBe('win');
    expect(r.matrix[0][2].opponentRank).toBe(3); // B новый rank

    // r.matrix[1] = строка C: vs A=draw, vs C=null, vs B=win.
    expect(r.matrix[1][0].result).toBe('draw');
    expect(r.matrix[1][0].opponentRank).toBe(1);
    expect(r.matrix[1][1].result).toBeNull();
    expect(r.matrix[1][2].result).toBe('win');
    expect(r.matrix[1][2].opponentRank).toBe(3);
  });

  it('равные points → tiebreak Sonneborn-Berger (выигравший у сильного выше)', () => {
    // 3 игрока, все 1 pt: A победил B, B победил C, C победил A.
    // SB(A) = points(B побежденного) = 1; SB(B) = 1; SB(C) = 1.
    // Все равны → fallback на oldRank ASC (A, B, C).
    // Поменяем веса: A победил B, A проиграл C — ничья B vs C.
    // points: A=1, B=0.5, C=1.5. Должно сортироваться C, A, B.
    const response: CrosstableRoundRobin = {
      tournamentType: 'round-robin',
      sourceType: 'chess-results',
      sourceUrl: null,
      fetchedAt: null,
      players: [
        { rank: 1, name: 'A', normalizedName: 'a', points: 1, gamesPlayed: 2 },
        { rank: 2, name: 'B', normalizedName: 'b', points: 0.5, gamesPlayed: 2 },
        { rank: 3, name: 'C', normalizedName: 'c', points: 1.5, gamesPlayed: 2 },
      ],
      matrix: [
        [{ result: null }, rrCell('win', 2, 'white'), rrCell('loss', 3, 'black')],
        [rrCell('loss', 1, 'black'), { result: null }, rrCell('draw', 3, 'black')],
        [rrCell('win', 1, 'white'), rrCell('draw', 2, 'white'), { result: null }],
      ],
    };
    const r = sortCrosstableByPoints(response) as CrosstableRoundRobin;
    expect(r.players.map((p) => p.name)).toEqual(['C', 'A', 'B']);
  });

  it('idempotent: повторный sort даёт тот же результат', () => {
    const response: CrosstableRoundRobin = {
      tournamentType: 'round-robin',
      sourceType: 'chess-results',
      sourceUrl: null,
      fetchedAt: null,
      players: [
        { rank: 1, name: 'A', normalizedName: 'a', points: 5, gamesPlayed: 2 },
        { rank: 2, name: 'B', normalizedName: 'b', points: 3, gamesPlayed: 2 },
        { rank: 3, name: 'C', normalizedName: 'c', points: 4, gamesPlayed: 2 },
      ],
      matrix: [
        [{ result: null }, rrCell('win', 2, 'white'), rrCell('draw', 3, 'white')],
        [rrCell('loss', 1, 'black'), { result: null }, rrCell('loss', 3, 'black')],
        [rrCell('draw', 1, 'black'), rrCell('win', 2, 'white'), { result: null }],
      ],
    };
    const r1 = sortCrosstableByPoints(response);
    const r2 = sortCrosstableByPoints(r1);
    expect(r2).toEqual(r1);
  });

  it('Latvijas-like: 10 игроков с разными очками — лидер с 6.5 на rank=1', () => {
    const players = [
      { rank: 1, name: 'Germanovs', normalizedName: 'germanovs', points: 4, gamesPlayed: 8 },
      { rank: 2, name: 'Mustaps', normalizedName: 'mustaps', points: 3.5, gamesPlayed: 8 },
      { rank: 3, name: 'Paikens', normalizedName: 'paikens', points: 3, gamesPlayed: 8 },
      { rank: 4, name: 'Starostits', normalizedName: 'starostits', points: 2.5, gamesPlayed: 8 },
      { rank: 5, name: 'Kantans', normalizedName: 'kantans', points: 6.5, gamesPlayed: 8 },
      { rank: 6, name: 'Miezis', normalizedName: 'miezis', points: 4, gamesPlayed: 8 },
      { rank: 7, name: 'Bernotas', normalizedName: 'bernotas', points: 2, gamesPlayed: 8 },
      { rank: 8, name: 'Meshkovs', normalizedName: 'meshkovs', points: 6, gamesPlayed: 8 },
      { rank: 9, name: 'Vingris', normalizedName: 'vingris', points: 2.5, gamesPlayed: 8 },
      { rank: 10, name: 'Neiksans', normalizedName: 'neiksans', points: 6, gamesPlayed: 8 },
    ];
    // Минимальная diagonal-only matrix — для теста нужны только player'ы.
    const matrix: CrosstableCell[][] = players.map(() =>
      players.map(() => ({ result: null })),
    );
    const r = sortCrosstableByPoints({
      tournamentType: 'round-robin',
      sourceType: 'chess-results',
      sourceUrl: null,
      fetchedAt: null,
      players,
      matrix,
    }) as CrosstableRoundRobin;
    expect(r.players[0].name).toBe('Kantans');
    expect(r.players[0].points).toBe(6.5);
    expect(r.players[0].rank).toBe(1);
    // Meshkovs и Neiksans оба 6 pts — без SB ничьи решают по старому
    // rank: Meshkovs (rank=8) < Neiksans (rank=10).
    expect([r.players[1].name, r.players[2].name]).toEqual([
      'Meshkovs',
      'Neiksans',
    ]);
  });
});

describe('sortCrosstableByPoints — swiss', () => {
  it('сортирует pairings и обновляет opponentRank', () => {
    const response: CrosstableSwiss = {
      tournamentType: 'swiss',
      sourceType: 'internal-fallback',
      sourceUrl: null,
      fetchedAt: null,
      roundCount: 2,
      players: [
        { rank: 1, name: 'A', normalizedName: 'a', points: 1, gamesPlayed: 2 },
        { rank: 2, name: 'B', normalizedName: 'b', points: 2, gamesPlayed: 2 },
      ],
      pairings: [
        // A: R1 vs B — loss; R2 vs ? — win против rank=2 (это B)
        [
          { opponentRank: 2, color: 'white', result: 'loss' },
          { opponentRank: 2, color: 'black', result: 'win' },
        ],
        // B: R1 vs A — win; R2 vs A — loss
        [
          { opponentRank: 1, color: 'black', result: 'win' },
          { opponentRank: 1, color: 'white', result: 'loss' },
        ],
      ],
    };
    const r = sortCrosstableByPoints(response) as CrosstableSwiss;
    expect(r.players.map((p) => p.name)).toEqual(['B', 'A']);
    expect(r.players.map((p) => p.rank)).toEqual([1, 2]);
    // r.pairings[0] = бывший pairings B (rank=2 → 1).
    expect(r.pairings[0][0].opponentRank).toBe(2); // против A (новый rank=2)
    expect(r.pairings[0][0].result).toBe('win');
    expect(r.pairings[1][0].opponentRank).toBe(1); // против B (новый rank=1)
    expect(r.pairings[1][0].result).toBe('loss');
  });
});

describe('sortCrosstableByPoints — team', () => {
  it('teams сортируются по points DESC, players тоже', () => {
    const response: CrosstableTeam = {
      tournamentType: 'team-round-robin',
      sourceType: 'chess-results',
      sourceUrl: null,
      fetchedAt: null,
      players: [
        { rank: 1, name: 'P1', normalizedName: 'p1', points: 1, gamesPlayed: 2, team: 'X' },
        { rank: 2, name: 'P2', normalizedName: 'p2', points: 2, gamesPlayed: 2, team: 'Y' },
      ],
      teams: [
        { name: 'X', rank: 1, points: 5 },
        { name: 'Y', rank: 2, points: 8 },
      ],
    };
    const r = sortCrosstableByPoints(response) as CrosstableTeam;
    expect(r.teams[0].name).toBe('Y');
    expect(r.teams[0].rank).toBe(1);
    expect(r.teams[1].name).toBe('X');
    expect(r.players[0].name).toBe('P2');
    expect(r.players[0].rank).toBe(1);
  });
});

describe('sortCrosstableByPoints — legacy/unknown', () => {
  it('legacy — no-op', () => {
    const response = {
      tournamentType: 'unknown' as const,
      sourceType: 'internal-fallback' as const,
      sourceUrl: null,
      fetchedAt: null,
      players: [
        { rank: 1, name: 'A', normalizedName: 'a', points: 1, gamesPlayed: 2 },
      ],
      reason: 'legacy',
    };
    const r = sortCrosstableByPoints(response);
    expect(r).toBe(response);
  });
});
