/**
 * KS-2240 (ADR-035 §5.5, §6.2 / api-contract §5.4-5.6, Drills E4).
 *
 * Sprint mode: 3-/5-минутный микс задач из выбранных drill-типов.
 *
 * Хранение **состояния сессии** — в Redis (TTL 10 мин ≥ max
 * durationMs+grace). БД пишется только при финале (одна запись в
 * `tactic_drill_sprint_scores`). Это даёт:
 *   - быстрый «следующий drill» без round-trip к БД на каждом ответе;
 *   - автоматический cleanup сессий, по которым клиент пропал.
 *
 * Контракты — api-contract §5:
 *   - POST /sprint/start  → `{ sessionId, drill, startedAt, durationMs }`
 *   - POST /sprint/submit → `{ attempt, next, final? }` (next=null когда
 *     сессия завершилась — по таймауту или вручную через /finish).
 *   - POST /sprint/finish → принудительно завершает сессию, сохраняет
 *     score в БД, возвращает summary.
 *   - GET  /sprint/leaderboard?mode=...&limit=...  — top-N.
 *
 * Уникальность активной сессии: один пользователь = одна активная
 * сессия. На /start с уже активной — 409 (api-contract §5.4) либо
 * `?force=true` для перезапуска.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TacticDrillService } from './tactic-drill.service';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';
import { normalizeStoredAnswer } from './dto/answer.dto';
import type {
  AnswerData,
  TacticDrillAttemptResponse,
  TacticDrillDto,
  TacticDrillSprintScoreItem,
  TacticDrillType,
} from '@kingside/shared';
import { DRILL_TYPE_LAYER, DRILL_TYPE_ORDER } from '@kingside/shared';
import type { TacticDrillSkillLayer } from '@kingside/shared';

const SESSION_TTL_SEC = 600; // 10 мин (api-contract §5.5 410 Gone)
const ALL_DRILL_TYPES: TacticDrillType[] = DRILL_TYPE_ORDER;

interface SprintSessionAttempt {
  drillId: string;
  solved: boolean;
  timeMs: number;
  /** IoU только для squares-shape; null иначе. */
  iou: number | null;
}

/** KS-2427: общая форма результата keyset-pick'а из tactic_drills. */
interface PickRow {
  id: string;
  type: string;
  fen: string;
  difficulty: number;
  meta: unknown;
}

interface SprintSessionState {
  sessionId: string;
  userId: string;
  startedAt: number; // unix-ms
  durationMs: number;
  /** Подмножество drill-типов; пустой массив = все 8. */
  types: TacticDrillType[];
  modeLabel: string;
  /** drillId, выданный пользователю, но ещё не отвеченный. */
  currentDrillId: string | null;
  /** Уже отданные drill (служебная для no-repeat внутри сессии). */
  drillsServed: string[];
  attempts: SprintSessionAttempt[];
}

export interface SprintStartResult {
  sessionId: string;
  drill: TacticDrillDto;
  startedAt: string; // ISO
  durationMs: number;
}

export interface SprintSubmitResult {
  attempt: TacticDrillAttemptResponse;
  next: TacticDrillDto | null;
  final?: {
    scoreId: string;
    score: number;
    accuracy: number;
    avgPrecision: number;
  };
}

/**
 * KS-2352: ответ `GET /sprint/active`. Совместим со `SprintStartResult`
 * (sessionId/drill/startedAt/durationMs) — фронт может «продолжить»
 * сессию тем же flow, что после `/sprint/start`. Дополнительно
 * `remainingMs`/`modeLabel`/`attemptsCount` для UI-счётчиков.
 */
export interface SprintActiveResult {
  sessionId: string;
  drill: TacticDrillDto;
  startedAt: string;
  durationMs: number;
  remainingMs: number;
  modeLabel: string;
  attemptsCount: number;
}

