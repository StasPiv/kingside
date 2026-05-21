/**
 * KS-3180 / ADR-072 §7 B1 — snapshot `GameStepPayload.sourceType='workshop_analysis'`
 * из таблицы `Analysis`.
 *
 * Контракт:
 *   - Если `payload.type !== 'game'` — no-op, возвращаем payload как есть.
 *   - Если `payload.type === 'game' && sourceType === 'pgn'` — no-op,
 *     payload уже валиден на уровне DTO (PGN ≤ 200 КБ, chess.js parse).
 *   - Если `payload.type === 'game' && sourceType === 'workshop_analysis'`:
 *       * читаем `Analysis` по `analysisId`,
 *       * 404 если запись не существует,
 *       * 403 если `analysis.userId !== userId` (owner-check),
 *       * 400 если у анализа нет `pgn` (для шага нужна играемая партия),
 *       * snapshot'ом копируем `pgn` + meta-теги в payload (overwrite
 *         любых клиентских значений) — после этого шаг самодостаточен:
 *         удаление исходного `Analysis` не сломает урок.
 *
 * Возврат — НОВЫЙ объект payload'а (исходный не мутируем — он мог
 * прийти из class-transformer'а с метаданными discriminator'а).
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { GameStepPayload, StepPayload } from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { checkGamePgn, MAX_GAME_PGN_BYTES } from './game-step.validators';

@Injectable()
export class GameStepHydratorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Подменяет `GameStepPayload(sourceType='workshop_analysis')` snapshot'ом
   * из `Analysis`. Прочие типы payload'а — пропускает без изменений.
   *
   * @param payload — валидированный DTO payload (любой из StepPayload).
   * @param userId — id текущего пользователя (для owner-check'а
   *   `Analysis.userId === userId`). Обязателен, если payload — game со
   *   sourceType=workshop_analysis; для остальных вызовов можно null
   *   (но безопаснее всегда передавать).
   */
  async hydrate<P extends StepPayload>(payload: P, userId: string | null): Promise<P> {
    if (!isGameStepPayload(payload)) return payload;
    if (payload.sourceType !== 'workshop_analysis') return payload;

    const analysisId = payload.analysisId;
    if (!analysisId) {
      // KS-3185: draft-режим — автор только что выбрал
      // sourceType=workshop_analysis, но ещё не указал, какой именно
      // анализ. Шаг сохраняется как заглушка, snapshot подтянем при
      // следующем PATCH с analysisId. Возвращаем payload как есть.
      return payload;
    }
    if (!userId) {
      throw new ForbiddenException(
        `userId is required to snapshot workshop analysis`,
      );
    }

    const analysis = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      select: {
        id: true,
        userId: true,
        pgn: true,
        white: true,
        black: true,
        result: true,
        pgnDate: true,
        event: true,
        site: true,
        round: true,
      },
    });
    if (!analysis) {
      throw new NotFoundException(`Analysis ${analysisId} not found`);
    }
    if (analysis.userId !== userId) {
      throw new ForbiddenException(
        `Analysis ${analysisId} does not belong to current user`,
      );
    }
    if (!analysis.pgn || analysis.pgn.trim().length === 0) {
      throw new BadRequestException(
        `Analysis ${analysisId} has no PGN — cannot create game step without playable moves`,
      );
    }

    // Дополнительная защита: PGN из БД может быть длиннее лимита (старые
    // анализы без лимита). Тогда честно говорим 400 — иначе шаг создастся
    // с pgn > 200 КБ, и фронт будет давиться при загрузке.
    if (Buffer.byteLength(analysis.pgn, 'utf8') > MAX_GAME_PGN_BYTES) {
      throw new BadRequestException(
        `Analysis ${analysisId} PGN exceeds ${MAX_GAME_PGN_BYTES} bytes — split or trim before snapshot`,
      );
    }
    // Дополнительная санити-проверка: PGN должен парситься. На уровне
    // `Analysis.create` его никто строго не валидировал (см.
    // `analysis.service.ts`), а нам шаг с непарсящимся PGN не нужен.
    const pgnCheck = checkGamePgn(analysis.pgn);
    if (!pgnCheck.ok) {
      throw new BadRequestException(
        `Analysis ${analysisId} PGN failed validation: ${pgnCheck.reason}`,
      );
    }

    const snapshot: GameStepPayload = {
      type: 'game',
      sourceType: 'workshop_analysis',
      pgn: analysis.pgn,
      analysisId,
      meta: {
        ...(analysis.white ? { white: analysis.white } : {}),
        ...(analysis.black ? { black: analysis.black } : {}),
        ...(analysis.result ? { result: analysis.result } : {}),
        ...(analysis.pgnDate ? { date: analysis.pgnDate } : {}),
        ...(analysis.event ? { event: analysis.event } : {}),
        ...(analysis.site ? { site: analysis.site } : {}),
        ...(analysis.round ? { round: analysis.round } : {}),
      },
    };
    // Если meta пустая — удалим ключ, чтобы не плодить шум в JSONB.
    if (snapshot.meta && Object.keys(snapshot.meta).length === 0) {
      delete snapshot.meta;
    }
    return snapshot as unknown as P;
  }
}

function isGameStepPayload(p: StepPayload): p is GameStepPayload {
  return (p as { type?: unknown }).type === 'game';
}
