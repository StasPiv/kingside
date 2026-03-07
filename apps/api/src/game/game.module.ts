import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';
import { GameClockService } from './game-clock.service';
import { RatingService } from './rating.service';
import { BotGameService } from './bot-game.service';
import { StockfishService } from '../engine/stockfish.service';
import { GameController } from './game.controller';
import { WsJwtGuard } from './guards/ws-jwt.guard';

@Module({
  imports: [AuthModule, ChatModule],
  controllers: [GameController],
  providers: [GameGateway, GameService, GameClockService, RatingService, BotGameService, StockfishService, WsJwtGuard],
  exports: [GameService, GameGateway, BotGameService, WsJwtGuard],
})
export class GameModule {}
