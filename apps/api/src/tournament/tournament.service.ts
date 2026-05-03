import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { INITIAL_FEN } from '@kingside/shared';

interface TopGameDto {
  id: string;
  whitePlayer: { id: string; username: string; rating: number };
  blackPlayer: { id: string; username: string; rating: number };
  currentFen: string;
  pgn: string | null;
}

interface TopActiveTournamentDto {
  id: string;
  name: string;
  timeControl: string;
  activePlayers: number;
  topGames: TopGameDto[];
}

const MOCK_TOURNAMENTS = [
  {
    id: 'tournament-blitz-daily',
    name: 'Daily Blitz Arena',
    timeControl: '3+2',
    minRating: 0,
    maxGames: 3,
  },
  {
    id: 'tournament-rapid-weekly',
    name: 'Weekly Rapid Open',
    timeControl: '10+0',
    minRating: 0,
    maxGames: 3,
  },
  {
    id: 'tournament-bullet-daily',
    name: 'Bullet Madness',
    timeControl: '1+0',
    minRating: 0,
    maxGames: 3,
  },
];

@Injectable()
export class TournamentService {
  constructor(private readonly prisma: PrismaService) {}

  async getTopActiveTournaments(): Promise<TopActiveTournamentDto[]> {
    // KS-2256 (ADR-036 §3.4): партии с участием hidden-аккаунтов не
    // должны попадать в публичный «top active games» список —
    // фильтруем оба игрока через nested-where.
    const activeGames = await this.prisma.game.findMany({
      where: {
        status: 'active',
        isBot: false,
        white: { isHidden: false },
        black: { isHidden: false },
      },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        pgn: true,
        finalFen: true,
        timeControlType: true,
        timeInitialSec: true,
        timeIncrementSec: true,
        white: { select: { id: true, username: true, ratingBlitz: true, ratingRapid: true, ratingBullet: true } },
        black: { select: { id: true, username: true, ratingBlitz: true, ratingRapid: true, ratingBullet: true } },
      },
    });

    return MOCK_TOURNAMENTS.map((tournament, idx) => {
      const slice = activeGames.slice(
        idx * tournament.maxGames,
        idx * tournament.maxGames + tournament.maxGames,
      );

      const topGames: TopGameDto[] = slice.map((g) => {
        const whiteRating = this.pickRating(g.white, g.timeControlType as string);
        const blackRating = this.pickRating(g.black, g.timeControlType as string);
        return {
          id: g.id,
          whitePlayer: { id: g.white.id, username: g.white.username ?? '', rating: whiteRating },
          blackPlayer: { id: g.black.id, username: g.black.username ?? '', rating: blackRating },
          currentFen: g.finalFen ?? INITIAL_FEN,
          pgn: g.pgn,
        };
      });

      return {
        id: tournament.id,
        name: tournament.name,
        timeControl: tournament.timeControl,
        activePlayers: activeGames.length > 0 ? Math.max(2, activeGames.length * (idx + 1)) : 0,
        topGames,
      };
    });
  }

  async getLiveTournaments(statusFilter?: string) {
    const where: Record<string, unknown> = {};
    if (statusFilter && statusFilter !== 'all') {
      where.status = statusFilter;
    }

    const tournaments = await this.prisma.liveTournament.findMany({
      where,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        name: true,
        chessResultsId: true,
        chessResultsUrl: true,
        livechessUuid: true,
        status: true,
        description: true,
        location: true,
        timeControl: true,
        playerCount: true,
        startDate: true,
        endDate: true,
        totalRounds: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      data: tournaments.map((t) => ({
        ...t,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
    };
  }

  private pickRating(
    user: { ratingBlitz: number; ratingRapid: number; ratingBullet: number },
    timeControlType: string,
  ): number {
    if (timeControlType === 'bullet') return user.ratingBullet;
    if (timeControlType === 'rapid') return user.ratingRapid;
    return user.ratingBlitz;
  }
}
