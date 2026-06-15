import { Module } from '@nestjs/common';
import { WorkshopController } from './workshop.controller';
import { WorkshopPublicController } from './workshop-public.controller';
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
  // KS-4130: PublicController с витринными `demo-games` зарегистрирован
  // отдельно (личный WorkshopController остаётся под class-JwtAuthGuard).
  controllers: [WorkshopPublicController, WorkshopController],
  providers: [WorkshopService, ExternalChessService],
  exports: [ExternalChessService],
})
export class WorkshopModule {}
