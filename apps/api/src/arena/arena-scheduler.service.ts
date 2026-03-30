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

      // Round completion is now handled by onGameEnd hook in arena.module.ts

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

}
