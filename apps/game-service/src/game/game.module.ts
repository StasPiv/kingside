import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { UserModule } from '../user/user.module';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';
import { GameClockService } from './game-clock.service';
import { RatingService } from './rating.service';
import { RatingProtectionService } from './rating-protection.service';
import { BotGameService } from './bot-game.service';
import { GameController } from './game.controller';
import { LiveGameService } from './live-game.service';
import { GameReportService } from './game-report.service';
import { BotCleanupService } from './bot-cleanup.service';
import { TimeoutCheckerService } from './timeout-checker.service';
import { WsJwtGuard } from './guards/ws-jwt.guard';

@Module({
  imports: [AuthModule, ChatModule, UserModule],
  controllers: [GameController],
  providers: [GameGateway, GameService, GameClockService, RatingService, RatingProtectionService, BotGameService, LiveGameService, GameReportService, BotCleanupService, TimeoutCheckerService, WsJwtGuard],
  exports: [GameService, GameGateway, BotGameService, LiveGameService, WsJwtGuard],
})
export class GameModule {}
