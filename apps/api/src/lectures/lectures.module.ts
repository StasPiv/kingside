import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LiveAnalysisModule } from '../live-analysis/live-analysis.module';
import { LecturesController } from './lectures.controller';
import { LecturesService } from './lectures.service';

/**
 * KS-3784 / ADR-113 §4 эпик 1. Модуль лекций тренера.
 *
 * Импортирует `AuthModule` (JwtAuthGuard) и `LiveAnalysisModule`
 * (createBareLiveSession для перехода в live).
 */
@Module({
  imports: [AuthModule, PrismaModule, LiveAnalysisModule],
  controllers: [LecturesController],
  providers: [LecturesService],
  exports: [LecturesService],
})
export class LecturesModule {}
