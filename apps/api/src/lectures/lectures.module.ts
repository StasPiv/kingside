import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LiveAnalysisModule } from '../live-analysis/live-analysis.module';
import { LectureAudioModule } from '../lecture-audio/lecture-audio.module';
import { LecturesController } from './lectures.controller';
import { LecturesService } from './lectures.service';
import { LecturesAccessModule } from './lectures-access.module';

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
 * KS-3940 / ADR-118 §2.3: `LecturesAccessModule` вынесен отдельно
 * для разрыва циркулярной зависимости с `LiveAnalysisModule`
 * (gateway вызывает `resolveLectureAccess` при subscribe). Здесь
 * импортируется ради `assertAccess` в `LecturesController.getById/
 * getRecording`.
 */
@Module({
  imports: [
    AuthModule,
    PrismaModule,
    LiveAnalysisModule,
    LectureAudioModule,
    LecturesAccessModule,
  ],
  controllers: [LecturesController],
  providers: [LecturesService],
  exports: [LecturesService],
})
export class LecturesModule {}
