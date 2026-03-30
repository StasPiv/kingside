import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GameService } from '../game/game.service';
import { SwissPairingService } from './swiss-pairing.service';
import { RoundRobinPairingService } from './round-robin-pairing.service';

@Injectable()
export class RoundManagerService {
  private readonly logger = new Logger(RoundManagerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
    private readonly swissPairing: SwissPairingService,
    private readonly rrPairing: RoundRobinPairingService,
  ) {}

  /**
   * Start the next round of a Swiss/RR tournament.
   */
  async startNextRound(tournamentId: string): Promise<string | null> {
    const t = await this.prisma.arenaTournament.findUnique({
      where: { id: tournamentId },
      include: { entries: true },
    });
    if (!t || t.status !== 'active') {
      this.logger.warn(`startNextRound: tournament ${tournamentId} not found or not active (status=${t?.status})`);
      return null;
    }
    if (t.type === 'arena') {
      this.logger.log(`startNextRound: skipping arena tournament ${tournamentId}`);
      return null;
    }

    const nextRound = t.currentRound + 1;
    if (t.totalRounds && nextRound > t.totalRounds) {
      this.logger.log(`startNextRound: all ${t.totalRounds} rounds played for ${tournamentId}`);
      return null;
    }

    this.logger.log(`startNextRound: ${t.type} tournament ${tournamentId}, round ${nextRound}, ${t.entries.length} entries`);

    let pairings: { whiteId: string; blackId: string | null; board: number }[];

    if (t.type === 'round_robin') {
      const playerIds = t.entries.map((e) => e.userId);
      const withdrawnIds = new Set(t.entries.filter((e) => e.withdrawn).map((e) => e.userId));
      const allRounds = this.rrPairing.generateAllRounds(playerIds);
      const rawPairings = allRounds[nextRound - 1] ?? [];
      // Filter out pairings where both players withdrew; convert to bye if one withdrew
      pairings = rawPairings.reduce<typeof rawPairings>((acc, p) => {
        const wWhite = withdrawnIds.has(p.whiteId);
        const wBlack = p.blackId ? withdrawnIds.has(p.blackId) : true;
        if (wWhite && wBlack) return acc; // both withdrawn or bye+withdrawn — skip
        if (wWhite) {
          // White withdrew — black gets bye
          acc.push({ whiteId: p.blackId!, blackId: null, board: p.board });
        } else if (wBlack) {
          // Black withdrew or bye — white gets bye
          acc.push({ whiteId: p.whiteId, blackId: null, board: p.board });
        } else {
          acc.push(p);
        }
        return acc;
      }, []);
    } else {
      // Swiss
      const players = await this.getSwissPlayers(tournamentId);
      pairings = this.swissPairing.pair(players, nextRound);
    }

    if (pairings.length === 0) {
      this.logger.warn(`startNextRound: 0 pairings generated for round ${nextRound} of ${tournamentId}`);
      return null;
    }

    this.logger.log(`startNextRound: ${pairings.length} pairings generated for round ${nextRound}`);

    // Create round
    const round = await this.prisma.tournamentRound.create({
      data: {
        tournamentId,
        roundNumber: nextRound,
        status: 'active',
        startedAt: new Date(),
      },
    });

    // Create games + pairings
    for (const p of pairings) {
      let gameId: string | null = null;

      if (p.blackId) {
        const game = await this.prisma.game.create({
          data: {
            whiteId: p.whiteId,
            blackId: p.blackId,
            status: 'waiting',
            timeControlType: t.timeControlType as 'bullet' | 'blitz' | 'rapid' | 'classical',
            timeInitialSec: t.timeInitialSec,
            timeIncrementSec: t.timeIncrementSec,
            tournamentId,
          },
        });
        await this.gameService.initGame(game.id);
        gameId = game.id;
        this.logger.log(`startNextRound: created game ${game.id} — ${p.whiteId} vs ${p.blackId} (board ${p.board})`);
      } else {
        this.logger.log(`startNextRound: bye for ${p.whiteId} (board ${p.board})`);
      }

      await this.prisma.tournamentPairing.create({
        data: {
          roundId: round.id,
          whiteId: p.whiteId,
          blackId: p.blackId,
          gameId,
          board: p.board,
          result: p.blackId ? null : 'bye',
        },
      });

      // Bye: give 1 point
      if (!p.blackId) {
        await this.prisma.arenaTournamentEntry.updateMany({
          where: { tournamentId, userId: p.whiteId },
          data: { score: { increment: 1 }, wins: { increment: 1 } },
        });
      }
    }

    // Update tournament currentRound
    await this.prisma.arenaTournament.update({
      where: { id: tournamentId },
      data: { currentRound: nextRound },
    });

    this.logger.log(`Tournament ${tournamentId}: round ${nextRound} started with ${pairings.length} pairings`);
    return round.id;
  }

