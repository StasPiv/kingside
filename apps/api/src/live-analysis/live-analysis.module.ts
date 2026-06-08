import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LiveAnalysisController } from './live-analysis.controller';
import { LiveAnalysisService } from './live-analysis.service';
import { LiveAnalysisGateway } from './live-analysis.gateway';
import { LiveAnalysisCleanupScheduler } from './live-analysis-cleanup.scheduler';
import { LecturesAccessModule } from '../lectures/lectures-access.module';

/**
 * KS-3732 / ADR-110: модуль live-трансляции анализа партии.
 *
 * Импортирует `AuthModule` ради `JwtService` (handshake-валидация в
 * gateway) и `JwtAuthGuard` в контроллере. Redis тянется глобально
 * через `RedisModule` в `AppModule`.
 *
 * KS-3940 / ADR-118 §2.4.2: `LecturesAccessModule` — gateway вызывает
 * `LecturesAccessService.resolveLectureAccess` при subscribe-handshake
 * к restricted-лекции. Модуль вынесен отдельно, чтобы не вводить
 * циркуляр с `LecturesModule` (та импортирует `LiveAnalysisModule`).
 */
@Module({
  imports: [AuthModule, PrismaModule, LecturesAccessModule],
  controllers: [LiveAnalysisController],
  providers: [LiveAnalysisService, LiveAnalysisGateway, LiveAnalysisCleanupScheduler],
  exports: [LiveAnalysisService, LiveAnalysisGateway],
})
export class LiveAnalysisModule {}
