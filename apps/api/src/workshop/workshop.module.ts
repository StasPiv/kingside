import { Module } from '@nestjs/common';
import { WorkshopController } from './workshop.controller';
import { WorkshopService } from './workshop.service';
import { ExternalChessService } from './external-chess.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): MCP-секция `workshop` — мастерская.
@McpDiscoveryModule({
  section: 'workshop',
  title: 'Мастерская',
  description:
    'Мастерская: импорт партий с chess.com/lichess, работа с PGN, ' +
    'подготовка собственных анализов. Сюда — если пользователь хочет ' +
    'загрузить партию из внешнего источника или разобрать её.',
  defaultAuth: 'user',
})
@Module({
  controllers: [WorkshopController],
  providers: [WorkshopService, ExternalChessService],
  exports: [ExternalChessService],
})
export class WorkshopModule {}
