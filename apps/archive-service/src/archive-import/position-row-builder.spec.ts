import { Chess } from 'chess.js';
import {
  POSITION_PLY_LIMIT,
  buildPositionRowsForGame,
  normalizeResult,
  serializePositionRowCsv,
  type PositionRow,
} from './position-row-builder';
import type { ParsedGame, GameMoveStep } from './pgn-utils';

const GAME_ID = '00000000-0000-0000-0000-000000000001';
const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Проигрываем UCI-список на chess.js, получаем GameMoveStep[]. */
function stepsFromUci(uciList: string[], startFen?: string): GameMoveStep[] {
  const chess = startFen ? new Chess(startFen) : new Chess();
  const steps: GameMoveStep[] = [];
  for (const u of uciList) {
    const from = u.slice(0, 2);
    const to = u.slice(2, 4);
    const promotion = u.length > 4 ? u.slice(4) : undefined;
    const res = chess.move({ from, to, promotion });
    if (!res) throw new Error(`bad uci: ${u}`);
    steps.push({ uci: u, fenAfter: chess.fen() });
  }
  return steps;
}

function mkGame(overrides: Partial<ParsedGame>): ParsedGame {
  return {
    white: 'W',
    black: 'B',
    whiteElo: 2400,
    blackElo: 2500,
    whiteTitle: null,
    blackTitle: null,
    event: null,
    site: null,
    round: null,
    date: '2025.01.01',
    playedAt: new Date('2025-01-01T00:00:00Z'),
    result: '1-0',
    eco: null,
    opening: null,
    plyCount: overrides.moves?.length ?? 0,
    moves: [],
    finalFen: STARTING_FEN,
    contentHash: Buffer.alloc(20),
    raw: '',
    timeControl: null,
    category: 'classical-legacy',
    isClassical: true,
    classificationReason: 'legacy_otb',
    ...overrides,
  };
}

