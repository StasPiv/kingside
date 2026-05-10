import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { Chess } from 'chess.js';
import type {
  PlayVsEnginePuzzleReason,
  PrecisionMoveSnapshot,
  PuzzleSolutionMode,
  PuzzleSourceGame,
  PuzzleStatsByMode,
  PuzzleStatsByModeEntry,
} from '@kingside/shared';
// KS-2665: серверные дефолты порогов PVE (ADR-050 §3 #5) — фронт-
// генератор их не передаёт в sourceMetadata, поэтому подхватываем тут
// при сборке `playVsEngine` блока из row.
import { PUZZLE_GEN_DEFAULTS, classifyMove } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PuzzleRatingService } from './puzzle-rating.service';
// KS-1927: MistakesService переехал из `lessons/` в `puzzle/` (ADR-032 §4).
import { MistakesService } from './mistakes.service';

/**
 * KS-2465 / ADR-044 §5.5. Параметры режима `play-vs-engine` в DTO.
 */
export interface PlayVsEngineDto {
  blunderMove: string;
  wdlAfterBlunder: number;
  winThreshold: number;
  failThreshold: number;
  halfMovesN: number;
  /** KS-2524: полные WDL-объекты per-mille. Опциональные (legacy). */
  wdlBefore?: { w: number; d: number; l: number };
  wdlAfter?: { w: number; d: number; l: number };
}

/**
 * KS-2524: проверка `{w,d,l}` объекта из metadata. Все три поля —
 * числа [0..1000]. Возвращает строго типизированный объект или null.
 */
function parseWdlObject(value: unknown): { w: number; d: number; l: number } | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const { w, d, l } = obj;
  if (typeof w !== 'number' || typeof d !== 'number' || typeof l !== 'number') {
    return null;
  }
  if (
    !Number.isFinite(w) || !Number.isFinite(d) || !Number.isFinite(l) ||
    w < 0 || d < 0 || l < 0
  ) {
    return null;
  }
  return { w, d, l };
}

/**
 * KS-2493: пустая запись `byMode` (для режимов без попыток).
 */
function emptyByModeEntry(): PuzzleStatsByModeEntry {
  return {
    attempts: 0,
    solved: 0,
    accuracy: 0,
    avgRating: null,
    avgTimeMs: 0,
  };
}

@Injectable()
export class PuzzleService {
  private readonly logger = new Logger(PuzzleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly puzzleRating: PuzzleRatingService,
    private readonly redis: RedisService,
    private readonly mistakes: MistakesService,
  ) {}

