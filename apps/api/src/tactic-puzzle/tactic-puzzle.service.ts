/**
 * KS-4342 / ADR-135 §2.4. Сервис раздела «Точность» (`/tactic-puzzles/*`).
 *
 * Изолирован от legacy `PuzzleService` — другая таблица (`tactic_puzzles`),
 * другой концепт (нет `solutionMode`, `puzzlePhase`, forced-line). Старый
 * `apps/api/src/puzzle/` не трогается, см. ADR-135 §2.6 / T9.
 *
 * Подбор пазла `/next`:
 *   1. Берём рейтинг пользователя из `user_tactic_ratings` (упорядочиваем
 *      по близости `|tactic_puzzles.rating - user.rating|`).
 *   2. Исключаем пазлы, на которые у пользователя уже есть успешная
 *      попытка (`tactic_puzzle_attempts.solved=true`) — повтор имеет
 *      смысл только из журнала ошибок (`/mistakes`).
 *
 * Попытка `/attempts`:
 *   * `solved` выводится из `stopReason` (`easy` ≡ пользователь
 *     завершил пазл сам когда сложность упала; `mate` — мат/пат;
 *     остальные — не решено).
 *   * Glicko-1 update идёт через тот же `GlickoRatingService`, что и
 *     legacy /puzzles — параметры формулы общие.
 *   * Mistake-журнал: при неуспехе (mistake/timeout/aborted) делаем
 *     `upsert` в `tactic_user_mistakes` (UNIQUE userId+puzzleId).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@kingside/db';

type TacticPuzzle = Prisma.TacticPuzzleModel;
type TacticPuzzleAttempt = Prisma.TacticPuzzleAttemptModel;
type TacticUserMistake = Prisma.TacticUserMistakeModel;
type UserTacticRating = Prisma.UserTacticRatingModel;
import {
  type SubmitTacticAttemptInput,
  type SubmitTacticAttemptResponse,
  type TacticPuzzleBrowsePage,
  type TacticPuzzleBrowseQuery,
  type TacticPuzzleResponse,
  type TacticPuzzleStopReason,
  type TacticUserMistakeItem,
  type TacticUserMistakesPage,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GlickoRatingService } from '../puzzle/glicko-rating.service';

const DEFAULT_BROWSE_LIMIT = 20;
const MAX_BROWSE_LIMIT = 100;
const DEFAULT_USER_RATING = 1500;
const DEFAULT_USER_RD = 350;

@Injectable()
export class TacticPuzzleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly glicko: GlickoRatingService,
  ) {}

  // ─── /next ──────────────────────────────────────────────────────

  /**
   * Выдаёт следующий tactic-пазл для пользователя. Простейшая стратегия:
   * ищем ближайший по рейтингу из непройденных. Подразумеваем небольшой
   * банк (~единицы тысяч записей) — full-scan по `tactic_puzzles` с
   * фильтром на «нерешённые» дешевле, чем сложный sampling-pipeline.
   * Усложним на T8 после массовой генерации, если потребуется.
   */
  async getNextForUser(userId: string): Promise<TacticPuzzleResponse> {
    const rating = await this.getOrCreateUserRating(userId);

    const solvedIds = await this.prisma.tacticPuzzleAttempt.findMany({
      where: { userId, solved: true },
      select: { puzzleId: true },
    });
    const excludeIds = solvedIds.map((r) => r.puzzleId);

    const where: Prisma.TacticPuzzleWhereInput =
      excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {};

    // Ближайший по рейтингу: берём top-50 «вокруг» нашего ratingу
    // и выбираем рандомный из них для разнообразия между попытками.
    const targetRating = Math.round(rating.rating);
    const candidates = await this.prisma.tacticPuzzle.findMany({
      where: {
        ...where,
        rating: { gte: targetRating - 200, lte: targetRating + 200 },
      },
      take: 50,
      orderBy: { rating: 'asc' },
    });
    const pool = candidates.length > 0
      ? candidates
      : await this.prisma.tacticPuzzle.findMany({
          where,
          take: 50,
          orderBy: { rating: 'asc' },
        });

    if (pool.length === 0) {
      throw new NotFoundException('No tactic puzzles available');
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    return this.toResponse(picked);
  }

  // ─── /:id ───────────────────────────────────────────────────────

  async getById(id: string): Promise<TacticPuzzleResponse> {
    const puzzle = await this.prisma.tacticPuzzle.findUnique({
      where: { id },
    });
    if (!puzzle) {
      throw new NotFoundException(`Tactic puzzle ${id} not found`);
    }
    return this.toResponse(puzzle);
  }

  // ─── /browse ────────────────────────────────────────────────────

  async browse(
    query: TacticPuzzleBrowseQuery,
  ): Promise<TacticPuzzleBrowsePage> {
    const limit = Math.min(
      Math.max(1, query.limit ?? DEFAULT_BROWSE_LIMIT),
      MAX_BROWSE_LIMIT,
    );
    const cursorId = decodeCursor(query.cursor);

    const where: Prisma.TacticPuzzleWhereInput = {};
    if (query.objective) where.objective = query.objective;
    if (query.maiaDifficultyMin != null) {
      where.difficulty = { gte: query.maiaDifficultyMin };
    }
    if (query.gapMin != null) where.gap = { gte: query.gapMin };
    if (query.ratingMin != null || query.ratingMax != null) {
      where.rating = {
        ...(query.ratingMin != null ? { gte: query.ratingMin } : {}),
        ...(query.ratingMax != null ? { lte: query.ratingMax } : {}),
      };
    }
    if (query.themes && query.themes.length > 0) {
      // themes хранятся как `"a b c"`. Простейший подход — для каждого
      // тега запрашиваем `contains` (LIKE %tag%). Точный поиск можно
      // ускорить GIN-индексом позже (см. legacy puzzles.themes_trgm_idx).
      where.AND = query.themes.map((t) => ({
        themes: { contains: t },
      }));
    }
    if (cursorId) {
      where.id = { gt: cursorId };
    }

    const items = await this.prisma.tacticPuzzle.findMany({
      where,
      take: limit + 1,
      orderBy: { id: 'asc' },
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1].id) : null;
    return {
      items: page.map((p) => this.toResponse(p)),
      nextCursor,
    };
  }

  // ─── /attempts ──────────────────────────────────────────────────

  async submitAttempt(
    userId: string,
    puzzleId: string,
    input: SubmitTacticAttemptInput,
  ): Promise<SubmitTacticAttemptResponse> {
    const puzzle = await this.prisma.tacticPuzzle.findUnique({
      where: { id: puzzleId },
    });
    if (!puzzle) {
      throw new NotFoundException(`Tactic puzzle ${puzzleId} not found`);
    }

    const userRating = await this.getOrCreateUserRating(userId);
    const solved = isSolvedStopReason(input.stopReason);

    const userUpdate = this.glicko.updateUserRating(
      Math.round(userRating.rating),
      Math.round(userRating.deviation),
      puzzle.rating,
      puzzle.ratingDev,
      solved,
    );
    const puzzleUpdate = this.glicko.updatePuzzleRating(
      puzzle.rating,
      puzzle.ratingDev,
      Math.round(userRating.rating),
      solved,
    );

    const attempt = await this.prisma.$transaction(async (tx) => {
      const created = await tx.tacticPuzzleAttempt.create({
        data: {
          puzzleId,
          userId,
          solved,
          timeMs: input.timeMs,
          ratingBefore: Math.round(userRating.rating),
          ratingAfter: userUpdate.newRating,
          puzzleRatingBefore: puzzle.rating,
          puzzleRatingAfter: puzzleUpdate.newRating,
          lineHalfMoves: input.lineHalfMoves,
          userMoves: input.userMoves,
          stopReason: input.stopReason,
          wdlStart: input.wdlStart ?? null,
          wdlEnd: input.wdlEnd ?? null,
          movesAccuracy: input.movesAccuracy ?? null,
          precisionGrade: input.precisionGrade ?? null,
        },
      });

      await tx.userTacticRating.upsert({
        where: { userId },
        update: {
          rating: userUpdate.newRating,
          deviation: userUpdate.newRD,
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
        },
        create: {
          userId,
          rating: userUpdate.newRating,
          deviation: userUpdate.newRD,
          volatility: 0.06,
          attempts: 1,
          lastAttemptAt: new Date(),
        },
      });

      await tx.tacticPuzzle.update({
        where: { id: puzzleId },
        data: {
          rating: puzzleUpdate.newRating,
          ratingDev: puzzleUpdate.newRD,
          nbPlays: { increment: 1 },
        },
      });

      return created;
    });

    const addedToMistakes = await this.maybeAddMistake(
      userId,
      puzzleId,
      solved,
      input.stopReason,
    );

    return {
      attemptId: attempt.id,
      solved,
      ratingBefore: Math.round(userRating.rating),
      ratingAfter: userUpdate.newRating,
      puzzleRatingBefore: puzzle.rating,
      puzzleRatingAfter: puzzleUpdate.newRating,
      addedToMistakes,
    };
  }

  // ─── /mistakes ──────────────────────────────────────────────────

  async listMistakes(
    userId: string,
    cursor?: string,
    limit = DEFAULT_BROWSE_LIMIT,
  ): Promise<TacticUserMistakesPage> {
    const cursorId = decodeCursor(cursor);
    const take = Math.min(
      Math.max(1, limit ?? DEFAULT_BROWSE_LIMIT),
      MAX_BROWSE_LIMIT,
    );
    const mistakes = await this.prisma.tacticUserMistake.findMany({
      where: {
        userId,
        resolved: false,
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      take: take + 1,
      orderBy: { id: 'asc' },
      include: { puzzle: true },
    });
    const hasMore = mistakes.length > take;
    const page = hasMore ? mistakes.slice(0, take) : mistakes;
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1].id) : null;
    return {
      items: page.map((m) => this.toMistakeItem(m)),
      nextCursor,
    };
  }

  // ─── helpers ────────────────────────────────────────────────────

  private async getOrCreateUserRating(
    userId: string,
  ): Promise<UserTacticRating> {
    const existing = await this.prisma.userTacticRating.findUnique({
      where: { userId },
    });
    if (existing) return existing;
    // Возвращаем «виртуальную» запись без persisting — реальную создадим
    // при первой попытке. Это даёт чистый старт без побочного эффекта
    // от GET /next.
    return {
      userId,
      rating: DEFAULT_USER_RATING,
      deviation: DEFAULT_USER_RD,
      volatility: 0.06,
      attempts: 0,
      lastAttemptAt: null,
      updatedAt: new Date(0),
    };
  }

  private async maybeAddMistake(
    userId: string,
    puzzleId: string,
    solved: boolean,
    stopReason: TacticPuzzleStopReason,
  ): Promise<boolean> {
    // В журнал попадают unsolved-попытки кроме 'easy' — easy ≡ user
    // завершил пазл сам, это не ошибка. 'aborted' тоже не считаем
    // ошибкой (пользователь сам прервал — не упрекать).
    if (solved) return false;
    if (stopReason === 'aborted') return false;
    try {
      await this.prisma.tacticUserMistake.upsert({
        where: { userId_puzzleId: { userId, puzzleId } },
        update: { resolved: false, createdAt: new Date() },
        create: { userId, puzzleId, resolved: false },
      });
      return true;
    } catch {
      return false;
    }
  }

  private toResponse(puzzle: TacticPuzzle): TacticPuzzleResponse {
    return {
      id: puzzle.id,
      fen: puzzle.fen,
      bestMoveUci: puzzle.bestMoveUci,
      solverSide: puzzle.solverSide === 'b' ? 'b' : 'w',
      objective:
        puzzle.objective === 'saveEquality'
          ? 'saveEquality'
          : 'convertAdvantage',
      themes: puzzle.themes
        ? puzzle.themes.split(/\s+/).filter(Boolean)
        : [],
      rating: puzzle.rating,
      ratingDev: puzzle.ratingDev,
      difficulty: puzzle.difficulty,
      gap: puzzle.gap,
      bestE: puzzle.bestE,
      secondE: puzzle.secondE,
      wdl: { w: puzzle.wdlW, d: puzzle.wdlD, l: puzzle.wdlL },
      createdAt: puzzle.createdAt.toISOString(),
      sourceHeaders: puzzle.sourceHeaders as Record<string, string> | null,
      sourceMoveNum: puzzle.sourceMoveNum,
      sourceGameId: puzzle.sourceGameId,
    };
  }

  private toMistakeItem(
    mistake: TacticUserMistake & { puzzle: TacticPuzzle },
  ): TacticUserMistakeItem {
    const p = mistake.puzzle;
    return {
      id: mistake.id,
      puzzleId: p.id,
      fen: p.fen,
      bestMoveUci: p.bestMoveUci,
      rating: p.rating,
      difficulty: p.difficulty,
      gap: p.gap,
      objective:
        p.objective === 'saveEquality' ? 'saveEquality' : 'convertAdvantage',
      themes: p.themes ? p.themes.split(/\s+/).filter(Boolean) : [],
      createdAt: mistake.createdAt.toISOString(),
    };
  }
}

// ─── stop_reason → solved ────────────────────────────────────────────

export function isSolvedStopReason(reason: TacticPuzzleStopReason): boolean {
  // 'easy' — пользователь сам завершил пазл когда сложность упала ниже
  // порога. Это засчитывается как успех (он не ошибся ни в одном ходе).
  // 'mate' — терминальное состояние, прервало пазл; считается успехом
  // только если последний ход был bestMove — но эту проверку клиент
  // делает сам и шлёт 'mistake' в противном случае.
  return reason === 'easy' || reason === 'mate';
}

// ─── cursor codec ────────────────────────────────────────────────────

// Cursor — просто base64 от UUID. Этого достаточно, чтобы пользователь
// не зависал от формата id и API мог сменить sort key без поломок
// клиентов.
function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    // Базовая проверка UUID-формы (8-4-4-4-12).
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        raw,
      )
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}
// avoid unused-import noise: TacticPuzzleAttempt используется в submit-tx.
export type { TacticPuzzleAttempt };
