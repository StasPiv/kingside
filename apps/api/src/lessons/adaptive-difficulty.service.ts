import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PuzzleStepPayload, PuzzleTheme } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { PuzzleService } from '../puzzle/puzzle.service';

/**
 * L-33 (KS-1803): адаптивная сложность follow-up задач внутри `PuzzleStep`
 * с `selection.mode='filter'`.
 *
 * Идея — после каждой попытки смещаем таргет-рейтинг следующего puzzle'а:
 *   - ≥ 3 решения подряд  → `+50` (в пределах `ratingMax`);
 *   - ≥ 2 ошибки подряд   → `-50` (в пределах `ratingMin`);
 *   - смешанная серия     → диапазон не меняется.
 *
 * Сериал хранится в той же JSONB-колонке `UserLessonProgress.stepsState`
 * под служебным ключом `__adaptive.<stepId>`. Для обычных клиентов (frontend,
 * `/progress/step`) этот ключ отфильтровывается `ProgressService.toShared`,
 * так что public-контракт `stepsState: Record<string, LessonStepState>`
 * (`@kingside/shared`) остаётся неизменным (без миграции БД).
 *
 * `mode='ids'` не адаптируется — там явный список из фикстуры.
 */

/** Служебный ключ в `stepsState`, под которым живёт адаптивное состояние. */
export const ADAPTIVE_STATE_KEY = '__adaptive';

/** Параметры правил адаптации — вынесены для удобства тестов. */
export const ADAPTIVE_RULES = {
  /** Сколько подряд решений триггерят повышение. */
  winStreakUp: 3,
  /** Сколько подряд ошибок триггерят понижение. */
  lossStreakDown: 2,
  /** Шаг изменения таргет-рейтинга, очки. */
  ratingStep: 50,
  /** Полуокно выборки (ratingMin/ratingMax = currentRating ± halfWindow). */
  halfWindow: 50,
  /** Максимальная длина истории (серии). Обрезается при записи. */
  maxSeriesLength: 10,
} as const;

/**
 * Состояние адаптивной сложности по одному шагу.
 *
 * Хранится в `UserLessonProgress.stepsState.__adaptive[stepId]`.
 */
export interface AdaptiveStepState {
  /**
   * Последние N результатов попыток (true=solved). Используется только
   * хвост: при триггере повышения/понижения серия обнуляется, чтобы
   * правило не срабатывало на каждой новой попытке.
   */
  series: boolean[];
  /** Текущий таргет-рейтинг для следующего puzzle'а. */
  currentRating: number;
  /** id задач, уже выданных в этом шаге (чтобы не повторять). */
  seenPuzzleIds: string[];
}

export interface AdaptiveStepConfig {
  ratingMin: number;
  ratingMax: number;
}

