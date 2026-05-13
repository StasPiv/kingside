import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisPublicController } from './analysis-public.controller';
import { AnalysisService } from './analysis.service';

/**
 * KS-2929 (Phase A5): старый `SavedFilterService` удалён — saved_filters
 *   логика переехала в `apps/api/src/user/saved-filters/`.
 * KS-2943 (Phase D1): legacy proxy `/analyses/filters` удалён целиком,
 *   зависимость от `UserModule` больше не нужна.
 */
@Module({
  controllers: [AnalysisController, AnalysisPublicController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
