import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { PeerFailedDto } from './dto/peer-failed.dto';
import { ChunkUrlDto } from './dto/chunk-url.dto';
import { ChunkAckDto } from './dto/chunk-ack.dto';
import { FinalizeRecordingDto } from './dto/finalize-recording.dto';
import { LectureAudioService } from './lecture-audio.service';

/**
 * KS-3830 / KS-3837. REST-эндпоинты аудио лекций.
 *
 *   POST /lectures/:id/audio/chunk-url  (KS-3830) — presigned PUT URL.
 *   POST /lectures/:id/audio/chunk-ack  (KS-3830) — ACK успешного PUT.
 *   POST /lectures/:id/end              (KS-3830) — финализация
 *     клиентской записи (ffmpeg-склейка + S3 PUT track.ogg + INSERT
 *     LectureAudio + DELETE чанков). НЕ меняет статус лекции; перевод
 *     `Lecture.status='recorded'` делает закрытие live-сессии через
 *     `LiveAnalysisService.closeBySlug` (см. ADR-113).
 *   POST /lecture-audio/peer-failed     (KS-3837) — метрика WebRTC.
 */
@Controller()
export class LectureAudioController {
  private readonly logger = new Logger(LectureAudioController.name);

  constructor(private readonly service: LectureAudioService) {}

  // ─── KS-3830 ──────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('lectures/:id/audio/chunk-url')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async chunkUrl(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChunkUrlDto,
  ): Promise<{ uploadUrl: string; chunkKey: string }> {
    return this.service.issueChunkUploadUrl(
      id,
      req.user.id,
      dto.seq,
      dto.sizeBytes,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('lectures/:id/audio/chunk-ack')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async chunkAck(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChunkAckDto,
  ): Promise<{ ok: true }> {
    return this.service.ackChunk(id, req.user.id, dto);
  }

  /**
   * KS-3830. `POST /lectures/:id/end` — финализация записи.
   * Синхронная: ждём ffmpeg-склейку и PUT финала. Объём небольшой
   * (~24 MB на час), очередь ограничена 2 параллельными задачами
   * через `FfmpegConcatService`. Если REST-таймаут случится —
   * cron-восстановитель KS-3833 добьёт.
   */
  @UseGuards(JwtAuthGuard)
  @Post('lectures/:id/end')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async end(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinalizeRecordingDto,
  ): Promise<{
    audio:
      | { lectureId: string; durationMs: number; offsetMs: number | null }
      | null;
  }> {
    const audio = await this.service.finalizeRecording(id, dto, {
      actingUserId: req.user.id,
    });
    return { audio };
  }

  // ─── KS-3837 ──────────────────────────────────────────────────────

  @UseGuards(OptionalJwtGuard)
  @Post('lecture-audio/peer-failed')
  @HttpCode(204)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  reportPeerFailed(
    @Request() req: AuthenticatedRequest,
    @Body() dto: PeerFailedDto,
  ): void {
    // Структурированный JSON в одной строке — удобно парсить из
    // CloudWatch Logs Insights (`fields @timestamp, lectureId, reason,
    // role, iceConnectionState`).
    const payload = {
      event: 'webrtc.peer_failed',
      lectureId: dto.lectureId,
      reason: dto.reason,
      role: dto.role,
      iceConnectionState: dto.iceConnectionState,
      userId: req.user?.id ?? 'anon',
    };
    this.logger.warn(JSON.stringify(payload));
  }
}
