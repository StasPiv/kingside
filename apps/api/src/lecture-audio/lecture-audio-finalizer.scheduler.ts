import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LectureAudioS3Service } from './lecture-audio-s3.service';
import { LectureAudioService, NoChunksError } from './lecture-audio.service';

/**
 * KS-3833 / ADR-116 §2.4.3. Cron-восстановитель брошенных лекций.
 *
 * Сценарий, который мы покрываем: тренер закрыл вкладку до вызова
 * `POST /lectures/:id/end`. Live-сессия закрылась (через cleanup-job
 * `LiveAnalysisCleanupScheduler`, 5 минут таймаута неактивности),
 * `Lecture.status='recorded'` выставлен, `LectureRecording` создан.
 * Аудио-чанки в S3 уже лежат (клиент успел отправить большинство), но
 * `LectureAudio` нет — финализировать некому. Lifecycle бы снёс
 * чанки через 24ч; этот cron подбирает их раньше.
 *
 * Алгоритм каждого тика (каждые 10 минут):
 *  1. SELECT id, startedAt FROM lectures WHERE status='recorded' AND
 *     NOT EXISTS (SELECT 1 FROM lecture_audio WHERE lecture_id=id).
 *  2. Для каждой такой лекции: `s3.listChunks(id)`. Если пусто —
 *     ничего не делаем (это нормальный сценарий «лекция без аудио»).
 *  3. Если чанки есть — `LectureAudioService.finalizeRecording(id, {})`.
 *     Сервис сам пересчитает recorderStartedAtClient (из MIN(client_
 *     created_at) журнала чанков) и offsetMs (от Lecture.startedAt).
 *
 * Ошибки внутри одной лекции логируются и не блокируют следующих.
 * Метрики количества обработанных лекций — счётчики в логе (info /
 * warn), для CloudWatch metric filter'ов.
 *
 * Лекции в статусе `live`/`scheduled`/`cancelled` не трогаем
 * (фильтр в WHERE).
 */
@Injectable()
export class LectureAudioFinalizerScheduler {
  private readonly logger = new Logger(LectureAudioFinalizerScheduler.name);

  /** Защита от перекрытия запусков, если предыдущий тик ещё работает. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: LectureAudioS3Service,
    private readonly audio: LectureAudioService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleTick(): Promise<void> {
    if (this.running) {
      this.logger.warn('finalizer: previous tick still running, skip');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      await this.runOnce();
    } finally {
      this.running = false;
      this.logger.log(
        `finalizer: tick done in ${Date.now() - startedAt}ms`,
      );
    }
  }

  /**
   * Один прогон цикла. Выделен как public, чтобы тесты могли
   * дёргать без эмуляции cron'а.
   */
  async runOnce(): Promise<{
    scanned: number;
    finalized: number;
    skippedNoChunks: number;
    failed: number;
  }> {
    // recorded-лекции без LectureAudio. Чанков может не быть (тогда
    // на шаге listChunks отсеется), но сначала отбрасываем уже
    // финализированные.
    const candidates = await this.prisma.lecture.findMany({
      where: {
        status: 'recorded',
        audio: { is: null },
      },
      select: { id: true, startedAt: true },
      // Лимит для безопасности: на тике обработаем не более 50 лекций,
      // следующие подберёт следующий тик.
      take: 50,
    });
    let finalized = 0;
    let skippedNoChunks = 0;
    let failed = 0;
    this.logger.log(
      `finalizer: scanned candidates=${candidates.length}`,
    );
    for (const lecture of candidates) {
      try {
        const chunks = await this.s3.listChunks(lecture.id);
        if (chunks.length === 0) {
          skippedNoChunks++;
          continue;
        }
        const result = await this.audio.finalizeRecording(lecture.id, {});
        finalized++;
        this.logger.log(
          `finalizer: lecture=${lecture.id} finalized durationMs=${result.durationMs} offsetMs=${result.offsetMs}`,
        );
      } catch (e) {
        if (e instanceof NoChunksError) {
          // Гонка между нашим listChunks и реальным запуском
          // finalizeRecording (kind=chunk lifecycle мог снести
          // последний чанк между двумя вызовами). Не считаем
          // ошибкой — просто пропускаем.
          skippedNoChunks++;
        } else {
          failed++;
          this.logger.warn(
            `finalizer: lecture=${lecture.id} failed: ${(e as Error).message}`,
          );
        }
      }
    }
    this.logger.log(
      `finalizer: result scanned=${candidates.length} finalized=${finalized} skipped=${skippedNoChunks} failed=${failed}`,
    );
    return {
      scanned: candidates.length,
      finalized,
      skippedNoChunks,
      failed,
    };
  }
}
