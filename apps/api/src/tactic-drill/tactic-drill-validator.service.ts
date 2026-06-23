/**
 * KS-2230 (api-contract §4). Сравнение `userAnswer` с эталоном для
 * каждой из 4 answer-shape.
 *
 * Контракт: `validate(answer, userAnswer) → { solved, metrics? }`.
 *
 *  - `square` / `number` / `move` — точное совпадение, метрик нет.
 *  - `squares` — Jaccard / IoU с threshold 0.7 (methodology §6.2).
 *
 * Discriminator-mismatch (`userAnswer.shape !== answer.shape`) до
 * валидатора не должен доходить — это 400 на уровне DTO. Если всё-таки
 * пришёл — `solved=false` без метрик.
 */
import { Injectable } from '@nestjs/common';
import type { AnswerData } from '@kingside/shared';

export interface ValidationMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  iou: number;
}

export interface ValidationResult {
  solved: boolean;
  metrics?: ValidationMetrics;
}

const SQUARES_THRESHOLD = 0.7;

@Injectable()
export class TacticDrillValidatorService {
  validate(answer: AnswerData, userAnswer: AnswerData): ValidationResult {
    if (answer.shape !== userAnswer.shape) {
      // KS-4575. Legacy-shape адаптер: для записей `find-fork` в БД эталон
      // хранится в старом формате `{shape:'square', square:<to>}` (до
      // KS-2400), а UI присылает новый `{shape:'move', from, to}`. Это
      // единственный тип тренажёра, где правильность хода определяется
      // только конечной клеткой (predicate в indexer-pipeline тоже сравнивал
      // `to`), поэтому потеря `from` корректна. Полная нормализация данных
      // и удаление этой ветки — отдельной задачей (backfill `TacticDrill.answer`).
      if (
        answer.shape === 'square' &&
        userAnswer.shape === 'move'
      ) {
        return {
          solved:
            answer.square.toLowerCase() === userAnswer.to.toLowerCase(),
        };
      }
      return { solved: false };
    }

    switch (answer.shape) {
      case 'square':
        return {
          solved:
            answer.square.toLowerCase() ===
            (userAnswer as typeof answer).square.toLowerCase(),
        };
      case 'number':
        return {
          solved: answer.value === (userAnswer as typeof answer).value,
        };
      case 'move': {
        const u = userAnswer as typeof answer;
        return {
          solved:
            answer.from === u.from &&
            answer.to === u.to,
        };
      }
      case 'squares': {
        const expected = new Set(answer.squares.map((s) => s.toLowerCase()));
        const got = new Set(
          (userAnswer as typeof answer).squares.map((s) => s.toLowerCase()),
        );
        let truePositive = 0;
        let falsePositive = 0;
        let falseNegative = 0;
        for (const sq of got) {
          if (expected.has(sq)) truePositive++;
          else falsePositive++;
        }
        for (const sq of expected) {
          if (!got.has(sq)) falseNegative++;
        }
        const denom = truePositive + falsePositive + falseNegative;
        const iou = denom === 0 ? 1 : truePositive / denom;
        return {
          solved: iou >= SQUARES_THRESHOLD,
          metrics: {
            truePositive,
            falsePositive,
            falseNegative,
            iou: Math.round(iou * 100) / 100,
          },
        };
      }
    }
  }
}