  /**
   * Check if all games in current round are finished.
   */
  async checkRoundComplete(tournamentId: string): Promise<boolean> {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t || t.currentRound === 0) return false;

    const round = await this.prisma.tournamentRound.findUnique({
      where: { tournamentId_roundNumber: { tournamentId, roundNumber: t.currentRound } },
      include: { pairings: true },
    });
    if (!round || round.status === 'finished') return false;

    const pendingGames = round.pairings.filter((p) => p.gameId && !p.result);
    return pendingGames.length === 0;
  }

  /**
   * Finalize current round and update pairing results from games.
   */
  async finalizeRound(tournamentId: string): Promise<void> {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t || t.currentRound === 0) return;

    const round = await this.prisma.tournamentRound.findUnique({
      where: { tournamentId_roundNumber: { tournamentId, roundNumber: t.currentRound } },
      include: { pairings: true },
    });
    if (!round) return;

    // Update pairing results from games
    for (const p of round.pairings) {
      if (p.result || !p.gameId) continue;
      const game = await this.prisma.game.findUnique({
        where: { id: p.gameId },
        select: { result: true, status: true },
      });
      if (game?.status === 'finished' && game.result) {
        let result: string;
        if (game.result === 'white') result = '1-0';
        else if (game.result === 'black') result = '0-1';
        else result = '1/2-1/2';

        await this.prisma.tournamentPairing.update({
          where: { id: p.id },
          data: { result },
        });
      }
    }

    await this.prisma.tournamentRound.update({
      where: { id: round.id },
      data: { status: 'finished', finishedAt: new Date() },
    });

    // Check if tournament is complete
    if (t.totalRounds && t.currentRound >= t.totalRounds) {
      await this.prisma.arenaTournament.update({
        where: { id: tournamentId },
        data: { status: 'finished' },
      });
      this.logger.log(`Tournament ${tournamentId} finished (all rounds complete)`);
    }
  }

  /**
   * Get rounds for a tournament.
   */
  async getRounds(tournamentId: string) {
    return this.prisma.tournamentRound.findMany({
      where: { tournamentId },
      orderBy: { roundNumber: 'asc' },
      include: {
        pairings: {
          orderBy: { board: 'asc' },
        },
      },
    });
  }

  async getRound(tournamentId: string, roundNumber: number) {
    return this.prisma.tournamentRound.findUnique({
      where: { tournamentId_roundNumber: { tournamentId, roundNumber } },
      include: {
        pairings: {
          orderBy: { board: 'asc' },
        },
      },
    });
  }

  private async getSwissPlayers(tournamentId: string) {
    const entries = await this.prisma.arenaTournamentEntry.findMany({
      where: { tournamentId, withdrawn: false },
      include: { user: { select: { ratingBlitz: true } } },
    });

    // Get opponent history from pairings
    const pairings = await this.prisma.tournamentPairing.findMany({
      where: { round: { tournamentId } },
      select: { whiteId: true, blackId: true },
    });

    const opponentMap = new Map<string, string[]>();
    const colorMap = new Map<string, ('w' | 'b')[]>();
    for (const p of pairings) {
      if (!p.blackId) continue;
      if (!opponentMap.has(p.whiteId)) opponentMap.set(p.whiteId, []);
      if (!opponentMap.has(p.blackId)) opponentMap.set(p.blackId, []);
      opponentMap.get(p.whiteId)!.push(p.blackId);
      opponentMap.get(p.blackId)!.push(p.whiteId);
      if (!colorMap.has(p.whiteId)) colorMap.set(p.whiteId, []);
      if (!colorMap.has(p.blackId)) colorMap.set(p.blackId, []);
      colorMap.get(p.whiteId)!.push('w');
      colorMap.get(p.blackId)!.push('b');
    }

    return entries.map((e) => ({
      userId: e.userId,
      score: e.score,
      rating: e.user?.ratingBlitz ?? 1500,
      opponents: opponentMap.get(e.userId) ?? [],
      colorHistory: colorMap.get(e.userId) ?? [],
    }));
  }
}
