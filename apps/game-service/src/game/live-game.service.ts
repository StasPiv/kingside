import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** Default spectator delay in milliseconds */
const DEFAULT_SPECTATOR_DELAY_MS = 5000;

@Injectable()
export class LiveGameService {
  readonly spectatorDelayMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const delaySec = this.config.get<number>('SPECTATOR_DELAY_SEC');
    this.spectatorDelayMs = delaySec
      ? delaySec * 1000
      : DEFAULT_SPECTATOR_DELAY_MS;
  }

  async getLiveGames(
    type?: string,
    player?: string,
    limit = 20,
    offset = 0,
  ) {
    const safeLimit = Math.min(limit, 100);

    const where: Record<string, unknown> = { status: 'active' };

    if (type) {
      where.timeControlType = type;
    }

    if (player) {
      where.OR = [
        { white: { username: { contains: player, mode: 'insensitive' } } },
        { black: { username: { contains: player, mode: 'insensitive' } } },
      ];
    }

    const [games, total] = await Promise.all([
      this.prisma.game.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: safeLimit,
        skip: offset,
        select: {
          id: true,
          timeControlType: true,
          timeInitialSec: true,
          timeIncrementSec: true,
          startedAt: true,
          whiteRatingBefore: true,
          blackRatingBefore: true,
          white: { select: { id: true, username: true } },
          black: { select: { id: true, username: true } },
          _count: { select: { moves: true } },
        },
      }),
      this.prisma.game.count({ where }),
    ]);

    const data = games.map((g) => {
      const minutes = Math.floor(g.timeInitialSec / 60);
      return {
        id: g.id,
        white: {
          id: g.white.id,
          username: g.white.username!,
          rating: g.whiteRatingBefore,
        },
        black: {
          id: g.black.id,
          username: g.black.username!,
          rating: g.blackRatingBefore,
        },
        timeControlType: g.timeControlType,
        timeControl: `${minutes}+${g.timeIncrementSec}`,
        moveCount: g._count.moves,
        startedAt: g.startedAt?.toISOString() ?? null,
      };
    });

    return { data, total };
  }

  async getLiveCount(): Promise<{ count: number }> {
    const count = await this.prisma.game.count({
      where: { status: 'active' },
    });
    return { count };
  }
}
