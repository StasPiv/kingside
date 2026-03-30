import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameService } from '../game/game.service';
import { classifyTimeControl } from '@kingside/shared';

const MAX_TOURNAMENTS_PER_USER = 3;

@Injectable()
export class ArenaService {
  private readonly logger = new Logger(ArenaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gameService: GameService,
  ) {}

  async create(userId: string, data: {
    name: string;
    timeInitialSec: number;
    timeIncrementSec: number;
    durationMin: number;
    startsAt: string;
  }) {
    if (data.durationMin < 30 || data.durationMin > 180) {
      throw new BadRequestException('Duration must be 30-180 minutes');
    }

    const existing = await this.prisma.arenaTournament.count({
      where: { createdBy: userId, status: { in: ['upcoming', 'active'] } },
    });
    if (existing >= MAX_TOURNAMENTS_PER_USER) {
      throw new BadRequestException('Maximum 3 active tournaments per user');
    }

    const startsAt = new Date(data.startsAt);
    if (startsAt <= new Date()) {
      throw new BadRequestException('Start time must be in the future');
    }

    const finishesAt = new Date(startsAt.getTime() + data.durationMin * 60000);
    const timeControlType = classifyTimeControl(data.timeInitialSec, data.timeIncrementSec);

    return this.prisma.arenaTournament.create({
      data: {
        name: data.name,
        createdBy: userId,
        timeControlType,
        timeInitialSec: data.timeInitialSec,
        timeIncrementSec: data.timeIncrementSec,
        durationMin: data.durationMin,
        startsAt,
        finishesAt,
      },
    });
  }

  async findAll(status?: string) {
    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    return this.prisma.arenaTournament.findMany({
      where,
      orderBy: { startsAt: 'desc' },
      include: { _count: { select: { entries: true } } },
    });
  }

  async findOne(id: string) {
    const t = await this.prisma.arenaTournament.findUnique({
      where: { id },
      include: { _count: { select: { entries: true } } },
    });
    if (!t) throw new NotFoundException('Tournament not found');
    return t;
  }

  async join(tournamentId: string, userId: string) {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t) throw new NotFoundException('Tournament not found');
    if (t.status === 'finished') throw new BadRequestException('Tournament already finished');

