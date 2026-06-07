import { Module } from '@nestjs/common';
import { LectureAudioS3Service } from './lecture-audio-s3.service';

/**
 * KS-3831 / ADR-116. Модуль аудио лекций. Сейчас содержит только
 * S3-обёртку; контроллер (KS-A02') и cron-finalizer (KS-A05')
 * подключаются отдельными задачами и будут импортировать
 * `LectureAudioS3Service` из этого модуля.
 */
@Module({
  providers: [LectureAudioS3Service],
  exports: [LectureAudioS3Service],
})
export class LectureAudioModule {}
