import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LectureAudioS3Service } from './lecture-audio-s3.service';
import { LectureAudioController } from './lecture-audio.controller';
import { FfmpegConcatService } from './ffmpeg-concat.service';
import { LectureAudioService } from './lecture-audio.service';
import { LectureAudioFinalizerScheduler } from './lecture-audio-finalizer.scheduler';

/**
 * KS-3830 / ADR-116. Модуль аудио лекций.
 *
 * Состав:
 *  - `LectureAudioS3Service` — S3/CloudFront-обёртка (KS-3831).
 *  - `FfmpegConcatService` — склейка WebM-чанков в Ogg (KS-3832).
 *  - `LectureAudioService` — бизнес-логика chunk-url / chunk-ack /
 *    finalize (KS-3830).
 *  - `LectureAudioController` — REST: presigned URL, ACK, end,
 *    peer-failed (KS-3830, KS-3837).
 *  - `LectureAudioFinalizerScheduler` — cron @ 10 мин: добивка
 *    брошенных лекций (KS-3833).
 *
 * `AuthModule` — `JwtAuthGuard` и `OptionalJwtGuard`. `PrismaModule` —
 * доступ к Prisma в сервисах и cron'е.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [LectureAudioController],
  providers: [
    LectureAudioS3Service,
    FfmpegConcatService,
    LectureAudioService,
    LectureAudioFinalizerScheduler,
  ],
  exports: [LectureAudioS3Service, FfmpegConcatService, LectureAudioService],
})
export class LectureAudioModule {}
