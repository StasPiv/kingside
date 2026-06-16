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
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PrecisionService } from '../precision/precision.service';

@Controller('admin/precision')
export class PrecisionDiagnosticController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly precision: PrecisionService,
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

  /**
   * KS-4243. Последние precision-attempts пользователя с расшифровкой
   * objective из puzzle.themes. Используется для проверки эффекта
   * KS-4238 на проде.
   */
  @Get('recent-attempts')
  async recentAttempts(
    @Headers('x-admin-token') token: string | undefined,
    @Query('userId') userId: string,
    @Query('limit') limitRaw?: string,
    @Query('since') sinceRaw?: string,
  ): Promise<{
    userId: string;
    since: string | null;
    total: number;
    saveEquality: number;
    convertAdvantage: number;
    other: number;
    items: Array<{
      attemptId: string;
      puzzleId: string;
      createdAt: string;
      objective: 'saveEquality' | 'convertAdvantage' | 'other';
      themes: string;
    }>;
  }> {
    this.assertAuth(token);
    if (!userId) throw new HttpException('userId is required', 400);
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '30', 10) || 30, 1), 200);
    const since = sinceRaw ? new Date(sinceRaw) : null;

    const rows = await this.prisma.puzzleAttempt.findMany({
      where: {
        userId,
        precisionAttempt: { isNot: null },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        puzzleId: true,
        createdAt: true,
        puzzle: { select: { themes: true } },
      },
    });

    let saveEq = 0;
    let convAdv = 0;
    let other = 0;
    const items = rows.map((r) => {
      const themes = r.puzzle?.themes ?? '';
      const hasSave = /saveEquality/.test(themes);
      const hasConv = /convertAdvantage/.test(themes);
      const objective: 'saveEquality' | 'convertAdvantage' | 'other' =
        hasConv ? 'convertAdvantage' : hasSave ? 'saveEquality' : 'other';
      if (objective === 'saveEquality') saveEq++;
      else if (objective === 'convertAdvantage') convAdv++;
      else other++;
      return {
        attemptId: r.id,
        puzzleId: r.puzzleId,
        createdAt: r.createdAt.toISOString(),
        objective,
        themes,
      };
    });

    return {
      userId,
      since: since?.toISOString() ?? null,
      total: rows.length,
      saveEquality: saveEq,
      convertAdvantage: convAdv,
      other,
      items,
    };
  }

  /**
   * KS-4243. Симуляция N последовательных pickNext'ов для конкретного
   * пользователя с дефолтными фильтрами. Считает распределение
   * objective по полученным puzzle'ам.
   *
   * Не пишет precision_attempts — это только чтение, эффект на
   * рейтинги нулевой.
   */
  @Get('simulate')
  async simulate(
    @Headers('x-admin-token') token: string | undefined,
    @Query('userId') userId: string,
    @Query('n') nRaw?: string,
    @Query('hideSolved') hideSolvedRaw?: string,
  ): Promise<{
    userId: string;
    n: number;
    hideSolved: boolean;
    distribution: {
      saveEquality: number;
      convertAdvantage: number;
      other: number;
    };
    uniquePuzzles: number;
    picks: Array<{ puzzleId: string; objective: string }>;
  }> {
    this.assertAuth(token);
    if (!userId) throw new HttpException('userId is required', 400);
    const n = Math.min(Math.max(parseInt(nRaw ?? '30', 10) || 30, 1), 100);
    const hideSolved = hideSolvedRaw === 'true';

    const picks: Array<{ puzzleId: string; objective: string }> = [];
    let saveEq = 0;
    let convAdv = 0;
    let other = 0;
    const seenIds = new Set<string>();

    for (let i = 0; i < n; i++) {
      const result = await this.precision.pickNext(userId, {
        scope: 'server',
        objective: 'all',
        hideSolved,
      });
      if (!result || !('puzzleId' in result) || result.puzzleId === null) {
        picks.push({ puzzleId: 'none', objective: 'none' });
        continue;
      }
      const puzzleId = result.puzzleId;
      seenIds.add(puzzleId);
      const puzzle = await this.prisma.puzzle.findUnique({
        where: { id: puzzleId },
        select: { themes: true },
      });
      const themes = puzzle?.themes ?? '';
      const hasConv = /convertAdvantage/.test(themes);
      const hasSave = /saveEquality/.test(themes);
      const objective = hasConv
        ? 'convertAdvantage'
        : hasSave
          ? 'saveEquality'
          : 'other';
      if (objective === 'saveEquality') saveEq++;
      else if (objective === 'convertAdvantage') convAdv++;
      else other++;
      picks.push({ puzzleId, objective });
    }

    return {
      userId,
      n,
      hideSolved,
      distribution: {
        saveEquality: saveEq,
        convertAdvantage: convAdv,
        other,
      },
      uniquePuzzles: seenIds.size,
      picks,
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
