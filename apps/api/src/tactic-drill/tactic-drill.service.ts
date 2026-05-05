/**
 * KS-2230 (ADR-035 §6.2 / api-contract §5).
 *
 * Drill-mode логика. Sprint реализован минимально (заглушки + lookup
 * leaderboard'а из таблицы `tactic_drill_sprint_scores`); start/submit
 * возвращают 501 на уровне controller'а.
 *
 * Cooldown 30 дней (ADR §3.2): для авторизованных юзеров не выдавать
 * drill, по которому есть `tactic_drill_attempt` за последние 30 дней.
 * Гости (auth-less) — без cooldown.
 *
 * Защита эталона (api-contract §7): метод `getNext` возвращает
 * `TacticDrillDto` БЕЗ поля `answer`. Эталон отдаётся только в ответе
 * `recordAttempt` (через `correctAnswer`).
 */
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { normalizeStoredAnswer } from './dto/answer.dto';
import type {
  AnswerData,
  AnswerShape,
  DrillDifficultyBucket,
  DrillStepPayload,
  TacticDrillAttemptResponse,
  TacticDrillByStepResponse,
  TacticDrillDto,
  TacticDrillSkillLayer,
  TacticDrillStatsItem,
  TacticDrillStatsResponse,
  TacticDrillType,
} from '@kingside/shared';
import {
  DRILL_BUCKET_TO_DIFFICULTY,
  DRILL_TYPE_ANSWER_SHAPE,
  DRILL_TYPE_LAYER,
  DRILL_TYPE_ORDER,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';
import type { TacticDrillRatingService } from './tactic-drill-rating.service';

const COOLDOWN_DAYS = 30;
const ALL_DRILL_TYPES: TacticDrillType[] = DRILL_TYPE_ORDER;

export interface TacticDrillTypeListItem {
  id: TacticDrillType;
  layer: TacticDrillSkillLayer;
  answerShape: AnswerShape;
  promptKey: string;
  unlocked: boolean;
}

@Injectable()
export class TacticDrillService {
  /**
   * KS-2311: optional rating-сервис. Подключается через `setRatingService`
   * после module-wiring (избегаем circular DI: rating-сервис ничего
   * не требует из drill-сервиса, но drill-сервис может вызывать его
   * после `recordAttempt`). В тестах, где rating не нужен, оставляем
   * undefined — recordAttempt просто пропускает rating-update.
   */
  private ratingService?: TacticDrillRatingService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: TacticDrillValidatorService,
  ) {}

  setRatingService(svc: TacticDrillRatingService): void {
    this.ratingService = svc;
  }

  /**
   * Список drill-типов с локализованными ключами и unlocked-статусом
   * (для гостей и не-прошедших — все unlocked, для авторизованных
   * со счётчиком — открыты те, у кого есть успешное прохождение).
   * MVP: всем unlocked=true (полная unlock-логика — в KS-DRILL-LOBBY).
   */
  async listTypes(userId: string | null): Promise<TacticDrillTypeListItem[]> {
    let unlockedSet = new Set<TacticDrillType>(ALL_DRILL_TYPES);
    if (userId) {
      // Авторизованный: unlocked — drill-типы, по которым есть хотя бы
      // одна solved-попытка. Это даёт корректный flag для KS-DRILL-LOBBY
      // unlock-логики, при этом MVP: все unlocked, пока lobby не
      // потребует жёсткий gating (см. api-contract §5.1).
      const solved = await this.prisma.tacticDrillAttempt.findMany({
        where: { userId, correct: true },
        select: { drill: { select: { type: true } } },
        distinct: ['drillId'],
      });
      const types = new Set<TacticDrillType>();
      for (const s of solved) types.add(s.drill.type as TacticDrillType);
      // Расширим unlocked множеством, всё равно для MVP unlocked=true
      // ниже. unlockedSet оставляем = ALL чтобы не блокировать.
      void types;
      unlockedSet = new Set<TacticDrillType>(ALL_DRILL_TYPES);
    }

    return ALL_DRILL_TYPES.map((id) => ({
      id,
      layer: DRILL_TYPE_LAYER[id],
      answerShape: DRILL_TYPE_ANSWER_SHAPE[id],
      promptKey: `review.drill.prompt.${id}`,
      unlocked: unlockedSet.has(id),
    }));
  }

  /**
   * Следующая drill-задача. Cooldown 30 дней — для авторизованных:
   * исключаем drill-id, по которым была попытка за этот срок.
   *
   * Возвращаем без поля `answer` (api-contract §7). Если задач нет
   * (cooldown поглотил весь пул) — `null`, controller вернёт 404.
   */
  async getNext(
    userId: string | null,
    type: TacticDrillType,
    difficulty?: number,
  ): Promise<TacticDrillDto | null> {
    // KS-2371: подробное timing-логирование для диагностики 14с-задержки
    // на проде. Каждый шаг измеряется hi-res-таймером; финальная строка
    // в логах включает breakdown. Логи структурированы (`[drill-next]
    // ...`) — DevOps grep'ает.
    const t0 = Date.now();
    let tCooldown = 0;
    let tBranch = 0;

    // KS-2433: SF-валидация удалена — фильтр `sfRejected=false`
    // больше не нужен.
    const where: Record<string, unknown> = { type };
    if (difficulty !== undefined) {
      where.difficulty = difficulty;
    }
    let recentCount = 0;
    if (userId) {
      const tCool0 = Date.now();
      const cooldownSince = new Date(
        Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
      );
      const recent = await this.prisma.tacticDrillAttempt.findMany({
        where: { userId, createdAt: { gte: cooldownSince } },
        select: { drillId: true },
        distinct: ['drillId'],
      });
      tCooldown = Date.now() - tCool0;
      recentCount = recent.length;
      if (recent.length > 0) {
        where.id = { notIn: recent.map((r) => r.drillId) };
      }
    }

    // KS-2346: для count-attackers балансируем по answer.value (1..4)
    // равновероятно. Без этого UX-распределение перекошено в сторону
    // value=1 (~72% банка), потому что в реальных партиях клетки с
    // одним атакующим встречаются в разы чаще. Идём по value-приоритету
    // в случайном порядке: первый где есть drill — тот и берём.
    if (type === 'count-attackers') {
      const tBranch0 = Date.now();
      const drill = await this.pickBalancedCountAttackers(where);
      tBranch = Date.now() - tBranch0;
      const tTotal = Date.now() - t0;
      // eslint-disable-next-line no-console
      console.log(
        `[drill-next] type=count-attackers cooldown=${tCooldown}ms recent=${recentCount} pick=${tBranch}ms total=${tTotal}ms found=${!!drill}`,
      );
      if (!drill) return null;
      return this.toDto(
        drill.id,
        drill.type as TacticDrillType,
        drill.fen,
        drill.difficulty,
        drill.meta,
      );
    }

    // KS-2370: keyset random pick через `id >= gen_random_uuid()`
    // вместо `findFirst({skip: offset})`. На больших buckets
    // (find-loose-piece 138k, find-pin 128k) обычный count + offset
    // walks по 70k+ index-entries — 2-3с cold cache. Keyset — index
    // seek O(log N), <50мс независимо от размера. KS-2433: индекс
    // переехал на `(type, id)` после удаления sf_rejected.
    const excludeIds =
      (where.id as { notIn?: string[] } | undefined)?.notIn ?? [];
    const difficultyVal =
      typeof where.difficulty === 'number'
        ? (where.difficulty as number)
        : null;
    const tBranch0 = Date.now();
    const drill = await this.pickRandomByKeyset(
      type,
      excludeIds,
      difficultyVal,
    );
    const tBranch2 = Date.now() - tBranch0;
    const tTotal = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `[drill-next] type=${type} cooldown=${tCooldown}ms recent=${recentCount} keyset=${tBranch2}ms total=${tTotal}ms found=${!!drill}`,
    );
    if (!drill) return null;

    return this.toDto(
      drill.id,
      drill.type as TacticDrillType,
      drill.fen,
      drill.difficulty,
      drill.meta,
    );
  }

  /**
   * KS-2370: keyset-random для drill-типов кроме count-attackers
   * (count-attackers обслуживается `pickBalancedCountAttackers` →
   * `pickCountAttackerByValue`, см. KS-2368/KS-2371).
   *
   * Алгоритм идентичен KS-2371: `id >= gen_random_uuid()` forward
   * seek + backward fallback при null. UUID v4 равномерно распределён
   * → index range scan на `tactic_drills_type_id_idx` (KS-2355,
   * перевыпущен в KS-2433 без sf_rejected) даёт O(log N) seek
   * независимо от размера bucket'а.
   *
   * `findFirst({skip: offset})` Prisma на 138k записях с offset=70k
   * walks по 70k index-entries — 2-3с cold cache. Здесь — <50мс.
   */
  private async pickRandomByKeyset(
    type: TacticDrillType,
    excludeIds: string[],
    difficulty: number | null,
  ): Promise<{
    id: string;
    type: string;
    fen: string;
    difficulty: number;
    meta: unknown;
  } | null> {
    const conditions = [`type = $1`];
    const params: unknown[] = [type];
    if (difficulty !== null) {
      params.push(difficulty);
      conditions.push(`difficulty = $${params.length}`);
    }
    if (excludeIds.length > 0) {
      params.push(excludeIds);
      conditions.push(`NOT (id = ANY($${params.length}::uuid[]))`);
    }
    const whereSql = conditions.join(' AND ');

    const sqlForward =
      `SELECT id, type, fen, difficulty, meta FROM tactic_drills ` +
      `WHERE ${whereSql} AND id >= gen_random_uuid() ` +
      `ORDER BY id ASC LIMIT 1`;
    const sqlBackward =
      `SELECT id, type, fen, difficulty, meta FROM tactic_drills ` +
      `WHERE ${whereSql} AND id < gen_random_uuid() ` +
      `ORDER BY id DESC LIMIT 1`;

    type Row = {
      id: string;
      type: string;
      fen: string;
      difficulty: number;
      meta: unknown;
    };

    const tFwd0 = Date.now();
    const fwd = await this.prisma.$queryRawUnsafe<Row[]>(
      sqlForward,
      ...params,
    );
    const tFwd = Date.now() - tFwd0;
    if (fwd[0]) {
      // eslint-disable-next-line no-console
      console.log(
        `[drill-next] keyset type=${type} fwd=${tFwd}ms hit=fwd excludeIds=${excludeIds.length}`,
      );
      return fwd[0];
    }

    const tBwd0 = Date.now();
    const bwd = await this.prisma.$queryRawUnsafe<Row[]>(
      sqlBackward,
      ...params,
    );
    const tBwd = Date.now() - tBwd0;
    // eslint-disable-next-line no-console
    console.log(
      `[drill-next] keyset type=${type} fwd=${tFwd}ms bwd=${tBwd}ms hit=${bwd[0] ? 'bwd' : 'none'} excludeIds=${excludeIds.length}`,
    );
    return bwd[0] ?? null;
  }

  /**
   * KS-2346: балансированная выборка count-attackers по answer.value
   * (1..4 равновероятно). Перебираем values в случайном порядке,
   * берём первый, у которого есть drill в пуле (с учётом cooldown'а
   * через `where`). Это даёт пользователю равные доли по ответам
   * независимо от перекошенного распределения банка.
   *
   * KS-2368: переведено с Prisma JSON-фильтра (`answer = { path:
   * ['value'], equals }`) на raw SQL с выражением `(answer->>'value')
   * ::int`. Prisma шлёт `(answer #> '{value}')::jsonb = '$'::jsonb` —
   * это НЕ использует функциональный индекс. Raw SQL c
   * `(answer->>'value')::int` использует partial index
   * `tactic_drills_ca_value_idx` (миграция 20260504130000) — на dev
   * 0.5мс vs 19мс (×40 ускорение).
   *
   * `baseWhere` — already-prepared фильтр (type, опц. difficulty и
   * cooldown.id). Извлекаем cooldown.notIn массив и difficulty для
   * raw SQL. KS-2433: `sf_rejected` исключён.
   */
  private async pickBalancedCountAttackers(
    baseWhere: Record<string, unknown>,
  ): Promise<{
    id: string;
    type: string;
    fen: string;
    difficulty: number;
    meta: unknown;
  } | null> {
    // Перемешаем 1..4 через Fisher-Yates (равномерное распределение
    // перестановок; `sort(() => Math.random()-0.5)` известный антипаттерн —
    // в V8 TimSort даёт смещение, value=1 чаще становится первым).
    const values = [1, 2, 3, 4];
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }

    // Извлекаем дополнительные фильтры из baseWhere для raw SQL.
    const excludeIds =
      (baseWhere.id as { notIn?: string[] } | undefined)?.notIn ?? [];
    const difficultyVal =
      typeof baseWhere.difficulty === 'number'
        ? (baseWhere.difficulty as number)
        : null;

    for (const value of values) {
      const drill = await this.pickCountAttackerByValue(
        value,
        excludeIds,
        difficultyVal,
      );
      if (drill) return drill;
    }
    return null;
  }

  /**
   * KS-2368/KS-2371: одна попытка для конкретного `answer.value`.
   *
   * Раньше использовали `count(*) + LIMIT 1 OFFSET random()*total`.
   * После rescore (KS-2354 update 639k строк) planner на functional
   * expression давал заниженный estimate → выбирался Bitmap Heap Scan
   * + external sort вместо Index Only Scan. На проде count =11с,
   * select =13с для value=1 (464k записей). VACUUM ANALYZE не помог —
   * planner всё равно ошибался в estimate.
   *
   * **Keyset-random pick** через `id >= gen_random_uuid()`:
   *   - UUID v4 равномерно распределён в 128-bit пространстве.
   *   - Index range scan на partial `(value, id)`-индексе: O(log N).
   *   - Никаких COUNT, OFFSET, sort'ов — только seek.
   *
   * Алгоритм:
   *   1. SELECT первого row где `id >= gen_random_uuid()` — попадает
   *      случайно в верхнюю часть диапазона.
   *   2. Если null (random uuid выше всех существующих id) —
   *      fallback с новым `gen_random_uuid()`. Редкий случай (~0.01%).
   *   3. Оба null — value-bucket пуст, return null.
   */
  private async pickCountAttackerByValue(
    value: number,
    excludeIds: string[],
    difficulty: number | null,
  ): Promise<{
    id: string;
    type: string;
    fen: string;
    difficulty: number;
    meta: unknown;
  } | null> {
    const conditions = [
      `type = 'count-attackers'`,
      `(answer->>'value')::int = $1`,
    ];
    const params: unknown[] = [value];
    if (difficulty !== null) {
      params.push(difficulty);
      conditions.push(`difficulty = $${params.length}`);
    }
    if (excludeIds.length > 0) {
      params.push(excludeIds);
      conditions.push(`NOT (id = ANY($${params.length}::uuid[]))`);
    }
    const whereSql = conditions.join(' AND ');

    // Try 1: id >= random uuid → ближайший выше-или-равный.
    const sqlForward =
      `SELECT id, type, fen, difficulty, meta FROM tactic_drills ` +
      `WHERE ${whereSql} AND id >= gen_random_uuid() ` +
      `ORDER BY id ASC LIMIT 1`;
    // Try 2 (fallback): id < random uuid → ближайший ниже.
    const sqlBackward =
      `SELECT id, type, fen, difficulty, meta FROM tactic_drills ` +
      `WHERE ${whereSql} AND id < gen_random_uuid() ` +
      `ORDER BY id DESC LIMIT 1`;

    type Row = {
      id: string;
      type: string;
      fen: string;
      difficulty: number;
      meta: unknown;
    };

    const tFwd0 = Date.now();
    const fwd = await this.prisma.$queryRawUnsafe<Row[]>(
      sqlForward,
      ...params,
    );
    const tFwd = Date.now() - tFwd0;
    if (fwd[0]) {
      // eslint-disable-next-line no-console
      console.log(
        `[drill-next] ca-pick value=${value} fwd=${tFwd}ms hit=fwd excludeIds=${excludeIds.length}`,
      );
      return fwd[0];
    }

    const tBwd0 = Date.now();
    const bwd = await this.prisma.$queryRawUnsafe<Row[]>(
      sqlBackward,
      ...params,
    );
    const tBwd = Date.now() - tBwd0;
    // eslint-disable-next-line no-console
    console.log(
      `[drill-next] ca-pick value=${value} fwd=${tFwd}ms bwd=${tBwd}ms hit=${bwd[0] ? 'bwd' : 'none'} excludeIds=${excludeIds.length}`,
    );
    return bwd[0] ?? null;
  }

  /**
   * POST /attempt. Сравнивает userAnswer с эталоном. Авторизованные —
   * пишут запись в `tactic_drill_attempts`; гости получают результат
   * без записи (api-contract §6).
   *
   * KS-2311: после записи попытки в drill mode вызываем
   * `TacticDrillRatingService.applyRatingChange` (если он внедрён в
   * сервис; sprint-flow вызывает submit отдельно и сам уведомляет
   * rating-сервис, см. KS-2311 §10.6 — sprint mode пропускается).
   */
  async recordAttempt(
    userId: string | null,
    drillId: string,
    userAnswer: AnswerData,
    timeMs: number,
    mode: 'drill' | 'sprint' | 'lessons-embed' = 'drill',
  ): Promise<TacticDrillAttemptResponse> {
    const drill = await this.prisma.tacticDrill.findUnique({
      where: { id: drillId },
      select: { id: true, answer: true },
    });
    if (!drill) throw new NotFoundException('drill not found');

    // KS-2246-fix: эталон из БД может быть в liberal-формате (от
    // author-seed chess-expert'а: `{shape:'square', value:'c6'}` или
    // `{shape:'squares[]', value:[...]}`). Нормализуем в канон перед
    // валидатором — иначе validator делает `expected.square.toLowerCase()`
    // на undefined → 500.
    const expected = normalizeStoredAnswer(drill.answer);
    if (!expected) {
      throw new InternalServerErrorException(
        `drill ${drillId} has malformed answer in DB (cannot normalize)`,
      );
    }
    const result = this.validator.validate(expected, userAnswer);

    let attemptId = `guest-${Date.now()}`;
    if (userId) {
      const created = await this.prisma.tacticDrillAttempt.create({
        data: {
          userId,
          drillId,
          correct: result.solved,
          timeMs,
          answerGiven: userAnswer as unknown as object,
        },
        select: { id: true },
      });
      attemptId = created.id;

      // KS-2311 (methodology §10.11): drill rating update — только
      // в drill mode, для авторизованных. Запись `ratingBefore/After/
      // Capped` сделается внутри сервиса. `rating` отсутствует — DI
      // не обязательно подключён в каждой сборке (например, в
      // мини-spec'ах без RedisService); мы вызываем через optional
      // setter ниже (`setRatingService` доступен в module wiring).
      if (this.ratingService) {
        await this.ratingService
          .applyRatingChange(userId, {
            drillId,
            attemptId,
            mode,
            solved: result.solved,
            metrics: result.metrics,
            userAnswer,
          })
          .catch(() => {
            // Rating-update не должен ломать attempt-flow: если упал
            // (Redis down, конкурентный update), attempt уже сохранён.
          });
      }
    }

    return {
      attemptId,
      solved: result.solved,
      // expected уже в каноне (после normalizeStoredAnswer выше) — frontend
      // получает консистентный shape (api-contract §3).
      correctAnswer: expected,
      ...(result.metrics ? { metrics: result.metrics } : {}),
    };
  }

  /**
   * GET /stats/me. Per-drill-type breakdown для UI lobby.
   * Только для авторизованных (controller проверяет JWT).
   */
  async getMyStats(userId: string): Promise<TacticDrillStatsResponse> {
    const attempts = await this.prisma.tacticDrillAttempt.findMany({
      where: { userId },
      select: {
        correct: true,
        timeMs: true,
        drill: { select: { type: true } },
      },
    });

    const byType = new Map<
      TacticDrillType,
      { attempts: number; solved: number; sumTime: number }
    >();
    for (const t of ALL_DRILL_TYPES) {
      byType.set(t, { attempts: 0, solved: 0, sumTime: 0 });
    }

    let total = 0;
    let totalSolved = 0;
    for (const a of attempts) {
      const t = a.drill.type as TacticDrillType;
      const acc = byType.get(t);
      if (!acc) continue;
      acc.attempts++;
      if (a.correct) {
        acc.solved++;
        acc.sumTime += a.timeMs;
      }
      total++;
      if (a.correct) totalSolved++;
    }

    const items: TacticDrillStatsItem[] = ALL_DRILL_TYPES.map((t) => {
      const v = byType.get(t)!;
      return {
        drillType: t,
        attempts: v.attempts,
        solved: v.solved,
        accuracy: v.attempts > 0 ? round2(v.solved / v.attempts) : 0,
        avgTimeMs: v.solved > 0 ? Math.round(v.sumTime / v.solved) : 0,
      };
    });

    const unlocked = items.filter((i) => i.solved > 0).map((i) => i.drillType);

    return {
      total: {
        attempts: total,
        solved: totalSolved,
        accuracy: total > 0 ? round2(totalSolved / total) : 0,
      },
      byType: items,
      unlocked,
    };
  }

  /**
   * KS-2315 (ADR-035 §11 / E6): резолвер для drill-step в lesson-player'е.
   *
   * Логика (см. ТЗ):
   *  1. Прочитать `LessonStep` по `stepId`. Не найден → 404.
   *  2. Проверить `payload.type === 'drill'` (иначе 400 — step есть, но
   *     это не drill-step).
   *  3. Если `payload.drillId` указан → отдать тот drill (404 если он
   *     удалён).
   *  4. Иначе random pick по `drillType` (+ опц. `difficultyBucket`).
   *  5. Если пул при заданном `bucket` пуст — fallback на любой drill
   *     этого `drillType`. Если и тогда пусто — 404.
   *
   * Cooldown 30 дней НЕ применяется (в lesson-context повторное
   * прохождение — это норма; рейтинг fading'ом по KS-2311 §10 не
   * растёт). KS-2433: фильтр `sfRejected=false` снят вместе с SF-валидацией.
   *
   * Возвращает `TacticDrillDto` без `answer` + `stepMeta` для FE-счётчика.
   */
  async pickDrillForLesson(stepId: string): Promise<TacticDrillByStepResponse> {
    const step = await this.prisma.lessonStep.findUnique({
      where: { id: stepId },
      select: { id: true, type: true, payload: true },
    });
    if (!step) {
      throw new NotFoundException(`lesson step not found: ${stepId}`);
    }
    if (step.type !== 'drill') {
      throw new BadRequestException(
        `lesson step ${stepId} is not a drill (type=${step.type})`,
      );
    }

    const payload = step.payload as unknown as DrillStepPayload;
    if (!payload || payload.type !== 'drill' || !payload.drillType) {
      throw new BadRequestException(
        `lesson step ${stepId} payload is malformed (expected DrillStepPayload)`,
      );
    }

    const drill = payload.drillId
      ? await this.fetchFixedDrillForLesson(payload.drillId, payload.drillType)
      : await this.pickRandomDrillForLesson(
          payload.drillType,
          payload.difficultyBucket,
        );

    if (!drill) {
      throw new NotFoundException(
        `no drill available for type=${payload.drillType}` +
          (payload.difficultyBucket
            ? ` bucket=${payload.difficultyBucket}`
            : ''),
      );
    }

    const count = payload.count ?? 1;
    const minSolved = payload.minSolved ?? count;

    return {
      drill: this.toDto(
        drill.id,
        drill.type as TacticDrillType,
        drill.fen,
        drill.difficulty,
        // KS-2250-fix: проброс meta для count-attackers и т.п.
        (drill as { meta?: unknown }).meta,
      ),
      stepMeta: {
        stepId,
        count,
        minSolved,
      },
    };
  }

  /**
   * Fixed-режим: драйл по UUID. Проверяем что он существует и совпадает
   * по типу с payload (защита от подмены — автор курса не должен
   * указывать `drillType: 'find-pin'` + drillId фигурной задачи).
   * При несовпадении возвращаем null → controller выдаёт 404.
   * KS-2433: проверка `sfRejected` снята вместе с SF-валидацией.
   */
  private async fetchFixedDrillForLesson(
    drillId: string,
    expectedType: TacticDrillType,
  ): Promise<{ id: string; type: string; fen: string; difficulty: number; meta?: unknown } | null> {
    const drill = await this.prisma.tacticDrill.findUnique({
      where: { id: drillId },
      select: { id: true, type: true, fen: true, difficulty: true, meta: true },
    });
    if (!drill) return null;
    if (drill.type !== expectedType) return null;
    return drill;
  }

  /**
   * Random-режим: bucket → diapason difficulty (1..5), затем
   * `ORDER BY random() LIMIT 1`. Если пул пуст при заданном bucket —
   * fallback на любой drill этого `drillType`. KS-2433: фильтр
   * `sfRejected=false` снят вместе с SF-валидацией.
   */
  private async pickRandomDrillForLesson(
    drillType: TacticDrillType,
    bucket: DrillDifficultyBucket | undefined,
  ): Promise<{ id: string; type: string; fen: string; difficulty: number; meta?: unknown } | null> {
    const baseWhere: Record<string, unknown> = { type: drillType };

    // 1. Сначала пробуем с фильтром по bucket (если задан).
    if (bucket) {
      const bucketDifficulties = DRILL_BUCKET_TO_DIFFICULTY[bucket];
      const where = {
        ...baseWhere,
        difficulty: { in: [...bucketDifficulties] },
      };
      const found = await this.pickRandomFromPool(where);
      if (found) return found;
    }

    // 2. Fallback — без bucket'а. (Также сюда попадаем если bucket не задан.)
    return this.pickRandomFromPool(baseWhere);
  }

  /** Random pick из пула: count + offset random. */
  private async pickRandomFromPool(
    where: Record<string, unknown>,
  ): Promise<{ id: string; type: string; fen: string; difficulty: number; meta?: unknown } | null> {
    const total = await this.prisma.tacticDrill.count({ where });
    if (total === 0) return null;
    const offset = Math.floor(Math.random() * total);
    const drill = await this.prisma.tacticDrill.findFirst({
      where,
      skip: offset,
      orderBy: { id: 'asc' },
      select: { id: true, type: true, fen: true, difficulty: true, meta: true },
    });
    return drill;
  }

  /**
   * Public — используется sprint-сервисом (KS-2240) и daily-сервисом
   * (KS-2250) для обёртки выбранного `tactic_drill`-row в DTO без
   * поля `answer`.
   *
   * KS-2250-fix: проброс `meta` (highlightedSquare / attackerColor /
   * expectedCount) из БД в DTO. Если `meta=null` в БД — поле в DTO не
   * включается. count-attackers требует highlightedSquare для
   * корректного UI рендера.
   */
  buildDto(
    id: string,
    type: TacticDrillType,
    fen: string,
    difficulty: number,
    meta?: unknown,
  ): TacticDrillDto {
    const sideToMove = inferSideToMove(type, fen);
    const dto: TacticDrillDto = {
      id,
      drillType: type,
      fen,
      sideToMove,
      answerShape: DRILL_TYPE_ANSWER_SHAPE[type],
      difficulty,
    };
    const m = sanitizeMeta(meta);
    if (m) dto.meta = m;
    return dto;
  }

  // ─── private ────────────────────────────────────────────────

  private toDto(
    id: string,
    type: TacticDrillType,
    fen: string,
    difficulty: number,
    meta?: unknown,
  ): TacticDrillDto {
    return this.buildDto(id, type, fen, difficulty, meta);
  }
}

