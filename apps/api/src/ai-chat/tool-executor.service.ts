import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute(tool: string, userId: string, params: Record<string, string>): Promise<unknown> {
    const limit = Math.min(parseInt(params.limit || '10', 10), 20);
    switch (tool) {
      case 'get_user_analyses': return this.getUserAnalyses(userId, limit);
      case 'get_game_details': return this.getGameDetails(params.gameId, userId);
      case 'get_user_tournaments': return this.getUserTournaments(userId);
      case 'search_games': return this.searchGames(userId, params, limit);
      case 'get_puzzle_stats_by_theme': return this.getPuzzleStatsByTheme(userId);
      case 'navigate': return { action: 'navigate', url: params.url, description: params.description };
      // New tools
      case 'get_user_profile': return this.getUserProfile(userId);
      case 'get_player_profile': return this.getPlayerProfile(params.username);
      case 'get_friends': return this.getFriends(userId);
      case 'get_online_players': return this.getOnlinePlayers(limit);
      case 'get_daily_puzzle': return this.getDailyPuzzle();
      case 'get_puzzle_rush_leaderboard': return this.getPuzzleRushLeaderboard(limit);
      case 'get_puzzle_rating_history': return this.getPuzzleRatingHistory(userId, parseInt(params.days || '30', 10));
      case 'get_broadcasts': return this.getBroadcasts(limit);
      case 'get_workshop_files': return this.getWorkshopFiles(userId, limit);
      case 'get_feedback_list': return this.getFeedbackList(params, limit);
      case 'get_user_settings': return this.getUserSettings(userId);
      case 'get_game_history': return this.getGameHistory(userId, limit, parseInt(params.offset || '0', 10));
      case 'get_active_games': return this.getActiveGames(userId);
      default: throw new NotFoundException(`Unknown tool: ${tool}`);
    }
  }

  // --- Existing tools ---

  private async getUserAnalyses(userId: string, limit: number) {
    const analyses = await this.prisma.analysis.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, title: true, pgn: true, createdAt: true },
    });
    return analyses.map((a) => ({
      id: a.id, title: a.title,
      pgnPreview: a.pgn?.slice(0, 200) ?? null,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  private async getGameDetails(gameId: string, userId: string) {
    if (!gameId) throw new NotFoundException('gameId required');
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: {
        id: true, status: true, result: true, termination: true,
        timeControlType: true, timeInitialSec: true, timeIncrementSec: true,
        pgn: true, eco: true, createdAt: true, isBot: true, botLevel: true,
        white: { select: { id: true, username: true } },
        black: { select: { id: true, username: true } },
        whiteRatingBefore: true, blackRatingBefore: true,
        whiteRatingAfter: true, blackRatingAfter: true,
      },
    });
    if (!game) throw new NotFoundException('Game not found');
    const playerColor = game.white.id === userId ? 'white' : game.black.id === userId ? 'black' : null;
    return {
      id: game.id, status: game.status, result: game.result, termination: game.termination,
      timeControl: `${Math.floor(game.timeInitialSec / 60)}+${game.timeIncrementSec}`,
      timeControlType: game.timeControlType, eco: game.eco,
      white: { username: game.white.username, ratingBefore: game.whiteRatingBefore, ratingAfter: game.whiteRatingAfter },
      black: { username: game.black.username, ratingBefore: game.blackRatingBefore, ratingAfter: game.blackRatingAfter },
      playerColor, isBot: game.isBot, botLevel: game.botLevel,
      createdAt: game.createdAt.toISOString(),
      pgnPreview: game.pgn?.slice(0, 300) ?? null,
    };
  }

  private async getUserTournaments(userId: string) {
    const tournaments = await this.prisma.arenaTournament.findMany({
      where: { OR: [{ createdBy: userId }, { entries: { some: { userId } } }] },
      orderBy: { startsAt: 'desc' },
      take: 10,
      select: {
        id: true, name: true, type: true, status: true, timeControlType: true,
        startsAt: true, finishesAt: true,
        _count: { select: { entries: true } },
        entries: { where: { userId }, select: { score: true, wins: true, draws: true, losses: true } },
      },
    });
    return tournaments.map((t) => ({
      id: t.id, name: t.name, type: t.type, status: t.status,
      timeControlType: t.timeControlType, playerCount: t._count.entries,
      startsAt: t.startsAt.toISOString(), finishesAt: t.finishesAt.toISOString(),
      myEntry: t.entries[0] ?? null,
    }));
  }

  private async searchGames(userId: string, params: Record<string, string>, limit: number) {
    const where: Record<string, unknown> = {
      status: 'finished',
      OR: [{ whiteId: userId }, { blackId: userId }],
    };
    if (params.timeControlType) where.timeControlType = params.timeControlType;
    if (params.result) where.result = params.result;
    if (params.opponent) {
      const opp = await this.prisma.user.findFirst({ where: { username: params.opponent }, select: { id: true } });
      if (opp) {
        where.OR = [
          { whiteId: userId, blackId: opp.id },
          { blackId: userId, whiteId: opp.id },
        ];
      }
    }
    const games = await this.prisma.game.findMany({
      where, orderBy: { createdAt: 'desc' }, take: limit,
      select: {
        id: true, result: true, termination: true, timeControlType: true,
        createdAt: true, whiteId: true,
        white: { select: { username: true } },
        black: { select: { username: true } },
      },
    });
    return games.map((g) => ({
      id: g.id, result: g.result, termination: g.termination,
      timeControlType: g.timeControlType,
      playerColor: g.whiteId === userId ? 'white' : 'black',
      opponent: g.whiteId === userId ? g.black.username : g.white.username,
      createdAt: g.createdAt.toISOString(),
    }));
  }

  private async getPuzzleStatsByTheme(userId: string) {
    const raw = await this.prisma.$queryRaw<Array<{ themes: string; total: bigint; solved: bigint }>>`
      SELECT p.themes, COUNT(*)::bigint as total, SUM(CASE WHEN pa.solved THEN 1 ELSE 0 END)::bigint as solved
      FROM puzzle_attempts pa JOIN puzzles p ON pa.puzzle_id = p.id
      WHERE pa.user_id = ${userId}::uuid AND p.themes != ''
      GROUP BY p.themes
    `;
    const themeMap = new Map<string, { attempted: number; solved: number }>();
    for (const row of raw) {
      for (const theme of row.themes.split(' ').filter(Boolean)) {
        const e = themeMap.get(theme) ?? { attempted: 0, solved: 0 };
        e.attempted += Number(row.total);
        e.solved += Number(row.solved);
        themeMap.set(theme, e);
      }
    }
    return Array.from(themeMap.entries())
      .map(([theme, s]) => ({ theme, attempted: s.attempted, solved: s.solved, rate: s.attempted > 0 ? Math.round((s.solved / s.attempted) * 100) : 0 }))
      .sort((a, b) => b.attempted - a.attempted).slice(0, 15);
  }

  // --- New tools ---

  private async getUserProfile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, username: true,
        ratingBullet: true, ratingBlitz: true, ratingRapid: true, ratingClassical: true, ratingPuzzle: true,
        gamesPlayedBullet: true, gamesPlayedBlitz: true, gamesPlayedRapid: true, gamesPlayedClassical: true,
        puzzleStreak: true, createdAt: true, lastSeenAt: true,
        boardTheme: true, pieceSet: true, locale: true,
      },
    });
    return {
      ...user,
      createdAt: user.createdAt.toISOString(),
      lastSeenAt: user.lastSeenAt.toISOString(),
    };
  }

  private async getPlayerProfile(username: string) {
    if (!username) throw new NotFoundException('username required');
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true, username: true, isBot: true,
        ratingBullet: true, ratingBlitz: true, ratingRapid: true, ratingClassical: true, ratingPuzzle: true,
        createdAt: true, lastSeenAt: true,
      },
    });
    if (!user) throw new NotFoundException('Player not found');
    return { ...user, createdAt: user.createdAt.toISOString(), lastSeenAt: user.lastSeenAt.toISOString() };
  }

  private async getFriends(userId: string) {
    const friendships = await this.prisma.friendship.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }], status: 'ACCEPTED' },
      include: {
        requester: { select: { id: true, username: true, lastSeenAt: true } },
        addressee: { select: { id: true, username: true, lastSeenAt: true } },
      },
    });
    const threshold = Date.now() - 5 * 60 * 1000;
    return friendships.map((f) => {
      const friend = f.requesterId === userId ? f.addressee : f.requester;
      return {
        id: friend.id, username: friend.username,
        online: friend.lastSeenAt.getTime() > threshold,
      };
    });
  }

  private async getOnlinePlayers(limit: number) {
    const threshold = new Date(Date.now() - 5 * 60 * 1000);
    const users = await this.prisma.user.findMany({
      where: { username: { not: null }, lastSeenAt: { gte: threshold } },
      orderBy: { lastSeenAt: 'desc' },
      take: limit,
      select: { id: true, username: true, ratingBlitz: true, isBot: true },
    });
    return users.map((u) => ({ id: u.id, username: u.username, ratingBlitz: u.ratingBlitz, isBot: u.isBot }));
  }

  private async getDailyPuzzle() {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const daily = await this.prisma.dailyPuzzle.findFirst({
      where: { date: today },
      include: { puzzle: { select: { id: true, fen: true, rating: true, themes: true } } },
    });
    if (!daily?.puzzle) return { message: 'No daily puzzle today' };
    return {
      id: daily.puzzle.id, fen: daily.puzzle.fen,
      rating: daily.puzzle.rating,
      themes: daily.puzzle.themes.split(' ').filter(Boolean),
      date: today.toISOString().slice(0, 10),
    };
  }

  private async getPuzzleRushLeaderboard(limit: number) {
    const scores = await this.prisma.puzzleRushScore.findMany({
      orderBy: { score: 'desc' },
      take: limit,
      select: { score: true, timeMode: true, createdAt: true, user: { select: { username: true } } },
    });
    return scores.map((s, i) => ({
      rank: i + 1, username: s.user.username, score: s.score,
      timeMode: s.timeMode, date: s.createdAt.toISOString().slice(0, 10),
    }));
  }

  private async getPuzzleRatingHistory(userId: string, days: number) {
    const since = new Date();
    since.setDate(since.getDate() - Math.min(days, 365));
    const snapshots = await this.prisma.puzzleRatingSnapshot.findMany({
      where: { userId, date: { gte: since } },
      orderBy: { date: 'asc' },
      select: { date: true, rating: true, attempts: true, solved: true },
    });
    return snapshots.map((s) => ({
      date: s.date.toISOString().slice(0, 10), rating: s.rating,
      attempts: s.attempts, solved: s.solved,
    }));
  }

  private async getBroadcasts(limit: number) {
    const broadcasts = await this.prisma.broadcast.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, title: true, description: true, isActive: true, url: true, createdAt: true },
    });
    return broadcasts.map((b) => ({
      id: b.id, title: b.title, description: b.description,
      isActive: b.isActive, url: b.url, createdAt: b.createdAt.toISOString(),
    }));
  }

  private async getWorkshopFiles(userId: string, limit: number) {
    const files = await this.prisma.pgnImport.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, fileName: true, createdAt: true, _count: { select: { games: true } } },
    });
    return files.map((f) => ({
      id: f.id, fileName: f.fileName, gameCount: f._count.games,
      createdAt: f.createdAt.toISOString(),
    }));
  }

  private async getFeedbackList(params: Record<string, string>, limit: number) {
    const where: Record<string, unknown> = { isPublic: true };
    if (params.type) where.type = params.type;
    if (params.status) where.status = params.status;
    const sort = params.sort === 'popular' ? { voteCount: 'desc' as const } : { createdAt: 'desc' as const };
    const items = await this.prisma.feedback.findMany({
      where, orderBy: sort, take: limit,
      select: {
        id: true, title: true, type: true, message: true, status: true,
        voteCount: true, createdAt: true,
        user: { select: { username: true } },
        _count: { select: { comments: true } },
      },
    });
    return items.map((f) => ({
      id: f.id, title: f.title, type: f.type, status: f.status,
      messagePreview: f.message.slice(0, 150),
      voteCount: f.voteCount, commentCount: f._count.comments,
      author: f.user?.username ?? 'anonymous',
      createdAt: f.createdAt.toISOString(),
    }));
  }

  private async getUserSettings(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        locale: true, boardTheme: true, pieceSet: true, soundEnabled: true,
        chesscomUsername: true, lichessUsername: true,
      },
    });
    return user;
  }

  private async getGameHistory(userId: string, limit: number, offset: number) {
    const [games, total] = await Promise.all([
      this.prisma.game.findMany({
        where: { status: 'finished', OR: [{ whiteId: userId }, { blackId: userId }] },
        orderBy: { createdAt: 'desc' },
        take: limit, skip: offset,
        select: {
          id: true, result: true, termination: true, timeControlType: true, eco: true,
          createdAt: true, whiteId: true, isBot: true,
          white: { select: { username: true } },
          black: { select: { username: true } },
        },
      }),
      this.prisma.game.count({
        where: { status: 'finished', OR: [{ whiteId: userId }, { blackId: userId }] },
      }),
    ]);
    return {
      total,
      games: games.map((g) => ({
        id: g.id, result: g.result, termination: g.termination,
        timeControlType: g.timeControlType, eco: g.eco, isBot: g.isBot,
        playerColor: g.whiteId === userId ? 'white' : 'black',
        opponent: g.whiteId === userId ? g.black.username : g.white.username,
        createdAt: g.createdAt.toISOString(),
      })),
    };
  }

  private async getActiveGames(userId: string) {
    const games = await this.prisma.game.findMany({
      where: { status: 'active', OR: [{ whiteId: userId }, { blackId: userId }] },
      select: {
        id: true, timeControlType: true, isBot: true, whiteId: true,
        white: { select: { username: true } },
        black: { select: { username: true } },
      },
    });
    return games.map((g) => ({
      id: g.id, timeControlType: g.timeControlType, isBot: g.isBot,
      playerColor: g.whiteId === userId ? 'white' : 'black',
      opponent: g.whiteId === userId ? g.black.username : g.white.username,
    }));
  }
}
