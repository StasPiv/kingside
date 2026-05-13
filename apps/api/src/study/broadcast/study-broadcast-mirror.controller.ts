/**
 * KS-2884 / ADR-060 §3.7 B11. Internal-эндпоинты для broadcast-зеркала.
 *
 * Защищены `InternalKeyGuard` (X-Internal-Auth, SYNTHETIC_BOT_INTERNAL_KEY).
 * Дёргает broadcast-service (B10) после создания/закрытия раунда.
 *
 * Пути: `POST /api/studies/from-broadcast-round` и
 *       `POST /api/studies/sync-broadcast-round`.
 *
 * MCP-discovery: автоматически отсечётся уровнем 1 (hard-exclude by
 * `InternalKeyGuard`, см. ADR-061 §5 / `MCP_FORBIDDEN_GUARDS`).
 */
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { InternalKeyGuard } from '../../auth/internal-key.guard';
import {
  CreateMirrorResult,
  StudyBroadcastMirrorService,
  SyncMirrorResult,
} from './study-broadcast-mirror.service';

export class FromBroadcastRoundDto {
  @IsUUID()
  roundId!: string;
}

export class SyncBroadcastRoundDto {
  @IsUUID()
  roundId!: string;
}

@Controller('studies')
@UseGuards(InternalKeyGuard)
export class StudyBroadcastMirrorController {
  constructor(private readonly mirror: StudyBroadcastMirrorService) {}

  /** Создать новое broadcast-зеркало. Идемпотентность через 409 при повторном вызове. */
  @Post('from-broadcast-round')
  async fromBroadcastRound(
    @Body() dto: FromBroadcastRoundDto,
  ): Promise<CreateMirrorResult> {
    return this.mirror.createMirror(dto.roundId);
  }

  /** Обновить pgn глав по свежим данным broadcast-service'а. Идемпотентный. */
  @Post('sync-broadcast-round')
  async syncBroadcastRound(
    @Body() dto: SyncBroadcastRoundDto,
  ): Promise<SyncMirrorResult> {
    return this.mirror.syncMirror(dto.roundId);
  }
}
