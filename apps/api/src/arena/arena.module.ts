import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
import { ArenaController } from './arena.controller';
import { ArenaService } from './arena.service';
import { RoundManagerService } from './round-manager.service';
import { SwissPairingService } from './swiss-pairing.service';
import { RoundRobinPairingService } from './round-robin-pairing.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

/**
 * ArenaModule for API Service — REST endpoints + arena service.
 * WS gateway, scheduler moved to Game Service.
 *
 * KS-2954 (ADR-061 §8): MCP-секция `arena` — арена с матчмейкингом
 * Swiss/round-robin.
 */
@McpDiscoveryModule({
  section: 'arena',
  title: 'Арена',
  description:
    'Арены с матчмейкингом: регистрация, текущая партия, расписание ' +
    'раундов, лидерборд. Поддерживаются swiss и round-robin форматы.',
  defaultAuth: 'optional',
})
@Module({
  imports: [AuthModule, GameModule],
  controllers: [ArenaController],
  providers: [ArenaService, RoundManagerService, SwissPairingService, RoundRobinPairingService],
  exports: [ArenaService],
})
export class ArenaModule {}
