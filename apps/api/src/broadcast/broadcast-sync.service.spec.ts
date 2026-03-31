jest.mock('../prisma/prisma.service', () => ({ PrismaService: jest.fn() }));
jest.mock('../redis/redis.service', () => ({ RedisService: jest.fn() }));

import { BroadcastSyncService } from './broadcast-sync.service';

type ParsedGame = {
  index: number;
  white: string;
  black: string;
  result: string;
  fen: string;
  uci: string;
  pgn: string;
  lichessGameId: string | null;
};

describe('BroadcastSyncService', () => {
  let service: BroadcastSyncService;
  let prisma: any;
  let redis: any;

  beforeEach(() => {
    prisma = {
      broadcast: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn(),
      },
      broadcastRound: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn(),
      },
      broadcastGame: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockResolvedValue(undefined),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    redis = {
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      keys: jest.fn().mockResolvedValue([]),
      quit: jest.fn().mockResolvedValue(undefined),
    };

    service = new BroadcastSyncService(prisma, redis);
  });

  describe('parsePgnGames (private)', () => {
    const parse = (pgn: string): ParsedGame[] =>
      (service as any).parsePgnGames(pgn) as ParsedGame[];

    it('should return empty array for empty PGN', () => {
      expect(parse('')).toEqual([]);
    });

    it('should parse a single game with FEN header', () => {
      const pgn = `[White "Carlsen, Magnus"]
[Black "Nepomniachtchi, Ian"]
[Result "*"]
[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]
[Site "https://lichess.org/abcdef12"]
[LastMove "e2e4"]

1. e4 *`;

      const games = parse(pgn);
      expect(games).toHaveLength(1);
      expect(games[0].white).toBe('Carlsen, Magnus');
      expect(games[0].black).toBe('Nepomniachtchi, Ian');
      expect(games[0].fen).toBe(
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      );
      expect(games[0].uci).toBe('e2e4');
      expect(games[0].lichessGameId).toBe('abcdef12');
      expect(games[0].index).toBe(0);
    });

    it('should parse multiple games and assign sequential indices', () => {
      const pgn = `[White "Player A"]
[Black "Player B"]
[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]
[Site "https://lichess.org/game001"]

1. d4 *

[White "Player C"]
[Black "Player D"]
[FEN "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1"]
[Site "https://lichess.org/game002"]

1. d4 d5 *`;

      const games = parse(pgn);
      expect(games).toHaveLength(2);
      expect(games[0].index).toBe(0);
      expect(games[0].lichessGameId).toBe('game001');
      expect(games[1].index).toBe(1);
      expect(games[1].lichessGameId).toBe('game002');
    });

    it('should compute FEN from moves when FEN header is absent', () => {
      const pgn = `[White "Player A"]
[Black "Player B"]
[Site "https://lichess.org/gameabc1"]

1. e4 e5 *`;

      const games = parse(pgn);
      expect(games).toHaveLength(1);
      // FEN should reflect position after 1. e4 e5, not starting FEN
      expect(games[0].fen).toBe(
        'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      );
      expect(games[0].white).toBe('Player A');
      expect(games[0].black).toBe('Player B');
    });

    it('should fall back to starting FEN when no FEN header and no moves', () => {
      const pgn = `[White "Player A"]
[Black "Player B"]
[Site "https://lichess.org/gameabc2"]
[Result "*"]

*`;

      const games = parse(pgn);
      expect(games).toHaveLength(1);
      expect(games[0].fen).toBe(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      );
    });

    it('should use Unknown for missing player headers', () => {
      const pgn = `[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]

1. e4 *`;

      const games = parse(pgn);
      expect(games).toHaveLength(1);
      expect(games[0].white).toBe('Unknown');
      expect(games[0].black).toBe('Unknown');
    });

    it('should handle PGN with inline comments in curly braces', () => {
      const pgn = `[White "Carlsen, Magnus"]
[Black "Nepomniachtchi, Ian"]
[Site "https://lichess.org/abc123"]

1. e4 {[%clk 1:29:50]} 1... e5 {[%clk 1:29:45]} *`;

      const games = parse(pgn);
      expect(games).toHaveLength(1);
      expect(games[0].fen).toBe(
        'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      );
    });

    it('should use move-by-move fallback when loadPgn fails', () => {
      // Simulate PGN that loadPgn cannot handle but moves are valid SAN
      // Use a malformed movetext that confuses loadPgn but individual moves are fine
      const pgn = `[White "Player A"]
[Black "Player B"]
[Site "https://lichess.org/fallback1"]

1. d4 INVALID_TOKEN d5 2. c4 e6 *`;

      const games = parse(pgn);
      expect(games).toHaveLength(1);
      // Fallback should parse d4 and stop at INVALID_TOKEN
      expect(games[0].fen).toBe(
        'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1',
      );
    });

    it('should filter out NDJSON lines mixed with PGN', () => {
      const pgn = `{"type":"featured","data":{"id":"abc"}}
[White "Player A"]
[Black "Player B"]
[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]
[Site "https://lichess.org/game001"]

1. e4 *`;

      const games = parse(pgn);
      expect(games).toHaveLength(1);
      expect(games[0].white).toBe('Player A');
    });

    it('should return empty uci when LastMove header is absent', () => {
      const pgn = `[White "A"]
[Black "B"]
[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]

1. e4 *`;

      const games = parse(pgn);
      expect(games[0].uci).toBe('');
    });
  });

  describe('fetchFinishedRoundGamesIfEmpty (private)', () => {
    const fetch = global.fetch as jest.Mock;

    beforeEach(() => {
      global.fetch = jest.fn();
    });

    afterEach(() => {
      global.fetch = fetch;
    });

    it('should skip fetch when games with real FEN already exist', async () => {
      prisma.broadcastRound.findUnique.mockResolvedValue({ id: 'round-db-id' });
      // count returns > 0, meaning games with non-starting FEN exist
      prisma.broadcastGame.count.mockResolvedValue(5);
      redis.get.mockResolvedValue(null);

      await (service as any).fetchFinishedRoundGamesIfEmpty('lichess-round-id');

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should skip fetch when round not found', async () => {
      prisma.broadcastRound.findUnique.mockResolvedValue(null);
      redis.get.mockResolvedValue(null);

      await (service as any).fetchFinishedRoundGamesIfEmpty('lichess-round-id');

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should skip fetch when cooldown is active', async () => {
      prisma.broadcastRound.findUnique.mockResolvedValue({ id: 'round-db-id' });
      prisma.broadcastGame.count.mockResolvedValue(0);
      redis.get.mockResolvedValue('1');

      await (service as any).fetchFinishedRoundGamesIfEmpty('lichess-round-id');

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should fetch PGN when round has no games and no cooldown', async () => {
      prisma.broadcastRound.findUnique.mockResolvedValue({ id: 'round-db-id' });
      prisma.broadcastGame.count.mockResolvedValue(0);
      redis.get.mockResolvedValue(null);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(''),
      });

      await (service as any).fetchFinishedRoundGamesIfEmpty('lichess-round-id');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://lichess.org/api/broadcast/round/lichess-round-id.pgn',
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });

    it('should set cooldown on fetch error', async () => {
      prisma.broadcastRound.findUnique.mockResolvedValue({ id: 'round-db-id' });
      prisma.broadcastGame.count.mockResolvedValue(0);
      redis.get.mockResolvedValue(null);
      (global.fetch as jest.Mock).mockRejectedValue(new Error('fetch failed'));

      await (service as any).fetchFinishedRoundGamesIfEmpty('lichess-round-id');

      expect(redis.set).toHaveBeenCalledWith(
        'broadcast:pgn-fetch-cooldown:lichess-round-id',
        '1',
        'EX',
        3600,
      );
    });

    it('should set cooldown on non-ok HTTP response', async () => {
      prisma.broadcastRound.findUnique.mockResolvedValue({ id: 'round-db-id' });
      prisma.broadcastGame.count.mockResolvedValue(0);
      redis.get.mockResolvedValue(null);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 404,
      });

      await (service as any).fetchFinishedRoundGamesIfEmpty('lichess-round-id');

      expect(redis.set).toHaveBeenCalledWith(
        'broadcast:pgn-fetch-cooldown:lichess-round-id',
        '1',
        'EX',
        3600,
      );
    });

    it('should set cooldown when PGN response is empty', async () => {
      prisma.broadcastRound.findUnique.mockResolvedValue({ id: 'round-db-id' });
      prisma.broadcastGame.count.mockResolvedValue(0);
      redis.get.mockResolvedValue(null);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue('   '),
      });

      await (service as any).fetchFinishedRoundGamesIfEmpty('lichess-round-id');

      expect(redis.set).toHaveBeenCalledWith(
        'broadcast:pgn-fetch-cooldown:lichess-round-id',
        '1',
        'EX',
        3600,
      );
    });
  });

  describe('getGameFens', () => {
    it('should return sorted list of fens from Redis', async () => {
      redis.keys.mockResolvedValue([
        'broadcast:fen:round1:2',
        'broadcast:fen:round1:0',
        'broadcast:fen:round1:1',
      ]);
      redis.get
        .mockResolvedValueOnce('fen2')
        .mockResolvedValueOnce('fen0')
        .mockResolvedValueOnce('fen1');

      const result = await service.getGameFens('round1');
      expect(result).toEqual([
        { index: 0, fen: 'fen0' },
        { index: 1, fen: 'fen1' },
        { index: 2, fen: 'fen2' },
      ]);
    });

    it('should return empty array when no fens in Redis', async () => {
      redis.keys.mockResolvedValue([]);
      const result = await service.getGameFens('round1');
      expect(result).toEqual([]);
    });
  });
});
