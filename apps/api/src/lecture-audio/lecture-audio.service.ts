import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import { basename, join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { LectureAudioS3Service } from './lecture-audio-s3.service';
import { FfmpegConcatService } from './ffmpeg-concat.service';

/**
 * KS-3830 / ADR-116 §5.1. Бизнес-сервис аудио лекций.
 *
 * REST-эндпоинты (`POST /lectures/:id/audio/chunk-url`,
 * `chunk-ack`, `POST /lectures/:id/end`) — тонкие; вся логика и
 * проверки тут.
 *
 * Поток клиентской записи:
 *  1. Клиент шлёт `chunk-url` → получает presigned PUT URL и `chunkKey`.
 *  2. Клиент PUT'ит чанк в S3 (тег `kind=chunk` — обязателен,
 *     включён в подпись KS-3831).
 *  3. Клиент шлёт `chunk-ack` → запись в `LectureAudioChunk` (UPSERT
 *     по `(lectureId, seq)`).
 *  4. По окончании записи клиент шлёт `POST /lectures/:id/end` →
 *     `finalizeRecording`: ffmpeg-склейка, PUT финального
 *     `audio/<id>/track.ogg`, INSERT `LectureAudio`, DELETE чанков
 *     из S3.
 *
 * Если клиент не успел шагнуть в (4) — задачу подбирает cron
 * `LectureAudioFinalizerScheduler` (KS-3833) и финализирует по
 * данным журнала чанков и `Lecture.startedAt`.
 */
@Injectable()
export class LectureAudioService {
  private readonly logger = new Logger(LectureAudioService.name);

  /** TTL presigned PUT URL'а для чанка (сек). */
  static readonly CHUNK_UPLOAD_TTL_SEC = 300;

  /**
   * Опции для уплат финализации, идущей из REST'а POST /end. Поля
   * опциональны — недостающие пересчитываются из БД (см.
   * `resolveFinalizeContext`).
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: LectureAudioS3Service,
    private readonly ffmpeg: FfmpegConcatService,
  ) {}

  // ─── Owner-check ───────────────────────────────────────────────────

  /**
   * Найти лекцию и проверить, что `actingUserId` — её владелец.
   * `null` → 404; чужой → 403.
   */
  private async assertOwnership(
    lectureId: string,
    actingUserId: string,
  ): Promise<{ id: string; ownerId: string; startedAt: Date | null }> {
    const lecture = await this.prisma.lecture.findUnique({
      where: { id: lectureId },
      select: { id: true, ownerId: true, startedAt: true },
    });
    if (!lecture) {
      throw new NotFoundException(`Lecture "${lectureId}" not found`);
    }
    if (lecture.ownerId !== actingUserId) {
      throw new ForbiddenException('Only the owner can record this lecture');
    }
    return lecture;
  }

  // ─── chunk-url ─────────────────────────────────────────────────────

  /**
   * KS-3830. Выдать presigned PUT URL для очередного чанка. TTL 5
   * минут — этого достаточно с запасом для одного PUT'а; если
   * клиент не успел, перевыдадим через тот же endpoint.
   *
   * `chunkKey` фиксирован: `audio/<lectureId>/chunks/<seq>.webm`.
   * Это позволяет cron-восстановителю (KS-3833) восстановить порядок
   * по имени файла, даже если `LectureAudioChunk`-журнал расходится
   * с фактом в S3.
   */
  async issueChunkUploadUrl(
    lectureId: string,
    actingUserId: string,
    seq: number,
    sizeBytes: number,
  ): Promise<{ uploadUrl: string; chunkKey: string }> {
    await this.assertOwnership(lectureId, actingUserId);
    const chunkKey = `audio/${lectureId}/chunks/${seq}.webm`;
    const uploadUrl = await this.s3.presignChunkUpload(
      lectureId,
      seq,
      sizeBytes,
      LectureAudioService.CHUNK_UPLOAD_TTL_SEC,
    );
    return { uploadUrl, chunkKey };
  }

  // ─── chunk-ack ─────────────────────────────────────────────────────

  /**
   * KS-3830. Идемпотентный UPSERT в `LectureAudioChunk` по
   * `(lectureId, seq)`. Повторный ACK того же seq не плодит дубль
   * (UNIQUE в БД), значения этага/размера обновляются — это нужно
   * на случай retry с переподписанным URL'ом (другой PUT, другой
   * этаг).
   */
  async ackChunk(
    lectureId: string,
    actingUserId: string,
    payload: {
      seq: number;
      etag: string;
      sizeBytes: number;
      clientCreatedAt: string;
    },
  ): Promise<{ ok: true }> {
    await this.assertOwnership(lectureId, actingUserId);
    const chunkKey = `audio/${lectureId}/chunks/${payload.seq}.webm`;
    const clientCreatedAt = new Date(payload.clientCreatedAt);
    await this.prisma.lectureAudioChunk.upsert({
      where: {
        lectureId_seq: { lectureId, seq: payload.seq },
      },
      update: {
        storageKey: chunkKey,
        etag: payload.etag,
        sizeBytes: payload.sizeBytes,
        clientCreatedAt,
      },
      create: {
        lectureId,
        seq: payload.seq,
        storageKey: chunkKey,
        etag: payload.etag,
        sizeBytes: payload.sizeBytes,
        clientCreatedAt,
      },
    });
    return { ok: true };
  }

  // ─── finalize ──────────────────────────────────────────────────────

  /**
   * KS-3830 / ADR-116 §5.1. Финализация клиентской записи.
   *
   * Алгоритм:
   *   1. Owner-check.
   *   2. ListObjectsV2 → список чанков из S3.
   *   3. Скачать чанки в tmp.
   *   4. `FfmpegConcatService.runWithOutput` → out.ogg, durationMs.
   *   5. PUT `audio/<id>/track.ogg` (без тега).
   *   6. INSERT `LectureAudio` (UPSERT по `lectureId` — на случай
   *      повторного finalize: cron уже добежал).
   *   7. DELETE чанков из S3 (lifecycle снесёт через 24ч, но
   *      проактивно убираем сразу).
   *
   * Идемпотентность:
   *   - Если уже есть `LectureAudio` для лекции — возвращаем как есть
   *     (`upsert` обновляет метаданные при повторе, но `track.ogg`
   *     не перезаписываем без надобности → проверяем в начале).
   *   - Если в S3 нет ни одного чанка — `null` (нечего финализировать).
   *
   * `payload` — клиентские подсказки; недостающие восполняются:
   *   - `recorderStartedAtClient` ← `MIN(client_created_at)` журнала.
   *   - `offsetMs` ← `recorderStartedAtClient - lecture.startedAt`.
   *   - `chunkCount` ← факт по `ListObjectsV2`.
   */
  async finalizeRecording(
    lectureId: string,
    payload: {
      offsetMs?: number;
      chunkCount?: number;
      recorderStartedAtClient?: string;
      recorderEndedAtClient?: string;
    },
    options: { actingUserId?: string } = {},
  ): Promise<{ lectureId: string; durationMs: number; offsetMs: number | null } | null> {
    let lecture: { id: string; ownerId: string; startedAt: Date | null };
    if (options.actingUserId) {
      lecture = await this.assertOwnership(lectureId, options.actingUserId);
    } else {
      const row = await this.prisma.lecture.findUnique({
        where: { id: lectureId },
        select: { id: true, ownerId: true, startedAt: true },
      });
      if (!row) {
        throw new NotFoundException(`Lecture "${lectureId}" not found`);
      }
      lecture = row;
    }

    // Идемпотентность: уже финализирована — возвращаем то, что есть.
    const existing = await this.prisma.lectureAudio.findUnique({
      where: { lectureId },
      select: { lectureId: true, durationMs: true, offsetMs: true },
    });
    if (existing) {
      this.logger.log(
        `finalize: already finalized lecture=${lectureId} (idempotent return)`,
      );
      return existing as {
        lectureId: string;
        durationMs: number;
        offsetMs: number | null;
      };
    }

    const chunks = await this.s3.listChunks(lectureId);
    if (chunks.length === 0) {
      this.logger.warn(
        `finalize: no chunks in S3 for lecture=${lectureId} — nothing to do`,
      );
      return null;
    }
    if (
      payload.chunkCount !== undefined &&
      payload.chunkCount !== chunks.length
    ) {
      this.logger.warn(
        `finalize: chunkCount mismatch lecture=${lectureId} client=${payload.chunkCount} s3=${chunks.length}`,
      );
    }

    // Готовим recorderStartedAtClient + offsetMs.
    const journal = await this.prisma.lectureAudioChunk.findMany({
      where: { lectureId },
      orderBy: { seq: 'asc' },
      select: { clientCreatedAt: true, createdAt: true, seq: true },
    });
    const recorderStartedAtClient = this.resolveRecorderStart(
      payload.recorderStartedAtClient,
      journal,
    );
    const offsetMs =
      payload.offsetMs ??
      this.computeOffsetMs(lecture.startedAt, recorderStartedAtClient);

    const downloadDir = await fsp.mkdtemp(
      join(os.tmpdir(), 'lecture-audio-finalize-'),
    );
    try {
      const localPaths = await this.downloadChunks(downloadDir, chunks);
      const inserted = await this.ffmpeg.runWithOutput(
        localPaths,
        async ({ localPath, durationMs }) => {
          await this.s3.putFinalTrack(lectureId, localPath);
          const audio = await this.prisma.lectureAudio.upsert({
            where: { lectureId },
            update: {
              durationMs,
              offsetMs,
              recorderStartedAtClient,
              storageKey: `audio/${lectureId}/track.ogg`,
            },
            create: {
              lectureId,
              storageKey: `audio/${lectureId}/track.ogg`,
              codec: 'opus',
              container: 'ogg',
              channels: 1,
              durationMs,
              offsetMs,
              recorderStartedAtClient,
            },
            select: {
              lectureId: true,
              durationMs: true,
              offsetMs: true,
            },
          });
          return audio;
        },
      );
      try {
        const deleted = await this.s3.deleteChunks(lectureId);
        this.logger.log(
          `finalize: lecture=${lectureId} chunks=${chunks.length} deleted=${deleted} durationMs=${inserted.durationMs}`,
        );
      } catch (e) {
        // Lifecycle снесёт через 24ч; не блокируем.
        this.logger.warn(
          `finalize: deleteChunks failed lecture=${lectureId}: ${(e as Error).message}`,
        );
      }
      return inserted as {
        lectureId: string;
        durationMs: number;
        offsetMs: number | null;
      };
    } finally {
      await fsp
        .rm(downloadDir, { recursive: true, force: true })
        .catch((e) =>
          this.logger.warn(
            `finalize: cleanup tmp failed ${downloadDir}: ${(e as Error).message}`,
          ),
        );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Скачать чанки из S3 в локальную директорию. Имена сохраняем
   * исходные (basename из key); порядок ffmpeg-concat читает по
   * порядку аргументов, поэтому массив возвращается в том же
   * порядке, что и `chunks` (уже отсортирован по seq).
   *
   * Реализация: использует `@aws-sdk/client-s3` через
   * `LectureAudioS3Service.getObjectStream` (см. ниже — для KS-3830
   * добавим публичный метод в S3-сервис). Тут — обращение через
   * прямой GetObjectCommand невозможно без расширения S3-сервиса,
   * поэтому делегируем через `s3.downloadChunk`.
   */
  private async downloadChunks(
    dir: string,
    chunks: Array<{ seq: number; key: string }>,
  ): Promise<string[]> {
    const paths: string[] = [];
    for (const c of chunks) {
      const local = join(dir, basename(c.key));
      await this.s3.downloadObject(c.key, local);
      paths.push(local);
    }
    return paths;
  }

  /**
   * Восстановить ISO-время старта recorder'а. Приоритет:
   *   1. payload (client сообщил).
   *   2. min(clientCreatedAt) журнала чанков.
   *   3. min(createdAt) журнала чанков (fallback, если client time нет).
   *   4. now() — крайний fallback, лучше неправильный offsetMs, чем
   *      пустое поле NOT NULL в БД.
   */
  private resolveRecorderStart(
    fromPayload: string | undefined,
    journal: Array<{ clientCreatedAt: Date | null; createdAt: Date }>,
  ): Date {
    if (fromPayload) {
      const d = new Date(fromPayload);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (journal.length > 0) {
      const clientTimes = journal
        .map((r) => r.clientCreatedAt?.getTime() ?? null)
        .filter((t): t is number => t !== null);
      if (clientTimes.length > 0) {
        return new Date(Math.min(...clientTimes));
      }
      const serverTimes = journal.map((r) => r.createdAt.getTime());
      return new Date(Math.min(...serverTimes));
    }
    return new Date();
  }

  /**
   * offsetMs = recorderStartedAtClient - lecture.startedAt. Если у
   * лекции нет `startedAt` (создаётся сразу live без перехода
   * через start — теоретически возможно для immediate-live из
   * `LecturesService.create`, но там тоже выставляется `startedAt`),
   * считаем offset нулевым.
   */
  private computeOffsetMs(
    lectureStartedAt: Date | null,
    recorderStartedAtClient: Date,
  ): number {
    if (!lectureStartedAt) return 0;
    return recorderStartedAtClient.getTime() - lectureStartedAt.getTime();
  }
}
