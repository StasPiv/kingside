import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UserContext {
  profile: {
    username: string;
    ratingBullet: number;
    ratingBlitz: number;
    ratingRapid: number;
    ratingClassical: number;
    ratingPuzzle: number;
    gamesPlayedBullet: number;
    gamesPlayedBlitz: number;
    gamesPlayedRapid: number;
    gamesPlayedClassical: number;
    puzzleStreak: number;
    memberSince: string;
  };
  puzzleStats: {
    totalAttempted: number;
    totalSolved: number;
    solveRate: number;
    currentStreak: number;
  };
  recentGames: Array<{
    id: string;
    result: string | null;
    timeControlType: string;
    color: 'white' | 'black';
    opponentUsername: string;
    createdAt: string;
  }>;
  ratingHistory: Array<{
    date: string;
    rating: number;
  }>;
}

@Injectable()
export class ContextCollectorService {
  private readonly logger = new Logger(ContextCollectorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async collectContext(userId: string): Promise<UserContext> {
    const [user, puzzleStats, recentGames, ratingHistory] = await Promise.all([
      this.getProfile(userId),
      this.getPuzzleStats(userId),
      this.getRecentGames(userId),
      this.getRatingHistory(userId),
    ]);

    return { profile: user, puzzleStats, recentGames, ratingHistory };
  }

  private async getProfile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        username: true,
        ratingBullet: true, ratingBlitz: true, ratingRapid: true, ratingClassical: true, ratingPuzzle: true,
        gamesPlayedBullet: true, gamesPlayedBlitz: true, gamesPlayedRapid: true, gamesPlayedClassical: true,
        puzzleStreak: true, createdAt: true,
      },
    });

    return {
      username: user.username ?? 'Anonymous',
      ratingBullet: user.ratingBullet,
      ratingBlitz: user.ratingBlitz,
      ratingRapid: user.ratingRapid,
      ratingClassical: user.ratingClassical,
      ratingPuzzle: user.ratingPuzzle,
      gamesPlayedBullet: user.gamesPlayedBullet,
      gamesPlayedBlitz: user.gamesPlayedBlitz,
      gamesPlayedRapid: user.gamesPlayedRapid,
      gamesPlayedClassical: user.gamesPlayedClassical,
      puzzleStreak: user.puzzleStreak,
      memberSince: user.createdAt.toISOString().slice(0, 10),
    };
  }

  private async getPuzzleStats(userId: string) {
    const [totalAttempted, totalSolved] = await Promise.all([
      this.prisma.puzzleAttempt.count({ where: { userId } }),
      this.prisma.puzzleAttempt.count({ where: { userId, solved: true } }),
    ]);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { puzzleStreak: true },
    });

    return {
      totalAttempted,
      totalSolved,
      solveRate: totalAttempted > 0 ? Math.round((totalSolved / totalAttempted) * 100) : 0,
      currentStreak: user.puzzleStreak,
    };
  }

  private async getRecentGames(userId: string) {
    const games = await this.prisma.game.findMany({
      where: { OR: [{ whiteId: userId }, { blackId: userId }], status: 'finished' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, result: true, timeControlType: true, whiteId: true, blackId: true, createdAt: true,
        white: { select: { username: true } },
        black: { select: { username: true } },
      },
    });

    return games.map((g) => ({
      id: g.id,
      result: g.result,
      timeControlType: g.timeControlType,
      color: (g.whiteId === userId ? 'white' : 'black') as 'white' | 'black',
      opponentUsername: g.whiteId === userId ? (g.black?.username ?? '?') : (g.white?.username ?? '?'),
      createdAt: g.createdAt.toISOString(),
    }));
  }

  private async getRatingHistory(userId: string) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const snapshots = await this.prisma.puzzleRatingSnapshot.findMany({
      where: { userId, date: { gte: since } },
      orderBy: { date: 'asc' },
      select: { date: true, rating: true },
    });

    return snapshots.map((s) => ({
      date: s.date.toISOString().slice(0, 10),
      rating: s.rating,
    }));
  }
}