@Injectable()
export class TacticDrillSprintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly drillService: TacticDrillService,
    private readonly validator: TacticDrillValidatorService,
  ) {}

  // ─── start ────────────────────────────────────────────────

  async start(
    userId: string,
    body: {
      durationMs: 180000 | 300000;
      types: TacticDrillType[];
      force?: boolean;
    },
  ): Promise<SprintStartResult> {
    if (body.durationMs !== 180000 && body.durationMs !== 300000) {
      throw new BadRequestException('durationMs must be 180000 or 300000');
    }
    const types = this.normalizeTypes(body.types);

    // Активная сессия?
    const activeKey = this.activeKey(userId);
    const existing = await this.redis.get(activeKey);
    if (existing && !body.force) {
      throw new ConflictException({
        message: 'sprint session already active',
        sessionId: existing,
      });
    }
    if (existing && body.force) {
      // снимаем старую (BD-запись финализируется, чтобы не оставить
      // полу-сессий, но score пишем по факту попыток).
      await this.forceFinish(userId, existing).catch(() => {});
    }

    // KS-2424: shuffle списка типов на старте — round-robin потом
    // идёт в случайном порядке, чтобы первые drill'ы шли вперемешку
    // по типам, а не блоками по одному типу. Подробности — JSDoc
    // `pickRandomDrill`.
    const shuffledTypes = this.shuffleTypes(types);

    // Первый drill — pickIndex=0 в round-robin'е.
    const drill = await this.pickRandomDrill(shuffledTypes, 0, []);
    if (!drill) {
      throw new NotFoundException('no drills available for selected types');
    }

    const sessionId = randomUUID();
    const state: SprintSessionState = {
      sessionId,
      userId,
      startedAt: Date.now(),
      durationMs: body.durationMs,
      types: shuffledTypes,
      modeLabel: this.buildModeLabel(body.durationMs, types),
      currentDrillId: drill.id,
      drillsServed: [drill.id],
      attempts: [],
    };
    const ttl = Math.ceil(body.durationMs / 1000) + 60;
    await this.redis.set(
      this.sessionKey(sessionId),
      JSON.stringify(state),
      'EX',
      ttl,
    );
    await this.redis.set(activeKey, sessionId, 'EX', ttl);

    // KS-2380: прод-диагностика. Mode-label рассинхрон с фронтом — частый
    // источник пустых лидербордов; лог даёт прямой ответ «какой mode
    // записан под какие types».
    // eslint-disable-next-line no-console
    console.log(
      `[sprint-start] user=${userId} sessionId=${sessionId} types=${types.length}/${ALL_DRILL_TYPES.length} modeLabel=${state.modeLabel} durationMs=${body.durationMs}`,
    );

    return {
      sessionId,
      drill: drill.dto,
      startedAt: new Date(state.startedAt).toISOString(),
      durationMs: body.durationMs,
    };
  }

  // ─── submit ────────────────────────────────────────────────

  async submit(
    userId: string,
    body: {
      sessionId: string;
      drillId: string;
      userAnswer: AnswerData;
      timeMs: number;
    },
  ): Promise<SprintSubmitResult> {
    // KS-2427: total-time instrumentation для диагностики жалоб на
    // «медленное переключение». Лог в конце submit'а — суммарное время
    // endpoint'а от entry до return.
    const submitT0 = Date.now();
    const state = await this.loadSessionOrThrow(userId, body.sessionId);

    if (state.currentDrillId !== body.drillId) {
      throw new BadRequestException(
        `drillId mismatch: session expects ${state.currentDrillId}, got ${body.drillId}`,
      );
    }

    // Валидация ответа против эталона.
    const drillRow = await this.prisma.tacticDrill.findUnique({
      where: { id: body.drillId },
      select: { id: true, answer: true },
    });
    if (!drillRow) throw new NotFoundException('drill not found');
    // KS-2246-fix: эталон в БД может быть в liberal-формате (author-seed) —
    // нормализуем перед validator'ом, иначе runtime undefined.toLowerCase().
    const expected = normalizeStoredAnswer(drillRow.answer);
    if (!expected) {
      throw new InternalServerErrorException(
        `drill ${body.drillId} has malformed answer in DB (cannot normalize)`,
      );
    }
    const result = this.validator.validate(expected, body.userAnswer);

    state.attempts.push({
      drillId: body.drillId,
      solved: result.solved,
      timeMs: body.timeMs,
      iou: result.metrics?.iou ?? null,
    });
    state.currentDrillId = null;

    const elapsed = Date.now() - state.startedAt;
    const timedOut = elapsed >= state.durationMs;

    let next: TacticDrillDto | null = null;
    let pickSqlCount = 0;
    let pickFallback = false;
    let pickMs = 0;
    if (!timedOut) {
      // KS-2424: pickIndex в round-robin'е — это длина уже выданных
      // drill'ов (для следующего pick). На начале нового цикла
      // (`pickIndex % len === 0`) перемешиваем types, чтобы цикл
      // шёл в новом порядке. На старте цикл #0 уже перемешан в
      // `start()`.
      const pickIndex = state.drillsServed.length;
      if (pickIndex > 0 && pickIndex % state.types.length === 0) {
        state.types = this.shuffleTypes(state.types);
      }
      const tPickStart = Date.now();
      const picked = await this.pickRandomDrill(
        state.types,
        pickIndex,
        state.drillsServed,
      );
      pickMs = Date.now() - tPickStart;
      if (picked) {
        state.currentDrillId = picked.id;
        state.drillsServed.push(picked.id);
        next = picked.dto;
        pickSqlCount = picked.sqlCount;
        pickFallback = picked.fallbackUsed;
      }
    }

    const attemptResp: TacticDrillAttemptResponse = {
      // attemptId — синтезируем; в Redis-сессии нет UUID для каждого
      // ответа (БД-запись пишем только в финале, см. ниже).
      attemptId: `sprint-${state.sessionId}-${state.attempts.length}`,
      solved: result.solved,
      correctAnswer: expected,
      ...(result.metrics ? { metrics: result.metrics } : {}),
    };

    if (next === null) {
      // Финал.
      const final = await this.finalize(state);
      await this.deleteSession(state);
      const totalMs = Date.now() - submitT0;
      // eslint-disable-next-line no-console
      console.log(
        `[sprint-submit] user=${userId} sessionId=${state.sessionId} totalMs=${totalMs} pickMs=${pickMs} pickSql=${pickSqlCount} fallback=${pickFallback} timedOut=${timedOut} final=true`,
      );
      return { attempt: attemptResp, next: null, final };
    }

    // Продолжаем.
    await this.persistSession(state);
    const totalMs = Date.now() - submitT0;
    // KS-2427: суммарное время submit и SQL-статистика по pick'у —
    // для диагностики жалоб «переключение стало медленнее».
    // eslint-disable-next-line no-console
    console.log(
      `[sprint-submit] user=${userId} sessionId=${state.sessionId} totalMs=${totalMs} pickMs=${pickMs} pickSql=${pickSqlCount} fallback=${pickFallback}`,
    );
    return { attempt: attemptResp, next };
  }

  // ─── active (KS-2352) ─────────────────────────────────────

  /**
   * KS-2352: возвращает текущую активную sprint-сессию пользователя
   * или `null` если её нет / истекла. Используется фронтом в conflict-
   * flow (KS-2350) для «продолжить» после 409 на `/sprint/start`.
   *
   * Чтение state идемпотентное; если active-маркер указывает на
   * sessionId, у которого state-key уже истёк — чистим маркер,
   * чтобы следующий `/sprint/start` не падал в 409.
   */
  async getActiveSession(userId: string): Promise<SprintActiveResult | null> {
    const sessionId = await this.redis.get(this.activeKey(userId));
    if (!sessionId) return null;
    const raw = await this.redis.get(this.sessionKey(sessionId));
    if (!raw) {
      // active-маркер пережил state — cleanup, чтобы не блокировать новый старт.
      await this.redis.del(this.activeKey(userId));
      return null;
    }
    let state: SprintSessionState;
    try {
      state = JSON.parse(raw) as SprintSessionState;
    } catch {
      await this.redis.del(this.activeKey(userId));
      await this.redis.del(this.sessionKey(sessionId));
      return null;
    }
    if (state.userId !== userId) return null;
    if (!state.currentDrillId) return null;

    const drillRow = await this.prisma.tacticDrill.findUnique({
      where: { id: state.currentDrillId },
      select: {
        id: true,
        type: true,
        fen: true,
        difficulty: true,
        meta: true,
      },
    });
    if (!drillRow) return null;
    const dto = this.drillService.buildDto(
      drillRow.id,
      drillRow.type as TacticDrillType,
      drillRow.fen,
      drillRow.difficulty,
      drillRow.meta,
    );

    const elapsed = Date.now() - state.startedAt;
    const remainingMs = Math.max(state.durationMs - elapsed, 0);

    return {
      sessionId: state.sessionId,
      drill: dto,
      startedAt: new Date(state.startedAt).toISOString(),
      durationMs: state.durationMs,
      remainingMs,
      modeLabel: state.modeLabel,
      attemptsCount: state.attempts.length,
    };
  }

  // ─── finish (manual) ───────────────────────────────────────

  async finishManual(
    userId: string,
    sessionId: string,
  ): Promise<{ scoreId: string; score: number; accuracy: number; avgPrecision: number }> {
    const state = await this.loadSessionOrThrow(userId, sessionId);
    const final = await this.finalize(state);
    await this.deleteSession(state);
    return final;
  }

  // ─── leaderboard ───────────────────────────────────────────

  async leaderboard(
    mode: string,
    limit = 100,
  ): Promise<{ mode: string; entries: TacticDrillSprintScoreItem[] }> {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = await this.prisma.tacticDrillSprintScore.findMany({
      where: { mode },
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
      take: safeLimit,
      select: {
        userId: true,
        score: true,
        accuracy: true,
        mode: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });
    const entries: TacticDrillSprintScoreItem[] = rows.map((r) => ({
      userId: r.userId,
      username: r.user?.username ?? 'unknown',
      mode: r.mode,
      score: r.score,
      accuracy: r.accuracy,
      createdAt: r.createdAt.toISOString(),
    }));
    return { mode, entries };
  }

  // ─── auto-finalize (KS-2380) ───────────────────────────────

  /**
   * KS-2380. Жалоба: пользователь прошёл sprint, но в лидерборде пусто.
   *
   * Корневая причина — финал сессии завязан на последний `/sprint/submit`
   * либо явный `/sprint/finish`. Если пользователь после истечения
   * таймера не отправил submit (закрыл вкладку, потерял фокус, перешёл
   * сразу на страницу лидерборда и т.д.) и фронт не вызвал `/finish`,
   * сессия в Redis висит до TTL (durationMs+60s) и затем тихо удаляется
   * Redis'ом — БД-записи не появляется.
   *
   * Решение: scheduler (см. `tactic-drill-sprint.scheduler.ts`) раз в
   * минуту вызывает этот метод. Он сканирует `drill-sprint:session:*`,
   * для каждой timedOut-сессии (`elapsed >= durationMs + grace`)
   * атомарно удаляет state-key (`redis.del` возвращает 1 только
   * первому, поэтому гонка с параллельным `submit`/`finish` исключена)
   * и финализирует state в БД, если были попытки.
   *
   * Сессии без attempts (пустые) — просто удаляются: пустую запись
   * в лидерборд писать смысла нет.
   *
   * Возвращает {scanned, finalized, skipped} для прод-логирования.
   */
  async autoFinalizeExpiredSessions(): Promise<{
    scanned: number;
    finalized: number;
    skipped: number;
  }> {
    const grace = 5_000; // запас, чтобы не конкурировать с обычным submit'ом
    const now = Date.now();
    const keys = await this.redis.keys?.('drill-sprint:session:*');
    if (!keys || keys.length === 0) {
      return { scanned: 0, finalized: 0, skipped: 0 };
    }

    let finalized = 0;
    let skipped = 0;
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) {
        skipped++;
        continue;
      }
      let state: SprintSessionState;
      try {
        state = JSON.parse(raw) as SprintSessionState;
      } catch {
        // Сломанный JSON — чистим и идём дальше.
        await this.redis.del(key);
        skipped++;
        continue;
      }
      const elapsed = now - state.startedAt;
      if (elapsed < state.durationMs + grace) {
        // Ещё работает — ничего не делаем.
        skipped++;
        continue;
      }
      // Atomic guard: только один процесс/тик заберёт сессию.
      const removed = await this.redis.del(key);
      if (removed === 0) {
        skipped++;
        continue;
      }
      try {
        if (state.attempts.length > 0) {
          await this.finalize(state);
          finalized++;
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[sprint-auto-finalize] user=${state.userId} sessionId=${state.sessionId} skipped=empty-attempts`,
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[sprint-auto-finalize] user=${state.userId} sessionId=${state.sessionId} error=`,
          e,
        );
      }
      // Чистим active-маркер только если он указывает на эту же сессию.
      const active = await this.redis.get(this.activeKey(state.userId));
      if (active === state.sessionId) {
        await this.redis.del(this.activeKey(state.userId));
      }
    }

    return { scanned: keys.length, finalized, skipped };
  }

  // ─── private ───────────────────────────────────────────────

  private sessionKey(sessionId: string): string {
    return `drill-sprint:session:${sessionId}`;
  }

  private activeKey(userId: string): string {
    return `drill-sprint:active:${userId}`;
  }

  private normalizeTypes(types: TacticDrillType[]): TacticDrillType[] {
    if (!types || types.length === 0) return [...ALL_DRILL_TYPES];
    const set = new Set<TacticDrillType>();
    for (const t of types) {
      if (ALL_DRILL_TYPES.includes(t)) set.add(t);
    }
    if (set.size === 0) {
      throw new BadRequestException('types: empty after filtering');
    }
    return Array.from(set);
  }

  /**
   * KS-2334. Раньше формат был `${min}min-${type}-only` для одиночного
   * типа и `${min}min-custom` для произвольного подмножества — фронт
   * (`DrillLeaderboardPage.tsx`) запрашивает `${min}min-${set}` где
   * `set ∈ {mixed, overview, pattern, calculation}` (taксономия по
   * `DRILL_TYPE_LAYER`). Из-за рассинхрона leaderboard всегда был
   * пустым, кроме фильтра «все 8 типов» при честном микс-спринте.
   *
   * Новая таксономия (синхрон с фронтом):
   *   - все 8 типов → `${min}min-mixed`
   *   - types ⊆ одного слоя L (overview/pattern/calculation) →
   *     `${min}min-${L}`. Один тип также попадает в свой слой
   *     (find-loose-piece → overview).
   *   - иначе (микс из >1 слоя, не все 8) → `${min}min-custom`
   */
  private buildModeLabel(
    durationMs: number,
    types: TacticDrillType[],
  ): string {
    const minutes = Math.round(durationMs / 60000);
    if (types.length === ALL_DRILL_TYPES.length) {
      return `${minutes}min-mixed`;
    }
    const layers = new Set<TacticDrillSkillLayer>();
    for (const t of types) {
      layers.add(DRILL_TYPE_LAYER[t]);
    }
    if (layers.size === 1) {
      const [layer] = Array.from(layers);
      return `${minutes}min-${layer}`;
    }
    return `${minutes}min-custom`;
  }

  private async loadSessionOrThrow(
    userId: string,
    sessionId: string,
  ): Promise<SprintSessionState> {
    const raw = await this.redis.get(this.sessionKey(sessionId));
    if (!raw) {
      throw new NotFoundException({
        message: 'sprint session expired or not found',
        sessionId,
      });
    }
    const state = JSON.parse(raw) as SprintSessionState;
    if (state.userId !== userId) {
      throw new NotFoundException('sprint session expired or not found');
    }
    return state;
  }

  private async persistSession(state: SprintSessionState): Promise<void> {
    const remaining = state.durationMs - (Date.now() - state.startedAt);
    const ttl = Math.max(Math.ceil(remaining / 1000) + 60, 60);
    await this.redis.set(
      this.sessionKey(state.sessionId),
      JSON.stringify(state),
      'EX',
      ttl,
    );
    await this.redis.set(this.activeKey(state.userId), state.sessionId, 'EX', ttl);
  }

  private async deleteSession(state: SprintSessionState): Promise<void> {
    await this.redis.del(this.sessionKey(state.sessionId));
    // active-маркер — чистим только если он указывает на эту же сессию
    // (на случай, если параллельный force-restart уже его перезаписал).
    const active = await this.redis.get(this.activeKey(state.userId));
    if (active === state.sessionId) {
      await this.redis.del(this.activeKey(state.userId));
    }
  }

  private async finalize(state: SprintSessionState): Promise<{
    scoreId: string;
    score: number;
    accuracy: number;
    avgPrecision: number;
  }> {
    const score = state.attempts.filter((a) => a.solved).length;
    const total = state.attempts.length;
    const accuracy = total > 0 ? Math.round((score / total) * 100) / 100 : 0;
    const iouAttempts = state.attempts.filter((a) => a.iou !== null);
    const avgPrecision =
      iouAttempts.length > 0
        ? Math.round(
            (iouAttempts.reduce((s, a) => s + (a.iou ?? 0), 0) /
              iouAttempts.length) *
              100,
          ) / 100
        : 0;

    const row = await this.prisma.tacticDrillSprintScore.create({
      data: {
        userId: state.userId,
        score,
        drillsCount: total,
        accuracy,
        mode: state.modeLabel,
      },
      select: { id: true },
    });

    // KS-2380: симметричный лог финала под `[sprint-start]`. По двум
    // строкам в проде однозначно видно: записалось ли в БД, какой mode,
    // какой score; чем закрыт цикл — submit'ом или scheduler'ом
    // (см. `autoFinalizeExpiredSessions`).
    // eslint-disable-next-line no-console
    console.log(
      `[sprint-final] user=${state.userId} sessionId=${state.sessionId} mode=${state.modeLabel} attempts=${total} score=${score} accuracy=${accuracy} scoreId=${row.id}`,
    );

    return { scoreId: row.id, score, accuracy, avgPrecision };
  }

  /**
   * KS-2424 / KS-2427: round-robin по типам в стратифицированном порядке.
   *
   * KS-2424: до фикса при mixed-sprint'е (несколько типов) каждый pick
   * делал `type = ANY(types)` по полному пулу. Из-за того что пул сильно
   * неравномерен по типам (find-loose-piece — 181k, find-fork — ≤1k
   * после safety-фильтров KS-2406/2408/2419), случайный UUID-seed чаще
   * приводил к «массовому» типу: пользователь видел первые 5-7 drill'ов
   * одного типа подряд.
   *
   * Round-robin лечит это: на pick #k берём `typesRotation[k % len]`
   * и делаем keyset-random ТОЛЬКО по этому типу. Цикл из всех типов
   * перемешивается — `start()` инициализирует state.types через
   * `shuffleTypes()`, `submit()` re-shuffle'ит при достижении границы
   * цикла.
   *
   * KS-2427 — оптимизация SQL count для регрессии на проде:
   *   - До: primary fwd → primary bwd → fallback fwd → fallback bwd
   *     (worst case 4 SQL).
   *   - После: primary fwd → fallback fwd → fallback bwd
   *     (worst case 3 SQL). Primary bwd убран — если single-type forward
   *     вернул null (random_uuid выше всех id типа), сразу идём на
   *     fallback (others), который перекроет любой одиночный пробел.
   *   - Normal case остаётся 1 SQL.
   *   - Возвращаем `sqlCount` и `fallbackUsed` — submit логирует
   *     суммарную статистику (`[sprint-pick-stats]`).
   *
   * Keyset-random алгоритм идентичен `TacticDrillService.pickRandomByKeyset`
   * (KS-2370/2371/2378): UUID v4 равномерно распределён, индекс
   * `tactic_drills_type_sf_rejected_id_idx` (KS-2355) поддерживает
   * range scan O(log N).
   *
   * KS-2247: sf-rejected drill'ы исключаем.
   * KS-2229: drill'ы из текущей сессии (excludeIds) — no-repeat.
   */
  private async pickRandomDrill(
    typesRotation: TacticDrillType[],
    pickIndex: number,
    excludeIds: string[],
  ): Promise<{
    id: string;
    dto: TacticDrillDto;
    sqlCount: number;
    fallbackUsed: boolean;
  } | null> {
    const primaryType =
      typesRotation[pickIndex % typesRotation.length];

    // KS-2429: для count-attackers перед pick'ом случайно выбираем
    // target value ∈ {1,2,3,4} равновероятно. Без этого распределение
    // ответов перекошено в сторону value=1 (~72% банка) — пользователь
    // видел 9/10 спринт-вопросов с ответом «1». Раньше балансировка
    // была только в `TacticDrillService.pickBalancedCountAttackers`
    // (lesson-flow / non-sprint), но не в sprint pickRandomDrill.
    let primarySqlCount = 0;
    if (primaryType === 'count-attackers') {
      const targetValue = 1 + Math.floor(Math.random() * 4);
      const balanced = await this.pickRandomDrillForTypes(
        [primaryType],
        excludeIds,
        'primary',
        false,
        targetValue,
      );
      primarySqlCount += balanced.sqlCount;
      if (balanced.row) {
        return {
          id: balanced.row.id,
          dto: balanced.dto!,
          sqlCount: primarySqlCount,
          fallbackUsed: false,
        };
      }
      // Fallback ВНУТРИ count-attackers: target value пуст в этом
      // sprint'е (excludeIds покрыли) — пробуем без value-фильтра.
      const bare = await this.pickRandomDrillForTypes(
        [primaryType],
        excludeIds,
        'primary',
        false,
      );
      primarySqlCount += bare.sqlCount;
      if (bare.row) {
        return {
          id: bare.row.id,
          dto: bare.dto!,
          sqlCount: primarySqlCount,
          fallbackUsed: false,
        };
      }
      // Иначе fallback на others-types (как обычно).
    } else {
      const primary = await this.pickRandomDrillForTypes(
        [primaryType],
        excludeIds,
        'primary',
        false,
      );
      primarySqlCount += primary.sqlCount;
      if (primary.row) {
        return {
          id: primary.row.id,
          dto: primary.dto!,
          sqlCount: primarySqlCount,
          fallbackUsed: false,
        };
      }
    }

    // Fallback: примерно "до KS-2424"-поведение — все типы (кроме
    // primary), forward + backward. Не должно срабатывать в норме;
    // нужен на случай, когда `id >= random_uuid()` для primary-типа
    // ушёл за хвост индекса (вероятность ~1/N, для N=994 это 0.1%).
    if (typesRotation.length > 1) {
      const others = typesRotation.filter((t) => t !== primaryType);
      const fallback = await this.pickRandomDrillForTypes(
        others,
        excludeIds,
        'fallback',
        true,
      );
      if (fallback.row) {
        return {
          id: fallback.row.id,
          dto: fallback.dto!,
          sqlCount: primarySqlCount + fallback.sqlCount,
          fallbackUsed: true,
        };
      }
      return null; // оба исчерпаны — sprint исчерпал пул, отдадим null
    }
    return null;
  }

  private async pickRandomDrillForTypes(
    types: TacticDrillType[],
    excludeIds: string[],
    phase: 'primary' | 'fallback',
    allowBackward: boolean,
    /**
     * KS-2429: для count-attackers — точное значение `answer.value`
     * (1..4). При указании к WHERE добавляется
     * `(answer->>'value')::int = $value`. Использует partial-индекс
     * `tactic_drills_ca_value_idx` (миграция 20260504130000) для O(log N)
     * seek по value+id. Игнорируется для других типов.
     */
    valueFilter?: number,
  ): Promise<{
    row: PickRow | null;
    dto: TacticDrillDto | null;
    sqlCount: number;
  }> {
    const conditions = ['type = ANY($1::text[])', 'sf_rejected = false'];
    const params: unknown[] = [types];
    if (typeof valueFilter === 'number') {
      params.push(valueFilter);
      conditions.push(`(answer->>'value')::int = $${params.length}`);
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

    let sqlCount = 0;
    const tFwd0 = Date.now();
    const fwd = await this.prisma.$queryRawUnsafe<PickRow[]>(
      sqlForward,
      ...params,
    );
    sqlCount += 1;
    const tFwd = Date.now() - tFwd0;
    let row: PickRow | undefined = fwd[0];
    let tBwd = 0;
    let hit: 'fwd' | 'bwd' | 'none' = fwd[0] ? 'fwd' : 'none';
    if (!row && allowBackward) {
      const tBwd0 = Date.now();
      const bwd = await this.prisma.$queryRawUnsafe<PickRow[]>(
        sqlBackward,
        ...params,
      );
      sqlCount += 1;
      tBwd = Date.now() - tBwd0;
      row = bwd[0];
      hit = bwd[0] ? 'bwd' : 'none';
    }
    // eslint-disable-next-line no-console
    console.log(
      `[sprint-pick] phase=${phase} types=${types.length} value=${valueFilter ?? '-'} excludeIds=${excludeIds.length} fwd=${tFwd}ms bwd=${tBwd}ms hit=${hit} sql=${sqlCount}`,
    );
    if (!row) return { row: null, dto: null, sqlCount };
    // KS-2250-fix: meta для count-attackers (highlightedSquare) проброс
    // в DTO через `drillService.buildDto`.
    const dto = this.drillService.buildDto(
      row.id,
      row.type as TacticDrillType,
      row.fen,
      row.difficulty,
      row.meta,
    );
    return { row, dto, sqlCount };
  }

  /**
   * KS-2424: Fisher-Yates перемешивание массива типов. Возвращает
   * новый массив, не мутирует исходный. Math.random — ок, нам не
   * нужна криптостойкость.
   */
  private shuffleTypes(types: TacticDrillType[]): TacticDrillType[] {
    const out = [...types];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private async forceFinish(userId: string, sessionId: string): Promise<void> {
    const raw = await this.redis.get(this.sessionKey(sessionId));
    if (!raw) {
      // Старая сессия уже истекла — просто чистим active-маркер.
      const active = await this.redis.get(this.activeKey(userId));
      if (active === sessionId) {
        await this.redis.del(this.activeKey(userId));
      }
      return;
    }
    const state = JSON.parse(raw) as SprintSessionState;
    if (state.attempts.length > 0) {
      await this.finalize(state).catch(() => {});
    }
    await this.deleteSession(state);
  }
}
