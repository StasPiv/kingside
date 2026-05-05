import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UserModule } from '../user/user.module';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { GameClockService } from './game-clock.service';
import { RatingService } from './rating.service';
import { RatingProtectionService } from './rating-protection.service';
import { LiveGameService } from './live-game.service';
import { EcoService } from './eco.service';
import { OpeningBookService } from '../engine/opening-book.service';

/**
 * GameModule for API Service — REST endpoints + analysis.
 * WS gateway, timeout-checker, bot logic moved to Game Service.
 *
 * KS-2433: GameReportService и StockfishService удалены — авто-генерация
 * отчётов по партиям через движок отключена, Stockfish из api-образа
 * больше не устанавливается.
 */
@Module({
  imports: [AuthModule, UserModule],
  controllers: [GameController],
  providers: [GameService, GameClockService, RatingService, RatingProtectionService, LiveGameService, EcoService, OpeningBookService],
  exports: [GameService],
})
export class GameModule {}