/**
 * Нормализует `tactic_drills.meta` (JSONB) в shape `TacticDrillDto.meta`.
 * Принимает только whitelist'нутые поля; остальное игнорируется. Если
 * meta пустой/null/невалиден — возвращает null (DTO выходит без `meta`).
 *
 * KS-2369: добавлен `attackerColor` для count-attackers — frontend
 * показывает в вопросе и индикаторе цвет атакующих ('w'|'b').
 */
function sanitizeMeta(
  raw: unknown,
): {
  highlightedSquare?: string;
  attackerColor?: 'w' | 'b';
  expectedCount?: number;
  expectedMoves?: { from: string; to: string }[];
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: {
    highlightedSquare?: string;
    attackerColor?: 'w' | 'b';
    expectedCount?: number;
    expectedMoves?: { from: string; to: string }[];
  } = {};
  if (typeof r.highlightedSquare === 'string' && /^[a-h][1-8]$/.test(r.highlightedSquare)) {
    out.highlightedSquare = r.highlightedSquare;
  }
  if (r.attackerColor === 'w' || r.attackerColor === 'b') {
    out.attackerColor = r.attackerColor;
  }
  if (typeof r.expectedCount === 'number' && Number.isFinite(r.expectedCount)) {
    out.expectedCount = r.expectedCount;
  }
  // KS-2397: для find-all-checks — массив пар {from, to}. Фильтруем
  // строго: оба поля — корректные shorthand-клетки.
  if (Array.isArray(r.expectedMoves)) {
    const sqRe = /^[a-h][1-8]$/;
    const moves: { from: string; to: string }[] = [];
    for (const m of r.expectedMoves) {
      if (!m || typeof m !== 'object') continue;
      const mm = m as Record<string, unknown>;
      if (
        typeof mm.from === 'string' &&
        typeof mm.to === 'string' &&
        sqRe.test(mm.from) &&
        sqRe.test(mm.to)
      ) {
        moves.push({ from: mm.from, to: mm.to });
      }
    }
    if (moves.length > 0) out.expectedMoves = moves;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Drill'ы, у которых side-to-move не важна (api-contract §2):
 * `find-pin`, `find-loose-piece`, `count-attackers` → `null`.
 * Для остальных — берём из FEN.
 */
function inferSideToMove(type: TacticDrillType, fen: string): 'w' | 'b' | null {
  const noSide = new Set<TacticDrillType>([
    'find-pin',
    'find-loose-piece',
    'count-attackers',
  ]);
  if (noSide.has(type)) return null;
  const parts = fen.split(' ');
  if (parts.length >= 2 && (parts[1] === 'w' || parts[1] === 'b')) {
    return parts[1];
  }
  return null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
