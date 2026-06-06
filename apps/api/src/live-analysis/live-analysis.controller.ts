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
} from '@kingside/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { CreateLiveAnalysisDto } from './dto/create-live-analysis.dto';
import { LiveAnalysisService } from './live-analysis.service';
import { LiveAnalysisGateway } from './live-analysis.gateway';

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

  @Get(':slug')
  getBySlug(@Param('slug') slug: string): Promise<LiveAnalysisResponse> {
    return this.service.getBySlug(slug, this.publicBaseUrl());
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
