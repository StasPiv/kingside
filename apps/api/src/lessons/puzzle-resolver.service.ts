import { Injectable, NotFoundException } from '@nestjs/common';
import type { PuzzleStepPayload } from '@kingside/shared';
import { PuzzleService } from '../puzzle/puzzle.service';

/**
 * Резолвер `PuzzleStepPayload` в реальный список задач (KS-1761).
 *
 * Не держит своей логики задач — делегирует в `PuzzleService`
 * (ADR-024 §2.5). Два режима:
 *  - `selection.mode='ids'` — строгий список `puzzleIds` из фикстуры.
 *  - `selection.mode='filter'` — фильтр по темам+рейтингу + `limit`;
 *     источник по умолчанию `lichess` (риск «нестабильные puzzleId» в
 *     сгенерированных задачах — lessons-roadmap.md §5).
 */
@Injectable()
export class LessonPuzzleResolverService {
  constructor(private readonly puzzleService: PuzzleService) {}

  async resolve(
    payload: PuzzleStepPayload,
    options: {
      excludeIds?: string[];
      source?: string;
      orderBy?: 'random' | 'rating' | 'popularity';
    } = {},
  ) {
    if (payload.selection.mode === 'ids') {
      return this.resolveIds(payload.selection.puzzleIds);
    }

    return this.puzzleService.findPuzzles({
      themes: payload.selection.themes,
      ratingMin: payload.selection.ratingMin,
      ratingMax: payload.selection.ratingMax,
      limit: payload.selection.limit,
      // KS-1783: дефолт убран (раньше был `'lichess'`) — до импорта
      // реальной Lichess-базы задач на dev / staging / prod ограничение
      // по source выдавало пустые списки. `source` остаётся опциональным;
      // вызывающий может передать его явно, чтобы ограничиться курируемым
      // источником (после импорта вернём дефолт обратно отдельной задачей).
      source: options.source,
      excludeIds: options.excludeIds,
      // KS-1776: дефолт `random`, иначе все пользователи получают
      // одинаковый срез «первых N по возрастанию рейтинга».
      // Детерминированность в рамках прохождения — в L-09/L-11 через stepsState.
      orderBy: options.orderBy ?? 'random',
    });
  }

  private async resolveIds(ids: string[]) {
    const out = [];
    for (const id of ids) {
      try {
        out.push(await this.puzzleService.getPuzzle(id));
      } catch (e) {
        if (e instanceof NotFoundException) {
          throw new NotFoundException(`Puzzle "${id}" referenced by lesson step not found`);
        }
        throw e;
      }
    }
    return out;
  }
}
