/**
 * KS-2431 (WDL pivot). Типы puzzle-генератора на основе Stockfish WDL.
 *
 * Алгоритм отбора:
 *   1. На каждом ply партии — Stockfish MultiPV=2 c UCI_ShowWDL=true.
 *   2. ΔWDL_зевка = (-WDL_PV1 от лица новой стороны) − prevWdl
 *      (от лица той стороны, что только что сходила).
 *      Кандидат если |ΔWDL_зевка| ≥ blunderDelta (X).
 *   3. ΔWDL_спред = WDL_PV1 − WDL_PV2 (от лица решающей).
 *      Кандидат если ΔWDL_спред ≥ spreadDelta (Y).
 *   4. Линия строится итеративно: на каждом нашем ходу — снова
 *      MultiPV=2, проверка ΔWDL_спред ≥ spreadDelta. Если нарушен —
 *      обрубаем линию. На ходах соперника берём PV1 без проверки.
 */
import type { MultiPvLine, AnalysisLimit } from '../stockfish/stockfish.service';

export type { MultiPvLine, AnalysisLimit };

/** Engine-интерфейс для unit-тестов pipeline (мокаемый). */
export interface EngineApi {
  analyzePositionWdl(
    fen: string,
    limit: AnalysisLimit,
    multiPV: number,
  ): Promise<MultiPvLine[]>;
}

export interface GeneratorOptions {
  /** Максимум партий. */
  maxGames: number;
  /** Stockfish-лимит на одну позицию. */
  engineLimit: AnalysisLimit;
  /** Порог X — минимальный |ΔWDL_зевка| для срабатывания. */
  blunderDelta: number;
  /** Порог Y — минимальный ΔWDL_спред для уникальности. */
  spreadDelta: number;
  /** Минимальный Elo обоих игроков (null допускается). */
  minRating: number;
  /** Минимальный plyCount партии. */
  minPly: number;
  /** Минимальный ply, с которого ищем зевок. */
  startPly: number;
  /** Минимальная длина построенной линии. */
  minLineLength: number;
  /** Максимальная длина построенной линии. */
  maxLineLength: number;
  /** Размер batch чтения партий. */
  gameBatchSize: number;
  /** UUID-cursor: брать партии с id > cursor. */
  cursor?: string | null;
  /** Insert-callback: true если запись вставилась (новый FEN), false если конфликт. */
  insertPuzzle: (puzzle: PuzzleRecord) => Promise<boolean>;
  /** Логгер. */
  log?: (line: string) => void;
}

export interface PuzzleRecord {
  id: string;
  /** FEN после зевка — стартовая позиция puzzle. */
  fen: string;
  /** UCI-ходы линии через пробел. */
  moves: string;
  rating: number;
  ratingDev: number;
  /** Теги через пробел. */
  themes: string;
  source: 'generated';
  sourceType: 'archive_game';
  sourceId: string;
  /** Ply, на котором был сделан зевочный ход. */
  sourceMoveNum: number;
  /**
   * `gap` поле в БД — для UX, целое в процентных пунктах WDL spread'а.
   * Например spread = 0.47 → gap = 47.
   */
  gap: number;
  /** Глубина анализа (фактическая, не запрошенная) или 0. */
  depth: number;
  isPublic: boolean;
  acceptedMoves: string | null;
  sourceMetadata: string;
}

export interface GeneratorStats {
  gamesProcessed: number;
  positionsAnalyzed: number;
  inserted: number;
  /** Сумма drops + inserted = positionsAnalyzed (инвариант). */
  drops: {
    /** |ΔWDL_зевка| < blunderDelta */
    notBlunder: number;
    /** ΔWDL_спред < spreadDelta на стартовой позиции */
    notUnique: number;
    /** длина построенной линии < minLineLength */
    tooShort: number;
    /** длина > maxLineLength */
    tooLong: number;
    /** дубликат FEN (UNIQUE conflict при insert) */
    duplicate: number;
    /** Stockfish не вернул score / WDL */
    noScore: number;
    /** ошибка при analyzePositionWdl или PV.length<1 */
    engineError: number;
  };
  tagDistribution: Record<string, number>;
  lastCursor: string | null;
}

export function defaultGeneratorOptions(
  overrides: Partial<GeneratorOptions> = {},
): Omit<GeneratorOptions, 'insertPuzzle'> & {
  insertPuzzle?: GeneratorOptions['insertPuzzle'];
} {
  return {
    maxGames: 100,
    // Стартовый лимит — ориентир. Подбираем на пользователя.
    // 5 секунд / 2M nodes / depth 20 — компромисс между качеством
    // WDL-оценки и временем прогона. Меняется через CLI.
    engineLimit: { depth: 20, timeMs: 5000, nodes: 2_000_000 },
    blunderDelta: 0.5, // X — стартовый
    spreadDelta: 0.3, // Y — стартовый
    minRating: 1400,
    minPly: 20,
    startPly: 20,
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
      notBlunder: 0,
      notUnique: 0,
      tooShort: 0,
      tooLong: 0,
      duplicate: 0,
      noScore: 0,
      engineError: 0,
    },
    tagDistribution: {},
    lastCursor: null,
  };
}
