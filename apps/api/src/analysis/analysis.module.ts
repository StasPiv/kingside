import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisPublicController } from './analysis-public.controller';
import { AnalysisService } from './analysis.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

/**
 * KS-2929 (Phase A5): старый `SavedFilterService` удалён — saved_filters
 *   логика переехала в `apps/api/src/user/saved-filters/`.
 * KS-2943 (Phase D1): legacy proxy `/analyses/filters` удалён целиком,
 *   зависимость от `UserModule` больше не нужна.
 * KS-2952 (ADR-061 §8): MCP-секция `analyses` (user + public).
 */
@McpDiscoveryModule({
  section: 'analyses',
  title: 'Анализ партий',
  description:
    'Сохранённые анализы партий пользователя: CRUD списка, экспорт PGN, ' +
    'публичные анализы по ссылке. Сюда — за просмотром/правкой ' +
    'собственных разборов и публичных шахматных анализов.',
  defaultAuth: 'optional',
})
@Module({
  controllers: [AnalysisController, AnalysisPublicController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
