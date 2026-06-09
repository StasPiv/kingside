import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  POSITIONAL_TRACE_MAX_BODY_BYTES,
  POSITIONAL_TRACE_VERSION,
  type AnalysisPositionalTraceDto,
  type PositionalTracePly,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminUserService } from '../../auth/admin-user.guard';
import type { PositionalTraceUpsertDto } from './dto/positional-trace.dto';

/**
 * KS-4026 / ADR-122 §3, §4. Сервис позиционной трассы анализа: UPSERT
 * по `analysisId`, чтение, удаление. Версионирование через `sfVersion`
 * — старая запись затирается при перерасчёте, отдельная история не
 * ведётся (см. ADR §12 — отвергнут вариант «несколько версий
 * параллельно»).
 *
 * Контроллер тонкий: только маршрутизация + auth/guard. Вся
 * бизнес-логика (проверка размера, монотонность `ply`, версия,
 * формирование DTO, проверка прав на удаление) живёт здесь.
 *
 * Переезд с `gameId` (KS-4023): в реальном потоке пользователя
 * `openAnalysisFromPgn` создаёт новый Analysis под архивную партию,
 * `gameId` почти всегда отсутствует — поэтому ключ хранения теперь
 * `analysisId`.
 */
@Injectable()
export class PositionalTraceService {
  private readonly logger = new Logger(PositionalTraceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminUser: AdminUserService,
  ) {}

  /**
   * GET — отдаём запись, если она есть и её `sfVersion` совпадает с
   * запрошенной клиентом. Несовпадение → 404 (а не 409/400), чтобы
   * клиент трактовал это как «кеша нет, пора пересчитывать» —
   * стандартный поток ADR-122 §2.1.
   */
  async getOrThrow(
    analysisId: string,
    requestedVersion: string,
  ): Promise<AnalysisPositionalTraceDto> {
    const row = await this.prisma.analysisPositionalTrace.findUnique({
      where: { analysisId },
      select: {
        analysisId: true,
        sfVersion: true,
        plies: true,
        durationMs: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!row || row.sfVersion !== requestedVersion) {
      throw new NotFoundException({
        error: 'positional_trace_not_found',
      });
    }
    return this.toDto(row);
  }

  /**
   * UPSERT с проверками:
   *   1. Размер JSON-тела ≤ 256 КБ.
   *   2. `sfVersion` совпадает с серверной константой
   *      `POSITIONAL_TRACE_VERSION`. Иначе 400 `sf_version_mismatch`.
   *   3. `plies` монотонно возрастает по `ply` без дыр.
   *   4. Анализ существует.
   *   5. UPSERT по `analysisId`.
   *
   * Возврат — DTO, идентичный `getOrThrow`. Контроллер выставляет
   * 201/200 по факту первой записи или перезаписи (см. возвращаемый
   * `wasCreated`).
   */
  async upsert(
    analysisId: string,
    actingUserId: string | null,
    payload: PositionalTraceUpsertDto,
  ): Promise<{ trace: AnalysisPositionalTraceDto; wasCreated: boolean }> {
    const bodySize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bodySize > POSITIONAL_TRACE_MAX_BODY_BYTES) {
      throw new PayloadTooLargeException({
        error: 'positional_trace_too_large',
        limitBytes: POSITIONAL_TRACE_MAX_BODY_BYTES,
        actualBytes: bodySize,
      });
    }

    if (payload.sfVersion !== POSITIONAL_TRACE_VERSION) {
      throw new BadRequestException({
        error: 'sf_version_mismatch',
        expected: POSITIONAL_TRACE_VERSION,
        got: payload.sfVersion,
      });
    }

    for (let i = 0; i < payload.plies.length; i++) {
      if (payload.plies[i].ply !== i) {
        throw new BadRequestException({
          error: 'positional_trace_invalid',
          reason: 'ply_sequence_not_monotonic',
          atIndex: i,
          expectedPly: i,
          gotPly: payload.plies[i].ply,
        });
      }
    }

    const analysis = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      select: { id: true },
    });
    if (!analysis) {
      throw new NotFoundException({
        error: 'analysis_not_found',
      });
    }

    const existing = await this.prisma.analysisPositionalTrace.findUnique({
      where: { analysisId },
      select: { id: true },
    });
    const row = await this.prisma.analysisPositionalTrace.upsert({
      where: { analysisId },
      create: {
        analysisId,
        sfVersion: payload.sfVersion,
        plies: payload.plies as unknown as object[],
        durationMs: payload.durationMs ?? null,
        createdById: actingUserId,
      },
      update: {
        sfVersion: payload.sfVersion,
        plies: payload.plies as unknown as object[],
        durationMs: payload.durationMs ?? null,
        // createdById НЕ обновляем — храним первого автора.
      },
      select: {
        analysisId: true,
        sfVersion: true,
        plies: true,
        durationMs: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    this.logger.log(
      `positional-trace upsert: analysis=${analysisId} version=${payload.sfVersion} ` +
        `plies=${payload.plies.length} sizeBytes=${bodySize} ` +
        `wasCreated=${!existing}`,
    );
    return { trace: this.toDto(row), wasCreated: !existing };
  }

  /**
   * DELETE — доступен:
   *   - владельцу анализа (`Analysis.userId == actor`);
   *   - админу (см. `AdminUserService.isAdmin`).
   *
   * Идемпотентно: если записи или анализа нет — всё равно 204.
   */
  async deleteByAnalysis(
    analysisId: string,
    actingUserId: string,
  ): Promise<void> {
    const analysis = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      select: { userId: true },
    });
    if (!analysis) return;

    const isOwner = analysis.userId === actingUserId;
    if (!isOwner) {
      const isAdmin = await this.adminUser.isAdmin(actingUserId);
      if (!isAdmin) {
        throw new ForbiddenException({
          error: 'forbidden',
          reason: 'not_analysis_owner_or_admin',
        });
      }
    }

    await this.prisma.analysisPositionalTrace
      .delete({ where: { analysisId } })
      .catch((e: { code?: string }) => {
        if (e?.code === 'P2025') return;
        throw e;
      });
  }

  // ─── helpers ────────────────────────────────────────────────────

  private toDto(row: {
    analysisId: string;
    sfVersion: string;
    plies: unknown;
    durationMs: number | null;
    createdAt: Date;
    updatedAt: Date;
  }): AnalysisPositionalTraceDto {
    return {
      analysisId: row.analysisId,
      sfVersion: row.sfVersion,
      plies: (row.plies as unknown as PositionalTracePly[]) ?? [],
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