@Injectable()
export class AdaptiveDifficultyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly puzzleService: PuzzleService,
  ) {}

  // ─── Pure helpers (testable without DB) ───────────────────────────

  /**
   * Чистая функция: применить правила к состоянию после новой попытки.
   * Возвращает новое состояние; исходное не мутирует.
   */
  static applyAttempt(
    state: AdaptiveStepState,
    solved: boolean,
    config: AdaptiveStepConfig,
  ): AdaptiveStepState {
    const series = [...state.series, solved].slice(-ADAPTIVE_RULES.maxSeriesLength);
    let currentRating = state.currentRating;

    // Проверяем «хвост» серии. Правила триггерятся ровно на нужное число
    // подряд, и после срабатывания хвост обнуляется — чтобы 4-е решение
    // подряд не давало ещё +50 автоматически, нужна новая серия.
    const tailWins = tailCount(series, true);
    const tailLosses = tailCount(series, false);

    let reset = false;
    if (tailWins >= ADAPTIVE_RULES.winStreakUp) {
      currentRating = Math.min(
        config.ratingMax,
        currentRating + ADAPTIVE_RULES.ratingStep,
      );
      reset = true;
    } else if (tailLosses >= ADAPTIVE_RULES.lossStreakDown) {
      currentRating = Math.max(
        config.ratingMin,
        currentRating - ADAPTIVE_RULES.ratingStep,
      );
      reset = true;
    }

    return {
      series: reset ? [] : series,
      currentRating,
      seenPuzzleIds: state.seenPuzzleIds,
    };
  }

  /**
   * Начальное состояние для шага — центр диапазона из payload.
   * Если payload содержит только одну границу, стартуем с неё (и даём
   * окно в одну сторону).
   */
  static initialState(config: AdaptiveStepConfig): AdaptiveStepState {
    const start = Math.round((config.ratingMin + config.ratingMax) / 2);
    return {
      series: [],
      currentRating: start,
      seenPuzzleIds: [],
    };
  }

  // ─── High-level API ──────────────────────────────────────────────

  /**
   * Записать попытку. Обновляет серию + таргет-рейтинг, сохраняет под
   * `stepsState.__adaptive[stepId]`. Добавляет `puzzleId` в `seenPuzzleIds`.
   *
   * @param solved   — решил ли пользователь (true=solved, false=failed).
   * @param _timeSpent — зарезервировано на будущее (учёт скорости); сейчас
   *                   не используется в правилах, принимается для контракта.
   */
  async recordAttempt(
    userId: string,
    lessonId: string,
    stepId: string,
    puzzleId: string,
    solved: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _timeSpent?: number,
  ): Promise<AdaptiveStepState> {
    const step = await this.loadStepWithPuzzlePayload(lessonId, stepId);
    const config = deriveAdaptiveConfig(step.payload);

    const record = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
    });
    const stepsState = (record?.stepsState as Record<string, unknown> | undefined) ?? {};
    const adaptiveMap = readAdaptiveMap(stepsState);
    const prev = adaptiveMap[stepId] ?? AdaptiveDifficultyService.initialState(config);

    const nextCore = AdaptiveDifficultyService.applyAttempt(prev, solved, config);
    const next: AdaptiveStepState = {
      ...nextCore,
      seenPuzzleIds: prev.seenPuzzleIds.includes(puzzleId)
        ? prev.seenPuzzleIds
        : [...prev.seenPuzzleIds, puzzleId],
    };

    const mergedStepsState: Record<string, unknown> = {
      ...stepsState,
      [ADAPTIVE_STATE_KEY]: { ...adaptiveMap, [stepId]: next },
    };

    // Prisma InputJsonValue — закрытый тип, проще кастовать явным объектом
    // с известной shape. Содержимое уже сериализовано plain-объектами.
    await this.prisma.userLessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: {
        userId,
        lessonId,
        startedAt: new Date(),
        score: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stepsState: mergedStepsState as any,
      },
      update: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stepsState: mergedStepsState as any,
      },
    });

    return next;
  }

  /**
   * Вернуть следующую задачу шага с учётом текущей серии пользователя.
   * Используется только для `selection.mode='filter'` — для `mode='ids'`
   * применяется статичный список (`LessonPuzzleResolverService.resolveIds`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getNextPuzzle(
    userId: string,
    lessonId: string,
    stepId: string,
  ): Promise<any | null> {
    const step = await this.loadStepWithPuzzlePayload(lessonId, stepId);
    if (step.payload.selection.mode !== 'filter') {
      throw new BadRequestException(
        'Adaptive difficulty applies only to PuzzleStep with selection.mode="filter"',
      );
    }
    const config = deriveAdaptiveConfig(step.payload);
    const state = await this.loadState(userId, lessonId, stepId, config);

    const halfWindow = ADAPTIVE_RULES.halfWindow;
    const ratingMin = Math.max(config.ratingMin, state.currentRating - halfWindow);
    const ratingMax = Math.min(config.ratingMax, state.currentRating + halfWindow);

    const puzzles = await this.puzzleService.findPuzzles({
      themes: step.payload.selection.themes as PuzzleTheme[],
      ratingMin,
      ratingMax,
      limit: 1,
      excludeIds: state.seenPuzzleIds,
      orderBy: 'random',
    });
    return puzzles[0] ?? null;
  }

  /**
   * Загрузить текущий adaptive-state шага; вернуть initialState если
   * записи ещё нет.
   */
  async loadState(
    userId: string,
    lessonId: string,
    stepId: string,
    config: AdaptiveStepConfig,
  ): Promise<AdaptiveStepState> {
    const record = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
      select: { stepsState: true },
    });
    const stepsState = (record?.stepsState as Record<string, unknown> | undefined) ?? {};
    const adaptiveMap = readAdaptiveMap(stepsState);
    return adaptiveMap[stepId] ?? AdaptiveDifficultyService.initialState(config);
  }

  // ─── Internal ────────────────────────────────────────────────────

  private async loadStepWithPuzzlePayload(
    lessonId: string,
    stepId: string,
  ): Promise<{ payload: PuzzleStepPayload }> {
    const step = await this.prisma.lessonStep.findUnique({
      where: { id: stepId },
      select: { id: true, lessonId: true, type: true, payload: true },
    });
    if (!step || step.lessonId !== lessonId) {
      throw new NotFoundException('Step not found in lesson');
    }
    if (step.type !== 'puzzle') {
      throw new BadRequestException('Adaptive difficulty applies only to puzzle steps');
    }
    return { payload: step.payload as unknown as PuzzleStepPayload };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Считает длину «хвоста» подряд идущих значений `target` с конца массива. */
function tailCount<T>(arr: T[], target: T): number {
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === target) n++;
    else break;
  }
  return n;
}

function readAdaptiveMap(
  stepsState: Record<string, unknown>,
): Record<string, AdaptiveStepState> {
  const raw = stepsState[ADAPTIVE_STATE_KEY];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, AdaptiveStepState> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const row = v as Partial<AdaptiveStepState>;
    if (typeof row.currentRating !== 'number') continue;
    out[k] = {
      series: Array.isArray(row.series) ? row.series.map(Boolean) : [],
      currentRating: row.currentRating,
      seenPuzzleIds: Array.isArray(row.seenPuzzleIds)
        ? row.seenPuzzleIds.filter((x): x is string => typeof x === 'string')
        : [],
    };
  }
  return out;
}

/**
 * Извлечь ratingMin/ratingMax из payload. Если в `selection.mode='filter'`
 * не заданы — используем широкий fallback 600…2200, чтобы поведение было
 * предсказуемо (но такое состояние — скорее упущение автора урока).
 */
export function deriveAdaptiveConfig(payload: PuzzleStepPayload): AdaptiveStepConfig {
  if (payload.selection.mode !== 'filter') {
    throw new BadRequestException(
      'deriveAdaptiveConfig requires PuzzleStepPayload with selection.mode="filter"',
    );
  }
  const ratingMin = payload.selection.ratingMin ?? 600;
  const ratingMax = payload.selection.ratingMax ?? 2200;
  if (ratingMin > ratingMax) {
    throw new BadRequestException('ratingMin > ratingMax in PuzzleStep.selection');
  }
  return { ratingMin, ratingMax };
}
