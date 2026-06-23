/**
 * KS-2250 (ADR-035 §11 / E6). Резолвер daily-drill для Telegram-рассылки
 * и /drills/daily-страницы. Один drill на дату — единый для всей
 * аудитории, бронируется в `daily_tactic_drills` (date PK).
 *
 * Логика выбора (см. /tmp/KS-2250/api-contract.md):
 *  1. Если на дату уже забронирован drill (запись в `daily_tactic_drills`)
 *     — возвращаем его (детерминизм).
 *  2. Иначе подбираем по правилам:
 *     - difficulty по дню недели (DAILY_DRILL_DIFFICULTY_BY_WEEKDAY).
 *     - drill.type — round-robin / random из 8, исключая использованные
 *       в окне 14 дней.
 *     - В рамках выбранной (type × difficulty) — random pick из пула,
 *       исключая ранее использованные drill_id (за всё время —
 *       чтобы не повторять одну позицию даже спустя год).
 *  3. Fallback chain:
 *     a. Тот же type, соседний bucket (medium → hard / easy).
 *     b. Drill этого type, использованный >14 дней назад с минимальным
 *        числом показов → `isRepeat=true`, `originalDate`.
 *     c. Round-robin к следующему type в `DRILL_TYPE_ORDER`.
 *     d. 404 если все 8 типов исчерпаны.
 *
 * Cooldown 30 дней (как в /next) НЕ применяется — daily-drill-history
 * сама по себе exclusion-механизм.
 *
 * Защита эталона (api-contract §7): возвращаем без `answer`.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DAILY_DRILL_DIFFICULTY_BY_WEEKDAY,
  DRILL_BUCKET_TO_DIFFICULTY,
  DRILL_DIFFICULTY_LABEL,
  DRILL_HINT,
  DRILL_INSTRUCTION,
  DRILL_TYPE_LABEL,
  DRILL_TYPE_ORDER,
  type DailyTacticDrillResponse,
  type DrillDifficultyBucket,
  type TacticDrillDto,
  type TacticDrillType,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TacticDrillService } from './tactic-drill.service';

export type Locale = 'ru' | 'en';

/** Окно «нет повтора по типу» (api-contract §Тематическое чередование). */
const NO_REPEAT_TYPE_WINDOW_DAYS = 14;

/** Базовый URL сайта для siteUrl (siteUrl бот сам добавит UTM). */
const DEFAULT_SITE_BASE = 'https://kingside.app';

