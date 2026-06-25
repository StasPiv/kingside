import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LiveAnalysisListItem,
  LiveAnalysisResponse,
  SwitchAnalysisResponse,
} from '@kingside/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { CreateLiveAnalysisDto } from './dto/create-live-analysis.dto';
import { SwitchAnalysisDto } from './dto/switch-analysis.dto';
import { LiveAnalysisService } from './live-analysis.service';
import { LiveAnalysisGateway } from './live-analysis.gateway';
import { LecturesAccessService } from '../lectures/lectures-access.service';
import { toPublicDto } from '../common/public-dto.mapper';

/**
 * KS-3732 / ADR-110 §2.3, §2.6: REST-эндпоинты live-трансляции анализа.
 *
 * Маршруты:
 *   POST   /live-analyses                                  — создать (Jwt-only).
 *   GET    /live-analyses/me                               — список своих (Jwt-only).
 *   GET    /live-analyses/by-analysis/:analysisId          — KS-3760: active по analysisId (Jwt-only, owner).
 *   GET    /live-analyses/:slug                            — snapshot (анонимный доступ).
 *   DELETE /live-analyses/:slug                            — закрыть, только owner.
 *
 * ВАЖНО: статические сегменты (`/me`, `/by-analysis/...`) объявлены
 * раньше `/:slug` — иначе Nest-роутер съел бы их динамическим
 * параметром.
 */
@Controller('live-analyses')
export class LiveAnalysisController {
  constructor(
    private readonly service: LiveAnalysisService,
    private readonly gateway: LiveAnalysisGateway,
    private readonly config: ConfigService,
    /**
     * KS-3941 / ADR-118 §2.4.2. Резолвер доступа к лекции при REST
     * snapshot `GET /live-analyses/:slug`. Поднимаем 401/403 в
     * формате ADR до того, как сервис прочитает live-state.
     */
    private readonly lecturesAccess: LecturesAccessService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateLiveAnalysisDto,
  ): Promise<LiveAnalysisResponse> {
    return this.service.create(req.user.id, dto, this.publicBaseUrl());
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  listMine(@Request() req: AuthenticatedRequest): Promise<LiveAnalysisListItem[]> {
    return this.service.listForOwner(req.user.id);
  }

  /**
   * KS-3760 / ADR-112 §3. Поиск активной трансляции автора по
   * `analysisId`. Используется фронтом перед нажатием «Транслировать»,
   * чтобы понять, идёт ли уже трансляция на этот анализ, и при
   * необходимости подцепиться к существующей вместо создания дубля.
   *
   * Owner-only по построению: сервис ищет `findFirst({ ownerId,
   * analysisId, status: 'active' })`. Чужие записи отсеиваются
   * фильтром `ownerId = req.user.id`. 404 если у запрашивающего нет
   * активной трансляции на этот анализ.
   *
   * `ParseUUIDPipe` гарантирует, что `:analysisId` — UUID; иначе 400
   * без обращения к сервису.
   */
  @UseGuards(JwtAuthGuard)
  @Get('by-analysis/:analysisId')
  async getActiveByAnalysisId(
    @Request() req: AuthenticatedRequest,
    @Param('analysisId', ParseUUIDPipe) analysisId: string,
  ): Promise<LiveAnalysisResponse> {
    const found = await this.service.findActiveByAnalysisId(
      req.user.id,
      analysisId,
      this.publicBaseUrl(),
    );
    if (!found) {
      throw new NotFoundException(
        `No active live analysis for analysisId="${analysisId}"`,
      );
    }
    return found;
  }

  /**
   * KS-3941 / ADR-118 §2.4.2. Опциональный JWT + резолвер доступа к
   * привязанной лекции. Если live-сессия связана с restricted-лекцией:
   *   - anon → 401 `{error:'auth_required'}`;
   *   - auth без grant'а → 403 `{error:'lecture_access_revoked'}`;
   *   - owner → пропускаем (allowed='owner').
   * Для public/unlisted и для трансляций без привязки к лекции —
   * прежнее поведение, без какой-либо проверки.
   */
  @UseGuards(OptionalJwtGuard)
  @Get(':slug')
  async getBySlug(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<LiveAnalysisResponse> {
    await this.lecturesAccess.assertAccessForLiveAnalysisSlug(
      slug,
      req.user?.id ?? null,
    );
    const result = await this.service.getBySlug(slug, this.publicBaseUrl());
    // KS-4135: у автора live-анализа (и любых nested user'ов) для гостя
    // вырезаем email/phone/oauthIds/lastSeenAt и пр.
    return toPublicDto(result, req.user ?? null);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':slug')
  @HttpCode(204)
  async closeBySlug(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<void> {
    const result = await this.service.closeBySlug(slug, req.user.id, 'by_owner');
    if (!result.alreadyClosed) {
      // Сообщаем подписчикам через gateway, чтобы те, кто уже в комнате,
      // получили `closed`-event без таймаута на pub/sub round-trip.
      this.gateway.broadcastClosed(slug, 'by_owner');
    }
  }

  /**
   * KS-4627 / ADR-142 §2.6. Тренер переключил активное окно анализа во
   * время live-лекции. Возвращает актуальный `SyncSnapshot` (тренер
   * применяет его локально без round-trip через WS). Подписчики комнаты
   * параллельно получают `live-analysis:sync` (legacy) и
   * `live-analysis:analysis-switch` (новое событие, ADR §2.7) — оба
   * публикуются сервисом через Redis pub/sub.
   *
   * Ошибки: 401 (без JWT), 403 (не владелец трансляции / Analysis принадлежит
   * другому пользователю), 404 (трансляция закрыта или Analysis не найден),
   * 400 (`tree` > 256 KB, rate-limit).
   */
  @UseGuards(JwtAuthGuard)
  @Post(':slug/switch-analysis')
  async switchAnalysis(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() body: SwitchAnalysisDto,
  ): Promise<SwitchAnalysisResponse> {
    return this.service.applySwitchAnalysis(slug, req.user.id, body);
  }

  private publicBaseUrl(): string {
    // `LIVE_ANALYSIS_PUBLIC_BASE_URL` — настраивается отдельно для preview
    // окружений; на проде совпадает с `PUBLIC_BASE_URL` / domain фронта.
    return (
      this.config.get<string>('LIVE_ANALYSIS_PUBLIC_BASE_URL') ||
      this.config.get<string>('PUBLIC_BASE_URL') ||
      'https://kingside.site'
    );
  }
}
