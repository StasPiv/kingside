import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { PeerFailedDto } from './dto/peer-failed.dto';

/**
 * KS-3837 / ADR-116 §6.2. Метрика провальных WebRTC-соединений лекции.
 *
 * Клиент (фронт публикатора или зрителя) присылает ярлык причины,
 * роль и последнее значение `iceConnectionState` после того, как
 * соединение не удалось установить за разумный таймаут (обычно 10
 * секунд). Backend логирует структурированный warning — лог уходит
 * в CloudWatch, оттуда метрики и алёрт по доле failed-соединений
 * (триггер ADR по поднятию coturn).
 *
 * Endpoint допускает анонимных клиентов: зрители публичной лекции
 * не обязаны быть авторизованы. Если JWT валиден — id пользователя
 * попадает в лог, иначе — `anon`.
 */
@Controller('lecture-audio')
export class LectureAudioController {
  private readonly logger = new Logger(LectureAudioController.name);

  @UseGuards(OptionalJwtGuard)
  @Post('peer-failed')
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
