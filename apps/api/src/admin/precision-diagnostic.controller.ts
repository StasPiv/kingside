/**
 * KS-4238. Диагностика precision-выборки: распределение задач по
 * objective-меткам (`convertAdvantage` / `saveEquality`) в публичном
 * корпусе. Используется для понимания корня перекоса:
 *   - симметричный baseline (~50/50) → проблема в коде выборки;
 *   - перекошенный baseline → проблема в данных, фикс через
 *     нормализацию выбора.
 *
 * Аутентификация — тот же `X-Admin-Token` (env `BROADCAST_ADMIN_TOKEN`).
 */

import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Controller('admin/precision')
export class PrecisionDiagnosticController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get('diagnostic')
  async diagnostic(
    @Headers('x-admin-token') token: string | undefined,
  ): Promise<{
    total: number;
    publicTotal: number;
    saveEqualityCount: number;
    convertAdvantageCount: number;
    saveEqualityRatio: number;
    convertAdvantageRatio: number;
    sampleFirst50Themes: string[];
  }> {
    this.assertAuth(token);

    const baseWhere = { source: 'generated', isPublic: true };

    const [total, publicTotal, saveEq, convAdv, sample] = await Promise.all([
      this.prisma.puzzle.count(),
      this.prisma.puzzle.count({ where: baseWhere }),
      this.prisma.puzzle.count({
        where: { ...baseWhere, themes: { contains: 'saveEquality' } },
      }),
      this.prisma.puzzle.count({
        where: { ...baseWhere, themes: { contains: 'convertAdvantage' } },
      }),
      // Воспроизводим запрос pickNext: take=50 БЕЗ orderBy.
      // Смотрим какие objective-метки попадают в выборку «first 50».
      this.prisma.puzzle.findMany({
        where: baseWhere,
        select: { themes: true },
        take: 50,
      }),
    ]);

    return {
      total,
      publicTotal,
      saveEqualityCount: saveEq,
      convertAdvantageCount: convAdv,
      saveEqualityRatio: publicTotal === 0 ? 0 : saveEq / publicTotal,
      convertAdvantageRatio: publicTotal === 0 ? 0 : convAdv / publicTotal,
      // Помечаем какая objective-метка преобладает в первых 50.
      sampleFirst50Themes: sample.map((r) => {
        const t = r.themes ?? '';
        const hasSave = /saveEquality/.test(t);
        const hasConv = /convertAdvantage/.test(t);
        return hasSave && hasConv
          ? 'both'
          : hasSave
            ? 'saveEquality'
            : hasConv
              ? 'convertAdvantage'
              : 'none';
      }),
    };
  }

  private assertAuth(token: string | undefined): void {
    const expected = this.config.get<string>('BROADCAST_ADMIN_TOKEN');
    if (!expected || !expected.trim()) {
      throw new HttpException(
        'admin endpoint is not configured (BROADCAST_ADMIN_TOKEN missing)',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!token || token !== expected) {
      throw new HttpException('forbidden', HttpStatus.FORBIDDEN);
    }
  }
}
