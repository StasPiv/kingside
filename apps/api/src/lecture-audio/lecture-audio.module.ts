import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LectureAudioS3Service } from './lecture-audio-s3.service';
import { LectureAudioController } from './lecture-audio.controller';

/**
 * KS-3831 / ADR-116. Модуль аудио лекций.
 *
 * Сейчас содержит:
 *  - `LectureAudioS3Service` — S3/CloudFront-обёртка (KS-3831).
 *  - `LectureAudioController` — endpoint `POST /lecture-audio/peer-failed`
 *    для метрики провальных WebRTC-соединений (KS-3837).
 *
 * Бизнес-контроллер аудио лекций (KS-A02') и cron-finalizer (KS-A05')
 * подключатся отдельными задачами.
 *
 * `AuthModule` нужен ради `OptionalJwtGuard` (passport-jwt strategy
 * берётся из общего реестра, регистрация — там).
 */
@Module({
  imports: [AuthModule],
  controllers: [LectureAudioController],
  providers: [LectureAudioS3Service],
  exports: [LectureAudioS3Service],
})
export class LectureAudioModule {}