    return this.prisma.arenaTournamentEntry.upsert({
      where: { tournamentId_userId: { tournamentId, userId } },
      update: {},
      create: { tournamentId, userId },
    });
  }

  async delete(tournamentId: string, userId: string) {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t) throw new NotFoundException('Tournament not found');
    if (t.createdBy !== userId) throw new ForbiddenException();
    if (t.status === 'active') throw new BadRequestException('Cannot delete active tournament');

    await this.prisma.arenaTournament.delete({ where: { id: tournamentId } });
    return { deleted: true };
  }

  async getStandings(tournamentId: string) {
    return this.prisma.arenaTournamentEntry.findMany({
      where: { tournamentId },
      orderBy: { score: 'desc' },
      select: {
        userId: true,
        score: true,
        wins: true,
        draws: true,
        losses: true,
        streak: true,
      },
    });
  }

  // --- Arena matchmaking ---

  private seekKey(tournamentId: string) {
    return `arena:${tournamentId}:seeking`;
  }

  private lastOpponentKey(tournamentId: string, userId: string) {
    return `arena:${tournamentId}:last:${userId}`;
  }

  async seekOpponent(tournamentId: string, userId: string): Promise<{ gameId: string; opponentId: string } | null> {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t || t.status !== 'active') return null;

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ratingField = `rating${t.timeControlType.charAt(0).toUpperCase() + t.timeControlType.slice(1)}` as keyof typeof user;
    const rating = (user[ratingField] as number) || 1500;

    const key = this.seekKey(tournamentId);

    // Check for opponent in queue
    const candidates = await this.redis.zrangebyscore(key, rating - 300, rating + 300);

    for (const data of candidates) {
      const candidate = JSON.parse(data) as { userId: string; rating: number };
      if (candidate.userId === userId) continue;

      // Avoid same opponent twice in a row
      const lastOpp = await this.redis.get(this.lastOpponentKey(tournamentId, userId));
      if (lastOpp === candidate.userId) continue;

      // Match found — remove from queue
      await this.redis.zrem(key, data);

      // Record last opponents
      await this.redis.set(this.lastOpponentKey(tournamentId, userId), candidate.userId, 'EX', 300);
      await this.redis.set(this.lastOpponentKey(tournamentId, candidate.userId), userId, 'EX', 300);

      // Create game
      const whiteId = Math.random() < 0.5 ? userId : candidate.userId;
      const blackId = whiteId === userId ? candidate.userId : userId;

      const game = await this.prisma.game.create({
        data: {
          whiteId,
          blackId,
          status: 'waiting',
          timeControlType: t.timeControlType as 'bullet' | 'blitz' | 'rapid' | 'classical',
          timeInitialSec: t.timeInitialSec,
          timeIncrementSec: t.timeIncrementSec,
          tournamentId,
        },
      });

      await this.gameService.initGame(game.id);

      return { gameId: game.id, opponentId: candidate.userId };
    }

    // No match — add to queue
    await this.redis.zadd(key, rating, JSON.stringify({ userId, rating }));
    return null;
  }

  async leaveSeeking(tournamentId: string, userId: string) {
    const key = this.seekKey(tournamentId);
    const members = await this.redis.zrange(key, 0, -1);
    for (const m of members) {
      const entry = JSON.parse(m) as { userId: string };
      if (entry.userId === userId) {
        await this.redis.zrem(key, m);
        return;
      }
    }
  }

  // --- Scoring ---

  async onGameFinished(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { tournamentId: true, whiteId: true, blackId: true, result: true },
    });
    if (!game?.tournamentId || !game.result) return;

    const { tournamentId, whiteId, blackId, result } = game;

    // Determine winner/loser
    if (result === 'draw') {
      await this.addScore(tournamentId, whiteId, 1, 'draw');
      await this.addScore(tournamentId, blackId, 1, 'draw');
    } else {
      const winnerId = result === 'white' ? whiteId : blackId;
      const loserId = result === 'white' ? blackId : whiteId;
      await this.addScore(tournamentId, winnerId, 2, 'win');
      await this.addScore(tournamentId, loserId, 0, 'loss');
    }
  }

  private async addScore(
    tournamentId: string,
    userId: string,
    basePoints: number,
    outcome: 'win' | 'draw' | 'loss',
  ) {
    const entry = await this.prisma.arenaTournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
    if (!entry) return;

    let newStreak = outcome === 'win' ? entry.streak + 1 : 0;
    // Streak bonus: 2+ consecutive wins = 4 points instead of 2
    let points = basePoints;
    if (outcome === 'win' && newStreak >= 2) {
      points = 4;
    }

    await this.prisma.arenaTournamentEntry.update({
      where: { id: entry.id },
      data: {
        score: { increment: points },
        streak: newStreak,
        wins: outcome === 'win' ? { increment: 1 } : undefined,
        draws: outcome === 'draw' ? { increment: 1 } : undefined,
        losses: outcome === 'loss' ? { increment: 1 } : undefined,
      },
    });
  }

  // --- Scheduler ---

  async checkAndStartTournaments() {
    const now = new Date();
    const upcoming = await this.prisma.arenaTournament.findMany({
      where: { status: 'upcoming', startsAt: { lte: now } },
    });
    for (const t of upcoming) {
      await this.prisma.arenaTournament.update({
        where: { id: t.id },
        data: { status: 'active' },
      });
      this.logger.log(`Tournament ${t.id} "${t.name}" started`);
    }
    return upcoming.map((t) => t.id);
  }

  async checkAndFinishTournaments() {
    const now = new Date();
    const active = await this.prisma.arenaTournament.findMany({
      where: { status: 'active', finishesAt: { lte: now } },
    });
    for (const t of active) {
      await this.prisma.arenaTournament.update({
        where: { id: t.id },
        data: { status: 'finished' },
      });
      // Clear seeking queue
      await this.redis.del(this.seekKey(t.id));
      this.logger.log(`Tournament ${t.id} "${t.name}" finished`);
    }
    return active.map((t) => t.id);
  }
}
