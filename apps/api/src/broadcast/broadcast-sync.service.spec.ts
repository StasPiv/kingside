jest.mock('../prisma/prisma.service', () => ({ PrismaService: jest.fn() }));
jest.mock('../redis/redis.service', () => ({ RedisService: jest.fn() }));

import { BroadcastSyncService } from './broadcast-sync.service';

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
    const parse = (pgn: string) =>
      (service as any).parsePgnGames(pgn) as ReturnType<
        typeof service['parsePgnGames' & keyof typeof service]
      >;

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

    it('should skip games without FEN header', () => {
      const pgn = `[White "Player A"]
[Black "Player B"]

1. e4 e5 *`;

      const games = parse(pgn);
      expect(games).toHaveLength(0);
    });

    it('should use Unknown for missing player headers', () => {
      const pgn = `[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]

1. e4 *`;

      const games = parse(pgn);
      expect(games).toHaveLength(1);
      expect(games[0].white).toBe('Unknown');
      expect(games[0].black).toBe('Unknown');
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
