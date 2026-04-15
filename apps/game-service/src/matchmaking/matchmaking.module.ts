import { Module } from '@nestjs/common';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingGateway } from './matchmaking.gateway';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';

@Module({
  imports: [AuthModule, GameModule],
  providers: [MatchmakingService, MatchmakingGateway],
  exports: [MatchmakingService],
})
export class MatchmakingModule {}