  /**
   * Get a puzzle matching the user's current rating (±200 range).
   * Excludes puzzles the user has already solved.
   *
   * KS-2562: убран ORDER BY popularity DESC. Раньше он заставлял
   * planner сортировать ~470k строк (rating ±200 range) → 10+ сек
   * на t3.micro. Теперь:
   *   - WHERE rating BETWEEN AND popularity >= 50 — partial-индекс
   *     `puzzles_rating_popularity_partial_idx` отбирает first-N через
   *     Index Scan, planner стопает рано на LIMIT 10 (т.к. сортировка
   *     не нужна).
   *   - JS random pick одного из 10 — рандомизация при повторных вызовах.
   *
   * Trade-off: вместо top-10 по популярности берём 10 «случайных
   * популярных» (popularity >= 50). На UX отличается слабо — пазлы
   * по-прежнему качественные (фильтр popularity >= 50 = топ ~10%
   * lichess), но не строго top-N.
   */
  async getNextPuzzle(
    userId: string | null,
    excludeId?: string,
    filters?: {
      themes?: string[];
      ratingMin?: number;
      ratingMax?: number;
      // KS-2472 / ADR-044 §5.5. Whitelist валидируется на DTO-уровне.
      solutionMode?: 'forced-line' | 'play-vs-engine';
    },
  ) {
    const DEFAULT_RATING = 1500;
    const range = 200;
    let userRating = DEFAULT_RATING;

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { ratingPuzzle: true },
      });
      if (user) userRating = user.ratingPuzzle;
    }

    const minRating = filters?.ratingMin ?? userRating - range;
    const maxRating = filters?.ratingMax ?? userRating + range;

    // KS-2735: anti-repeat ladder для PVE/forced-line. Каскад из 4
    // попыток сужения exclude-окна:
    //   1) recent-7d   — исключаем все попытки последней недели
    //                    (главный сигнал «не повторять прямо сейчас»);
    //   2) recent-1d   — исключаем только последний день
    //                    (если за неделю юзер прошёл всё);
    //   3) solved-only — исключаем только успешно решённые
    //                    (старое поведение до KS-2735);
    //   4) no-user-exclude — отдаём что есть.
    //
    // Между уровнями (1)→(2)→(3) держим rating+popularity; на финальном
    // (4) дополнительно ослабляем range/popularity. Все 4 пути дают
    // согласованный SQL с переиндексацией параметров (KS-2733-фикс).

    type ExcludeStrategy = 'recent-7d' | 'recent-1d' | 'solved-only' | 'none';
    type RangeMode = 'strict' | 'relaxed';

    const tryQuery = async (
      excludeStrategy: ExcludeStrategy,
      rangeMode: RangeMode,
    ): Promise<
      Array<{
        id: string;
        fen: string;
        moves: string;
        rating: number;
        themes: string;
        game_url: string | null;
        opening_tags: string | null;
        source: string;
        solution_mode: string | null;
        source_metadata: string | null;
      }>
    > => {
      const conds: string[] = [];
      const ps: (string | number)[] = [];
      let i = 1;
      if (rangeMode === 'strict') {
        conds.push(`p.rating >= $${i}`);
        ps.push(minRating);
        i++;
        conds.push(`p.rating <= $${i}`);
        ps.push(maxRating);
        i++;
        // popularity >= 50 — partial-индекс KS-2562.
        conds.push('p.popularity >= 50');
      }
      if (excludeId) {
        conds.push(`p.id != $${i}`);
        ps.push(excludeId);
        i++;
      }
      if (userId && excludeStrategy !== 'none') {
        let exclusion: string;
        if (excludeStrategy === 'recent-7d') {
          exclusion = `NOT EXISTS (
            SELECT 1 FROM puzzle_attempts pa
            WHERE pa.puzzle_id = p.id
              AND pa.user_id = $${i}::uuid
              AND pa.created_at > NOW() - INTERVAL '7 days'
          )`;
        } else if (excludeStrategy === 'recent-1d') {
          exclusion = `NOT EXISTS (
            SELECT 1 FROM puzzle_attempts pa
            WHERE pa.puzzle_id = p.id
              AND pa.user_id = $${i}::uuid
              AND pa.created_at > NOW() - INTERVAL '1 day'
          )`;
        } else {
          // solved-only — старое поведение до KS-2735.
          exclusion = `NOT EXISTS (
            SELECT 1 FROM puzzle_attempts pa
            WHERE pa.puzzle_id = p.id
              AND pa.user_id = $${i}::uuid
              AND pa.solved = true
          )`;
        }
        conds.push(exclusion);
        ps.push(userId);
        i++;
      }
      if (filters?.themes && filters.themes.length > 0) {
        for (const theme of filters.themes) {
          conds.push(`p.themes LIKE $${i}`);
          ps.push(`%${theme}%`);
          i++;
        }
      }
      if (filters?.solutionMode) {
        conds.push(`p.solution_mode = $${i}`);
        ps.push(filters.solutionMode);
        i++;
      }
      const whereClause = conds.length > 0 ? conds.join(' AND ') : 'true';
      const orderBy =
        rangeMode === 'strict' ? '' : 'ORDER BY p.rating ASC';
      const limit = rangeMode === 'strict' ? 10 : 1;
      return this.prisma.$queryRawUnsafe(
        `SELECT * FROM puzzles p WHERE ${whereClause} ${orderBy} LIMIT ${limit}`,
        ...ps,
      );
    };

    // Primary: strict range + 7-дневное окно.
    let puzzles = await tryQuery('recent-7d', 'strict');
    if (puzzles.length === 0) {
      // 1-day fallback в strict-range — пользователь решил всю выборку
      // за неделю, но за сутки могли остаться непосещённые.
      puzzles = await tryQuery('recent-1d', 'strict');
    }
    if (puzzles.length === 0) {
      // Старое поведение: только solved исключаем (KS-2735 fallback 3).
      puzzles = await tryQuery('solved-only', 'strict');
    }
    if (puzzles.length === 0) {
      // Relaxed range + solved-only — последний шанс.
      puzzles = await tryQuery('solved-only', 'relaxed');
    }
    if (puzzles.length === 0) {
      // Совсем без user-exclude — пускай повторится, но дадим
      // что-нибудь. Это сигнал «PVE-контента мало».
      puzzles = await tryQuery('none', 'relaxed');
    }

    if (puzzles.length === 0) {
      throw new NotFoundException(
        this.i18n.t('messages.puzzle.noPuzzlesAvailable'),
      );
    }

    const picked = puzzles[Math.floor(Math.random() * puzzles.length)];
    return this.formatRawPuzzle(picked);
  }

  /**
   * Search puzzles by theme and/or difficulty range.
   * Themes are stored as a space-separated string, so we use `contains` for filtering.
   *
   * Ревизия KS-1761 (L-06): добавлены `source` и `excludeIds` — чтобы
   * `LessonsModule.PuzzleStep` с `selection.mode='filter'` мог ограничиваться
   * курируемым источником (обычно `'lichess'` — см. lessons-roadmap.md §5
   * «Стабильность puzzleId») и не повторять уже выбранные задачи в рамках
   * одного урока.
   *
   * Ревизия KS-1776: добавлен `orderBy: 'random' | 'rating' | 'popularity'`
   * (default `'rating'`, обратная совместимость сохранена). `'random'` —
   * через `ORDER BY random()` в raw SQL: без этого все ученики получают
   * одинаковый срез «первых N по рейтингу», что плохо для курируемых
   * наборов в уроках.
   */
  async findPuzzles(params: {
    themes?: string[];
    ratingMin?: number;
    ratingMax?: number;
    limit?: number;
    source?: string;
    excludeIds?: string[];
    orderBy?: 'random' | 'rating' | 'popularity';
    // KS-2472 / ADR-044 §5.5. Whitelist валидируется на DTO-уровне.
    solutionMode?: 'forced-line' | 'play-vs-engine';
  }) {
    const { themes, ratingMin, ratingMax, limit, source, excludeIds, orderBy, solutionMode } = params;
    const take = limit ?? 10;
    const order = orderBy ?? 'rating';

    if (order === 'random') {
      return this.findPuzzlesRandom({
        themes,
        ratingMin,
        ratingMax,
        source,
        excludeIds,
        take,
        solutionMode,
      });
    }

    const where: Record<string, any> = {};

    if (ratingMin !== undefined || ratingMax !== undefined) {
      where.rating = {};
      if (ratingMin !== undefined) where.rating.gte = ratingMin;
      if (ratingMax !== undefined) where.rating.lte = ratingMax;
    }

    if (themes && themes.length > 0) {
      where.AND = themes.map((theme) => ({
        themes: { contains: theme },
      }));
    }

    if (source !== undefined) {
      where.source = source;
    }

    if (excludeIds && excludeIds.length > 0) {
      where.id = { notIn: excludeIds };
    }

    // KS-2472 / ADR-044 §5.5.
    if (solutionMode !== undefined) {
      where.solutionMode = solutionMode;
    }

    const prismaOrder =
      order === 'popularity'
        ? { popularity: 'desc' as const }
        : { rating: 'asc' as const };

    const puzzles = await this.prisma.puzzle.findMany({
      where,
      take,
      orderBy: prismaOrder,
    });

    return puzzles.map((p) => this.formatPuzzle(p));
  }

  /**
   * `findPuzzles` с `orderBy='random'` — через raw SQL `ORDER BY random()`.
   * Prisma не поддерживает random-ordering нативно, поэтому строим WHERE
   * динамически (по аналогии с `getNextPuzzle`).
   */
  private async findPuzzlesRandom(params: {
    themes?: string[];
    ratingMin?: number;
    ratingMax?: number;
    source?: string;
    excludeIds?: string[];
    take: number;
    // KS-2472 / ADR-044 §5.5.
    solutionMode?: 'forced-line' | 'play-vs-engine';
  }) {
    const { themes, ratingMin, ratingMax, source, excludeIds, take, solutionMode } = params;
    const conditions: string[] = [];
    const paramsList: (string | number)[] = [];
    let idx = 1;

    if (ratingMin !== undefined) {
      conditions.push(`p.rating >= $${idx++}`);
      paramsList.push(ratingMin);
    }
    if (ratingMax !== undefined) {
      conditions.push(`p.rating <= $${idx++}`);
      paramsList.push(ratingMax);
    }
    if (source !== undefined) {
      conditions.push(`p.source = $${idx++}`);
      paramsList.push(source);
    }
    if (themes && themes.length > 0) {
      for (const theme of themes) {
        conditions.push(`p.themes LIKE $${idx++}`);
        paramsList.push(`%${theme}%`);
      }
    }
    if (excludeIds && excludeIds.length > 0) {
      const placeholders = excludeIds.map(() => `$${idx++}`).join(', ');
      conditions.push(`p.id NOT IN (${placeholders})`);
      paramsList.push(...excludeIds);
    }
    // KS-2472 / ADR-044 §5.5. Whitelist DTO защищает от sql injection.
    if (solutionMode !== undefined) {
      conditions.push(`p.solution_mode = $${idx++}`);
      paramsList.push(solutionMode);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM puzzles p ${whereClause} ORDER BY random() LIMIT ${Number(take)}`;

    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: string; fen: string; moves: string; rating: number; themes: string;
      source: string; game_url: string | null; opening_tags: string | null;
      solution_mode: string | null; source_metadata: string | null;
    }>>(sql, ...paramsList);

    return rows.map((p) => this.formatRawPuzzle(p));
  }

  /**
   * Get all available puzzle themes with counts.
   */
  async getThemes(): Promise<{ theme: string; count: number }[]> {
    const puzzles = await this.prisma.puzzle.findMany({
      select: { themes: true },
    });

    const counts = new Map<string, number>();
    for (const p of puzzles) {
      for (const t of p.themes.split(' ').filter(Boolean)) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .map(([theme, count]) => ({ theme, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get next puzzle for user filtered by a specific theme.
   * Matches user rating ±200 and excludes already attempted puzzles.
   */
  async getNextPuzzleByTheme(userId: string | null, theme: string, excludeId?: string) {
    const DEFAULT_RATING = 1500;
    const range = 200;
    let userRating = DEFAULT_RATING;
    const excludeIds: string[] = [];

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { ratingPuzzle: true },
      });
      if (user) userRating = user.ratingPuzzle;

      const attemptedIds = await this.prisma.puzzleAttempt.findMany({
        where: { userId },
        select: { puzzleId: true },
        distinct: ['puzzleId'],
      });
      excludeIds.push(...attemptedIds.map((a) => a.puzzleId));
    }

    const minRating = userRating - range;
    const maxRating = userRating + range;
    if (excludeId && !excludeIds.includes(excludeId)) {
      excludeIds.push(excludeId);
    }

    const puzzles = await this.prisma.puzzle.findMany({
      where: {
        rating: { gte: minRating, lte: maxRating },
        themes: { contains: theme },
        id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
      },
      take: 10,
      orderBy: { rating: 'asc' },
    });

    if (puzzles.length === 0) {
      throw new NotFoundException(this.i18n.t('messages.puzzle.noPuzzlesAvailable'));
    }

    const picked = puzzles[Math.floor(Math.random() * puzzles.length)];
    return this.formatPuzzle(picked);
  }

  /**
   * Submit an attempt for a puzzle and return the rating changes.
   *
   * KS-2465 / ADR-044 §5.4. Для `solutionMode='play-vs-engine'` принимаем
   * опц. поля `halfMovesPlayed`, `finalWdl`, `reason` — на MVP только
   * логируем, в БД не пишем (PuzzleAttempt.metadata JSONB — v2). Glicko-2
   * update идёт через стандартный `solved` boolean.
   */
  async submitAttempt(
    userId: string,
    puzzleId: string,
    solved: boolean,
    timeMs: number,
    userMoves?: string,
    hintsUsed?: number,
    playVsEngine?: {
      halfMovesPlayed?: number;
      finalWdl?: number;
      initialWdl?: number;
      reason?: PlayVsEnginePuzzleReason;
      moves?: PrecisionMoveSnapshot[];
    },
  ) {
    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: puzzleId },
    });
    if (!puzzle) {
      throw new NotFoundException(this.i18n.t('messages.puzzle.notFound'));
    }

    // KS-2465: резолвим solutionMode (валидация JSON metadata + fallback).
    const mode = this.resolveSolutionMode(
      puzzle.id,
      (puzzle as { solutionMode?: string | null }).solutionMode,
      (puzzle as { sourceMetadata?: string | null }).sourceMetadata,
    );

    // Server-side validation: verify user played the correct side.
    // Для play-vs-engine validatePlayerSide делает early-return (нет линии).
    if (solved && userMoves) {
      const isValid = this.validatePlayerSide(
        puzzle.fen,
        puzzle.moves,
        puzzle.source,
        userMoves,
        mode.solutionMode,
      );
      if (!isValid) {
        this.logger.warn(`Puzzle ${puzzleId}: user ${userId} played wrong side, overriding solved=false`);
        solved = false;
      }
    }

    // KS-2465: лог play-vs-engine метаданных попытки (в БД не пишем — v2).
    if (mode.solutionMode === 'play-vs-engine' && playVsEngine) {
      this.logger.log(
        `Puzzle ${puzzleId} play-vs-engine attempt by user ${userId}: ` +
          `solved=${solved} halfMovesPlayed=${playVsEngine.halfMovesPlayed ?? 'n/a'} ` +
          `finalWdl=${playVsEngine.finalWdl ?? 'n/a'} reason=${playVsEngine.reason ?? 'n/a'}`,
      );
    }

    // Check if already solved — retry without rating change
    const alreadySolved = await this.prisma.puzzleAttempt.findFirst({
      where: { userId, puzzleId, solved: true },
    });
    const isRetry = !!alreadySolved;

    let ratingChange;
    if (isRetry) {
      // No rating change on retry
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { ratingPuzzle: true },
      });
      ratingChange = {
        userRatingBefore: user.ratingPuzzle,
        userRatingAfter: user.ratingPuzzle,
        puzzleRatingBefore: puzzle.rating,
        puzzleRatingAfter: puzzle.rating,
      };
    } else {
      ratingChange = await this.puzzleRating.applyRatingChange(userId, puzzleId, solved);
    }

    // KS-2717 / ADR-056 §3.3. Server-trust: если PVE-attempt с
    // `moves[]` — внутри транзакции пишем PuzzleAttempt + PrecisionAttempt
    // + N PrecisionAttemptMove. Server валидирует legality каждого хода
    // через chess.js и пересчитывает classification из (cpBefore, cpAfter)
    // через `classifyMove` из @kingside/shared — клиентскому полю не верим.
    const isPveWithMoves =
      mode.solutionMode === 'play-vs-engine' &&
      Array.isArray(playVsEngine?.moves) &&
      playVsEngine!.moves!.length > 0;

    if (isPveWithMoves) {
      await this.persistPveAttemptWithMoves({
        userId,
        puzzleId,
        puzzleFen: puzzle.fen,
        solved,
        timeMs,
        userMoves: userMoves ?? null,
        hintsUsed: hintsUsed ?? 0,
        ratingChange,
        playVsEngine: playVsEngine!,
      });
    } else {
      await this.prisma.puzzleAttempt.create({
        data: {
          puzzleId,
          userId,
          solved,
          timeMs,
          ratingBefore: ratingChange.userRatingBefore,
          ratingAfter: ratingChange.userRatingAfter,
          userMoves: userMoves ?? null,
          hintsUsed: hintsUsed ?? 0,
        },
      });
    }

    // L-31 (KS-1802): фиксируем ошибку в дневнике. Идемпотентность по
    // `(userId, puzzleId)` обеспечивает сам `MistakesService` — повторная
    // неудача по той же задаче обновит `occurredAt`, не создаст дубликат.
    // Сбой записи не должен ломать submitAttempt — логируем и идём дальше.
    if (!solved) {
      this.mistakes.recordPuzzleMistake(userId, puzzleId).catch((e) => {
        this.logger.warn(
          `recordPuzzleMistake failed for user=${userId} puzzle=${puzzleId}: ${(e as Error).message ?? e}`,
        );
      });
    }

    this.logger.log(
      `Puzzle ${puzzleId} ${solved ? 'solved' : 'failed'} by user ${userId}: rating ${ratingChange.userRatingBefore} -> ${ratingChange.userRatingAfter}${isRetry ? ' (retry)' : ''}`,
    );

    let nextPuzzle = null;
    try {
      nextPuzzle = await this.getNextPuzzle(userId, puzzleId);
    } catch (e: unknown) { this.logger.warn(`Daily puzzle error: ${(e as Error).message ?? e}`);
    }

    return {
      solved,
      isRetry,
      puzzleRating: ratingChange.puzzleRatingAfter,
      userRatingBefore: ratingChange.userRatingBefore,
      userRatingAfter: ratingChange.userRatingAfter,
      correctMoves: puzzle.moves.split(' '),
      nextPuzzle,
    };
  }

  /**
   * KS-2717 / ADR-056 §3.3. Транзакционная запись PuzzleAttempt +
   * PrecisionAttempt + N PrecisionAttemptMove для PVE-попытки.
   *
   * Server-trust: каждый ход валидируется через chess.js (legality);
   * classification пересчитывается через `classifyMove` из shared —
   * клиентский результат игнорируется. Если хоть один ход нелегален,
   * выбрасываем `BadRequestException` (400) и НИЧЕГО не пишем
   * (транзакция откатывается).
   */
  private async persistPveAttemptWithMoves(args: {
    userId: string;
    puzzleId: string;
    puzzleFen: string;
    solved: boolean;
    timeMs: number;
    userMoves: string | null;
    hintsUsed: number;
    ratingChange: {
      userRatingBefore: number;
      userRatingAfter: number;
      puzzleRatingBefore: number;
      puzzleRatingAfter: number;
    };
    playVsEngine: {
      halfMovesPlayed?: number;
      finalWdl?: number;
      initialWdl?: number;
      reason?: PlayVsEnginePuzzleReason;
      moves?: PrecisionMoveSnapshot[];
    };
  }): Promise<void> {
    const moves = args.playVsEngine.moves ?? [];

    // 1. Sanity / order check: ply должны идти подряд начиная с 1.
    for (let i = 0; i < moves.length; i++) {
      if (moves[i].ply !== i + 1) {
        throw new BadRequestException(
          `precision moves: ply mismatch at index ${i} (expected ${i + 1}, got ${moves[i].ply})`,
        );
      }
    }

    // 2. Validate legality каждого хода через chess.js. Применяем
    //    последовательно от puzzle.fen — не доверяем клиентским
    //    fenBefore (он может быть подделан); но проверяем что
    //    клиентский fenBefore совпадает с нашим воспроизведением.
    //    Если позиция «солвера» — каждый второй ход, то между
    //    user-ходами идут engine-ходы, которые клиент НЕ присылает
    //    в `moves`, но они зафиксированы в playedUci/bestUci через
    //    последовательность fenBefore. Поэтому проверяем только
    //    legality конкретного playedUci в fenBefore (без полной
    //    реплейки от puzzle.fen — это PVE, engine-ходы могут быть
    //    разными между попытками).
    for (const m of moves) {
      const ok = this.isLegalMove(m.fenBefore, m.playedUci);
      if (!ok) {
        throw new BadRequestException(
          `precision moves: illegal move at ply ${m.ply}: ${m.playedUci} from ${m.fenBefore.slice(0, 30)}…`,
        );
      }
    }

    // 3. Классификация (server-trust). Аггрегаты.
    const classified = moves.map((m) => {
      const isBestMove = sameUci(m.playedUci, m.bestUci);
      const klass = classifyMove({
        cpBefore: m.cpBefore ?? null,
        cpAfter: m.cpAfter ?? null,
        isBestMove,
      });
      const wdlBeforeSigned = signedFromWdl(m.wdlBefore);
      // POV меняется после хода — для leak от лица решателя инвертируем.
      const wdlAfterSignedSolver =
        m.wdlAfter == null ? null : -signedFromWdl(m.wdlAfter)!;
      const leak =
        wdlBeforeSigned == null || wdlAfterSignedSolver == null
          ? 0
          : Math.max(0, wdlBeforeSigned - wdlAfterSignedSolver);
      return { m, klass, leak };
    });

    const counts = {
      best: 0,
      good: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 0,
    };
    let firstMistakePly: number | null = null;
    let wdlLeakSum = 0;
    for (const c of classified) {
      counts[c.klass]++;
      if (
        firstMistakePly == null &&
        (c.klass === 'mistake' || c.klass === 'blunder')
      ) {
        firstMistakePly = c.m.ply;
      }
      wdlLeakSum += c.leak;
    }
    const total = classified.length;
    const accuracyPercent =
      total > 0 ? ((counts.best + counts.good) / total) * 100 : 0;

    // 4. wdlAtStart / wdlAtEnd: предпочитаем явные initialWdl/finalWdl
    //    из payload, иначе деривим из первого/последнего snapshot'а.
    const firstSnap = moves[0];
    const lastSnap = moves[moves.length - 1];
    const wdlAtStartSigned =
      args.playVsEngine.initialWdl ??
      signedFromWdl(firstSnap?.wdlBefore) ??
      0;
    const wdlAtEndSigned =
      args.playVsEngine.finalWdl ??
      (lastSnap?.wdlAfter ? -signedFromWdl(lastSnap.wdlAfter)! : null) ??
      0;

    const halfMovesPlayed = args.playVsEngine.halfMovesPlayed ?? total;
    const halfMovesTarget = halfMovesPlayed; // фронт сейчас не присылает
    // целевую длину отдельно — берём = halfMovesPlayed; в KS-2718 при
    // расчётах avgPlysToFirstMistake используется только played.

    const endReason = args.playVsEngine.reason ?? 'aborted';

    // 5. Транзакция: PuzzleAttempt → PrecisionAttempt → moves.
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.puzzleAttempt.create({
        data: {
          puzzleId: args.puzzleId,
          userId: args.userId,
          solved: args.solved,
          timeMs: args.timeMs,
          ratingBefore: args.ratingChange.userRatingBefore,
          ratingAfter: args.ratingChange.userRatingAfter,
          userMoves: args.userMoves,
          hintsUsed: args.hintsUsed,
        },
        select: { id: true },
      });

      await tx.precisionAttempt.create({
        data: {
          attemptId: created.id,
          wdlAtStartSigned,
          wdlAtEndSigned,
          halfMovesPlayed,
          halfMovesTarget,
          accuracyPercent,
          bestMovesCount: counts.best,
          goodMovesCount: counts.good,
          inaccuraciesCount: counts.inaccuracy,
          mistakesCount: counts.mistake,
          blundersCount: counts.blunder,
          firstMistakePly,
          wdlLeakSum,
          endReason,
        },
      });

      if (classified.length > 0) {
        await tx.precisionAttemptMove.createMany({
          data: classified.map(({ m, klass }) => ({
            attemptId: created.id,
            ply: m.ply,
            fenBefore: m.fenBefore,
            playedUci: m.playedUci,
            bestUci: m.bestUci,
            cpBefore: m.cpBefore ?? null,
            cpAfter: m.cpAfter ?? null,
            wdlBeforeW: m.wdlBefore?.w ?? null,
            wdlBeforeD: m.wdlBefore?.d ?? null,
            wdlBeforeL: m.wdlBefore?.l ?? null,
            wdlAfterW: m.wdlAfter?.w ?? null,
            wdlAfterD: m.wdlAfter?.d ?? null,
            wdlAfterL: m.wdlAfter?.l ?? null,
            depth: m.depth ?? null,
            classification: klass,
          })),
        });
      }
    });

    this.logger.log(
      `Puzzle ${args.puzzleId} PVE attempt by user ${args.userId}: ` +
        `accuracy=${accuracyPercent.toFixed(1)}% halfMoves=${halfMovesPlayed} ` +
        `firstMistakePly=${firstMistakePly ?? 'none'} ` +
        `wdlLeakSum=${wdlLeakSum.toFixed(3)} endReason=${endReason}`,
    );
  }

  /**
   * KS-2717: проверка legality одного UCI-хода в данной FEN-позиции
   * через chess.js. Используется для server-trust валидации
   * `precision_attempt_moves`.
   */
  private isLegalMove(fen: string, uci: string): boolean {
    if (uci.length < 4) return false;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion =
      uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
    try {
      const chess = new Chess(fen);
      const move = chess.move({
        from,
        to,
        ...(promotion ? { promotion } : {}),
      });
      return !!move;
    } catch {
      return false;
    }
  }

  /**
   * Get puzzle statistics for a user.
   *
   * KS-2493 / ADR-046 §5.3. К ответу добавлен блок `byMode` с разбивкой
   * метрик (`attempts/solved/accuracy/avgRating/avgTimeMs`) по
   * `solutionMode` (`forced-line` / `play-vs-engine`). JOIN
   * `puzzle_attempts ↔ puzzles` по `solution_mode`. Оба ключа
   * присутствуют всегда — пустой режим заполняется нулями (`avgRating=null`).
   */
  async getStats(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { ratingPuzzle: true, ratingPuzzleDev: true, puzzleStreak: true },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // KS-2716 / ADR-055 B1. Top-level счётчики `totalAttempted` /
    // `totalSolved` / `avgTimeMs` фильтруем по `solution_mode='forced-line'`
    // — PVE-attempts (Тренировка точности, /precision) живут в `byMode
    // ['play-vs-engine']` и не должны протекать в classical-метрики.
    // `currentStreak` / `todaySnapshot` уже не загрязняются, потому что
    // `applyRatingChange` для PVE делает early-return (B2 ниже).
    const forcedLineFilter = {
      userId,
      puzzle: { is: { solutionMode: 'forced-line' as const } },
    };
    const [
      totalAttempted,
      totalSolved,
      bestRush,
      avgTime,
      todaySnapshot,
      byModeRows,
    ] = await Promise.all([
      this.prisma.puzzleAttempt.count({ where: forcedLineFilter }),
      this.prisma.puzzleAttempt.count({
        where: { ...forcedLineFilter, solved: true },
      }),
      this.prisma.puzzleRushScore.findFirst({
        where: { userId },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
      this.prisma.puzzleAttempt.aggregate({
        where: forcedLineFilter,
        _avg: { timeMs: true },
      }),
      this.prisma.puzzleRatingSnapshot.findUnique({
        where: { userId_date: { userId, date: today } },
      }),
      // KS-2493: GROUP BY solution_mode. COALESCE для старых пазлов
      // без значения (миграция KS-2463 проставила default 'forced-line',
      // но raw read на всякий случай). avg(p.rating) / avg(pa.time_ms)
      // возвращают NULL при 0 строк — это резолвится в JS-картирование.
      this.prisma.$queryRaw<
        Array<{
          solution_mode: string | null;
          attempts: bigint;
          solved: bigint;
          avg_rating: number | null;
          avg_time_ms: number | null;
        }>
      >`
        SELECT
          COALESCE(p.solution_mode, 'forced-line') AS solution_mode,
          COUNT(*)::bigint AS attempts,
          SUM(CASE WHEN pa.solved THEN 1 ELSE 0 END)::bigint AS solved,
          AVG(p.rating)::float AS avg_rating,
          AVG(pa.time_ms)::float AS avg_time_ms
        FROM puzzle_attempts pa
        JOIN puzzles p ON pa.puzzle_id = p.id
        WHERE pa.user_id = ${userId}::uuid
        GROUP BY COALESCE(p.solution_mode, 'forced-line')
      `,
    ]);

    const byMode: PuzzleStatsByMode = {
      'forced-line': emptyByModeEntry(),
      'play-vs-engine': emptyByModeEntry(),
    };
    for (const row of byModeRows) {
      const mode = row.solution_mode === 'play-vs-engine'
        ? 'play-vs-engine'
        : 'forced-line';
      const attempts = Number(row.attempts);
      const solved = Number(row.solved);
      byMode[mode] = {
        attempts,
        solved,
        accuracy: attempts > 0 ? Math.round((solved / attempts) * 100) : 0,
        avgRating: row.avg_rating != null ? Math.round(row.avg_rating) : null,
        avgTimeMs: row.avg_time_ms != null ? Math.round(row.avg_time_ms) : 0,
      };
    }

    return {
      rating: user.ratingPuzzle,
      ratingDev: user.ratingPuzzleDev,
      totalSolved,
      totalAttempted,
      solveRate: totalAttempted > 0 ? Math.round((totalSolved / totalAttempted) * 100) : 0,
      avgTimeMs: Math.round(avgTime._avg.timeMs ?? 0),
      currentStreak: user.puzzleStreak,
      todaySolved: todaySnapshot?.solved ?? 0,
      todayAttempted: todaySnapshot?.attempts ?? 0,
      bestPuzzleRushScore: bestRush?.score ?? null,
      byMode,
    };
  }

  async getRatingHistory(userId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const snapshots = await this.prisma.puzzleRatingSnapshot.findMany({
      where: { userId, date: { gte: since } },
      orderBy: { date: 'asc' },
      select: { date: true, rating: true, attempts: true, solved: true },
    });

    return snapshots.map((s: { date: Date; rating: number; attempts: number; solved: number }) => ({
      date: s.date.toISOString().slice(0, 10),
      rating: s.rating,
      attempts: s.attempts,
      solved: s.solved,
    }));
  }

  async getThemeStats(userId: string) {
    const cacheKey = `puzzle:theme-stats:${userId}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached);

    // Aggregate from puzzle_attempts joined with puzzles (lichess)
    const raw = await this.prisma.$queryRaw<Array<{ themes: string; total: bigint; solved: bigint }>>`
      SELECT p.themes, COUNT(*)::bigint as total, SUM(CASE WHEN pa.solved THEN 1 ELSE 0 END)::bigint as solved
      FROM puzzle_attempts pa
      JOIN puzzles p ON pa.puzzle_id = p.id
      WHERE pa.user_id = ${userId}::uuid AND p.themes != ''
      GROUP BY p.themes
    `;

    const themeMap = new Map<string, { attempted: number; solved: number }>();
    for (const row of raw) {
      for (const theme of row.themes.split(' ').filter(Boolean)) {
        const existing = themeMap.get(theme) ?? { attempted: 0, solved: 0 };
        existing.attempted += Number(row.total);
        existing.solved += Number(row.solved);
        themeMap.set(theme, existing);
      }
    }

    const result = Array.from(themeMap.entries())
      .map(([theme, stats]) => ({
        theme,
        attempted: stats.attempted,
        solved: stats.solved,
        rate: stats.attempted > 0 ? Math.round((stats.solved / stats.attempted) * 100) : 0,
      }))
      .sort((a, b) => b.attempted - a.attempted);

    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 300).catch(() => {});
    return result;
  }

  /**
   * Get a specific puzzle by ID.
   */
  async getPuzzle(puzzleId: string) {
    const puzzle = await this.prisma.puzzle.findUnique({
      where: { id: puzzleId },
    });
    if (!puzzle) {
      throw new NotFoundException(this.i18n.t('messages.puzzle.notFound'));
    }
    return this.formatPuzzle(puzzle);
  }

  /**
   * Get user's recent puzzle attempts.
   *
   * KS-2494 / ADR-046 §5.4. К каждому attempt'у возвращаем
   * `puzzle.solutionMode` — нужен фронту (KS-2498) для переключения
   * поведения клика по recent-attempt'у: для `play-vs-engine` пазл
   * открывается на `/puzzle/:id` (нет линии для `/analysis`), для
   * `forced-line` — старое поведение.
   */
  async getUserAttempts(userId: string, take = 20, skip = 0) {
    return this.prisma.puzzleAttempt.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        puzzle: {
          select: {
            id: true,
            fen: true,
            rating: true,
            themes: true,
            source: true,
            solutionMode: true,
          },
        },
      },
    });
  }

  /**
   * Validate that user's moves were made by the correct side.
   * Lichess puzzles: moves[0] is setup (opponent), player is opposite side.
   * Generated puzzles: no setup, player is the side to move in FEN.
   *
   * KS-2465 / ADR-044 §5.4. Для `solutionMode='play-vs-engine'` эталонной
   * линии нет, серверная валидация хода не применима — early-return true
   * (anti-cheat для MVP не делаем).
   */
  private validatePlayerSide(
    fen: string,
    moves: string,
    source: string,
    userMoves: string,
    solutionMode: PuzzleSolutionMode = 'forced-line',
  ): boolean {
    if (solutionMode === 'play-vs-engine') return true;
    try {
      const chess = new Chess(fen);
      const solutionMoves = moves.split(' ');
      const userMovesList = userMoves.split(' ').filter(Boolean);
      if (userMovesList.length === 0) return true; // no moves to validate

      const initialTurn = chess.turn();
      const isGenerated = source === 'generated';
      const playerColor = isGenerated ? initialTurn : (initialTurn === 'w' ? 'b' : 'w');

      // For Lichess: apply setup move to reach the player's position
      if (!isGenerated && solutionMoves.length > 1) {
        const setup = solutionMoves[0];
        chess.move({ from: setup.slice(0, 2), to: setup.slice(2, 4), promotion: setup[4] });
      }

      // After setup, it must be the player's turn
      if (chess.turn() !== playerColor) return false;

      // Check that the first user move is a piece of the player's color
      const firstUci = userMovesList[0];
      if (firstUci.length >= 4) {
        const piece = chess.get(firstUci.slice(0, 2) as any);
        if (piece && piece.color !== playerColor) return false;
      }

      return true;
    } catch {
      return true; // don't block on validation errors
    }
  }

  /**
   * KS-2465 / ADR-044 §5.5. Резолвим solutionMode + playVsEngine для DTO.
   *
   * Если в БД лежит `solutionMode='play-vs-engine'` — парсим
   * `sourceMetadata` как JSON и собираем блок.
   *
   * KS-2665: пороги `winThreshold` / `failThreshold` / `halfMovesN`
   * по ADR-050 §3 #5 — **серверные дефолты**, фронт-генератор
   * (KS-2584) их не передаёт. Раньше resolver требовал их в
   * sourceMetadata и при отсутствии валидного значения откидывал
   * весь блок → фронт на /precision не получал `blunderMove` и
   * показывал «Соперник зевнул ходом ?». Теперь обязательны только
   * `blunderMove` (без него UI нечего показать) и `wdlAfterBlunder`
   * (используется для отрисовки шкалы преимущества); недостающие
   * пороги берутся из `PUZZLE_GEN_DEFAULTS`.
   *
   * Сломанный JSON или отсутствие `blunderMove`/`wdlAfterBlunder` —
   * по-прежнему fallback на `forced-line` (никогда не отдаём
   * `play-vs-engine` без валидного блока, чтобы клиент не упал).
   */
  private resolveSolutionMode(
    puzzleId: string,
    solutionModeRaw: string | null | undefined,
    sourceMetadata: string | null | undefined,
  ): { solutionMode: PuzzleSolutionMode; playVsEngine?: PlayVsEngineDto } {
    if (solutionModeRaw !== 'play-vs-engine') {
      return { solutionMode: 'forced-line' };
    }
    if (!sourceMetadata) {
      this.logger.warn(
        `Puzzle ${puzzleId}: solutionMode='play-vs-engine' но sourceMetadata пустой — fallback на forced-line`,
      );
      return { solutionMode: 'forced-line' };
    }
    try {
      const meta = JSON.parse(sourceMetadata) as Record<string, unknown>;
      const blunderMove = meta.blunderMove;
      const wdlAfterBlunder = meta.wdlAfterBlunder;
      // KS-2665: только `blunderMove` + `wdlAfterBlunder` обязательны.
      if (
        typeof blunderMove !== 'string' ||
        blunderMove.length === 0 ||
        typeof wdlAfterBlunder !== 'number'
      ) {
        this.logger.warn(
          `Puzzle ${puzzleId}: sourceMetadata без blunderMove/wdlAfterBlunder — fallback на forced-line`,
        );
        return { solutionMode: 'forced-line' };
      }
      // KS-2665: пороги — из meta если переданы, иначе из shared
      // дефолтов. Стандартный путь по ADR-050: фронт не передаёт.
      const winThreshold =
        typeof meta.winThreshold === 'number'
          ? meta.winThreshold
          : PUZZLE_GEN_DEFAULTS.winThreshold;
      const failThreshold =
        typeof meta.failThreshold === 'number'
          ? meta.failThreshold
          : PUZZLE_GEN_DEFAULTS.failThreshold;
      const halfMovesN =
        typeof meta.halfMovesN === 'number'
          ? meta.halfMovesN
          : PUZZLE_GEN_DEFAULTS.halfMovesN;
      // KS-2524: опциональные `{w,d,l}` объекты per-mille от Stockfish.
      // Legacy-пазлы (до KS-2523) их не имеют — поля undefined,
      // фронт fallback'ом смотрит на `wdlAfterBlunder` (signed).
      const wdlBefore = parseWdlObject(meta.wdlBefore);
      const wdlAfter = parseWdlObject(meta.wdlAfter);
      return {
        solutionMode: 'play-vs-engine',
        playVsEngine: {
          blunderMove,
          wdlAfterBlunder,
          winThreshold,
          failThreshold,
          halfMovesN,
          ...(wdlBefore ? { wdlBefore } : {}),
          ...(wdlAfter ? { wdlAfter } : {}),
        },
      };
    } catch (e) {
      this.logger.warn(
        `Puzzle ${puzzleId}: sourceMetadata невалидный JSON — fallback на forced-line: ${(e as Error).message}`,
      );
      return { solutionMode: 'forced-line' };
    }
  }

  private formatPuzzle(puzzle: {
    id: string;
    fen: string;
    moves: string;
    rating: number;
    themes: string;
    source: string;
    solutionMode?: string | null;
    sourceMetadata?: string | null;
    gameUrl?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
  }) {
    const mode = this.resolveSolutionMode(
      puzzle.id,
      puzzle.solutionMode,
      puzzle.sourceMetadata,
    );
    const sourceGame = this.resolveSourceGame({
      gameUrl: puzzle.gameUrl ?? null,
      sourceType: puzzle.sourceType ?? null,
      sourceId: puzzle.sourceId ?? null,
      sourceMetadata: puzzle.sourceMetadata ?? null,
    });
    return {
      id: puzzle.id,
      fen: puzzle.fen,
      moves: puzzle.moves.split(' '),
      rating: puzzle.rating,
      themes: puzzle.themes.split(' ').filter(Boolean),
      source: puzzle.source,
      solutionMode: mode.solutionMode,
      ...(mode.playVsEngine ? { playVsEngine: mode.playVsEngine } : {}),
      ...(sourceGame ? { sourceGame } : {}),
    };
  }

  private formatRawPuzzle(p: {
    id: string;
    fen: string;
    moves: string;
    rating: number;
    themes: string;
    source: string;
    game_url?: string | null;
    opening_tags?: string | null;
    solution_mode?: string | null;
    source_metadata?: string | null;
    source_type?: string | null;
    source_id?: string | null;
  }) {
    const mode = this.resolveSolutionMode(
      p.id,
      p.solution_mode,
      p.source_metadata,
    );
    const sourceGame = this.resolveSourceGame({
      gameUrl: p.game_url ?? null,
      sourceType: p.source_type ?? null,
      sourceId: p.source_id ?? null,
      sourceMetadata: p.source_metadata ?? null,
    });
    return {
      id: p.id,
      fen: p.fen,
      moves: p.moves.split(' '),
      rating: p.rating,
      themes: p.themes.split(' ').filter(Boolean),
      source: p.source,
      gameUrl: p.game_url ?? null,
      openingTags: p.opening_tags ?? null,
      solutionMode: mode.solutionMode,
      ...(mode.playVsEngine ? { playVsEngine: mode.playVsEngine } : {}),
      ...(sourceGame ? { sourceGame } : {}),
    };
  }

  /**
   * KS-2487. Резолвим блок `sourceGame` для DTO. Источники данных:
   *
   *   1. `puzzle.sourceMetadata` — JSON-строка. Если в ней есть ключи
   *      `headers` (объект с PGN-тегами `White/Black/Event/Date/Result`)
   *      или соответствующие top-level поля (`white/black/event/date/
   *      result`) — забираем их как есть. Это путь для будущих
   *      generated-puzzle (KS-2487-* — апдейт `tactic-worker` пишет
   *      headers в metadata).
   *   2. `puzzle.gameUrl` (lichess) — URL партии. Сохраняем как
   *      `pgnUrl`. White/Black у Lichess пазлов в gameUrl не зашиты —
   *      доступны только через дополнительный запрос к Lichess API,
   *      что вне backend-scope (фронт может разворачивать сам).
   *   3. `puzzle.sourceType='archive_game' + puzzle.sourceId` — UUID
   *      строки в `archive_games`. Сохраняем `archiveGameId` для
   *      глубокой ссылки на архив; backend не делает JOIN (archive-БД
   *      — отдельный pg-кластер, не подключён к api Prisma).
   *
   * Возвращает `undefined`, если не нашлось ни одного поля — фронт
   * не рисует блок «Из партии».
   */
  private resolveSourceGame(input: {
    gameUrl: string | null;
    sourceType: string | null;
    sourceId: string | null;
    sourceMetadata: string | null;
  }): PuzzleSourceGame | undefined {
    const out: PuzzleSourceGame = {};

    if (input.sourceMetadata) {
      try {
        const meta = JSON.parse(input.sourceMetadata) as Record<string, unknown>;
        // Headers могут быть как top-level, так и под ключом `headers`.
        const headers =
          typeof meta.headers === 'object' && meta.headers !== null
            ? (meta.headers as Record<string, unknown>)
            : {};
        const pick = (key: string): string | undefined => {
          const v = headers[key] ?? meta[key];
          return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
        };
        const white =
          pick('white') ?? pick('White');
        const black =
          pick('black') ?? pick('Black');
        const event = pick('event') ?? pick('Event');
        const date = pick('date') ?? pick('Date');
        const resultRaw = pick('result') ?? pick('Result');
        if (white) out.white = white;
        if (black) out.black = black;
        if (event) out.event = event;
        if (date) out.date = date;
        if (
          resultRaw === '1-0' ||
          resultRaw === '0-1' ||
          resultRaw === '1/2-1/2' ||
          resultRaw === '*'
        ) {
          out.result = resultRaw;
        }
      } catch {
        // Невалидный JSON — пропускаем, остальные источники работают.
      }
    }

    if (input.sourceType === 'archive_game' && input.sourceId) {
      out.archiveGameId = input.sourceId;
    }

    if (input.gameUrl) {
      out.pgnUrl = input.gameUrl;
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }
}

/**
 * KS-2717: WDL_signed = (W − L) / 1000, диапазон [-1..+1].
 * null если данные неполны.
 */
function signedFromWdl(
  wdl: { w: number; d: number; l: number } | null | undefined,
): number | null {
  if (!wdl) return null;
  return (wdl.w - wdl.l) / 1000;
}

/**
 * KS-2717: сравнение UCI ходов (from+to+promotion). Сходный с
 * `samePv1` в puzzle-generator: 5 символов с promotion, 4 без.
 */
function sameUci(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length < 4 || b.length < 4) return false;
  return a.slice(0, 5) === b.slice(0, 5);
}
