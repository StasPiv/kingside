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
    type?: string;
    timeInitialSec: number;
    timeIncrementSec: number;
    durationMin: number;
    totalRounds?: number;
    roundPauseMin?: number;
    pointsWin?: number;
    pointsDraw?: number;
    pointsLoss?: number;
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

    const tournamentType = data.type ?? 'arena';

    return this.prisma.arenaTournament.create({
      data: {
        name: data.name,
        type: tournamentType,
        createdBy: userId,
        timeControlType,
        timeInitialSec: data.timeInitialSec,
        timeIncrementSec: data.timeIncrementSec,
        durationMin: data.durationMin,
        ...(data.totalRounds ? { totalRounds: data.totalRounds } : {}),
        ...(data.roundPauseMin ? { roundPauseMin: data.roundPauseMin } : {}),
        ...(data.pointsWin != null ? { pointsWin: data.pointsWin } : {}),
        ...(data.pointsDraw != null ? { pointsDraw: data.pointsDraw } : {}),
        ...(data.pointsLoss != null ? { pointsLoss: data.pointsLoss } : {}),
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

  async leave(tournamentId: string, userId: string) {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t) throw new NotFoundException('Tournament not found');
    if (t.status === 'finished') throw new BadRequestException('Tournament already finished');

    const entry = await this.prisma.arenaTournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
    if (!entry) throw new BadRequestException('Not in tournament');

    if (t.status === 'upcoming') {
      // Before start: remove entry entirely
      await this.prisma.arenaTournamentEntry.delete({
        where: { id: entry.id },
      });
      await this.leaveSeeking(tournamentId, userId);

      // Check if no players left — cancel the tournament
      const remaining = await this.prisma.arenaTournamentEntry.count({ where: { tournamentId } });
      if (remaining === 0) {
        await this.prisma.arenaTournament.update({
          where: { id: tournamentId },
          data: { status: 'finished' },
        });
        this.logger.log(`Tournament ${tournamentId} cancelled — no players left`);
        return { action: 'removed', tournamentFinished: true };
      }

      this.logger.log(`User ${userId} left upcoming tournament ${tournamentId}`);
      return { action: 'removed', tournamentFinished: false };
    }

    // During active tournament: mark as withdrawn
    await this.prisma.arenaTournamentEntry.update({
      where: { id: entry.id },
      data: { withdrawn: true },
    });

    await this.leaveSeeking(tournamentId, userId);

    // If the player has an active game in current round, forfeit it
    if (t.type !== 'arena') {
      await this.forfeitCurrentGame(tournamentId, userId);
    }

    // Check remaining active players
    const activeCount = await this.prisma.arenaTournamentEntry.count({
      where: { tournamentId, withdrawn: false },
    });

    if (activeCount <= 1 && t.type !== 'arena') {
      // Swiss/RR: can't continue with 0 or 1 player
      await this.finishTournamentEarly(tournamentId);
      this.logger.log(`Tournament ${tournamentId} auto-finished — ${activeCount} active player(s) left`);
      return { action: 'withdrawn', tournamentFinished: true };
    }

    if (activeCount === 0) {
      // Arena with 0 players
      await this.finishTournamentEarly(tournamentId);
      this.logger.log(`Tournament ${tournamentId} auto-finished — no active players`);
      return { action: 'withdrawn', tournamentFinished: true };
    }

    this.logger.log(`User ${userId} withdrew from active tournament ${tournamentId}`);
    return { action: 'withdrawn', tournamentFinished: false };
  }

  private async finishTournamentEarly(tournamentId: string) {
    await this.prisma.arenaTournament.update({
      where: { id: tournamentId },
      data: { status: 'finished' },
    });

    // Cancel all active/pending rounds
    await this.prisma.tournamentRound.updateMany({
      where: { tournamentId, status: { in: ['active', 'pending'] } },
      data: { status: 'finished', finishedAt: new Date() },
    });

    // End all active games in the tournament
    const activeGames = await this.prisma.game.findMany({
      where: { tournamentId, status: { in: ['waiting', 'active'] } },
    });
    for (const game of activeGames) {
      try {
        await this.gameService.endGame(game.id, 'draw', 'draw_agreement');
      } catch (e: unknown) {
        this.logger.error(`Failed to end game ${game.id}: ${(e as Error).message}`);
      }
    }

    await this.redis.del(this.seekKey(tournamentId));
  }

  private async forfeitCurrentGame(tournamentId: string, userId: string) {
    // Find active game for this user in the tournament
    const activeGame = await this.prisma.game.findFirst({
      where: {
        tournamentId,
        OR: [{ whiteId: userId }, { blackId: userId }],
        status: { in: ['waiting', 'active'] },
      },
    });

    if (activeGame) {
      // Determine result: the opponent wins
      const result = activeGame.whiteId === userId ? 'black' : 'white';
      await this.gameService.endGame(activeGame.id, result, 'resignation');
      this.logger.log(`Forfeited game ${activeGame.id} for withdrawn user ${userId}`);
    }
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
    const tournament = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!tournament) throw new NotFoundException('Tournament not found');

    const isArena = tournament.type === 'arena';
    const ptsWin = isArena ? 2 : tournament.pointsWin;
    const ptsDraw = isArena ? 1 : tournament.pointsDraw;
    const ptsLoss = isArena ? 0 : tournament.pointsLoss;

    const [entries, games] = await Promise.all([
      this.prisma.arenaTournamentEntry.findMany({
        where: { tournamentId },
        orderBy: { score: 'desc' },
        select: {
          userId: true,
          score: true,
          wins: true,
          draws: true,
          losses: true,
          streak: true,
          withdrawn: true,
          user: { select: { username: true } },
        },
      }),
      this.prisma.game.findMany({
        where: { tournamentId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          whiteId: true,
          blackId: true,
          result: true,
          status: true,
          white: { select: { username: true } },
          black: { select: { username: true } },
        },
      }),
    ]);

    // Build games[] per player
    const playerGames = new Map<string, Array<{
      gameId: string;
      opponentId: string;
      opponentUsername: string;
      result: string | null;
      color: 'white' | 'black';
      points: number;
      status: string;
    }>>();

    for (const g of games) {
      for (const playerId of [g.whiteId, g.blackId]) {
        const isWhite = playerId === g.whiteId;
        const opponentId = isWhite ? g.blackId : g.whiteId;
        const opponentUsername = (isWhite ? g.black?.username : g.white?.username) ?? '?';
        const color = isWhite ? 'white' as const : 'black' as const;

        let points = 0;
        let result: string | null = null;
        if (g.result === 'draw') {
          result = 'draw';
          points = ptsDraw;
        } else if (g.result) {
          const won = g.result === color;
          result = won ? 'win' : 'loss';
          points = won ? ptsWin : ptsLoss;
        }

        if (!playerGames.has(playerId)) playerGames.set(playerId, []);
        playerGames.get(playerId)!.push({
          gameId: g.id,
          opponentId,
          opponentUsername,
          result: g.status === 'finished' ? result : null,
          color,
          points: g.status === 'finished' ? points : 0,
          status: g.status,
        });
      }
    }

    // For Swiss: compute buchholz, progressive, rounds[]
    const isSwiss = tournament.type === 'swiss';
    let pairings: Array<{ whiteId: string; blackId: string | null; result: string | null; gameId: string | null; round: { roundNumber: number } }> = [];
    if (isSwiss) {
      pairings = await this.prisma.tournamentPairing.findMany({
        where: { round: { tournamentId } },
        select: { whiteId: true, blackId: true, result: true, gameId: true, round: { select: { roundNumber: true } } },
      });
    }

    // Build score map for buchholz
    const scoreMap = new Map(entries.map((e) => [e.userId, e.score]));
    // Build rating map
    const userIds = entries.map((e) => e.userId);
    let ratingMap = new Map<string, number>();
    if (isSwiss) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, ratingBlitz: true },
      });
      ratingMap = new Map(users.map((u) => [u.id, u.ratingBlitz ?? 1500]));
    }

    const result = entries.map((e) => {
      const base = {
        userId: e.userId,
        username: e.user?.username ?? '?',
        score: e.score,
        wins: e.wins,
        draws: e.draws,
        losses: e.losses,
        streak: e.streak,
        withdrawn: e.withdrawn,
        games: playerGames.get(e.userId) ?? [],
      };

      if (!isSwiss) return { ...base, rank: 0, buchholz: 0, progressive: 0, rounds: [] as unknown[], rating: 0 };

      // Compute rounds[] for this player from pairings
      const playerRounds: Array<{ round: number; opponentId: string | null; color: 'white' | 'black' | null; result: string | null; gameId: string | null; points: number }> = [];
      const roundPoints: number[] = [];

      for (const p of pairings) {
        if (p.whiteId !== e.userId && p.blackId !== e.userId) continue;
        const isWhite = p.whiteId === e.userId;
        const opponentId = isWhite ? p.blackId : p.whiteId;
        const color = p.blackId ? (isWhite ? 'white' as const : 'black' as const) : null;

        let pts = 0;
        let res: string | null = null;
        if (p.result === 'bye') {
          res = 'bye';
          pts = ptsWin;
        } else if (p.result === '1-0') {
          res = isWhite ? 'win' : 'loss';
          pts = isWhite ? ptsWin : ptsLoss;
        } else if (p.result === '0-1') {
          res = isWhite ? 'loss' : 'win';
          pts = isWhite ? ptsLoss : ptsWin;
        } else if (p.result === '1/2-1/2') {
          res = 'draw';
          pts = ptsDraw;
        }

        playerRounds.push({
          round: p.round.roundNumber,
          opponentId,
          color,
          result: res,
          gameId: p.gameId,
          points: pts,
        });
        roundPoints.push(pts);
      }

      playerRounds.sort((a, b) => a.round - b.round);
      roundPoints.sort(); // ensure order by round

      // Buchholz: sum of opponents' scores (bye opponent = 0)
      const buchholz = playerRounds.reduce((sum, r) => {
        if (!r.opponentId || r.result === 'bye') return sum;
        return sum + (scoreMap.get(r.opponentId) ?? 0);
      }, 0);

      // Progressive: cumulative score per round
      let cumulative = 0;
      const progressive = playerRounds.reduce((sum, r) => {
        cumulative += r.points;
        return sum + cumulative;
      }, 0);

      return { ...base, buchholz, progressive, rounds: playerRounds, rating: ratingMap.get(e.userId) ?? 1500 };
    });

    // Sort by score DESC, buchholz DESC, rating DESC and assign rank
    if (isSwiss) {
      result.sort((a, b) => b.score - a.score || (b.buchholz ?? 0) - (a.buchholz ?? 0) || (b.rating ?? 0) - (a.rating ?? 0));
    }
    result.forEach((e, i) => { (e as any).rank = i + 1; });

    return result;
  }

  // --- Arena matchmaking ---

  private seekKey(tournamentId: string) {
    return `arena:${tournamentId}:seeking`;
  }

  private lastOpponentKey(tournamentId: string, userId: string) {
    return `arena:${tournamentId}:last:${userId}`;
  }

  async seekOpponent(tournamentId: string, userId: string): Promise<{ gameId: string; opponentId: string; whiteId: string; blackId: string } | null> {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t || t.status !== 'active') return null;

    // Don't allow withdrawn players to seek
    const entry = await this.prisma.arenaTournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
    if (!entry || entry.withdrawn) return null;

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ratingField = `rating${t.timeControlType.charAt(0).toUpperCase() + t.timeControlType.slice(1)}` as keyof typeof user;
    const rating = (user[ratingField] as number) || 1500;

    const key = this.seekKey(tournamentId);

    // Check for opponent in queue
    const candidates = await this.redis.zrangebyscore(key, rating - 300, rating + 300);

    // Two-pass: prefer non-repeat opponent, fallback to any
    const lastOpp = await this.redis.get(this.lastOpponentKey(tournamentId, userId));
    let matchedData: string | null = null;
    let matchedCandidate: { userId: string; rating: number } | null = null;

    // Pass 1: non-repeat opponents
    for (const data of candidates) {
      const candidate = JSON.parse(data) as { userId: string; rating: number };
      if (candidate.userId === userId) continue;
      if (lastOpp === candidate.userId) continue;
      matchedData = data;
      matchedCandidate = candidate;
      break;
    }

    // Pass 2: allow repeat if no alternative
    if (!matchedCandidate) {
      for (const data of candidates) {
        const candidate = JSON.parse(data) as { userId: string; rating: number };
        if (candidate.userId === userId) continue;
        matchedData = data;
        matchedCandidate = candidate;
        break;
      }
    }

    if (matchedData && matchedCandidate) {
      const candidate = matchedCandidate;

      // Remove from queue
      await this.redis.zrem(key, matchedData);

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

      return { gameId: game.id, opponentId: candidate.userId, whiteId, blackId };
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
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t) return;

    const isArena = t.type === 'arena';

    // Determine winner/loser
    if (result === 'draw') {
      const drawPts = isArena ? 1 : t.pointsDraw;
      await this.addScore(tournamentId, whiteId, drawPts, 'draw', isArena);
      await this.addScore(tournamentId, blackId, drawPts, 'draw', isArena);
    } else {
      const winnerId = result === 'white' ? whiteId : blackId;
      const loserId = result === 'white' ? blackId : whiteId;
      const winPts = isArena ? 2 : t.pointsWin;
      const lossPts = isArena ? 0 : t.pointsLoss;
      await this.addScore(tournamentId, winnerId, winPts, 'win', isArena);
      await this.addScore(tournamentId, loserId, lossPts, 'loss', isArena);
    }
  }

  private async addScore(
    tournamentId: string,
    userId: string,
    basePoints: number,
    outcome: 'win' | 'draw' | 'loss',
    useStreakBonus: boolean,
  ) {
    const entry = await this.prisma.arenaTournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
    if (!entry) return;

    let newStreak = outcome === 'win' ? entry.streak + 1 : 0;
    // Arena streak bonus: 2+ consecutive wins = 4 points instead of 2
    let points = basePoints;
    if (useStreakBonus && outcome === 'win' && newStreak >= 2) {
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

  // --- Schedule ---

  async getSchedule(tournamentId: string) {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t) throw new NotFoundException('Tournament not found');

    const rounds = await this.prisma.tournamentRound.findMany({
      where: { tournamentId },
      orderBy: { roundNumber: 'asc' },
      include: {
        pairings: { orderBy: { board: 'asc' } },
      },
    });

    // Collect all user IDs and fetch usernames
    const userIds = new Set<string>();
    for (const r of rounds) {
      for (const p of r.pairings) {
        userIds.add(p.whiteId);
        if (p.blackId) userIds.add(p.blackId);
      }
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, username: true },
    });
    const usernameMap = new Map(users.map((u) => [u.id, u.username]));

    return rounds.map((r) => ({
      roundNumber: r.roundNumber,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      pairings: r.pairings.map((p) => ({
        whiteId: p.whiteId,
        whiteUsername: usernameMap.get(p.whiteId) ?? '?',
        blackId: p.blackId,
        blackUsername: p.blackId ? usernameMap.get(p.blackId) ?? '?' : null,
        result: p.result,
        gameId: p.gameId,
        board: p.board,
      })),
    }));
  }

  // --- Crosstable ---

  async getCrosstable(tournamentId: string) {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t) throw new NotFoundException('Tournament not found');

    const entries = await this.prisma.arenaTournamentEntry.findMany({
      where: { tournamentId },
      orderBy: { score: 'desc' },
      include: { user: { select: { username: true, ratingBlitz: true } } },
    });

    const pairings = await this.prisma.tournamentPairing.findMany({
      where: { round: { tournamentId } },
      include: { round: { select: { roundNumber: true } } },
    });

    // Build results map: "id1:id2" → array of results (for multi-round)
    const results: Record<string, Array<{ result: string | null; gameId: string | null; color: 'white' | 'black'; round: number }>> = {};

    for (const p of pairings) {
      if (!p.blackId) continue; // skip byes
      const roundNum = p.round.roundNumber;

      // From white's perspective
      const whiteKey = `${p.whiteId}:${p.blackId}`;
      if (!results[whiteKey]) results[whiteKey] = [];
      results[whiteKey].push({
        result: p.result,
        gameId: p.gameId,
        color: 'white',
        round: roundNum,
      });

      // From black's perspective
      const blackKey = `${p.blackId}:${p.whiteId}`;
      if (!results[blackKey]) results[blackKey] = [];
      results[blackKey].push({
        result: p.result,
        gameId: p.gameId,
        color: 'black',
        round: roundNum,
      });
    }

    // Sort each array by round number
    for (const key of Object.keys(results)) {
      results[key].sort((a, b) => a.round - b.round);
    }

    const players = entries.map((e, i) => ({
      userId: e.userId,
      username: e.user?.username ?? '?',
      rating: e.user?.ratingBlitz ?? 1500,
      score: e.score,
      rank: i + 1,
      withdrawn: e.withdrawn,
    }));

    return { players, results };
  }

  async recalculateScores(tournamentId: string) {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t) throw new NotFoundException('Tournament not found');

    const isArena = t.type === 'arena';

    // Reset all entry scores
    await this.prisma.arenaTournamentEntry.updateMany({
      where: { tournamentId },
      data: { score: 0, wins: 0, draws: 0, losses: 0, streak: 0 },
    });

    // Get all finished games for this tournament, ordered by creation
    const games = await this.prisma.game.findMany({
      where: { tournamentId, status: 'finished', result: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, whiteId: true, blackId: true, result: true },
    });

    for (const game of games) {
      if (!game.result) continue;
      if (game.result === 'draw') {
        const drawPts = isArena ? 1 : t.pointsDraw;
        await this.addScore(tournamentId, game.whiteId, drawPts, 'draw', isArena);
        await this.addScore(tournamentId, game.blackId, drawPts, 'draw', isArena);
      } else {
        const winnerId = game.result === 'white' ? game.whiteId : game.blackId;
        const loserId = game.result === 'white' ? game.blackId : game.whiteId;
        const winPts = isArena ? 2 : t.pointsWin;
        const lossPts = isArena ? 0 : t.pointsLoss;
        await this.addScore(tournamentId, winnerId, winPts, 'win', isArena);
        await this.addScore(tournamentId, loserId, lossPts, 'loss', isArena);
      }
    }

    // Add bye points from pairings
    const byePairings = await this.prisma.tournamentPairing.findMany({
      where: { round: { tournamentId }, result: 'bye' },
      select: { whiteId: true },
    });
    const byePoints = isArena ? 1 : t.pointsWin;
    for (const p of byePairings) {
      await this.prisma.arenaTournamentEntry.updateMany({
        where: { tournamentId, userId: p.whiteId },
        data: { score: { increment: byePoints }, wins: { increment: 1 } },
      });
    }

    this.logger.log(`Recalculated scores for tournament ${tournamentId}: ${games.length} games, ${byePairings.length} byes`);
    return { recalculated: true, games: games.length, byes: byePairings.length };
  }

  // --- Scheduler ---

  async checkAndStartTournaments(): Promise<{ started: string[]; cancelled: string[] }> {
    const now = new Date();
    const upcoming = await this.prisma.arenaTournament.findMany({
      where: { status: 'upcoming', startsAt: { lte: now } },
      include: { _count: { select: { entries: true } } },
    });

    const started: string[] = [];
    const cancelled: string[] = [];

    for (const t of upcoming) {
      const minPlayers = 2;
      if (t._count.entries < minPlayers) {
        // Not enough players — cancel
        await this.prisma.arenaTournament.update({
          where: { id: t.id },
          data: { status: 'finished' },
        });
        this.logger.log(`Tournament ${t.id} "${t.name}" cancelled — only ${t._count.entries} player(s), need ${minPlayers}`);
        cancelled.push(t.id);
      } else {
        await this.prisma.arenaTournament.update({
          where: { id: t.id },
          data: { status: 'active' },
        });
        this.logger.log(`Tournament ${t.id} "${t.name}" (type=${t.type}) started — transitioning upcoming→active`);
        started.push(t.id);
      }
    }

    return { started, cancelled };
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
