import { Module, Logger, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
import { PrismaService } from '../prisma/prisma.service';
import { GameService } from '../game/game.service';
import { ArenaController } from './arena.controller';
import { ArenaService } from './arena.service';
import { ArenaGateway } from './arena.gateway';
import { ArenaSchedulerService } from './arena-scheduler.service';
import { RoundManagerService } from './round-manager.service';
import { SwissPairingService } from './swiss-pairing.service';
import { RoundRobinPairingService } from './round-robin-pairing.service';

@Module({
  imports: [AuthModule, GameModule],
  controllers: [ArenaController],
  providers: [ArenaService, ArenaGateway, ArenaSchedulerService, RoundManagerService, SwissPairingService, RoundRobinPairingService],
  exports: [ArenaService, ArenaGateway, RoundManagerService],
})
export class ArenaModule implements OnModuleInit {
  private readonly logger = new Logger(ArenaModule.name);

  constructor(
    private readonly gameService: GameService,
    private readonly arenaService: ArenaService,
    private readonly gateway: ArenaGateway,
    private readonly roundManager: RoundManagerService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.gameService.onGameEnd(async (gameId: string) => {
      // 1. Arena scoring (works for all tournament types)
      await this.arenaService.onGameFinished(gameId);

      // 2. Get game to check if tournament game
      const game = await this.prisma.game.findUnique({
        where: { id: gameId },
        select: { tournamentId: true, result: true },
      });
      if (!game?.tournamentId) return;

      const tournamentId = game.tournamentId;

      // 3. Update TournamentPairing.result
      const pairingInfo = await this.roundManager.updatePairingResult(gameId);
      if (pairingInfo) {
        // 4. Emit tournament:game_end
        this.gateway.emitGameEnd(tournamentId, gameId, game.result ?? '', pairingInfo.pairingId);
      }

      // 5. Emit updated standings
      await this.gateway.emitStandings(tournamentId);

      // 6. For Swiss/RR: check round completion and auto-start next
      const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
      if (!t || t.type === 'arena') return;

      const complete = await this.roundManager.checkRoundComplete(tournamentId);
      if (!complete) return;

      this.logger.log(`Round ${t.currentRound} complete for ${t.type} tournament ${tournamentId}`);

      // Finalize current round
      await this.roundManager.finalizeRound(tournamentId);
      this.gateway.emitRoundEnd(tournamentId, t.currentRound);
      await this.gateway.emitStandings(tournamentId);

      // Check if tournament is finished (finalizeRound may have set status to finished)
      const updated = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
      if (!updated || updated.status === 'finished') {
        this.gateway.emitTournamentFinished(tournamentId);
        this.logger.log(`Tournament ${tournamentId} finished after round ${t.currentRound}`);
        return;
      }

      // Start next round (with pause if configured)
      const pauseMs = (t.roundPauseMin ?? 0) * 60_000;
      if (pauseMs > 0) {
        this.logger.log(`Waiting ${t.roundPauseMin} min before starting next round for ${tournamentId}`);
        setTimeout(() => this.startNextRoundWithEmit(tournamentId), pauseMs);
      } else {
        await this.startNextRoundWithEmit(tournamentId);
      }
    });
  }

  private async startNextRoundWithEmit(tournamentId: string) {
    try {
      const roundId = await this.roundManager.startNextRound(tournamentId);
      if (!roundId) {
        this.logger.log(`No next round for tournament ${tournamentId}`);
        return;
      }

      const t = await this.prisma.arenaTournament.findUnique({ where: { id: tournamentId } });
      if (!t) return;

      const round = await this.roundManager.getRound(tournamentId, t.currentRound);
      if (round) {
        const pairingsPayload = round.pairings.map((p: { whiteId: string; blackId: string | null; gameId: string | null; board: number }) => ({
          whiteId: p.whiteId,
          blackId: p.blackId,
          gameId: p.gameId,
          board: p.board,
        }));
        this.gateway.emitRoundStart(tournamentId, t.currentRound, pairingsPayload);

        for (const p of round.pairings) {
          if (p.gameId) {
            this.gateway.emitPaired(tournamentId, p.gameId, p.whiteId, p.blackId);
          }
        }
      }

      this.logger.log(`Round ${t.currentRound} started for tournament ${tournamentId}`);
    } catch (e: unknown) {
      this.logger.error(`Failed to start next round for ${tournamentId}: ${(e as Error).message}`);
    }
  }
}
