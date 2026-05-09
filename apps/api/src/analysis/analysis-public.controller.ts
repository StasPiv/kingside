import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { AnalysisService } from './analysis.service';

/**
 * KS-2601 (ADR-051 §3 share-2). Публичный read-only доступ к анализу
 * по `id`, если у записи `isPublic=true`.
 *
 * Вынесён в отдельный контроллер (без `@UseGuards(JwtAuthGuard)`),
 * чтобы не пересекаться с приватным `AnalysisController`, у которого
 * guard стоит на классе. NestJS не позволяет «снять» class-level
 * guard на уровне метода, поэтому отдельный контроллер — самый
 * чистый паттерн.
 *
 * Path `analyses/public` гарантированно не конфликтует с
 * параметрическим `:id` приватного контроллера: Nest сначала матчит
 * статические сегменты, а UUID-pipe всё равно отклонил бы строку
 * "public" как id.
 */
@Controller('analyses/public')
export class AnalysisPublicController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Get(':id')
  findPublic(@Param('id', ParseUUIDPipe) id: string) {
    return this.analysisService.findPublic(id);
  }
}
