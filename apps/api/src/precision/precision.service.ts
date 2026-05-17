/**
 * KS-2718 / ADR-056 §5 B5–B6. Precision-метрики Уровня А и детали
 * одной попытки для PostGameReview.
 *
 * Таблицы (KS-2717):
 *   - `puzzle_attempts` — один к одному с `precision_attempts`.
 *   - `precision_attempts` — агрегаты PVE-попытки.
 *   - `precision_attempt_moves` — per-move детали.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  PrecisionAttemptDetail,
  PrecisionAttemptsListResponse,
  PrecisionBreakdownsResponse,
  PrecisionStatsResponse,
  PrecisionTrendsResponse,
  PrecisionMoveInput,
} from '@kingside/shared';
import {
  classifyMove,
  computePrecisionScore,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTestFixtureAttemptDto } from './dto/test-fixture.dto';

@Injectable()
export class PrecisionService {
  private readonly logger = new Logger(PrecisionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Уровень А (ADR-056 §2.1): top-блок `/precision` страницы.
   * `since` — опц. ISO-date для фильтрации «за период».
   */
  async getStatsForUser(
    userId: string,
    since?: Date,
  ): Promise<PrecisionStatsResponse> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Базовый фильтр: PVE-attempts текущего пользователя.
    // Через relation puzzle.solutionMode='play-vs-engine' (KS-2716/B1
    // подтвердил что relation-фильтр работает корректно).
    const baseFilter: {
      userId: string;
      puzzle: { is: { solutionMode: 'play-vs-engine' } };
      createdAt?: { gte?: Date };
    } = {
      userId,
      puzzle: { is: { solutionMode: 'play-vs-engine' } },
    };
    if (since) {
      baseFilter.createdAt = { gte: since };
    }

    // Counters по puzzle_attempts.
    const [totalAttempts, preservedCount, todayAttempts, todayPreserved] =
      await Promise.all([
        this.prisma.puzzleAttempt.count({ where: baseFilter }),
        this.prisma.puzzleAttempt.count({
          where: { ...baseFilter, solved: true },
        }),
        this.prisma.puzzleAttempt.count({
          where: {
            userId,
            puzzle: { is: { solutionMode: 'play-vs-engine' } },
            createdAt: { gte: today },
          },
        }),
        this.prisma.puzzleAttempt.count({
          where: {
            userId,
            puzzle: { is: { solutionMode: 'play-vs-engine' } },
            createdAt: { gte: today },
            solved: true,
          },
        }),
      ]);

    const lostCount = Math.max(0, totalAttempts - preservedCount);
    const preservedRate =
      totalAttempts > 0 ? preservedCount / totalAttempts : 0;

    // Аггрегаты по precision_attempts: AVG(accuracy), AVG(wdlLeak/halfMoves),
    // AVG(firstMistakePly).
    //
    // Связь PrecisionAttempt → PuzzleAttempt 1:1 через attemptId. Чтобы
    // фильтровать по userId + since + solutionMode (PVE), идём через
    // relation `attempt`.
    const precisionFilter: {
      attempt: {
        userId: string;
        puzzle: { is: { solutionMode: 'play-vs-engine' } };
        createdAt?: { gte: Date };
      };
    } = {
      attempt: {
        userId,
        puzzle: { is: { solutionMode: 'play-vs-engine' } },
      },
    };
    if (since) {
      precisionFilter.attempt.createdAt = { gte: since };
    }

    const [
      accuracyAgg,
      leakRows,
      firstMistakeAgg,
      // KS-3000: avgScore / avgScorePct + распределение по звёздам.
      scoreAgg,
      scoreGroups,
    ] = await Promise.all([
      this.prisma.precisionAttempt.aggregate({
        where: precisionFilter,
        _avg: { accuracyPercent: true },
      }),
      // wdlLeakSum / halfMovesPlayed — нужно посчитать как ratio, не
      // SUM/SUM (иначе попытки с разной длиной зазвешиваются по
      // длине). По ADR-056 §2.1 формула — `Σ(wdlBefore-wdlAfter) /
      // totalUserMoves`. Это эквивалентно AVG(leakSum/halfMovesPlayed)
      // взвешенному по halfMovesPlayed; для простоты усредняем
      // плоским `AVG`, метрика — оценочная.
      this.prisma.precisionAttempt.findMany({
        where: { ...precisionFilter, halfMovesPlayed: { gt: 0 } },
        select: { wdlLeakSum: true, halfMovesPlayed: true },
      }),
      this.prisma.precisionAttempt.aggregate({
        where: { ...precisionFilter, firstMistakePly: { not: null } },
        _avg: { firstMistakePly: true },
      }),
      // KS-3000 / ADR-065 §6.5: AVG среди attempts со score!=null
      // (legacy без WDL/cp проигнорированы — это правильно: NULL не
      // искажает среднее).
      this.prisma.precisionAttempt.aggregate({
        where: { ...precisionFilter, score: { not: null } },
        _avg: { score: true, scorePct: true },
      }),
      // KS-3000: распределение по звёздам через groupBy. Индекс
      // `precision_attempts_score_idx` (KS-2998) ускоряет COUNT(*).
      this.prisma.precisionAttempt.groupBy({
        by: ['score'],
        where: { ...precisionFilter, score: { not: null } },
        _count: { score: true },
      }),
    ]);

    let avgWdlLeakPerMove = 0;
    if (leakRows.length > 0) {
      let totalLeak = 0;
      let totalMoves = 0;
      for (const r of leakRows) {
        totalLeak += r.wdlLeakSum;
        totalMoves += r.halfMovesPlayed;
      }
      avgWdlLeakPerMove = totalMoves > 0 ? totalLeak / totalMoves : 0;
    }

    // KS-3000: scoreDistribution. groupBy({score}) даёт массив
    // `{score: 1..5 | null, _count: {score: N}}`; разворачиваем в
    // объект stars1..stars5. NULL-группа исключена фильтром выше.
    const scoreDistribution = {
      stars1: 0,
      stars2: 0,
      stars3: 0,
      stars4: 0,
      stars5: 0,
    };
    for (const g of scoreGroups) {
      if (g.score === null || g.score === undefined) continue;
      const key = `stars${g.score}` as keyof typeof scoreDistribution;
      if (key in scoreDistribution) scoreDistribution[key] = g._count.score;
    }

    return {
      totalAttempts,
      preservedCount,
      lostCount,
      preservedRate,
      avgAccuracyPercent: accuracyAgg._avg.accuracyPercent ?? 0,
      avgWdlLeakPerMove,
      avgHalfMovesUntilFirstMistake:
        firstMistakeAgg._avg.firstMistakePly ?? null,
      todayAttempts,
      todayPreserved,
      // KS-3000 / ADR-065 §6.5.
      avgScore: scoreAgg._avg.score ?? null,
      avgScorePct: scoreAgg._avg.scorePct ?? null,
      scoreDistribution,
    };
  }

  /**
   * KS-2724: список PVE-попыток текущего пользователя для блока
   * «История попыток» на /precision. Возвращает агрегаты Уровня А
   * каждой попытки (accuracyPercent, classCounts, endReason); per-move
   * детали тянутся отдельно через `getAttemptDetail`.
   *
   * Сортировка — последние первыми (`createdAt DESC`).
   */
  async listAttemptsForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<PrecisionAttemptsListResponse> {
    // KS-2737: убрали фильтр `precisionAttempt: isNot: null`. Раньше
    // attempts без записи в `precision_attempts` (legacy/PVE без
    // moves[]-snapshot из фронта) не попадали в список — пользователь
    // видел пустую историю даже при наличии puzzle_attempts. Теперь
    // показываем все PVE-attempts; если нет precisionAttempt-snapshot,
    // возвращаем дефолтные агрегаты (accuracy=0, classCounts=0,
    // endReason='legacy'). Фронт может отрендерить такой item с
    // меткой «без детального разбора».
    const baseFilter = {
      userId,
      puzzle: { is: { solutionMode: 'play-vs-engine' as const } },
    };

    const [rows, total] = await Promise.all([
      this.prisma.puzzleAttempt.findMany({
        where: baseFilter,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          puzzle: { select: { id: true, fen: true } },
          precisionAttempt: true,
        },
      }),
      this.prisma.puzzleAttempt.count({ where: baseFilter }),
    ]);

    const items = rows.map((r) => {
      const pa = r.precisionAttempt;
      if (pa) {
        return {
          attemptId: r.id,
          puzzleId: r.puzzleId,
          puzzleFen: r.puzzle.fen,
          attemptedAt: r.createdAt.toISOString(),
          solved: r.solved,
          endReason: pa.endReason,
          halfMovesPlayed: pa.halfMovesPlayed,
          accuracyPercent: pa.accuracyPercent,
          classCounts: {
            best: pa.bestMovesCount,
            good: pa.goodMovesCount,
            inaccuracy: pa.inaccuraciesCount,
            mistake: pa.mistakesCount,
            blunder: pa.blundersCount,
          },
          // KS-3000 / ADR-065 §6.1. 5★-оценка; null для legacy.
          score: pa.score,
          // KS-3077 / ADR-065 §6.1. Процент той же WDL/cp-шкалы;
          // фронт показывает его на карточке вместо accuracyPercent
          // (синхрон со звёздами и detail-страницей).
          scorePct: pa.scorePct,
        };
      }
      // Legacy/без moves[]-snapshot — дефолтные агрегаты.
      return {
        attemptId: r.id,
        puzzleId: r.puzzleId,
        puzzleFen: r.puzzle.fen,
        attemptedAt: r.createdAt.toISOString(),
        solved: r.solved,
        endReason: 'legacy',
        halfMovesPlayed: 0,
        accuracyPercent: 0,
        classCounts: {
          best: 0,
          good: 0,
          inaccuracy: 0,
          mistake: 0,
          blunder: 0,
        },
        score: null,
        scorePct: null,
      };
    });

    return { items, total };
  }

  /**
   * Уровень Б (ADR-056 §2.2): детали одной PVE-попытки.
   *
   * Доступ: только владелец attempt'а или админ. 404 если attempt
   * не существует или это не PVE.
   */
  async getAttemptDetail(
    attemptId: string,
    requestingUserId: string,
    isAdmin: boolean,
  ): Promise<PrecisionAttemptDetail> {
    const attempt = await this.prisma.puzzleAttempt.findUnique({
      where: { id: attemptId },
      include: {
        precisionAttempt: { include: { moves: { orderBy: { ply: 'asc' } } } },
        puzzle: { select: { id: true, solutionMode: true } },
      },
    });

    if (!attempt || !attempt.precisionAttempt) {
      throw new NotFoundException(`Precision attempt ${attemptId} not found`);
    }
    if (attempt.puzzle.solutionMode !== 'play-vs-engine') {
      throw new NotFoundException(
        `Attempt ${attemptId} is not a play-vs-engine attempt`,
      );
    }
    if (!isAdmin && attempt.userId !== requestingUserId) {
      throw new ForbiddenException(
        'You do not have access to this precision attempt',
      );
    }

    const pa = attempt.precisionAttempt;
    return {
      attemptId: attempt.id,
      puzzleId: attempt.puzzleId,
      attemptedAt: attempt.createdAt.toISOString(),
      solved: attempt.solved,
      endReason: pa.endReason,
      halfMovesPlayed: pa.halfMovesPlayed,
      halfMovesTarget: pa.halfMovesTarget,
      accuracyPercent: pa.accuracyPercent,
      classCounts: {
        best: pa.bestMovesCount,
        good: pa.goodMovesCount,
        inaccuracy: pa.inaccuraciesCount,
        mistake: pa.mistakesCount,
        blunder: pa.blundersCount,
      },
      wdlAtStart: pa.wdlAtStartSigned,
      wdlAtEnd: pa.wdlAtEndSigned,
      wdlLeakSum: pa.wdlLeakSum,
      firstMistakePly: pa.firstMistakePly,
      // KS-3000 / ADR-065 §6.1.
      score: pa.score,
      scorePct: pa.scorePct,
      moves: pa.moves.map((m) => ({
        ply: m.ply,
        fenBefore: m.fenBefore,
        playedUci: m.playedUci,
        bestUci: m.bestUci,
        cpBefore: m.cpBefore,
        cpAfter: m.cpAfter,
        // KS-2754. Отдаём полное W/D/L distribution per-mille (как
        // лежит в БД), а не свёрнутый скаляр — фронт показывает W/D/L%.
        // null если хотя бы одна компонента не записана (legacy /
        // fallback-движок без UCI_ShowWDL).
        wdlBefore: wdlTripleOrNull(m.wdlBeforeW, m.wdlBeforeD, m.wdlBeforeL),
        wdlAfter: wdlTripleOrNull(m.wdlAfterW, m.wdlAfterD, m.wdlAfterL),
        depth: m.depth,
        classification: m.classification as PrecisionAttemptDetail['moves'][number]['classification'],
        // KS-2754. UCI engine-ответа на этот user-ход; кладёт фронт
        // при сохранении attempt'а. null для последнего user-полухода
        // партии и для legacy-attempt'ов (до KS-2754).
        engineUci: m.engineUci,
      })),
    };
  }

  // ── KS-2727: Уровень В — trends + breakdowns ────────────────────

  /**
   * KS-2727 B7.1. Тренд точности и удержания по бакетам времени.
   * Группировка по `date_trunc(bucket, created_at)`. Пустые бакеты
   * не возвращаются — фронт сам нарисует «дни без попыток».
   */
  async getTrendsForUser(
    userId: string,
    options: {
      bucket: 'day' | 'week' | 'month';
      since?: Date;
      until?: Date;
    },
  ): Promise<PrecisionTrendsResponse> {
    const bucket = options.bucket;
    const sinceMs = options.since?.toISOString() ?? null;
    const untilMs = options.until?.toISOString() ?? null;

    // Прямой SQL: date_trunc + JOIN. Параметризованные значения
    // подставляются через Prisma.sql — защита от SQL-injection.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        bucket_start: Date;
        attempts: bigint;
        preserved: bigint;
        avg_accuracy: number | null;
        sum_leak: number | null;
        sum_half_moves: bigint;
        // KS-3000: AVG идёт только по строкам со score!=null (PG AVG
        // автоматически игнорирует NULL — это нужное поведение).
        avg_score: number | null;
        avg_score_pct: number | null;
      }>
    >(
      `
      SELECT
        date_trunc($2::text, pa.created_at) AS bucket_start,
        COUNT(*)::bigint                   AS attempts,
        SUM(CASE WHEN pa.solved THEN 1 ELSE 0 END)::bigint AS preserved,
        AVG(prec.accuracy_percent)::float  AS avg_accuracy,
        SUM(prec.wdl_leak_sum)::float      AS sum_leak,
        SUM(prec.half_moves_played)::bigint AS sum_half_moves,
        AVG(prec.score)::float             AS avg_score,
        AVG(prec.score_pct)::float         AS avg_score_pct
      FROM puzzle_attempts pa
      JOIN puzzles p ON p.id = pa.puzzle_id
      JOIN precision_attempts prec ON prec.attempt_id = pa.id
      WHERE pa.user_id = $1::uuid
        AND p.solution_mode = 'play-vs-engine'
        ${sinceMs ? 'AND pa.created_at >= $3::timestamp' : ''}
        ${untilMs ? `AND pa.created_at <= $${sinceMs ? 4 : 3}::timestamp` : ''}
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
      `,
      ...[userId, bucket, sinceMs, untilMs].filter((v) => v !== null),
    );

    return {
      bucket,
      points: rows.map((r) => ({
        bucketStart: r.bucket_start.toISOString(),
        attempts: Number(r.attempts),
        preserved: Number(r.preserved),
        avgAccuracyPercent: r.avg_accuracy ?? 0,
        avgWdlLeakPerMove:
          Number(r.sum_half_moves) > 0
            ? (r.sum_leak ?? 0) / Number(r.sum_half_moves)
            : 0,
        // KS-3000 / ADR-065 §6.5. null если в бакете все score=null.
        avgScore: r.avg_score,
        avgScorePct: r.avg_score_pct,
      })),
    };
  }

  /**
   * KS-2727 B7.2. Разбивка по фазе игры (по числу фигур в FEN
   * первого хода попытки) и по темам пазла.
   */
  async getBreakdownsForUser(
    userId: string,
    since?: Date,
  ): Promise<PrecisionBreakdownsResponse> {
    const sinceMs = since?.toISOString() ?? null;

    // ── byPhase: считаем фазу по FEN первого хода каждой попытки ───
    // Грузим (attemptId, fen первого ply, accuracyPercent). PG SQL не
    // парсит FEN, поэтому делаем JS-группировку на пачке.
    const movesRows = await this.prisma.$queryRawUnsafe<
      Array<{ accuracy: number; first_fen: string }>
    >(
      `
      SELECT
        prec.accuracy_percent::float AS accuracy,
        first_move.fen_before        AS first_fen
      FROM puzzle_attempts pa
      JOIN puzzles p ON p.id = pa.puzzle_id
      JOIN precision_attempts prec ON prec.attempt_id = pa.id
      JOIN LATERAL (
        SELECT fen_before
        FROM precision_attempt_moves m
        WHERE m.attempt_id = pa.id
        ORDER BY m.ply ASC
        LIMIT 1
      ) AS first_move ON TRUE
      WHERE pa.user_id = $1::uuid
        AND p.solution_mode = 'play-vs-engine'
        ${sinceMs ? 'AND pa.created_at >= $2::timestamp' : ''}
      `,
      ...[userId, sinceMs].filter((v) => v !== null),
    );

    const phaseAcc = new Map<
      'opening' | 'middlegame' | 'endgame',
      { sum: number; n: number }
    >();
    for (const r of movesRows) {
      const phase = classifyPhaseByFen(r.first_fen);
      if (!phase) continue;
      const acc = phaseAcc.get(phase) ?? { sum: 0, n: 0 };
      acc.sum += r.accuracy;
      acc.n += 1;
      phaseAcc.set(phase, acc);
    }
    const byPhase: PrecisionBreakdownsResponse['byPhase'] = (
      ['opening', 'middlegame', 'endgame'] as const
    ).map((phase) => {
      const a = phaseAcc.get(phase) ?? { sum: 0, n: 0 };
      return {
        phase,
        attempts: a.n,
        avgAccuracyPercent: a.n > 0 ? a.sum / a.n : 0,
      };
    });

    // ── byTheme: UNNEST string_to_array(themes, ' ') ───────────────
    const themeRows = await this.prisma.$queryRawUnsafe<
      Array<{ theme: string; attempts: bigint; avg_accuracy: number | null }>
    >(
      `
      SELECT
        theme,
        COUNT(*)::bigint           AS attempts,
        AVG(prec.accuracy_percent)::float AS avg_accuracy
      FROM puzzle_attempts pa
      JOIN puzzles p ON p.id = pa.puzzle_id
      JOIN precision_attempts prec ON prec.attempt_id = pa.id,
           UNNEST(string_to_array(p.themes, ' ')) AS theme
      WHERE pa.user_id = $1::uuid
        AND p.solution_mode = 'play-vs-engine'
        AND theme <> ''
        AND theme NOT IN ('playVsEngine')
        ${sinceMs ? 'AND pa.created_at >= $2::timestamp' : ''}
      GROUP BY theme
      ORDER BY (100 - COALESCE(AVG(prec.accuracy_percent)::float, 0)) DESC,
               COUNT(*) DESC
      LIMIT 10
      `,
      ...[userId, sinceMs].filter((v) => v !== null),
    );

    const byTheme: PrecisionBreakdownsResponse['byTheme'] = themeRows.map(
      (r) => ({
        theme: r.theme,
        attempts: Number(r.attempts),
        avgAccuracyPercent: r.avg_accuracy ?? 0,
        weakness: 100 - (r.avg_accuracy ?? 0),
      }),
    );

    return { byPhase, byTheme };
  }

  // ── KS-3029: dev-only fixture для e2e (KS-3007) ──────────────────

  /**
   * KS-3029. Создаёт precision-attempt с произвольными moves БЕЗ
   * chess.js валидации — для e2e KS-3007 (5★ сценарии ADR-065 §4.3).
   *
   * Доступ ограничен `DevOnlyGuard` на контроллере (NODE_ENV !=
   * production). На проде endpoint вернёт 404 ещё до вызова сервиса.
   *
   * Алгоритм:
   *  1. Если `puzzleId` не задан — берём первый PVE-пазл из БД.
   *  2. Для каждого move: classifyMove(WDL/cp/isBestMove).
   *  3. Считаем counts, accuracyPercent, firstMistakePly, wdlLeakSum.
   *  4. computePrecisionScore → score, scorePct.
   *  5. Транзакция: PuzzleAttempt + PrecisionAttempt + Moves.
   *  6. Возврат `{attemptId, score, scorePct}`.
   */
  async createTestFixtureAttempt(args: {
    userId: string;
    body: CreateTestFixtureAttemptDto;
  }): Promise<{
    attemptId: string;
    score: number | null;
    scorePct: number | null;
  }> {
    const moves = args.body.moves ?? [];
    if (moves.length === 0) {
      throw new BadRequestException('moves[] must be non-empty');
    }

    let puzzleId = args.body.puzzleId;
    if (!puzzleId) {
      const puzzle = await this.prisma.puzzle.findFirst({
        where: { solutionMode: 'play-vs-engine' },
        select: { id: true },
      });
      if (!puzzle) {
        throw new BadRequestException(
          'No PVE puzzle in DB to attach fixture attempt. Pass puzzleId explicitly.',
        );
      }
      puzzleId = puzzle.id;
    }

    // Классификация + входы для score.
    const classified = moves.map((m) => {
      const isBestMove = m.playedUci === m.bestUci;
      const klass = classifyMove({
        wdlBefore: m.wdlBefore ?? null,
        wdlAfter: m.wdlAfter ?? null,
        cpBefore: m.cpBefore ?? null,
        cpAfter: m.cpAfter ?? null,
        isBestMove,
      });
      return { m, klass };
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
      const wb = c.m.wdlBefore;
      const wa = c.m.wdlAfter;
      if (wb && wa) {
        const eBefore = (wb.w + wb.d / 2) / 1000;
        const eAfter = (wa.w + wa.d / 2) / 1000;
        wdlLeakSum += Math.max(0, eBefore - eAfter);
      }
    }
    const total = classified.length;
    const accuracyPercent =
      total > 0 ? ((counts.best + counts.good) / total) * 100 : 0;

    const scoreInputs: PrecisionMoveInput[] = classified.map(({ m, klass }) => ({
      wdlBefore: m.wdlBefore ?? null,
      wdlAfter: m.wdlAfter ?? null,
      cpBefore: m.cpBefore ?? null,
      cpAfter: m.cpAfter ?? null,
      classification: klass,
    }));
    const scoreResult = computePrecisionScore(scoreInputs);

    // WDL_signed start/end для PrecisionAttempt (упрощённо).
    const first = moves[0];
    const last = moves[moves.length - 1];
    const wdlSigned = (w: { w: number; d: number; l: number } | null | undefined) =>
      w ? (w.w - w.l) / 1000 : 0;
    const wdlAtStartSigned = wdlSigned(first.wdlBefore);
    const wdlAtEndSigned = wdlSigned(last.wdlAfter);

    const endReason = args.body.endReason ?? 'win';
    const solved = args.body.solved ?? true;

    const attemptId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.puzzleAttempt.create({
        data: {
          puzzleId: puzzleId!,
          userId: args.userId,
          solved,
          timeMs: 0,
          ratingBefore: 0,
          ratingAfter: 0,
          userMoves: null,
          hintsUsed: 0,
        },
        select: { id: true },
      });

      await tx.precisionAttempt.create({
        data: {
          attemptId: created.id,
          wdlAtStartSigned,
          wdlAtEndSigned,
          halfMovesPlayed: total,
          halfMovesTarget: total,
          accuracyPercent,
          bestMovesCount: counts.best,
          goodMovesCount: counts.good,
          inaccuraciesCount: counts.inaccuracy,
          mistakesCount: counts.mistake,
          blundersCount: counts.blunder,
          firstMistakePly,
          wdlLeakSum,
          endReason,
          score: scoreResult.stars,
          scorePct: scoreResult.scorePct,
        },
      });

      if (classified.length > 0) {
        await tx.precisionAttemptMove.createMany({
          data: classified.map(({ m, klass }) => ({
            attemptId: created.id,
            ply: m.ply,
            fenBefore: m.fenBefore ?? '',
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

      return created.id;
    });

    this.logger.log(
      `KS-3029 test fixture: user=${args.userId} puzzle=${puzzleId} ` +
        `moves=${total} score=${scoreResult.stars} scorePct=${scoreResult.scorePct?.toFixed(1)}`,
    );

    return {
      attemptId,
      score: scoreResult.stars,
      scorePct: scoreResult.scorePct,
    };
  }
}

/**
 * KS-2727: эвристика фазы по FEN. По числу не-королевских фигур
 * (всех major/minor/pawn у обеих сторон):
 *   ≥28 → opening; 14..27 → middlegame; ≤13 → endgame.
 *
 * Эталонная начальная позиция = 32 фигуры; чем меньше материала,
 * тем дальше игра. Король не считаем (всегда есть).
 */
export function classifyPhaseByFen(
  fen: string,
): 'opening' | 'middlegame' | 'endgame' | null {
  const board = fen.split(/\s+/)[0];
  if (!board) return null;
  let count = 0;
  for (const ch of board) {
    if (/[prnbqPRNBQ]/.test(ch)) count++;
  }
  if (count >= 28) return 'opening';
  if (count >= 14) return 'middlegame';
  return 'endgame';
}

/**
 * KS-2754. Собирает W/D/L per-mille distribution из трёх колонок БД.
 * Возвращает `null`, если хотя бы одна компонента не записана
 * (legacy attempt'ы либо attempt с fallback-движком без UCI_ShowWDL).
 */
function wdlTripleOrNull(
  w: number | null,
  d: number | null,
  l: number | null,
): { w: number; d: number; l: number } | null {
  if (w == null || d == null || l == null) return null;
  return { w, d, l };
}
