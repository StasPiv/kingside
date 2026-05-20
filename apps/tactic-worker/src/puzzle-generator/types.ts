/**
 * KS-2464 / ADR-044 §6, KS-3136 / ADR-068 §3.2 — типы puzzle-генератора
 * в режиме play-vs-engine.
 *
 * Алгоритм отбора:
 *   1. На каждом ply ≥ startPly анализируем позицию ДО хода через
 *      `analyzePositionWdl(fenBefore, limit, multiPV=2)`.
 *   2. samePv1 — если ход партии совпал с PV1 движка → не зевок.
 *   3. skipDecided — если |WDL_before| > skipDecidedWdl, партия уже
 *      решена → не зевок.
 *   4. После применения хода анализируем `fenAfter` (multiPV=1, можно
 *      переиспользовать пре-анализ следующего ply через кэш — здесь
 *      делаем явный второй анализ).
 *   5. KS-3136 / ADR-068: триггер — `evaluateBlunder` из `@kingside/
 *      shared`. OR двух дельт `deltaW`/`deltaD` ≥ порогов + after-фильтр
 *      §3.2 (защита от мираж-побед / проигрышной «ничьи»). Пороги
 *      hardcoded в `generator-pipeline.ts` (`HARD_*`), наружу не
 *      выставлены.
 *   6. Solvability: прогоняем halfMovesN полуходов Stockfish-vs-Stockfish.
 *      На каждом ply решающего берём bestmove. Если в любой момент
 *      WDL решающей < failThreshold — drop. После halfMovesN ходов:
 *      если WDL ≥ winThreshold — пазл проходит.
 *   7. Tagging — drill-предикаты + алгоритмические теги, добавляем
 *      технический тег `playVsEngine`.
 *   8. Insert с `solutionMode='play-vs-engine'`, `moves=''`,
 *      `acceptedMoves=null`. В `sourceMetadata.playVsEngine` пишем
 *      `deltaW`/`deltaD` (новые поля) + сохраняем `wdlBefore`/`wdlAfter`
 *      raw для UI.
 */
import type { MultiPvLine, AnalysisLimit } from '../stockfish/stockfish.service';
import { PUZZLE_GEN_DEFAULTS } from '@kingside/shared';

export type { MultiPvLine, AnalysisLimit };

/** Engine-интерфейс для unit-тестов pipeline (мокаемый). */
export interface EngineApi {
  analyzePositionWdl(
    fen: string,
    limit: AnalysisLimit,
    multiPV: number,
    label?: string,
  ): Promise<MultiPvLine[]>;
}

export type PuzzleSolutionMode = 'forced-line' | 'play-vs-engine';

export interface GeneratorOptions {
  /** Максимум партий. */
  maxGames: number;
  /** Stockfish-лимит на одну позицию. */
  engineLimit: AnalysisLimit;
  /**
   * Режим, в котором сохраняем пазлы. Default `play-vs-engine`
   * (KS-2464). Для legacy `forced-line` нужно явно указывать в CLI —
   * pipeline в этом режиме принимает старые опции
   * `spreadDelta`/`continueSpreadDelta`/`min/maxLineLength`.
   */
  solutionMode: PuzzleSolutionMode;
  /**
   * play-vs-engine: количество полуходов Stockfish-vs-Stockfish для
   * проверки solvability. Default 6.
   */
  halfMovesN: number;
  /**
   * play-vs-engine: нижний порог WDL для решающей в финале (через
   * halfMovesN ходов). Default 0.5.
   */
  winThreshold: number;
  /**
   * play-vs-engine: порог WDL, ниже которого drop сразу (на любом ply).
   * Default 0.0.
   */
  failThreshold: number;
  /**
   * |WDL_before| > этого значения → партия уже решена, ход не считается
   * зевком (skipDecided). Default 0.95.
   */
  skipDecidedWdl: number;
  /**
   * Legacy forced-line — спред PV1-PV2 на стартовой позиции. Ignored
   * в play-vs-engine режиме.
   */
  spreadDelta: number;
  /**
   * Legacy forced-line — спред на продолжении линии. Ignored в
   * play-vs-engine режиме.
   */
  continueSpreadDelta: number;
  /**
   * Legacy forced-line — порог forced-spread (KS-2431, не используется
   * после рефакторинга, оставлено как inert).
   */
  forcedSpreadDelta: number;
  /** Минимальный Elo обоих игроков (null допускается). */
  minRating: number;
  /** Минимальный plyCount партии. */
  minPly: number;
  /** Минимальный ply, с которого ищем зевок. */
  startPly: number;
  /** Legacy forced-line: минимальная длина построенной линии. */
  minLineLength: number;
  /** Legacy forced-line: максимальная длина построенной линии. */
  maxLineLength: number;
  /** Размер batch чтения партий. */
  gameBatchSize: number;
  /** UUID-cursor: брать партии с id > cursor. */
  cursor?: string | null;
  /**
   * KS-2776. Фильтр по `archive_games.import_id` — берём партии только
   * из конкретного PGN-импорта (например, последнего TWIC).
   */
  importId?: string | null;
  /**
   * KS-2776. Список `archive_games.id` для исключения (UUID-строки).
   * Используется когда на этих партиях уже сгенерены PVE-пазлы и
   * повтор не нужен. SQL добавит `AND id <> ALL($N::uuid[])`.
   * Пустой массив — без исключения.
   */
  excludeGameIds?: string[];
  /** Insert-callback: true если запись вставилась (новый FEN), false если конфликт. */
  insertPuzzle: (puzzle: PuzzleRecord) => Promise<boolean>;
  /** Логгер. */
  log?: (line: string) => void;
}