describe('buildPositionRowsForGame', () => {
  it('Gherkin: партия 20 полуходов → 21 строка ply 0..20 с ожидаемыми полями', () => {
    const uci = [
      'e2e4', 'e7e5',
      'g1f3', 'b8c6',
      'f1c4', 'f8c5',
      'c2c3', 'g8f6',
      'd2d3', 'a7a6',
      'b1d2', 'd7d6',
      'e1g1', 'e8g8',
      'h2h3', 'h7h6',
      'f1e1', 'c8e6',
      'c4b3', 'd8d7',
    ];
    const moves = stepsFromUci(uci);
    const game = mkGame({ moves, plyCount: moves.length, result: '1-0' });

    const rows = buildPositionRowsForGame(GAME_ID, game, 'master');

    expect(rows).toHaveLength(21);
    expect(rows.map((r) => r.ply)).toEqual([...Array(21).keys()]);
    expect(rows[0].sideToMove).toBe('w');
    expect(rows[0].moveUci).toBe('e2e4');
    expect(rows[0].ply).toBe(0);
    expect(rows[1].sideToMove).toBe('b');
    expect(rows[1].moveUci).toBe('e7e5');
    expect(rows[20].ply).toBe(20);
    expect(rows[20].moveUci).toBeNull();
    for (const r of rows) {
      expect(r.gameId).toBe(GAME_ID);
      expect(r.bucket).toBe('master');
      expect(r.avgElo).toBe(2450); // (2400 + 2500) / 2
      expect(r.result).toBe('w');
      expect(r.playedAt?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
      expect(r.positionKey).toBeInstanceOf(Buffer);
      expect(r.positionKey.length).toBe(16);
    }
  });

  it('Gherkin: транспозиция → одна строка per-game', () => {
    const uci = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    const moves = stepsFromUci(uci);
    const game = mkGame({ moves, plyCount: moves.length });

    const rows = buildPositionRowsForGame(GAME_ID, game, 'master');

    const keys = rows.map((r) => r.positionKey.toString('hex'));
    const unique = new Set(keys);
    expect(unique.size).toBe(rows.length);

    const startKey = rows[0].positionKey.toString('hex');
    const occurrences = rows.filter(
      (r) => r.positionKey.toString('hex') === startKey,
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].ply).toBe(0);
  });

  it('Gherkin: партия 60 полуходов → только ply 0..POSITION_PLY_LIMIT', () => {
    const chess = new Chess();
    const moves: GameMoveStep[] = [];
    for (let i = 0; i < 60; i++) {
      const legal = chess.moves({ verbose: true }) as Array<{
        from: string;
        to: string;
        promotion?: string;
      }>;
      if (legal.length === 0) break;
      const m = legal[0];
      const res = chess.move({ from: m.from, to: m.to, promotion: m.promotion });
      if (!res) break;
      const uci = res.from + res.to + (res.promotion ?? '');
      moves.push({ uci, fenAfter: chess.fen() });
    }
    expect(moves.length).toBeGreaterThanOrEqual(POSITION_PLY_LIMIT + 1);

    const game = mkGame({ moves, plyCount: moves.length });
    const rows = buildPositionRowsForGame(GAME_ID, game, 'master');

    expect(rows.length).toBeLessThanOrEqual(POSITION_PLY_LIMIT + 1);
    for (const r of rows) {
      expect(r.ply).toBeLessThanOrEqual(POSITION_PLY_LIMIT);
      expect(r.ply).toBeGreaterThanOrEqual(0);
    }
  });

  it('avgElo = null если у одного из игроков Elo не указан', () => {
    const moves = stepsFromUci(['e2e4']);
    const game = mkGame({ moves, whiteElo: null, blackElo: 2500 });
    const rows = buildPositionRowsForGame(GAME_ID, game, 'master');
    expect(rows[0].avgElo).toBeNull();
  });

  it('result маппится: 1-0 → w, 0-1 → b, 1/2-1/2 → d, * → null', () => {
    expect(normalizeResult('1-0')).toBe('w');
    expect(normalizeResult('0-1')).toBe('b');
    expect(normalizeResult('1/2-1/2')).toBe('d');
    expect(normalizeResult('*')).toBeNull();
    expect(normalizeResult(null)).toBeNull();
  });

  it('Gherkin KS-1624: SetUp-партия (startFen задан) → rows = []', () => {
    const nonStartFen = 'r1bqkbnr/pppppppp/2n5/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const moves = stepsFromUci(['e2e4', 'c6e5'], nonStartFen);
    const game = mkGame({
      moves,
      plyCount: moves.length,
      startFen: nonStartFen,
    });

    const rows = buildPositionRowsForGame(GAME_ID, game, 'master');
    expect(rows).toEqual([]);
  });

  it('Gherkin KS-1624: обычная партия (startFen undefined) индексируется как раньше', () => {
    const moves = stepsFromUci(['e2e4', 'e7e5']);
    const game = mkGame({ moves, plyCount: moves.length });

    const rows = buildPositionRowsForGame(GAME_ID, game, 'master');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].ply).toBe(0);
    expect(rows[0].moveUci).toBe('e2e4');
    expect(rows[0].sideToMove).toBe('w');
  });
});

describe('serializePositionRowCsv', () => {
  it('сериализует все поля и использует \\x-префикс для bytea', () => {
    const row: PositionRow = {
      positionKey: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      bucket: 'master',
      gameId: GAME_ID,
      ply: 7,
      moveUci: 'e2e4',
      sideToMove: 'w',
      playedAt: new Date('2025-01-01T00:00:00Z'),
      avgElo: 2450,
      result: 'w',
    };
    const csv = serializePositionRowCsv(row);
    expect(csv).toBe(
      '\\x00112233445566778899aabbccddeeff,master,' +
        GAME_ID +
        ',7,e2e4,w,2025-01-01T00:00:00.000Z,2450,w\n',
    );
  });

  it("null-поля сериализуются как пустые поля (COPY NULL '')", () => {
    const row: PositionRow = {
      positionKey: Buffer.from('00', 'hex'),
      bucket: 'master',
      gameId: GAME_ID,
      ply: 0,
      moveUci: null,
      sideToMove: 'w',
      playedAt: null,
      avgElo: null,
      result: null,
    };
    const csv = serializePositionRowCsv(row);
    expect(csv).toBe(`\\x00,master,${GAME_ID},0,,w,,,\n`);
  });
});
