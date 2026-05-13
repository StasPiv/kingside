import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisPublicController } from './analysis-public.controller';
import { AnalysisService } from './analysis.service';
import { UserModule } from '../user/user.module';

/**
 * KS-2929 (Phase A5): старый `SavedFilterService` удалён —
 * бизнес-логика saved_filters переехала в
 * `apps/api/src/user/saved-filters/`. UserModule импортируется,
 * чтобы legacy proxy `/analyses/filters` в AnalysisController мог
 * делегировать в `SavedFiltersService`.
 */
@Module({
  imports: [UserModule],
  controllers: [AnalysisController, AnalysisPublicController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
