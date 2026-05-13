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
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

/**
 * GameModule for API Service — REST endpoints + analysis.
 * WS gateway, timeout-checker, bot logic moved to Game Service.
 *
 * KS-2433: GameReportService и StockfishService удалены — авто-генерация
 * отчётов по партиям через движок отключена, Stockfish из api-образа
 * больше не устанавливается.
 *
 * KS-2952 (ADR-061 §8): MCP-секция `games` — REST-эндпоинты партий
 * (архив, детали, состояние). WebSocket gateway сюда не попадает (нет
 * HTTP-роутов).
 */
@McpDiscoveryModule({
  section: 'games',
  title: 'Партии и архив',
  description:
    'Партии пользователя: архив сыгранных партий, состояние конкретной ' +
    'партии, история ходов. Сюда — если пользователь хочет вспомнить ' +
    'свою партию, посмотреть детали или открыть архив.',
  defaultAuth: 'user',
})
@Module({
  imports: [AuthModule, UserModule],
  controllers: [GameController],
  providers: [GameService, GameClockService, RatingService, RatingProtectionService, LiveGameService, EcoService, OpeningBookService],
  exports: [GameService],
})
export class GameModule {}
