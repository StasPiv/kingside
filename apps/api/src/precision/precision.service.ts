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
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

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

    const [accuracyAgg, leakRows, firstMistakeAgg] = await Promise.all([
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
      moves: pa.moves.map((m) => ({
        ply: m.ply,
        fenBefore: m.fenBefore,
        playedUci: m.playedUci,
        bestUci: m.bestUci,
        cpBefore: m.cpBefore,
        cpAfter: m.cpAfter,
        // Преобразуем W/D/L per-mille → signed [-1..+1] от лица
        // решающего/предыдущего хода. Это удобнее для фронта.
        wdlBefore: signedFromTriple(m.wdlBeforeW, m.wdlBeforeL),
        wdlAfter: signedFromTriple(m.wdlAfterW, m.wdlAfterL),
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
      }>
    >(
      `
      SELECT
        date_trunc($2::text, pa.created_at) AS bucket_start,
        COUNT(*)::bigint                   AS attempts,
        SUM(CASE WHEN pa.solved THEN 1 ELSE 0 END)::bigint AS preserved,
        AVG(prec.accuracy_percent)::float  AS avg_accuracy,
        SUM(prec.wdl_leak_sum)::float      AS sum_leak,
        SUM(prec.half_moves_played)::bigint AS sum_half_moves
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

function signedFromTriple(
  w: number | null,
  l: number | null,
): number | null {
  if (w == null || l == null) return null;
  return (w - l) / 1000;
}
