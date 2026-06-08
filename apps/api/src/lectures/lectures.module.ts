import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LiveAnalysisModule } from '../live-analysis/live-analysis.module';
import { LectureAudioModule } from '../lecture-audio/lecture-audio.module';
import { LecturesController } from './lectures.controller';
import { LecturesAccessController } from './lectures-access.controller';
import { LecturesService } from './lectures.service';
import { LecturesAccessService } from './lectures-access.service';

/**
 * KS-3784 / ADR-113 §4 эпик 1. Модуль лекций тренера.
 *
 * Импортирует `AuthModule` (JwtAuthGuard) и `LiveAnalysisModule`
 * (createBareLiveSession для перехода в live).
 *
 * KS-3835 / ADR-116 §5.1: `LectureAudioModule` нужен для
 * `LectureAudioS3Service.signedCloudFrontUrl` — формирование
 * подписанного URL финального аудио в `GET /lectures/:id`.
 *
 * KS-3931 / ADR-118 §2.3: `LecturesAccessService` — единая точка
 * резолва доступа (owner/public/unlisted/restricted). Экспортируется,
 * чтобы `LiveAnalysisGateway` мог использовать тот же резолвер для
 * WS-subscribe (KS-3940 C01).
 */
@Module({
  imports: [AuthModule, PrismaModule, LiveAnalysisModule, LectureAudioModule],
  controllers: [LecturesController, LecturesAccessController],
  providers: [LecturesService, LecturesAccessService],
  exports: [LecturesService, LecturesAccessService],
})
export class LecturesModule {}
