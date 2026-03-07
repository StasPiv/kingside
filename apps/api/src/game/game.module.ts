import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';
import { GameClockService } from './game-clock.service';
import { GameController } from './game.controller';
import { WsJwtGuard } from './guards/ws-jwt.guard';

@Module({
  imports: [AuthModule, ChatModule],
  controllers: [GameController],
  providers: [GameGateway, GameService, GameClockService, WsJwtGuard],
  exports: [GameService, GameGateway, WsJwtGuard],
})
export class GameModule {}
