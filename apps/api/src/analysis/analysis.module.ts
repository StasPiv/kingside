import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { SavedFilterService } from './saved-filter.service';

@Module({
  controllers: [AnalysisController],
  providers: [AnalysisService, SavedFilterService],
})
export class AnalysisModule {}
