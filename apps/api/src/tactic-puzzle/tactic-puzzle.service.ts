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
  type TacticAttemptDetail,
  type TacticAttemptListItem,
  type TacticAttemptListPage,
  type TacticPuzzleBrowsePage,
  type TacticPuzzleBrowseQuery,
  type TacticPuzzleResponse,
  type TacticPuzzleStopReason,
  type TacticRatingPoint,
  type TacticStopReason,
  type TacticUserMistakeItem,
  type TacticUserMistakesPage,
  type TacticUserStats,
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
    userId: string | null = null,
  ): Promise<TacticPuzzleBrowsePage> {
    const limit = Math.min(
      Math.max(1, query.limit ?? DEFAULT_BROWSE_LIMIT),
      MAX_BROWSE_LIMIT,
    );
    const cursorId = decodeCursor(query.cursor);

    const where: Prisma.TacticPuzzleWhereInput = {};
    // KS-4369 / KS-4367. Фильтр `where.objective` удалён вместе с полем.
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
    // KS-4365. Фильтр «решено / не решено» для текущего пользователя.
    // Для гостя (userId=null) параметр игнорируется — выборка как раньше.
    // true  → id IN (puzzleId из attempts с solved=true этого юзера);
    // false → id NOT IN (та же выборка).
    if (typeof query.solved === 'boolean' && userId) {
      where.attempts = query.solved
        ? { some: { userId, solved: true } }
        : { none: { userId, solved: true } };
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

    // KS-4356 / ADR-136. Mistake-резолв и mistake-add теперь в той же
    // транзакции, что и attempt + рейтинги — атомарно и без расхождения
    // состояний при падении одного из шагов.
    const { attempt, addedToMistakes, autoResolvedMistake } =
      await this.prisma.$transaction(async (tx) => {
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

        // KS-4356 / ADR-136 п.6: авто-резолв при solved-попытке. Если
        // запись в журнале была — помечаем resolved=true и больше не
        // показываем её в /mistakes. updateMany не падает на 0 rows.
        let auto = 0;
        let added = false;
        if (solved) {
          const r = await tx.tacticUserMistake.updateMany({
            where: { userId, puzzleId, resolved: false },
            data: { resolved: true },
          });
          auto = r.count;
        } else if (input.stopReason !== 'aborted') {
          // В журнал попадают unsolved-попытки кроме 'aborted' (юзер
          // сам прервал — не упрекаем). Upsert даёт идемпотентность.
          await tx.tacticUserMistake.upsert({
            where: { userId_puzzleId: { userId, puzzleId } },
            update: { resolved: false, createdAt: new Date() },
            create: { userId, puzzleId, resolved: false },
          });
          added = true;
        }

        return {
          attempt: created,
          addedToMistakes: added,
          autoResolvedMistake: auto > 0,
        };
      });

    // KS-4356. autoResolvedMistake залогируем для observability, но в
    // ответе не возвращаем — фронт увидит обновлённый список через
    // следующий GET /mistakes. Поле не входит в `SubmitTacticAttemptResponse`.
    void autoResolvedMistake;

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

  // ─── KS-4356 / ADR-136: история, статистика, авто-резолв ──────────

  /** GET /tactic-puzzles/attempts — список истории попыток. */
  async listAttempts(
    userId: string,
    query: {
      from?: string;
      to?: string;
      stopReason?: TacticStopReason;
      solved?: boolean;
      ratingMin?: number;
      ratingMax?: number;
      cursor?: string;
      limit?: number;
    },
  ): Promise<TacticAttemptListPage> {
    const limit = Math.min(
      Math.max(1, query.limit ?? DEFAULT_BROWSE_LIMIT),
      MAX_BROWSE_LIMIT,
    );

    const where: Prisma.TacticPuzzleAttemptWhereInput = { userId };
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.stopReason) where.stopReason = query.stopReason;
    if (typeof query.solved === 'boolean') where.solved = query.solved;
    if (query.ratingMin != null || query.ratingMax != null) {
      where.ratingBefore = {
        ...(query.ratingMin != null ? { gte: query.ratingMin } : {}),
        ...(query.ratingMax != null ? { lte: query.ratingMax } : {}),
      };
    }

    const cursorTs = decodeAttemptCursor(query.cursor);
    if (cursorTs) {
      // createdAt DESC — cursor содержит ms-timestamp границы; берём
      // строго раньше неё. Tiebreak по id (на одном createdAt бывает).
      where.OR = [
        { createdAt: { lt: cursorTs.createdAt } },
        {
          createdAt: cursorTs.createdAt,
          id: { lt: cursorTs.id },
        },
      ];
    }

    const rows = await this.prisma.tacticPuzzleAttempt.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { puzzle: true },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeAttemptCursor(last.createdAt, last.id)
        : null;
    return {
      items: page.map((r) => this.toAttemptListItem(r)),
      nextCursor,
    };
  }

  /** GET /tactic-puzzles/attempts/:id — детали одной попытки. */
  async getAttemptDetail(
    userId: string,
    id: string,
  ): Promise<TacticAttemptDetail> {
    const row = await this.prisma.tacticPuzzleAttempt.findUnique({
      where: { id },
      include: { puzzle: true },
    });
    // 404 как при отсутствии записи, так и при чужой попытке — не
    // палим существование чужого attempt'а.
    if (!row || row.userId !== userId) {
      throw new NotFoundException(`Tactic attempt ${id} not found`);
    }
    const list = this.toAttemptListItem(row);
    const p = row.puzzle;
    return {
      ...list,
      userMoves: row.userMoves ?? '',
      wdlStart: row.wdlStart,
      wdlEnd: row.wdlEnd,
      movesAccuracy: row.movesAccuracy,
      puzzle: {
        id: p.id,
        fen: p.fen,
        bestMoveUci: p.bestMoveUci,
        // KS-4369 / KS-4367. objective из карточки удалён.
        difficulty: p.difficulty,
        gap: p.gap,
        rating: p.rating,
        themes: splitThemes(p.themes),
      },
      sourceGameId: p.sourceGameId,
      sourceMoveNum: p.sourceMoveNum,
      sourceHeaders: p.sourceHeaders as Record<string, string> | null,
    };
  }

  /** GET /tactic-puzzles/stats/me — агрегаты по пользователю. */
  async getUserStats(userId: string): Promise<TacticUserStats> {
    const [rating, attempts] = await Promise.all([
      this.prisma.userTacticRating.findUnique({ where: { userId } }),
      this.prisma.tacticPuzzleAttempt.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        // KS-4369 / KS-4367. Колонка `objective` уйдёт из БД на T1 миграции;
        // selects её больше не запрашивает. Для difficultyBuckets нужен только difficulty.
        include: { puzzle: { select: { difficulty: true } } },
      }),
    ]);

    const totals = {
      attempts: attempts.length,
      solved: 0,
      solvedPercent: 0,
      avgTimeMs: 0,
      avgLineHalfMoves: 0,
      avgPrecisionGrade: null as number | null,
    };
    const stopReasonBreakdown: Record<TacticStopReason, number> = {
      easy: 0,
      mate: 0,
      mistake: 0,
      timeout: 0,
      aborted: 0,
    };
    // KS-4369 / KS-4367. objectiveBreakdown удалён вместе с полем.
    const difficultyBuckets: Record<string, number> = {
      '0.90-0.92': 0,
      '0.92-0.94': 0,
      '0.94-0.96': 0,
      '0.96-0.98': 0,
      '0.98-1.00': 0,
    };

    let sumTime = 0;
    let sumLine = 0;
    let sumGrade = 0;
    let gradeCount = 0;
    let currentRun = 0;
    let bestRun = 0;
    let currentTailRun = 0;

    for (const a of attempts) {
      sumTime += a.timeMs;
      sumLine += a.lineHalfMoves;
      if (a.precisionGrade != null) {
        sumGrade += a.precisionGrade;
        gradeCount++;
      }
      if (a.solved) {
        totals.solved++;
        currentRun++;
        if (currentRun > bestRun) bestRun = currentRun;
        currentTailRun++;
      } else {
        currentRun = 0;
        currentTailRun = 0;
      }
      const reason = a.stopReason as TacticStopReason;
      if (reason in stopReasonBreakdown) stopReasonBreakdown[reason]++;
      bucketize(difficultyBuckets, a.puzzle.difficulty);
    }

    if (totals.attempts > 0) {
      totals.solvedPercent = Math.round(
        (totals.solved / totals.attempts) * 100,
      );
      totals.avgTimeMs = Math.round(sumTime / totals.attempts);
      totals.avgLineHalfMoves =
        Math.round((sumLine / totals.attempts) * 10) / 10;
    }
    if (gradeCount > 0) {
      totals.avgPrecisionGrade = Math.round((sumGrade / gradeCount) * 10) / 10;
    }

    return {
      rating: {
        value: rating ? Math.round(rating.rating) : DEFAULT_USER_RATING,
        deviation: rating ? Math.round(rating.deviation) : DEFAULT_USER_RD,
        attempts: rating?.attempts ?? 0,
        lastAttemptAt: rating?.lastAttemptAt
          ? rating.lastAttemptAt.toISOString()
          : null,
      },
      totals,
      streak: { current: currentTailRun, best: bestRun },
      stopReasonBreakdown,
      difficultyBuckets,
    };
  }

  /** GET /tactic-puzzles/stats/rating-history — точки графика. */
  async getRatingHistory(
    userId: string,
    query: { from?: string; to?: string },
  ): Promise<TacticRatingPoint[]> {
    const where: Prisma.TacticRatingSnapshotWhereInput = { userId };
    if (query.from || query.to) {
      where.date = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    const rows = await this.prisma.tacticRatingSnapshot.findMany({
      where,
      orderBy: { date: 'asc' },
    });
    return rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      rating: Math.round(r.rating),
      attempts: r.attempts,
      solved: r.solved,
    }));
  }

  /** POST /tactic-puzzles/mistakes/:puzzleId/resolve — ручной резолв. */
  async resolveMistake(userId: string, puzzleId: string): Promise<void> {
    const r = await this.prisma.tacticUserMistake.updateMany({
      where: { userId, puzzleId, resolved: false },
      data: { resolved: true },
    });
    if (r.count === 0) {
      // Либо записи нет, либо уже resolved — для UI достаточно общего 404.
      throw new NotFoundException(
        `Unresolved tactic mistake for puzzle ${puzzleId} not found`,
      );
    }
  }

  // ─── маппинги ─────────────────────────────────────────────────────

  private toAttemptListItem(
    row: TacticPuzzleAttempt & { puzzle: TacticPuzzle },
  ): TacticAttemptListItem {
    const p = row.puzzle;
    return {
      id: row.id,
      puzzleId: p.id,
      fen: p.fen,
      bestMoveUci: p.bestMoveUci,
      solverSide: p.solverSide === 'b' ? 'b' : 'w',
      // KS-4369 / KS-4367. objective из карточки удалён.
      playersTitle: buildPlayersTitle(
        p.sourceHeaders as Record<string, string> | null,
      ),
      solved: row.solved,
      stopReason: row.stopReason as TacticStopReason,
      lineHalfMoves: row.lineHalfMoves,
      timeMs: row.timeMs,
      ratingBefore: row.ratingBefore,
      ratingAfter: row.ratingAfter,
      ratingDelta: row.ratingAfter - row.ratingBefore,
      precisionGrade: row.precisionGrade,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toResponse(puzzle: TacticPuzzle): TacticPuzzleResponse {
    return {
      id: puzzle.id,
      fen: puzzle.fen,
      bestMoveUci: puzzle.bestMoveUci,
      solverSide: puzzle.solverSide === 'b' ? 'b' : 'w',
      // KS-4369 / KS-4367. objective из ответа удалён.
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
      // KS-4369 / KS-4367. objective из карточки журнала ошибок удалён.
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

// ─── KS-4356 helpers ─────────────────────────────────────────────────

// KS-4369 / KS-4367. `toObjective` удалён вместе с типом TacticPuzzleObjective.

function splitThemes(raw: string): string[] {
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function buildPlayersTitle(
  headers: Record<string, string> | null,
): string | null {
  if (!headers) return null;
  const white = headers.White?.trim();
  const black = headers.Black?.trim();
  if (!white || !black) return null;
  return `${white} vs ${black}`;
}

function bucketize(buckets: Record<string, number>, difficulty: number): void {
  // 5 равных бакетов по 0.02 в диапазоне [0.90, 1.00]. Значения вне
  // диапазона относим к ближайшему краю — на практике такие пазлы
  // в банке не существуют (DIFFICULTY_MIN=0.9 в shared).
  const buckets05 = [
    [0.9, 0.92, '0.90-0.92'],
    [0.92, 0.94, '0.92-0.94'],
    [0.94, 0.96, '0.94-0.96'],
    [0.96, 0.98, '0.96-0.98'],
    [0.98, 1.01, '0.98-1.00'],
  ] as const;
  for (const [lo, hi, key] of buckets05) {
    if (difficulty >= lo && difficulty < hi) {
      buckets[key]++;
      return;
    }
  }
  // fallback — попало <0.9: кладём в первый бакет, чтобы суммы не
  // расходились с totals.attempts.
  buckets['0.90-0.92']++;
}

interface AttemptCursor {
  createdAt: Date;
  id: string;
}

function encodeAttemptCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.getTime()}|${id}`, 'utf8').toString(
    'base64url',
  );
}

function decodeAttemptCursor(cursor: string | undefined): AttemptCursor | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [tsRaw, idRaw] = raw.split('|');
    const ts = Number.parseInt(tsRaw ?? '', 10);
    if (!Number.isFinite(ts)) return null;
    if (
      !idRaw ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        idRaw,
      )
    ) {
      return null;
    }
    return { createdAt: new Date(ts), id: idRaw };
  } catch {
    return null;
  }
}

// ─── cursor codec (browse / mistakes — UUID-only) ────────────────────

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
