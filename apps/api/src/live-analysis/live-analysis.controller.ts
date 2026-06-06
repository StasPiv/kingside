import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
 *   POST   /live-analyses           — создать (Jwt-only).
 *   GET    /live-analyses/me        — список своих (Jwt-only).
 *   GET    /live-analyses/:slug     — snapshot (анонимный доступ).
 *   DELETE /live-analyses/:slug     — закрыть, только owner.
 *
 * ВАЖНО: `/me` объявлен раньше `/:slug` — иначе Nest-роутер съест
 * статический сегмент динамическим параметром.
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