@Injectable()
export class DailyTacticDrillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drillService: TacticDrillService,
  ) {}

  /**
   * Главный entrypoint — возвращает готовый response для контроллера.
   * Lazy-fill: при первом обращении на дату создаёт запись в
   * `daily_tactic_drills`. Повторный вызов отдаёт ту же запись.
   */
  async getDaily(
    date: Date,
    locale: Locale,
  ): Promise<DailyTacticDrillResponse> {
    const dateOnly = toDateOnly(date);

    // 1. Если уже забронирован — отдаём.
    const existing = await this.prisma.dailyTacticDrill.findUnique({
      where: { date: dateOnly },
      include: { drill: true },
    });
    if (existing) {
      return this.format(existing, locale);
    }

    // 2. Подбираем drill и бронируем.
    const picked = await this.pick(dateOnly);
    if (!picked) {
      throw new NotFoundException({
        error: 'DAILY_DRILL_NOT_FOUND',
        date: toIsoDate(dateOnly),
      });
    }

    const created = await this.prisma.dailyTacticDrill.create({
      data: {
        date: dateOnly,
        drillId: picked.drill.id,
        drillType: picked.drill.type,
        difficulty: picked.difficulty,
        isRepeat: picked.isRepeat,
        originalDate: picked.originalDate,
      },
      include: { drill: true },
    });

    return this.format(created, locale);
  }

  /**
   * Подбор drill'а на дату. Возвращает выбранный drill + метаданные
   * fallback'а (isRepeat, originalDate) или null если все 8 типов
   * исчерпаны.
   */
  private async pick(date: Date): Promise<PickResult | null> {
    const targetDifficulty = bucketForDate(date);

    // Список type'ов, использованных в окне 14 дней — исключаем.
    const recentTypes = await this.recentTypesInWindow(date);
    const usedTypes = new Set(recentTypes);

    // Round-robin порядок: начинаем с seed-типа от даты, чтобы
    // распределение по типам выглядело случайно но стабильно.
    const startIdx = dateSeed(date) % DRILL_TYPE_ORDER.length;
    const orderedTypes = [
      ...DRILL_TYPE_ORDER.slice(startIdx),
      ...DRILL_TYPE_ORDER.slice(0, startIdx),
    ];

    // Сначала пробуем все 8 типов на target-bucket (за исключением
    // recent). Если не вышло — те же 8, на соседних bucket'ах. Если и
    // тогда нет — fallback на repeat (>14 дней). Иначе drill любого
    // type вне окна.
    for (const type of orderedTypes) {
      if (usedTypes.has(type)) continue;
      const drill = await this.pickFresh(type, targetDifficulty);
      if (drill) {
        return {
          drill,
          difficulty: targetDifficulty,
          isRepeat: false,
          originalDate: null,
        };
      }
    }

    // Fallback A: ослабляем difficulty (соседние bucket'ы) для тех же
    // типов вне окна 14 дней.
    const neighborBuckets = neighborsOf(targetDifficulty);
    for (const type of orderedTypes) {
      if (usedTypes.has(type)) continue;
      for (const bucket of neighborBuckets) {
        const drill = await this.pickFresh(type, bucket);
        if (drill) {
          return {
            drill,
            difficulty: bucket,
            isRepeat: false,
            originalDate: null,
          };
        }
      }
    }

    // Fallback B: repeat — drill из предыдущего цикла (>14 дней назад)
    // с минимальным числом показов в `daily_tactic_drills` history.
    for (const type of orderedTypes) {
      if (usedTypes.has(type)) continue;
      const repeat = await this.pickRepeat(type, date);
      if (repeat) {
        return {
          drill: repeat.drill,
          difficulty: repeat.difficulty,
          isRepeat: true,
          originalDate: repeat.originalDate,
        };
      }
    }

    // Fallback C: те же ослабления, но допускаем тип из 14-day окна.
    // (Бывает когда банк критически мал; маркетинг согласовал явно.)
    for (const type of orderedTypes) {
      const drill = await this.pickFresh(type, targetDifficulty);
      if (drill) {
        return {
          drill,
          difficulty: targetDifficulty,
          isRepeat: false,
          originalDate: null,
        };
      }
    }

    return null;
  }

  /**
   * Свежий (не использованный в `daily_tactic_drills` history никогда)
   * drill заданного type+bucket. KS-2433: фильтр `sfRejected=false`
   * убран вместе с удалением SF-валидации.
   */
  private async pickFresh(
    type: TacticDrillType,
    bucket: DrillDifficultyBucket,
  ): Promise<DrillRow | null> {
    const difficulties = DRILL_BUCKET_TO_DIFFICULTY[bucket];
    const usedIds = await this.allUsedDrillIds();
    const where: Record<string, unknown> = {
      type,
      difficulty: { in: [...difficulties] },
    };
    if (usedIds.length > 0) {
      where.id = { notIn: usedIds };
    }
    // KS-4576: см. комментарий в `TacticDrillService.pickRandomByKeyset`.
    // Daily может отдавать `find-fork`; legacy-shape записи отсеиваем.
    if (type === 'find-fork') {
      where.answer = { path: ['shape'], equals: 'move' };
    }
    const total = await this.prisma.tacticDrill.count({ where });
    if (total === 0) return null;
    const offset = Math.floor(Math.random() * total);
    const row = await this.prisma.tacticDrill.findFirst({
      where,
      skip: offset,
      orderBy: { id: 'asc' },
      // KS-2250-fix: meta для проброса highlightedSquare в DTO.
      select: { id: true, type: true, fen: true, difficulty: true, answer: true, meta: true },
    });
    return row as DrillRow | null;
  }

  /**
   * Repeat-вариант: drill этого type, использованный >14 дней назад,
   * с минимальным числом показов. Возвращает drill + дату его
   * последнего показа (для originalDate).
   */
  private async pickRepeat(
    type: TacticDrillType,
    today: Date,
  ): Promise<{ drill: DrillRow; difficulty: DrillDifficultyBucket; originalDate: Date } | null> {
    const cutoff = new Date(today);
    cutoff.setUTCDate(cutoff.getUTCDate() - NO_REPEAT_TYPE_WINDOW_DAYS);

    // Группируем по drill_id: count показов + max(date). Берём drill с
    // min(count) и max(date) ≤ cutoff.
    const candidates = await this.prisma.dailyTacticDrill.groupBy({
      by: ['drillId'],
      where: { drillType: type, date: { lte: cutoff } },
      _count: { drillId: true },
      _max: { date: true, difficulty: true },
      orderBy: { _count: { drillId: 'asc' } },
      take: 10,
    });
    if (candidates.length === 0) return null;

    // KS-2433: фильтр `sfRejected=false` убран — поле удалено.
    for (const c of candidates) {
      const drill = await this.prisma.tacticDrill.findFirst({
        where: { id: c.drillId },
        // KS-2250-fix: meta для проброса highlightedSquare.
        select: { id: true, type: true, fen: true, difficulty: true, answer: true, meta: true },
      });
      if (drill && c._max.date && c._max.difficulty) {
        return {
          drill: drill as DrillRow,
          difficulty: c._max.difficulty as DrillDifficultyBucket,
          originalDate: c._max.date,
        };
      }
    }
    return null;
  }

  /** Все drill_id, использованные хоть раз в `daily_tactic_drills`. */
  private async allUsedDrillIds(): Promise<string[]> {
    const rows = await this.prisma.dailyTacticDrill.findMany({
      select: { drillId: true },
      distinct: ['drillId'],
    });
    return rows.map((r) => r.drillId);
  }

  /** Drill-типы, использованные за окно 14 дней до `date`. */
  private async recentTypesInWindow(date: Date): Promise<TacticDrillType[]> {
    const cutoff = new Date(date);
    cutoff.setUTCDate(cutoff.getUTCDate() - NO_REPEAT_TYPE_WINDOW_DAYS);
    const rows = await this.prisma.dailyTacticDrill.findMany({
      where: { date: { gte: cutoff, lt: date } },
      select: { drillType: true },
      distinct: ['drillType'],
    });
    return rows.map((r) => r.drillType as TacticDrillType);
  }

  /**
   * Сериализация `DailyTacticDrill` row в response. Включает derive
   * `drill.context.highlight` (для count-attackers — meta.highlightedSquare,
   * для остальных пусто).
   */
  private format(
    row: {
      date: Date;
      drillType: string;
      difficulty: string;
      isRepeat: boolean;
      originalDate: Date | null;
      drill: {
        id: string;
        type: string;
        fen: string;
        difficulty: number;
        meta?: unknown;
      };
    },
    locale: Locale,
  ): DailyTacticDrillResponse {
    const dto = this.drillService.buildDto(
      row.drill.id,
      row.drill.type as TacticDrillType,
      row.drill.fen,
      row.drill.difficulty,
      // KS-2250-fix: проброс meta для UI рендера (count-attackers и т.п.).
      row.drill.meta,
    );
    const drillType = row.drillType as TacticDrillType;
    const difficulty = row.difficulty as DrillDifficultyBucket;
    const dateIso = toIsoDate(row.date);

    const highlight = this.deriveHighlight(dto);

    const drillWithContext: DailyTacticDrillResponse['drill'] = {
      ...dto,
      context: { highlight },
      instruction: DRILL_INSTRUCTION[drillType][locale],
    };

    return {
      date: dateIso,
      drill: drillWithContext,
      drillTypeLabel: DRILL_TYPE_LABEL[drillType],
      difficulty,
      difficultyLabel: DRILL_DIFFICULTY_LABEL[difficulty],
      hint: DRILL_HINT[drillType],
      siteUrl: `${DEFAULT_SITE_BASE}/drills/${dto.id}`,
      imageUrl: `${DEFAULT_SITE_BASE}/api/tactic-drill/daily/image/${dateIso}-${locale}.png`,
      isRepeat: row.isRepeat,
      originalDate: row.originalDate ? toIsoDate(row.originalDate) : null,
    };
  }

  /**
   * Derive highlight-клеток для overlay. count-attackers — целевая
   * клетка из meta. Остальные drill-типы — пустой массив (overlay
   * рисует только если массив непуст).
   */
  private deriveHighlight(dto: TacticDrillDto): string[] {
    if (dto.drillType === 'count-attackers' && dto.meta?.highlightedSquare) {
      return [dto.meta.highlightedSquare];
    }
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

interface DrillRow {
  id: string;
  type: string;
  fen: string;
  difficulty: number;
  /** KS-2250-fix: UI-meta из tactic_drills.meta JSONB. */
  meta?: unknown;
}

interface PickResult {
  drill: DrillRow;
  difficulty: DrillDifficultyBucket;
  isRepeat: boolean;
  originalDate: Date | null;
}

/** Обрезает Date до 00:00:00 UTC (соответствует Postgres @db.Date). */
export function toDateOnly(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** ISO `YYYY-MM-DD` UTC. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Bucket по дню недели (0=Вс ... 6=Сб). */
export function bucketForDate(date: Date): DrillDifficultyBucket {
  const dow = date.getUTCDay();
  return DAILY_DRILL_DIFFICULTY_BY_WEEKDAY[dow];
}

/** Соседние bucket'ы для fallback ослабления difficulty. */
export function neighborsOf(b: DrillDifficultyBucket): DrillDifficultyBucket[] {
  if (b === 'easy') return ['medium', 'hard'];
  if (b === 'hard') return ['medium', 'easy'];
  return ['easy', 'hard'];
}

/** Детерминированный seed по дате (для round-robin start-index). */
export function dateSeed(date: Date): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return ((y * 10000 + m * 100 + d) * 2654435761) >>> 0;
}
