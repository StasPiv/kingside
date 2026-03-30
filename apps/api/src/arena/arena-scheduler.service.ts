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
      for (const id of started) {
        this.gateway.emitTournamentStarted(id);
        // Auto-start first round for Swiss/RR tournaments
        await this.autoStartFirstRound(id);
      }

      // Check if current round is complete for Swiss/RR → finalize + start next
      await this.checkSwissRRRounds();

      const finished = await this.arena.checkAndFinishTournaments();
      for (const id of finished) {
        this.gateway.emitTournamentFinished(id);
      }
    } catch (e: unknown) {
      this.logger.error(`Arena scheduler error: ${(e as Error).message}`);
    }
  }

  private async autoStartFirstRound(tournamentId: string) {
    const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
    if (!t || t.type === 'arena') return;

    this.logger.log(`Auto-starting first round for ${t.type} tournament ${tournamentId}`);
    const roundId = await this.roundManager.startNextRound(tournamentId);
    if (roundId) {
      // Emit paired events via WS for each pairing with a gameId
      const round = await this.roundManager.getRound(tournamentId, 1);
      if (round) {
        for (const p of round.pairings) {
          if (p.gameId) {
            this.gateway.emitPaired(tournamentId, p.gameId, p.whiteId, p.blackId);
          }
        }
      }
      this.gateway.emitRoundStart(tournamentId, 1);
    }
  }

  private async checkSwissRRRounds() {
    const active = await this.prisma.arenaTournament.findMany({
      where: { status: 'active', type: { in: ['swiss', 'round_robin'] }, currentRound: { gt: 0 } },
    });

    for (const t of active) {
      const complete = await this.roundManager.checkRoundComplete(t.id);
      if (!complete) continue;

      await this.roundManager.finalizeRound(t.id);
      this.gateway.emitRoundEnd(t.id, t.currentRound);
      await this.gateway.emitStandings(t.id);

      // Start next round after pause (or immediately if no pause)
      const updated = await this.prisma.arenaTournament.findUnique({ where: { id: t.id } });
      if (updated && updated.status === 'active') {
        const roundId = await this.roundManager.startNextRound(t.id);
        if (roundId) {
          const nextRound = t.currentRound + 1;
          const round = await this.roundManager.getRound(t.id, nextRound);
          if (round) {
            for (const p of round.pairings) {
              if (p.gameId) {
                this.gateway.emitPaired(t.id, p.gameId, p.whiteId, p.blackId);
              }
            }
          }
          this.gateway.emitRoundStart(t.id, nextRound);
        }
      }
    }
  }
}
