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
  type GamePositionalTraceDto,
  type PositionalTracePly,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminUserService } from '../../auth/admin-user.guard';
import type { PositionalTraceUpsertDto } from './dto/positional-trace.dto';

/**
 * KS-4023 / ADR-122 §3, §4. Сервис позиционной трассы партии:
 * UPSERT по `gameId`, чтение, удаление. Версионирование через
 * `sfVersion` — старая запись затирается при перерасчёте, отдельная
 * история не ведётся (см. ADR §12 — отвергнут вариант «несколько
 * версий параллельно»).
 *
 * Контроллер тонкий: только маршрутизация + auth/guard. Вся
 * бизнес-логика (проверка размера, монотонность `ply`, версия,
 * формирование DTO) живёт здесь.
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
    gameId: string,
    requestedVersion: string,
  ): Promise<GamePositionalTraceDto> {
    const row = await this.prisma.gamePositionalTrace.findUnique({
      where: { gameId },
      select: {
        gameId: true,
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
   *   1. Размер JSON-тела ≤ 256 КБ. Считаем длину уже сериализованного
   *      DTO — Express принимает тело как JSON, длина строки ≈ длине
   *      сети ± микроскопические отличия (whitespace), но порог даём
   *      с запасом для DOS-защиты на класс-валидатор.
   *   2. `sfVersion` совпадает с серверной константой
   *      `POSITIONAL_TRACE_VERSION`. Иначе 400 `sf_version_mismatch`.
   *   3. `plies` монотонно возрастает по `ply` без дыр (см. ADR §3.1):
   *      `plies[i].ply == i` ⇒ строгая монотонность 0,1,2,…; дыры
   *      запрещены — иначе график пропускает полуходы.
   *
   * Возврат — DTO, идентичный `getOrThrow`. Контроллер выставляет
   * 201/200 по факту первой записи или перезаписи (см. возвращаемый
   * `wasCreated`).
   */
  async upsert(
    gameId: string,
    actingUserId: string | null,
    payload: PositionalTraceUpsertDto,
  ): Promise<{ trace: GamePositionalTraceDto; wasCreated: boolean }> {
    // 1) Размер тела. Сериализация уже произведена express'ом, но
    //    надёжнее посчитать ещё раз на DTO — буфер запроса нам не
    //    доступен, JSON.stringify даст близкую оценку.
    const bodySize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bodySize > POSITIONAL_TRACE_MAX_BODY_BYTES) {
      throw new PayloadTooLargeException({
        error: 'positional_trace_too_large',
        limitBytes: POSITIONAL_TRACE_MAX_BODY_BYTES,
        actualBytes: bodySize,
      });
    }

    // 2) Версия.
    if (payload.sfVersion !== POSITIONAL_TRACE_VERSION) {
      throw new BadRequestException({
        error: 'sf_version_mismatch',
        expected: POSITIONAL_TRACE_VERSION,
        got: payload.sfVersion,
      });
    }

    // 3) Монотонность `ply`. Требуем 0,1,2,…N без пропусков.
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

    // 4) Существует ли партия (FK Cascade всё равно бросит ошибку на
    //    insert'е, но дружелюбнее ответить 404 явно). Берём один SELECT
    //    с минимальным набором полей.
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) {
      throw new NotFoundException({
        error: 'game_not_found',
      });
    }

    // 5) UPSERT. Старая запись затирается полностью — мы НЕ мержим
    //    plies, потому что версия могла измениться, и старые ключи
    //    устарели семантически.
    const existing = await this.prisma.gamePositionalTrace.findUnique({
      where: { gameId },
      select: { id: true },
    });
    const row = await this.prisma.gamePositionalTrace.upsert({
      where: { gameId },
      create: {
        gameId,
        sfVersion: payload.sfVersion,
        plies: payload.plies as unknown as object[],
        durationMs: payload.durationMs ?? null,
        createdById: actingUserId,
      },
      update: {
        sfVersion: payload.sfVersion,
        plies: payload.plies as unknown as object[],
        durationMs: payload.durationMs ?? null,
        // createdById НЕ обновляем — храним первого автора (FYI поле,
        // не критично для бизнеса).
      },
      select: {
        gameId: true,
        sfVersion: true,
        plies: true,
        durationMs: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    this.logger.log(
      `positional-trace upsert: game=${gameId} version=${payload.sfVersion} ` +
        `plies=${payload.plies.length} sizeBytes=${bodySize} ` +
        `wasCreated=${!existing}`,
    );
    return { trace: this.toDto(row), wasCreated: !existing };
  }

  /**
   * DELETE — доступен:
   *   - владельцу партии (`Game.whiteId == actor` или `blackId == actor`);
   *   - админу (см. `AdminUserService.isAdmin`).
   *
   * Идемпотентно: если записи или партии нет — всё равно 204. Это
   * упрощает «инструмент модератора» (повторное удаление не падает).
   */
  async deleteByGame(
    gameId: string,
    actingUserId: string,
  ): Promise<void> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { whiteId: true, blackId: true },
    });
    // Партии нет — считаем DELETE no-op (та же запись и не могла
    // существовать без партии: FK Cascade). 204 без бросания.
    if (!game) return;

    const isOwner =
      game.whiteId === actingUserId || game.blackId === actingUserId;
    if (!isOwner) {
      const isAdmin = await this.adminUser.isAdmin(actingUserId);
      if (!isAdmin) {
        throw new ForbiddenException({
          error: 'forbidden',
          reason: 'not_game_owner_or_admin',
        });
      }
    }

    await this.prisma.gamePositionalTrace
      .delete({ where: { gameId } })
      .catch((e: { code?: string }) => {
        // P2025 — record to delete not found. Идемпотентно: 204 как
        // если бы записи и не было.
        if (e?.code === 'P2025') return;
        throw e;
      });
  }

  // ─── helpers ────────────────────────────────────────────────────

  private toDto(row: {
    gameId: string;
    sfVersion: string;
    plies: unknown;
    durationMs: number | null;
    createdAt: Date;
    updatedAt: Date;
  }): GamePositionalTraceDto {
    return {
      gameId: row.gameId,
      sfVersion: row.sfVersion,
      plies: (row.plies as unknown as PositionalTracePly[]) ?? [],
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
