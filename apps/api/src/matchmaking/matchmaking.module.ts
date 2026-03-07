import { Module } from '@nestjs/common';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingGateway } from './matchmaking.gateway';
import { GameModule } from '../game/game.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [GameModule, AuthModule],
  providers: [MatchmakingService, MatchmakingGateway],
  exports: [MatchmakingService],
})
export class MatchmakingModule {}
