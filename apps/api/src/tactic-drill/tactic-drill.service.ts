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
import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AnswerData,
  AnswerShape,
  TacticDrillAttemptResponse,
  TacticDrillDto,
  TacticDrillSkillLayer,
  TacticDrillStatsItem,
  TacticDrillStatsResponse,
  TacticDrillType,
} from '@kingside/shared';
import {
  DRILL_TYPE_ANSWER_SHAPE,
  DRILL_TYPE_LAYER,
  DRILL_TYPE_ORDER,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: TacticDrillValidatorService,
  ) {}

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
    const where: Record<string, unknown> = { type };
    if (difficulty !== undefined) {
      where.difficulty = difficulty;
    }
    if (userId) {
      const cooldownSince = new Date(
        Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
      );
      const recent = await this.prisma.tacticDrillAttempt.findMany({
        where: { userId, createdAt: { gte: cooldownSince } },
        select: { drillId: true },
        distinct: ['drillId'],
      });
      if (recent.length > 0) {
        where.id = { notIn: recent.map((r) => r.drillId) };
      }
    }

    // Простой LRU-сурогат: берём один drill, выбираем рандом через
    // skip/random offset. Полный «least-recently-shown» — KS-DRILL-INDEXER-INC.
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
        // `answer` — НЕ включаем (api-contract §7).
      },
    });
    if (!drill) return null;

    return this.toDto(
      drill.id,
      drill.type as TacticDrillType,
      drill.fen,
      drill.difficulty,
    );
  }

  /**
   * POST /attempt. Сравнивает userAnswer с эталоном. Авторизованные —
   * пишут запись в `tactic_drill_attempts`; гости получают результат
   * без записи (api-contract §6).
   */
  async recordAttempt(
    userId: string | null,
    drillId: string,
    userAnswer: AnswerData,
    timeMs: number,
  ): Promise<TacticDrillAttemptResponse> {
    const drill = await this.prisma.tacticDrill.findUnique({
      where: { id: drillId },
      select: { id: true, answer: true },
    });
    if (!drill) throw new NotFoundException('drill not found');

    const expected = drill.answer as unknown as AnswerData;
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
    }

    return {
      attemptId,
      solved: result.solved,
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
   * Public — используется sprint-сервисом (KS-2240) для обёртки
   * выбранного `tactic_drill`-row в DTO без поля `answer`.
   */
  buildDto(
    id: string,
    type: TacticDrillType,
    fen: string,
    difficulty: number,
  ): TacticDrillDto {
    const sideToMove = inferSideToMove(type, fen);
    return {
      id,
      drillType: type,
      fen,
      sideToMove,
      answerShape: DRILL_TYPE_ANSWER_SHAPE[type],
      difficulty,
    };
  }

  // ─── private ────────────────────────────────────────────────

  private toDto(
    id: string,
    type: TacticDrillType,
    fen: string,
    difficulty: number,
  ): TacticDrillDto {
    return this.buildDto(id, type, fen, difficulty);
  }
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
