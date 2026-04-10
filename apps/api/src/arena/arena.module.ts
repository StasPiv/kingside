import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
import { ArenaController } from './arena.controller';
import { ArenaService } from './arena.service';
import { RoundManagerService } from './round-manager.service';
import { SwissPairingService } from './swiss-pairing.service';
import { RoundRobinPairingService } from './round-robin-pairing.service';

/**
 * ArenaModule for API Service — REST endpoints + arena service.
 * WS gateway, scheduler moved to Game Service.
 */
@Module({
  imports: [AuthModule, GameModule],
  controllers: [ArenaController],
  providers: [ArenaService, RoundManagerService, SwissPairingService, RoundRobinPairingService],
  exports: [ArenaService],
})
export class ArenaModule {}
