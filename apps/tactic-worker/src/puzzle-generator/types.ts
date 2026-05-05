/**
 * KS-2431. Типы puzzle-генератора (ADR-041).
 */
import type { ScoreCp, MultiPvLine } from '../stockfish/stockfish.service';

export type { ScoreCp, MultiPvLine };

/**
 * Минимальный engine-интерфейс для unit-тестов: pipeline зависит
 * только от двух методов StockfishService. Для теста проще передать
 * мок, чем поднимать реальный SF.
 */
export interface EngineApi {
  analyze(
    fen: string,
    depth: number,
  ): Promise<{ bestMove: string; score?: ScoreCp; depth?: number }>;
  analyzeMultiPV(
    fen: string,
    depth: number,
    multiPV: number,
  ): Promise<MultiPvLine[]>;
}

export interface GeneratorOptions {
  /** Максимум партий для обработки. */
  maxGames: number;
  /** Stockfish-глубина. KS-2431: стартуем с 10, потом калибруем. */
  depth: number;
  /** MultiPV для проверки uniqueness. */
  multiPV: number;
  /** Минимальный Elo обоих игроков. Null/undefined в archive_games — допускается. */
  minRating: number;
  /** Минимальная длина партии (плойсы). */
  minPly: number;
  /** Минимальный ply, с которого ищем blunder (после дебюта). */
  startPly: number;
  /** Минимальный evalDrop (cp) для blunder-detection. */
  minEvalDrop: number;
  /** Минимальный spread (cp) для uniqueness. */
  minSpread: number;
  /** Минимальная длина построенной линии в полуходах. */
  minLineLength: number;
  /** Максимальная длина построенной линии в полуходах. */
  maxLineLength: number;
  /** Размер batch чтения партий из archive-RDS. */
  gameBatchSize: number;
  /** UUID-курсор: брать партии с id > cursor. */
  cursor?: string | null;
  /**
   * Insert-callback: вызывается на каждом успешно сгенерированном
   * puzzle. Возвращает true, если запись вставилась (уникальный fen),
   * false при conflict (дубликат). Pipeline использует это для
   * счётчика `inserted`.
   */
  insertPuzzle: (puzzle: PuzzleRecord) => Promise<boolean>;
  /** Логгер. */
  log?: (line: string) => void;
}

/** То, что pipeline пишет в БД (поля Puzzle). */
export interface PuzzleRecord {
  id: string;
  /** Стартовая FEN puzzle (= позиция после blunder). */
  fen: string;
  /** UCI-ходы линии через пробел. */
  moves: string;
  rating: number;
  ratingDev: number;
  /** Пробел-разделённые теги. */
  themes: string;
  source: 'generated';
  sourceType: 'archive_game';
  sourceId: string;
  sourceMoveNum: number;
  gap: number;
  depth: number;
  isPublic: boolean;
  acceptedMoves: string | null;
  sourceMetadata: string;
}

export interface GeneratorStats {
  gamesProcessed: number;
  positionsAnalyzed: number;
  inserted: number;
  /**
   * Счётчики отсева по причинам. KS-2431: сумма всех drops + inserted
   * = positionsAnalyzed (инвариант для прозрачности калибровки).
   */
  drops: {
    /** evalDrop < minEvalDrop */
    noBlunder: number;
    /** spread < minSpread */
    notUnique: number;
    /** длина линии < minLineLength */
    tooShort: number;
    /** длина линии > maxLineLength (theoretically нечасто, но возможно) */
    tooLong: number;
    /** recapture / тривиальный размен (ADR-041 §2.5) */
    recapture: number;
    /** дубликат FEN (UNIQUE conflict при insert) */
    duplicate: number;
    /**
     * Stockfish не вернул score (либо bestBefore, либо actualAfter).
     * Бывает на patовых / странных позициях — pipeline пропускает.
     */
    noScore: number;
    /**
     * analyzeMultiPV крашнулся или вернул пустой массив на uniqueness-
     * проверке либо при построении линии. KS-2431: раньше «терялись»
     * без учёта.
     */
    mpvFail: number;
    /**
     * Engine.analyze() throw'нул (timeout / spawn error). KS-2431:
     * раньше «терялись» без учёта.
     */
    engineError: number;
  };
  /** Распределение тегов: theme → count puzzle'ов с ним. */
  tagDistribution: Record<string, number>;
  /** Cursor последней обработанной партии. */
  lastCursor: string | null;
}

export function defaultGeneratorOptions(
  overrides: Partial<GeneratorOptions> = {},
): Omit<GeneratorOptions, 'insertPuzzle'> & {
  insertPuzzle?: GeneratorOptions['insertPuzzle'];
} {
  return {
    maxGames: 100,
    depth: 10, // KS-2431 старт; калибруем после первого batch'а
    multiPV: 3,
    minRating: 1400,
    minPly: 20,
    startPly: 20,
    minEvalDrop: 200,
    minSpread: 150,
    minLineLength: 2,
    maxLineLength: 6,
    gameBatchSize: 100,
    cursor: null,
    ...overrides,
  };
}

export function newGeneratorStats(): GeneratorStats {
  return {
    gamesProcessed: 0,
    positionsAnalyzed: 0,
    inserted: 0,
    drops: {
      noBlunder: 0,
      notUnique: 0,
      tooShort: 0,
      tooLong: 0,
      recapture: 0,
      duplicate: 0,
      noScore: 0,
      mpvFail: 0,
      engineError: 0,
    },
    tagDistribution: {},
    lastCursor: null,
  };
}
