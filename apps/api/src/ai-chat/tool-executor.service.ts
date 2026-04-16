import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute(tool: string, userId: string, params: Record<string, string>): Promise<unknown> {
    switch (tool) {
      case 'get_user_analyses':
        return this.getUserAnalyses(userId, parseInt(params.limit || '10', 10));
      case 'get_game_details':
        return this.getGameDetails(params.gameId, userId);
      case 'get_user_tournaments':
        return this.getUserTournaments(userId);
      case 'search_games':
        return this.searchGames(userId, params);
      case 'get_puzzle_stats_by_theme':
        return this.getPuzzleStatsByTheme(userId);
      case 'navigate':
        return { action: 'navigate', url: params.url, description: params.description };
      default:
        throw new NotFoundException(`Unknown tool: ${tool}`);
    }
  }

  private async getUserAnalyses(userId: string, limit: number) {
    const analyses = await this.prisma.analysis.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 20),
      select: { id: true, title: true, pgn: true, createdAt: true },
    });
    return analyses.map((a) => ({
      id: a.id,
      title: a.title,
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
      where: {
        OR: [
          { createdBy: userId },
          { entries: { some: { userId } } },
        ],
      },
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
      timeControlType: t.timeControlType,
      playerCount: t._count.entries,
      startsAt: t.startsAt.toISOString(),
      finishesAt: t.finishesAt.toISOString(),
      myEntry: t.entries[0] ?? null,
    }));
  }

  private async searchGames(userId: string, params: Record<string, string>) {
    const where: Record<string, unknown> = {
      status: 'finished',
      OR: [{ whiteId: userId }, { blackId: userId }],
    };
    if (params.timeControlType) where.timeControlType = params.timeControlType;
    if (params.result) where.result = params.result;

    const games = await this.prisma.game.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(params.limit || '10', 10), 20),
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
      FROM puzzle_attempts pa
      JOIN puzzles p ON pa.puzzle_id = p.id
      WHERE pa.user_id = ${userId}::uuid AND p.themes != ''
      GROUP BY p.themes
    `;

    const themeMap = new Map<string, { attempted: number; solved: number }>();
    for (const row of raw) {
      for (const theme of row.themes.split(' ').filter(Boolean)) {
        const existing = themeMap.get(theme) ?? { attempted: 0, solved: 0 };
        existing.attempted += Number(row.total);
        existing.solved += Number(row.solved);
        themeMap.set(theme, existing);
      }
    }

    return Array.from(themeMap.entries())
      .map(([theme, stats]) => ({
        theme,
        attempted: stats.attempted,
        solved: stats.solved,
        rate: stats.attempted > 0 ? Math.round((stats.solved / stats.attempted) * 100) : 0,
      }))
      .sort((a, b) => b.attempted - a.attempted)
      .slice(0, 15);
  }
}
