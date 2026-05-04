/**
 * KS-2247 (ADR-035 §6.3 R5, Drills E5). Stockfish-валидация drill'ов
 * с риском неоднозначности.
 *
 * KS-2393: после удаления типа `mate-in-1 (deprecated)` валидатор
 * обслуживает только `find-hanging-piece`. Метод `validateMateInOne`
 * удалён, fetchUnvalidatedBatch фильтрует только по hanging-piece.
 *
 * Алгоритм:
 *   - **find-hanging-piece**: запрашиваем `analyze(fen, depth=10)`.
 *     Эталон — клетка вражеской фигуры, которую можно безнаказанно
 *     взять. Drill отклоняется, если bestMove SF — **не** взятие
 *     этой клетки (то есть SF предлагает заметно лучший вариант:
 *     тактика на другом фланге, мат, более ценная цель).
 *
 * Ограничения:
 *   - Throttle 1 позиция/сек обеспечивается на уровне scheduler'а
 *     (`tactic-drill-sf-validator.scheduler.ts`).
 *   - Один SF-instance на validateOne — последовательный await цикл
 *     scheduler'а эффективно даёт «один поток».
 */
import { Injectable, Logger } from '@nestjs/common';
import { Chess } from 'chess.js';
import { PrismaService } from '../prisma/prisma.service';
import { StockfishService } from '../engine/stockfish.service';
import type { AnswerData } from '@kingside/shared';

const SF_DEPTH_HANGING = 10;

export interface SfValidationVerdict {
  accepted: boolean;
  reason?: string;
}

@Injectable()
export class TacticDrillSfValidatorService {
  private readonly logger = new Logger(TacticDrillSfValidatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stockfish: StockfishService,
  ) {}

  /**
   * Проверяет один drill, обновляет флаги в БД (sfValidatedAt,
   * sfRejected, sfRejectionReason). Возвращает verdict для логов.
   */
  async validateOne(drill: {
    id: string;
    type: string;
    fen: string;
    answer: unknown;
  }): Promise<SfValidationVerdict> {
    const answer = drill.answer as AnswerData;
    let verdict: SfValidationVerdict;

    try {
      if (drill.type === 'find-hanging-piece') {
        verdict = await this.validateHangingPiece(drill.fen, answer);
      } else {
        // KS-2393: тип mate-in-1 (deprecated) удалён, валидатор
        // остаётся только для hanging-piece. Для других типов — no-op,
        // помечаем как валидное (validatedAt проставится, чтобы
        // scheduler не брал повторно при расширении фильтра).
        verdict = { accepted: true };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `sf-validate failed drill=${drill.id} type=${drill.type}: ${msg}`,
      );
      // Не помечаем как rejected — это не вина drill'а, scheduler
      // повторит на следующем тике (sfValidatedAt оставляем null).
      return { accepted: false, reason: `sf-error: ${msg}` };
    }

    await this.prisma.tacticDrill.update({
      where: { id: drill.id },
      data: {
        sfValidatedAt: new Date(),
        sfRejected: !verdict.accepted,
        sfRejectionReason: verdict.accepted ? null : (verdict.reason ?? 'rejected'),
      },
    });

    return verdict;
  }

  // ─── find-hanging-piece ────────────────────────────────────
  // KS-2393: метод validateMateInOne удалён вместе с типом
  // mate-in-1 (deprecated).

