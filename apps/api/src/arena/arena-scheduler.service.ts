import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ArenaService } from './arena.service';
import { ArenaGateway } from './arena.gateway';
import { RoundManagerService } from './round-manager.service';

const CHECK_INTERVAL_MS = 10_000; // 10 seconds

@Injectable()
export class ArenaSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArenaSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly arena: ArenaService,
    private readonly gateway: ArenaGateway,
    private readonly roundManager: RoundManagerService,
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
      const started = await this.arena.checkAndStartTournaments();
      if (started.length > 0) {
        this.logger.log(`Tournaments just started: ${started.join(', ')}`);
      }
      for (const id of started) {
        this.gateway.emitTournamentStarted(id);
        // Auto-start first round for Swiss/RR tournaments
        await this.autoStartFirstRound(id);
      }

      // Check if current round is complete for Swiss/RR → finalize + start next
      await this.checkSwissRRRounds();

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

    this.logger.log(`autoStartFirstRound: starting first round for ${t.type} tournament ${tournamentId}`);
    const roundId = await this.roundManager.startNextRound(tournamentId);
    this.logger.log(`autoStartFirstRound: startNextRound returned ${roundId ? roundId : 'null (no round created)'}`);

    if (roundId) {
      // Emit paired events via WS for each pairing with a gameId
      const round = await this.roundManager.getRound(tournamentId, 1);
      if (round) {
        this.logger.log(`autoStartFirstRound: round 1 has ${round.pairings.length} pairings`);
        for (const p of round.pairings) {
          if (p.gameId) {
            this.logger.log(`autoStartFirstRound: emitting paired — game ${p.gameId}, white ${p.whiteId}, black ${p.blackId}`);
            this.gateway.emitPaired(tournamentId, p.gameId, p.whiteId, p.blackId);
          }
        }
      }
      this.gateway.emitRoundStart(tournamentId, 1);
      this.logger.log(`autoStartFirstRound: emitted round_start for tournament ${tournamentId}`);
    }
  }

  private async checkSwissRRRounds() {
    const active = await this.prisma.arenaTournament.findMany({
      where: { status: 'active', type: { in: ['swiss', 'round_robin'] }, currentRound: { gt: 0 } },
    });

    if (active.length > 0) {
      this.logger.debug(`checkSwissRRRounds: ${active.length} active Swiss/RR tournaments with rounds`);
    }

    for (const t of active) {
      const complete = await this.roundManager.checkRoundComplete(t.id);
      if (!complete) continue;

      this.logger.log(`checkSwissRRRounds: round ${t.currentRound} complete for tournament ${t.id}, finalizing...`);
      await this.roundManager.finalizeRound(t.id);
      this.gateway.emitRoundEnd(t.id, t.currentRound);
      await this.gateway.emitStandings(t.id);

      // Start next round after pause (or immediately if no pause)
      const updated = await this.prisma.arenaTournament.findUnique({ where: { id: t.id } });
      if (updated && updated.status === 'active') {
        this.logger.log(`checkSwissRRRounds: starting next round for tournament ${t.id}`);
        const roundId = await this.roundManager.startNextRound(t.id);
        if (roundId) {
          const nextRound = t.currentRound + 1;
          const round = await this.roundManager.getRound(t.id, nextRound);
          if (round) {
            this.logger.log(`checkSwissRRRounds: round ${nextRound} has ${round.pairings.length} pairings`);
            for (const p of round.pairings) {
              if (p.gameId) {
                this.logger.log(`checkSwissRRRounds: emitting paired — game ${p.gameId}`);
                this.gateway.emitPaired(t.id, p.gameId, p.whiteId, p.blackId);
              }
            }
          }
          this.gateway.emitRoundStart(t.id, nextRound);
        } else {
          this.logger.log(`checkSwissRRRounds: no next round for tournament ${t.id} (all rounds played or no pairings)`);
        }
      }
    }
  }
}
