import { Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
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
  constructor(
    private readonly gameService: GameService,
    private readonly arenaService: ArenaService,
    private readonly gateway: ArenaGateway,
  ) {}

  onModuleInit() {
    // Register post-game hook for arena scoring + standings broadcast
    this.gameService.onGameEnd(async (gameId: string) => {
      await this.arenaService.onGameFinished(gameId);
      // Get the game to check if it's a tournament game
      const game = await (this.arenaService as any).prisma.game.findUnique({
        where: { id: gameId },
        select: { tournamentId: true },
      });
      if (game?.tournamentId) {
        await this.gateway.emitStandings(game.tournamentId);
      }
    });
  }
}
