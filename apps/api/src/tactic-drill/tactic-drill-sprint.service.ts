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
import { DRILL_TYPE_ORDER } from '@kingside/shared';

const SESSION_TTL_SEC = 600; // 10 мин (api-contract §5.5 410 Gone)
const ALL_DRILL_TYPES: TacticDrillType[] = DRILL_TYPE_ORDER;

interface SprintSessionAttempt {
  drillId: string;
  solved: boolean;
  timeMs: number;
  /** IoU только для squares-shape; null иначе. */
  iou: number | null;
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

    // Первый drill.
    const drill = await this.pickRandomDrill(types, []);
    if (!drill) {
      throw new NotFoundException('no drills available for selected types');
    }

    const sessionId = randomUUID();
    const state: SprintSessionState = {
      sessionId,
      userId,
      startedAt: Date.now(),
      durationMs: body.durationMs,
      types,
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
    if (!timedOut) {
      const picked = await this.pickRandomDrill(state.types, state.drillsServed);
      if (picked) {
        state.currentDrillId = picked.id;
        state.drillsServed.push(picked.id);
        next = picked.dto;
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
      return { attempt: attemptResp, next: null, final };
    }

    // Продолжаем.
    await this.persistSession(state);
    return { attempt: attemptResp, next };
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

  private buildModeLabel(
    durationMs: number,
    types: TacticDrillType[],
  ): string {
    const minutes = Math.round(durationMs / 60000);
    if (types.length === ALL_DRILL_TYPES.length) {
      return `${minutes}min-mixed`;
    }
    if (types.length === 1) {
      // Например `5min-find-fork-only` — для аналитики «sprint только
      // по конкретному типу».
      return `${minutes}min-${types[0]}-only`;
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

    return { scoreId: row.id, score, accuracy, avgPrecision };
  }

  private async pickRandomDrill(
    types: TacticDrillType[],
    excludeIds: string[],
  ): Promise<{ id: string; dto: TacticDrillDto } | null> {
    // Random pick by offset из пула типов. Простейший подход; в KS-2229
    // (KS-DRILL-INDEXER-INC) появится «least-recently-shown» курсор.
    // KS-2247: sf-rejected drill'ы тоже исключаем из sprint-пула.
    const where: Record<string, unknown> = {
      type: { in: types },
      sfRejected: false,
    };
    if (excludeIds.length > 0) {
      where.id = { notIn: excludeIds };
    }
    const total = await this.prisma.tacticDrill.count({ where });
    if (total === 0) return null;
    const offset = Math.floor(Math.random() * total);
    const drill = await this.prisma.tacticDrill.findFirst({
      where,
      skip: offset,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        type: true,
        fen: true,
        difficulty: true,
        // KS-2250-fix: meta для count-attackers (highlightedSquare).
        meta: true,
      },
    });
    if (!drill) return null;
    const dto = this.drillService.buildDto(
      drill.id,
      drill.type as TacticDrillType,
      drill.fen,
      drill.difficulty,
      drill.meta,
    );
    return { id: drill.id, dto };
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
