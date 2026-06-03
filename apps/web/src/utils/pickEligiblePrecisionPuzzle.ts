/**
 * KS-3634 / KS-3642 / ADR-106 §2.6. Подобрать следующий Precision-пазл с
 * учётом клиентского фильтра Maia. Делает до `maxRetries` повторных
 * вызовов `precisionApi.pickNext` + `puzzleApi.getById` если выпадает
 * неподходящий (`maiaWeakChoiceProb < threshold` при актуальной
 * `maiaMetricVersion`). После исчерпания попыток возвращает последний
 * полученный — чтобы не зависать на «нет пазла».
 *
 * Backend `/precision/next` возвращает только `puzzleId`, без полного
 * PuzzleDto. Чтобы посмотреть `maiaWeakChoiceProb`/`maiaMetricVersion`,
 * делаем дополнительный `GET /puzzles/:id`. Это компромисс
 * производительности до миграции фильтра на сервер (если потребуется).
 */
import type {
  PickNextPrecisionRequest,
  PickNextPrecisionResponse,
  PrecisionPickNextWithThemesRequest,
  PuzzleDto,
} from '@kingside/shared';

import { isPuzzleEligible } from './isPuzzleEligible';

/** Зависимости — для тестируемости (никаких глобальных импортов в саму ф-ю). */
export interface PickEligibleDeps {
  pickNext: (
    params: PickNextPrecisionRequest | PrecisionPickNextWithThemesRequest,
  ) => Promise<PickNextPrecisionResponse>;
  getPuzzleById: (id: string) => Promise<PuzzleDto>;
}

export interface PickEligibleOptions {
  /** Порог Maia (см. `readPrecisionMaiaThreshold`). */
  threshold: number;
  /** Сколько раз пробовать pickNext до сдачи. ADR-104 §8: 5. */
  maxRetries?: number;
}

/**
 * Результат:
 *   - `null` — backend вернул `puzzleId=null` на первой же итерации
 *     (нет подходящих по другим фильтрам — рейтинг-окно/темы).
 *   - объект — успех или fallback после исчерпания retry. Поле
 *     `eligible` показывает, прошёл ли пазл Maia-фильтр; вызывающий
 *     код может это залогировать.
 */
export type PickEligibleResult =
  | null
  | {
      puzzleId: string;
      rating: number;
      ratingDelta: number;
      puzzle: PuzzleDto;
      eligible: boolean;
      /** Сколько попыток сделано (включая успешную / финальную). */
      attempts: number;
    };

export async function pickEligiblePrecisionPuzzle(
  params: PickNextPrecisionRequest | PrecisionPickNextWithThemesRequest,
  options: PickEligibleOptions,
  deps: PickEligibleDeps,
): Promise<PickEligibleResult> {
  const maxRetries = options.maxRetries ?? 5;
  let lastSuccess: {
    res: Extract<PickNextPrecisionResponse, { puzzleId: string }>;
    puzzle: PuzzleDto;
  } | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await deps.pickNext(params);
    if (res.puzzleId == null) {
      // Бэкенд сам сказал «пазлов нет». Retry бесполезен.
      return null;
    }
    let puzzle: PuzzleDto;
    try {
      puzzle = await deps.getPuzzleById(res.puzzleId);
    } catch {
      // Не смогли подгрузить детали — лучше отдать как есть, чем
      // дёргать backend дальше до 5 раз. Eligible считаем false,
      // вызывающий код решит логировать.
      return {
        puzzleId: res.puzzleId,
        rating: res.rating,
        ratingDelta: res.ratingDelta,
        // PuzzleDto в этом случае недоступен; вернём минимальный
        // stub-объект через any-cast было бы грязно. Вместо этого
        // вернём null и пусть UI пойдёт по своему back-fallback'у.
        // Это редкий путь — getById падает только при сети.
        puzzle: undefined as unknown as PuzzleDto,
        eligible: false,
        attempts: attempt,
      };
    }

    if (isPuzzleEligible(puzzle, options.threshold)) {
      return {
        puzzleId: res.puzzleId,
        rating: res.rating,
        ratingDelta: res.ratingDelta,
        puzzle,
        eligible: true,
        attempts: attempt,
      };
    }

    // Запоминаем последний полученный — если все 5 попыток выпадут
    // неподходящими, вернём этот как fallback (ADR-106 §2.6: «лучше
    // показать менее острый, чем ничего»).
    lastSuccess = { res, puzzle };
  }

  if (lastSuccess) {
    return {
      puzzleId: lastSuccess.res.puzzleId,
      rating: lastSuccess.res.rating,
      ratingDelta: lastSuccess.res.ratingDelta,
      puzzle: lastSuccess.puzzle,
      eligible: false,
      attempts: maxRetries,
    };
  }
  return null;
}
