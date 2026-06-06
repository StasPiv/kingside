import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LiveAnalysisController } from './live-analysis.controller';
import { LiveAnalysisService } from './live-analysis.service';
import { LiveAnalysisGateway } from './live-analysis.gateway';
import { LiveAnalysisCleanupScheduler } from './live-analysis-cleanup.scheduler';

/**
 * KS-3732 / ADR-110: модуль live-трансляции анализа партии.
 *
 * Импортирует `AuthModule` ради `JwtService` (handshake-валидация в
 * gateway) и `JwtAuthGuard` в контроллере. Redis тянется глобально
 * через `RedisModule` в `AppModule`.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [LiveAnalysisController],
  providers: [LiveAnalysisService, LiveAnalysisGateway, LiveAnalysisCleanupScheduler],
  exports: [LiveAnalysisService, LiveAnalysisGateway],
})
export class LiveAnalysisModule {}
