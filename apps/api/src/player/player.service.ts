import { Injectable, NotFoundException } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type {
  RatingType,
  TopPlayersResponse,
  OnlinePlayersResponse,
  PlayerProfileResponse,
  SearchPlayersResponse,
} from '@kingside/shared';

const RATING_FIELD_MAP: Record<RatingType, string> = {
  bullet: 'ratingBullet',
  blitz: 'ratingBlitz',
  rapid: 'ratingRapid',
  classical: 'ratingClassical',
  puzzle: 'ratingPuzzle',
};

const GAMES_PLAYED_FIELD_MAP: Record<string, string> = {
  bullet: 'gamesPlayedBullet',
  blitz: 'gamesPlayedBlitz',
  rapid: 'gamesPlayedRapid',
  classical: 'gamesPlayedClassical',
};

/** Users seen within last 5 minutes are considered online */
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

@Injectable()
export class PlayerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly i18n: I18nService,
  ) {}

  async getTopPlayers(
    type: RatingType = 'blitz',
    limit = 20,
    offset = 0,
  ): Promise<TopPlayersResponse> {
    const ratingField = RATING_FIELD_MAP[type];
    const gamesField = GAMES_PLAYED_FIELD_MAP[type];
    const safeLimit = Math.min(limit, 100);

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { username: { not: null }, isBot: false },
        orderBy: { [ratingField]: 'desc' },
        take: safeLimit,
        skip: offset,
        select: {
          id: true,
          username: true,
          ratingBullet: true,
          ratingBlitz: true,
          ratingRapid: true,
          ratingClassical: true,
          ratingPuzzle: true,
          gamesPlayedBullet: true,
          gamesPlayedBlitz: true,
          gamesPlayedRapid: true,
          gamesPlayedClassical: true,
        },
      }),
      this.prisma.user.count({
        where: { username: { not: null }, isBot: false },
      }),
    ]);

    // For puzzle type, fetch puzzle rush stats for each user
    let puzzleRushMap: Map<string, { best3: number; best5: number; totalSessions: number }> | null = null;
    if (type === 'puzzle') {
      const userIds = users.map((u) => u.id);
      puzzleRushMap = await this.getPuzzleRushStatsForUsers(userIds);
    }

    const data = users.map((user, index) => {
      const item: Record<string, unknown> = {
        rank: offset + index + 1,
        id: user.id,
        username: user.username!,
        rating: user[ratingField as keyof typeof user] as number,
        gamesPlayed: gamesField
          ? (user[gamesField as keyof typeof user] as number)
          : 0,
      };

      if (puzzleRushMap) {
        item.puzzleRush = puzzleRushMap.get(user.id) ?? { best3: 0, best5: 0, totalSessions: 0 };
      }

      return item;
    });

    return { data, total, ratingType: type };
  }

  async getOnlinePlayers(
    limit = 50,
    offset = 0,
  ): Promise<OnlinePlayersResponse> {
    const safeLimit = Math.min(limit, 100);
    const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS);

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          username: { not: null },
          isBot: false,
          lastSeenAt: { gte: threshold },
        },
        orderBy: { lastSeenAt: 'desc' },
        take: safeLimit,
        skip: offset,
        select: {
          id: true,
          username: true,
          ratingBullet: true,
          ratingBlitz: true,
          ratingRapid: true,
          ratingClassical: true,
        },
      }),
      this.prisma.user.count({
        where: {
          username: { not: null },
          isBot: false,
          lastSeenAt: { gte: threshold },
        },
      }),
    ]);

    const data = users.map((user) => ({
      id: user.id,
      username: user.username!,
      ratingBullet: user.ratingBullet,
      ratingBlitz: user.ratingBlitz,
      ratingRapid: user.ratingRapid,
      ratingClassical: user.ratingClassical,
    }));

    return { data, total };
  }

  async getPlayerProfile(username: string): Promise<PlayerProfileResponse> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
        ratingPuzzle: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    const [wins, losses, draws, recentGames, puzzleRush] = await Promise.all([
      this.prisma.game.count({
        where: {
          status: 'finished',
          OR: [
            { whiteId: user.id, result: 'white' },
            { blackId: user.id, result: 'black' },
          ],
        },
      }),
      this.prisma.game.count({
        where: {
          status: 'finished',
          OR: [
            { whiteId: user.id, result: 'black' },
            { blackId: user.id, result: 'white' },
          ],
        },
      }),
      this.prisma.game.count({
        where: {
          status: 'finished',
          result: 'draw',
          OR: [{ whiteId: user.id }, { blackId: user.id }],
        },
      }),
      this.prisma.game.findMany({
        where: {
          status: 'finished',
          OR: [{ whiteId: user.id }, { blackId: user.id }],
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          whiteId: true,
          blackId: true,
          result: true,
          timeControlType: true,
          timeInitialSec: true,
          timeIncrementSec: true,
          createdAt: true,
          white: { select: { id: true, username: true } },
          black: { select: { id: true, username: true } },
        },
      }),
      this.getPuzzleRushStatsForUser(user.id),
    ]);

    const recentGamesData = recentGames.map((game) => {
      const isWhite = game.whiteId === user.id;
      const playerColor = isWhite ? ('white' as const) : ('black' as const);
      const opponent = isWhite ? game.black : game.white;

      let playerResult: 'win' | 'loss' | 'draw' | null;
      if (game.result === null) {
        playerResult = null;
      } else if (game.result === 'draw') {
        playerResult = 'draw';
      } else if (game.result === playerColor) {
        playerResult = 'win';
      } else {
        playerResult = 'loss';
      }

      const minutes = Math.floor(game.timeInitialSec / 60);
      const timeControl = `${minutes}+${game.timeIncrementSec}`;

      return {
        id: game.id,
        playerColor,
        playerResult,
        opponent: { id: opponent.id, username: opponent.username! },
        timeControlType: game.timeControlType,
        timeControl,
        createdAt: game.createdAt.toISOString(),
      };
    });

    return {
      id: user.id,
      username: user.username!,
      ratings: {
        bullet: user.ratingBullet,
        blitz: user.ratingBlitz,
        rapid: user.ratingRapid,
        classical: user.ratingClassical,
        puzzle: user.ratingPuzzle,
      },
      stats: {
        wins,
        losses,
        draws,
        totalGames: wins + losses + draws,
      },
      createdAt: user.createdAt.toISOString(),
      lastSeenAt: user.lastSeenAt.toISOString(),
      recentGames: recentGamesData,
      puzzleRush,
    };
  }

  async searchPlayers(
    query: string,
    limit = 20,
  ): Promise<SearchPlayersResponse> {
    const safeLimit = Math.min(limit, 50);

    const users = await this.prisma.user.findMany({
      where: {
        username: { contains: query, mode: 'insensitive' },
        isBot: false,
      },
      orderBy: { ratingBlitz: 'desc' },
      take: safeLimit,
      select: {
        id: true,
        username: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
      },
    });

    const data = users.map((user) => ({
      id: user.id,
      username: user.username!,
      ratingBullet: user.ratingBullet,
      ratingBlitz: user.ratingBlitz,
      ratingRapid: user.ratingRapid,
      ratingClassical: user.ratingClassical,
    }));

    return { data };
  }

  private async getPuzzleRushStatsForUser(
    userId: string,
  ): Promise<{ best3: number; best5: number; totalSessions: number }> {
    const [best3, best5, totalSessions] = await Promise.all([
      this.prisma.puzzleRushScore.findFirst({
        where: { userId, timeMode: '3' },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
      this.prisma.puzzleRushScore.findFirst({
        where: { userId, timeMode: '5' },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
      this.prisma.puzzleRushScore.count({ where: { userId } }),
    ]);

    return {
      best3: best3?.score ?? 0,
      best5: best5?.score ?? 0,
      totalSessions,
    };
  }

  private async getPuzzleRushStatsForUsers(
    userIds: string[],
  ): Promise<Map<string, { best3: number; best5: number; totalSessions: number }>> {
    const results = await Promise.all(
      userIds.map(async (id) => {
        const stats = await this.getPuzzleRushStatsForUser(id);
        return [id, stats] as const;
      }),
    );
    return new Map(results);
  }
}
