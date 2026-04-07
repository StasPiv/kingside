import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ArenaService } from './arena.service';
import { ArenaGateway } from './arena.gateway';
import { RoundManagerService } from './round-manager.service';
import { RoundRobinPairingService } from './round-robin-pairing.service';

const CHECK_INTERVAL_MS = 10_000; // 10 seconds

@Injectable()
export class ArenaSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArenaSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly arena: ArenaService,
    private readonly gateway: ArenaGateway,
    private readonly roundManager: RoundManagerService,
    private readonly rrPairing: RoundRobinPairingService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.logger.log('Arena scheduler started (every 10s)');
  }

  onModuleDestroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async check() {
    try {
      const { started, cancelled } = await this.arena.checkAndStartTournaments();
      if (started.length > 0) {
        this.logger.log(`Tournaments just started: ${started.join(', ')}`);
      }
      for (const id of started) {
        this.gateway.emitTournamentStarted(id);
        // Auto-start first round for Swiss/RR tournaments
        await this.autoStartFirstRound(id);
      }
      for (const id of cancelled) {
        this.gateway.emitTournamentFinished(id);
      }

      // Fallback: retry autoStartFirstRound for active tournaments stuck at round 0
      await this.checkStuckStart();

      // Fallback: check for stuck completed rounds (e.g. after API restart lost setTimeout)
      await this.checkStuckRounds();

      const finished = await this.arena.checkAndFinishTournaments();
      if (finished.length > 0) {
        this.logger.log(`Tournaments just finished: ${finished.join(', ')}`);
      }
      for (const id of finished) {
        this.gateway.emitTournamentFinished(id);
      }
    } catch (e: unknown) {
      this.logger.error(`Arena scheduler error: ${(e as Error).message}`, (e as Error).stack);
    }
  }

  private async autoStartFirstRound(tournamentId: string) {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t) {
      this.logger.warn(`autoStartFirstRound: tournament ${tournamentId} not found`);
      return;
    }
    if (t.type === 'arena') {
      this.logger.log(`autoStartFirstRound: skipping arena tournament ${tournamentId} (uses seek-based matchmaking)`);
      return;
    }

    // For RR: generate full schedule (all rounds + pairings as pending) before starting
    if (t.type === 'round-robin') {
      await this.generateRRSchedule(tournamentId, t);
    }

    this.logger.log(`autoStartFirstRound: starting first round for ${t.type} tournament ${tournamentId}`);
    const roundId = await this.roundManager.startNextRound(tournamentId);
    this.logger.log(`autoStartFirstRound: startNextRound returned ${roundId ? roundId : 'null (no round created)'}`);

    if (roundId) {
      // Emit paired events via WS for each pairing with a gameId
      const round = await this.roundManager.getRound(tournamentId, 1);
      if (round) {
        this.logger.log(`autoStartFirstRound: round 1 has ${round.pairings.length} pairings`);
        const pairingsPayload = round.pairings.map((p) => ({
          whiteId: p.whiteId,
          blackId: p.blackId,
          gameId: p.gameId,
          board: p.board,
        }));
        this.gateway.emitRoundStart(tournamentId, 1, pairingsPayload);
        for (const p of round.pairings) {
          if (p.gameId) {
            this.logger.log(`autoStartFirstRound: emitting paired — game ${p.gameId}, white ${p.whiteId}, black ${p.blackId}`);
            this.gateway.emitPaired(tournamentId, p.gameId, p.whiteId, p.blackId);
          }
        }
      }
      this.logger.log(`autoStartFirstRound: emitted round_start for tournament ${tournamentId}`);
    }
  }

  /**
   * Fallback: detect rounds where all games finished but round not finalized.
   * This handles cases where onGameEnd's setTimeout was lost (API restart).
   */
  private async checkStuckRounds() {
    const active = await this.prisma.arenaTournament.findMany({
      where: { status: 'active', type: { in: ['swiss', 'round-robin'] }, currentRound: { gt: 0 } },
    });

    for (const t of active) {
      const complete = await this.roundManager.checkRoundComplete(t.id);
      if (!complete) continue;

      this.logger.log(`checkStuckRounds: round ${t.currentRound} stuck-complete for ${t.type} tournament ${t.id}, finalizing...`);

      await this.roundManager.finalizeRound(t.id);

      const updated = await this.prisma.arenaTournament.findUnique({ where: { id: t.id } });
      if (!updated || updated.status === 'finished') {
        this.gateway.emitRoundEnd(t.id, t.currentRound, null);
        await this.gateway.emitStandings(t.id);
        this.gateway.emitTournamentFinished(t.id);
        continue;
      }

      // Check if pause has elapsed (if roundPauseMin set)
      const round = await this.prisma.tournamentRound.findUnique({
        where: { tournamentId_roundNumber: { tournamentId: t.id, roundNumber: t.currentRound } },
      });
      if (round?.finishedAt && t.roundPauseMin) {
        const pauseEnd = new Date(round.finishedAt).getTime() + t.roundPauseMin * 60_000;
        if (Date.now() < pauseEnd) {
          // Still in pause — emit round_end with nextRoundStartsAt so frontend shows timer
          this.gateway.emitRoundEnd(t.id, t.currentRound, new Date(pauseEnd).toISOString());
          await this.gateway.emitStandings(t.id);
          continue;
        }
      }

      this.gateway.emitRoundEnd(t.id, t.currentRound, null);
      await this.gateway.emitStandings(t.id);

      // Start next round
      const roundId = await this.roundManager.startNextRound(t.id);
      if (roundId) {
        const refreshed = await this.prisma.arenaTournament.findUnique({ where: { id: t.id } });
        if (refreshed) {
          const round = await this.roundManager.getRound(t.id, refreshed.currentRound);
          if (round) {
            const pairingsPayload = round.pairings.map((p) => ({
              whiteId: p.whiteId,
              blackId: p.blackId,
              gameId: p.gameId,
              board: p.board,
            }));
            this.gateway.emitRoundStart(t.id, refreshed.currentRound, pairingsPayload);
            for (const p of round.pairings) {
              if (p.gameId) {
                this.gateway.emitPaired(t.id, p.gameId, p.whiteId, p.blackId);
              }
            }
          }
        }
        this.logger.log(`checkStuckRounds: started next round for ${t.id}`);
      }
    }

    // Case 2: round already finished but next round not started (lost setTimeout)
    await this.checkMissingNextRound();
  }

  private async checkMissingNextRound() {
    const active = await this.prisma.arenaTournament.findMany({
      where: { status: 'active', type: { in: ['swiss', 'round-robin'] }, currentRound: { gt: 0 } },
    });

    for (const t of active) {
      if (t.totalRounds && t.currentRound >= t.totalRounds) continue;

      const currentRound = await this.prisma.tournamentRound.findUnique({
        where: { tournamentId_roundNumber: { tournamentId: t.id, roundNumber: t.currentRound } },
      });
      if (!currentRound || currentRound.status !== 'finished') continue;

      // Check if next round exists
      const nextRound = await this.prisma.tournamentRound.findUnique({
        where: { tournamentId_roundNumber: { tournamentId: t.id, roundNumber: t.currentRound + 1 } },
      });
      if (nextRound) continue; // next round exists (pending or active)

      // Respect roundPauseMin
      if (currentRound.finishedAt && t.roundPauseMin) {
        const pauseEnd = new Date(currentRound.finishedAt).getTime() + t.roundPauseMin * 60_000;
        if (Date.now() < pauseEnd) continue;
      }

      this.logger.log(`checkMissingNextRound: round ${t.currentRound} finished but no next round for ${t.type} tournament ${t.id}, starting...`);

      const roundId = await this.roundManager.startNextRound(t.id);
      if (roundId) {
        const refreshed = await this.prisma.arenaTournament.findUnique({ where: { id: t.id } });
        if (refreshed) {
          const round = await this.roundManager.getRound(t.id, refreshed.currentRound);
          if (round) {
            const pairingsPayload = round.pairings.map((p: { whiteId: string; blackId: string | null; gameId: string | null; board: number }) => ({
              whiteId: p.whiteId,
              blackId: p.blackId,
              gameId: p.gameId,
              board: p.board,
            }));
            this.gateway.emitRoundStart(t.id, refreshed.currentRound, pairingsPayload);
            for (const p of round.pairings) {
              if (p.gameId) {
                this.gateway.emitPaired(t.id, p.gameId, p.whiteId, p.blackId);
              }
            }
          }
        }
        this.logger.log(`checkMissingNextRound: started round ${t.currentRound + 1} for ${t.id}`);
      }
    }
  }

  /**
   * Retry autoStartFirstRound for tournaments stuck at active + currentRound=0.
   * This handles cases where autoStartFirstRound threw an error on first attempt.
   */
  private async checkStuckStart() {
    const stuck = await this.prisma.arenaTournament.findMany({
      where: { status: 'active', type: { in: ['swiss', 'round-robin'] }, currentRound: 0 },
    });

    for (const t of stuck) {
      this.logger.warn(`checkStuckStart: tournament ${t.id} (${t.type}) stuck at round 0, retrying autoStartFirstRound`);
      try {
        await this.autoStartFirstRound(t.id);
      } catch (e: unknown) {
        this.logger.error(`checkStuckStart: failed for ${t.id}: ${(e as Error).message}`);
      }
    }
  }

  private async generateRRSchedule(tournamentId: string, t: { totalRounds: number | null; cycles: number; type: string }) {
    const entries = await this.prisma.arenaTournamentEntry.findMany({
      where: { tournamentId },
      select: { userId: true },
    });
    const playerIds = entries.map((e) => e.userId);
    const cycles = t.cycles ?? 1;
    const schedule = this.rrPairing.generateFullSchedule(playerIds, cycles);

    for (let i = 0; i < schedule.length; i++) {
      const roundNumber = i + 1;
      const round = await this.prisma.tournamentRound.create({
        data: {
          tournamentId,
          roundNumber,
          status: 'pending',
        },
      });

      for (const p of schedule[i]) {
        await this.prisma.tournamentPairing.create({
          data: {
            roundId: round.id,
            whiteId: p.whiteId,
            blackId: p.blackId,
            gameId: null,
            board: p.board,
            result: p.blackId ? null : 'bye',
          },
        });
      }
    }

    // Update totalRounds in DB (computed from cycles × cycleLength)
    await this.prisma.arenaTournament.update({
      where: { id: tournamentId },
      data: { totalRounds: schedule.length },
    });

    this.logger.log(`generateRRSchedule: created ${schedule.length} rounds (${cycles} cycles) for tournament ${tournamentId}`);
  }

}