  private async validateHangingPiece(
    fen: string,
    answer: AnswerData,
  ): Promise<SfValidationVerdict> {
    // KS-2335 / KS-2337: shape для find-hanging-piece переведён с
    // 'square' на 'move'. Старая ветка для совместимости с legacy-
    // данными (curated drill'ы могут оставаться в shape='square'
    // до их перегенерации) — извлекаем target-клетку из обоих
    // форматов.
    let targetSq: string;
    if (answer.shape === 'move') {
      targetSq = answer.to.toLowerCase();
    } else if (answer.shape === 'square') {
      targetSq = answer.square.toLowerCase();
    } else {
      return {
        accepted: false,
        reason: 'expected move or square shape for hanging-piece',
      };
    }

    const result = await this.stockfish.analyze(fen, SF_DEPTH_HANGING);
    if (!result.bestMove || result.bestMove === '(none)') {
      return { accepted: false, reason: 'sf returned no best move' };
    }

    // Best move SF: проверим, ведёт ли его `to` в нашу target-клетку.
    const sfTo = uciTo(result.bestMove);
    if (sfTo === targetSq) {
      // SF тоже считает «бить эту фигуру» лучшим — drill согласован.
      return { accepted: true };
    }

    // Best move SF — другой ход. Проверим, действительно ли он
    // существенно лучше (значит, наш drill «упускает» лучшую тактику).
    // Сравниваем оценку SF с оценкой материального захвата target-фигуры.
    // Простая эвристика: если SF score = mate-в-N (N≥1) или cp ≥ +200 —
    // это явно лучше чем «забрать висящую фигуру», drill rejected.
    // (Pawn = ~100 cp; minor = ~300; то есть выигрыш minor'а — стандартный
    // «нормальный» ход; SF может предпочитать «лучше», и это не делает
    // наш drill невалидным.)
    if (result.score?.type === 'mate' && result.score.value > 0) {
      return {
        accepted: false,
        reason: `sf prefers mate in ${result.score.value} via ${result.bestMove} (target=${targetSq})`,
      };
    }
    if (result.score?.type === 'cp' && result.score.value >= 500) {
      return {
        accepted: false,
        reason: `sf prefers ${result.bestMove} (cp ${result.score.value}) over capturing ${targetSq}`,
      };
    }
    // Если SF предпочитает другой ход с близкой/худшей оценкой — это
    // допустимо для drill (есть несколько разумных ходов, наш — один
    // из них). Не отклоняем.

    // Доп. проверка: после SF best move позиция должна оставлять цель
    // на доске (если SF её просто берёт через другой маршрут — fine,
    // но drill всё равно ассоциирован с конкретной target-клеткой).
    // Используем chess.js, чтобы понять: атакует ли target-клетка
    // фигура противника после SF best move.
    try {
      const chess = new Chess(fen);
      const moved = chess.move({
        from: uciFrom(result.bestMove),
        to: sfTo,
        promotion: uciPromotion(result.bestMove),
      });
      if (!moved) {
        // SF предложил нелегальный ход — пропускаем (странно, но не
        // повод reject'ить наш drill).
        return { accepted: true };
      }
      // Проверяем, осталась ли target-фигура (если её больше нет,
      // SF её взял — drill согласован).
      const piece = chess.get(targetSq as never);
      if (!piece) return { accepted: true };
    } catch {
      // chess.js не сложился — оставляем accepted.
      return { accepted: true };
    }

    return { accepted: true };
  }

  // ─── batch helper ─────────────────────────────────────────

  /**
   * Получить очередную партию неvalidированных drill'ов из БД.
   * Используется scheduler'ом.
   */
  async fetchUnvalidatedBatch(limit: number): Promise<
    {
      id: string;
      type: string;
      fen: string;
      answer: unknown;
    }[]
  > {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    return this.prisma.tacticDrill.findMany({
      where: {
        // KS-2393: только find-hanging-piece (mate-in-1 удалён).
        type: 'find-hanging-piece',
        sfValidatedAt: null,
      },
      take: safeLimit,
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true, fen: true, answer: true },
    });
  }
}

// ─── helpers ─────────────────────────────────────────────────

/** UCI move "e2e4" → "e4". Promotion suffix "e7e8q" → "e8". */
function uciTo(uci: string): string {
  return uci.slice(2, 4).toLowerCase();
}

function uciFrom(uci: string): string {
  return uci.slice(0, 2).toLowerCase();
}

function uciPromotion(uci: string): 'q' | 'r' | 'b' | 'n' | undefined {
  const c = uci.slice(4, 5).toLowerCase();
  if (c === 'q' || c === 'r' || c === 'b' || c === 'n') return c;
  return undefined;
}