export interface PuzzleRecord {
  id: string;
  /** FEN после зевка — стартовая позиция puzzle. */
  fen: string;
  /**
   * UCI-ходы линии через пробел. Для play-vs-engine — пустая строка
   * (линии нет, решатель играет против движка).
   */
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
   * `gap` поле в БД — для UX, целое в процентных пунктах WDL_after_blunder
   * для решающей (диапазон 0..100). Например WDL=0.78 → gap=78.
   */
  gap: number;
  /** Глубина анализа (фактическая, не запрошенная) или 0. */
  depth: number;
  isPublic: boolean;
  acceptedMoves: string | null;
  sourceMetadata: string;
  /** KS-2462/2463/2464 — режим решения пазла. */
  solutionMode: PuzzleSolutionMode;
  /**
   * KS-2762. Денормализованные ELO игроков партии-источника
   * (из `archive_games.white_elo` / `black_elo`). NULL если у партии
   * нет рейтинга соответствующей стороны.
   */
  sourceWhiteElo: number | null;
  sourceBlackElo: number | null;
}

export interface GeneratorStats {
  gamesProcessed: number;
  positionsAnalyzed: number;
  inserted: number;
  /** Сумма drops + inserted = positionsAnalyzed (инвариант). */
  drops: {
    /**
     * KS-3136 / ADR-068: обе дельты ниже своих порогов (deltaW <
     * HARD_DELTA_W И deltaD < HARD_DELTA_D) — ход не зевок.
     */
    notBlunder: number;
    /** Ход партии = PV1 движка — не зевок (точно так, как считал движок). */
    samePv1: number;
    /** |WDL_before| > skipDecidedWdl — партия уже решена. */
    decided: number;
    /** Игра уже терминальная (мат/пат/ничья) после хода. */
    gameOver: number;
    /**
     * KS-3136 / ADR-068 §3.2. Триггер по W сработал, но
     * `W_after_for_solver < HARD_MIN_W_AFTER` — мираж-победа (решающий
     * не в выигранной позиции после хода блaндера).
     */
    lowWAfterForSolver: number;
    /**
     * KS-3136 / ADR-068 §3.2. Триггер по D без W, но `W + D after <
     * HARD_MIN_WD_AFTER` — решающий не держит даже ничью.
     */
    lowWplusDAfter: number;
    /**
     * play-vs-engine: solvability-check провалился — за halfMovesN
     * Stockfish-vs-Stockfish WDL у решающей упал/не достиг порогов.
     */
    solvabilityFailed: number;
    /** дубликат FEN (UNIQUE conflict при insert). */
    duplicate: number;
    /** Stockfish не вернул score / WDL. */
    noScore: number;
    /** ошибка при analyzePositionWdl или PV.length<1. */
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
    engineLimit: { timeMs: 1000 },
    // Default play-vs-engine. Lichess-уровень X=0.6 (см. ADR-044 §2.1
    // и сравнительный анализ с lichess-puzzler).
    solutionMode: 'play-vs-engine',
    // KS-2583: алгоритмические пороги — общие с клиентским генератором
    // (`@kingside/shared:PUZZLE_GEN_DEFAULTS`). KS-3136 / ADR-068:
    // пороги дельт `deltaWThreshold` / `deltaDThreshold` /
    // `minWAfterForSolver` / `minWPlusDAfterForSolver` в options НЕ
    // прокидываются — на сервере они hardcoded в pipeline (см.
    // `HARD_DELTA_W` и пр.). Здесь берём только параметры, которые
    // действительно настраиваемые (halfMovesN / win/failThreshold /
    // skipDecidedWdl / startPly).
    halfMovesN: PUZZLE_GEN_DEFAULTS.halfMovesN,
    winThreshold: PUZZLE_GEN_DEFAULTS.winThreshold,
    failThreshold: PUZZLE_GEN_DEFAULTS.failThreshold,
    skipDecidedWdl: PUZZLE_GEN_DEFAULTS.skipDecidedWdl,
    startPly: PUZZLE_GEN_DEFAULTS.startPly,
    // Legacy forced-line дефолты — не используются в play-vs-engine,
    // но сохраняются для обратной совместимости CLI.
    spreadDelta: 0.3,
    continueSpreadDelta: 0.3,
    forcedSpreadDelta: 0.5,
    minRating: 1400,
    minPly: 20,
    minLineLength: 1,
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
      samePv1: 0,
      decided: 0,
      gameOver: 0,
      lowWAfterForSolver: 0,
      lowWplusDAfter: 0,
      solvabilityFailed: 0,
      duplicate: 0,
      noScore: 0,
      engineError: 0,
    },
    tagDistribution: {},
    lastCursor: null,
  };
}
