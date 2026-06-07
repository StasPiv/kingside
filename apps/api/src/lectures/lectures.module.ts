import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LiveAnalysisModule } from '../live-analysis/live-analysis.module';
import { LectureAudioModule } from '../lecture-audio/lecture-audio.module';
import { LecturesController } from './lectures.controller';
import { LecturesService } from './lectures.service';

/**
 * KS-3784 / ADR-113 §4 эпик 1. Модуль лекций тренера.
 *
 * Импортирует `AuthModule` (JwtAuthGuard) и `LiveAnalysisModule`
 * (createBareLiveSession для перехода в live).
 *
 * KS-3835 / ADR-116 §5.1: `LectureAudioModule` нужен для
 * `LectureAudioS3Service.signedCloudFrontUrl` — формирование
 * подписанного URL финального аудио в `GET /lectures/:id`.
 */
@Module({
  imports: [AuthModule, PrismaModule, LiveAnalysisModule, LectureAudioModule],
  controllers: [LecturesController],
  providers: [LecturesService],
  exports: [LecturesService],
})
export class LecturesModule {}
