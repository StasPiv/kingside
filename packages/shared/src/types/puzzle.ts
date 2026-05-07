export type PuzzleTheme =
  | 'advancedPawn'
  | 'advantage'
  | 'anapierce'
  | 'arabianMate'
  | 'attackingF2F7'
  | 'attraction'
  | 'backRankMate'
  | 'bishopEndgame'
  | 'bodenMate'
  | 'capturingDefender'
  | 'castling'
  | 'clearance'
  | 'crushing'
  | 'defensiveMove'
  | 'deflection'
  | 'discoveredAttack'
  | 'doubleBishopMate'
  | 'doubleCheck'
  | 'dovetailMate'
  | 'enPassant'
  | 'endgame'
  | 'equality'
  | 'exposedKing'
  | 'fork'
  | 'hangingPiece'
  | 'hookMate'
  | 'interference'
  | 'intermezzo'
  | 'kingsideAttack'
  | 'knightEndgame'
  | 'long'
  | 'master'
  | 'masterVsMaster'
  | 'mate'
  | 'mateIn1'
  | 'mateIn2'
  | 'mateIn3'
  | 'mateIn4'
  | 'mateIn5'
  | 'middlegame'
  | 'oneMove'
  | 'opening'
  | 'pawnEndgame'
  | 'pin'
  | 'promotion'
  | 'queenEndgame'
  | 'queenRookEndgame'
  | 'queensideAttack'
  | 'quietMove'
  | 'rookEndgame'
  | 'sacrifice'
  | 'short'
  | 'skewer'
  | 'smotheredMate'
  | 'superGM'
  | 'trappedPiece'
  | 'underPromotion'
  | 'veryLong'
  | 'xRayAttack'
  | 'zugzwang';

/**
 * KS-2462 / ADR-044 §5.5. Режим решения пазла:
 *  - `forced-line` — классика: решатель играет заранее зафиксированную
 *    линию `moves`, любое отклонение = fail. Это все исторические
 *    Lichess-puzzle и custom-задачи курсов.
 *  - `play-vs-engine` — открытая защита позиции после зевка: решатель
 *    играет против движка (на клиенте), задача — удержать оценку выше
 *    `winThreshold` в течение `halfMovesN` полуходов. Линия не задана.
 */
export type PuzzleSolutionMode = 'forced-line' | 'play-vs-engine';

export type PuzzleDto = {
  id: string;
  fen: string;
  moves: string;
  /**
   * KS-1908 / ADR-029: для **custom puzzle** (авторских задач в шагах
   * пользовательских курсов) рейтинг отсутствует — `null`. Для системных
   * (Lichess) puzzle — целое число (Glicko-2). Glicko-2-update'ы при
   * `rating === null` не вызываются (`isCustom === true`).
   */
  rating: number | null;
  ratingDeviation: number;
  popularity: number;
  nbPlays: number;
  themes: PuzzleTheme[];
  gameUrl: string;
  openingTags: string;
  source?: string;
  /**
   * KS-1908 / ADR-029 §5.2: маркер «авторская задача из user-курса».
   * При `true` runner НЕ вызывает `puzzleApi.submitAttempt`, в
   * `PuzzleAttempt`/`MistakeSpec` записи не пишутся, рейтинг не идёт.
   * Для системных puzzle поле отсутствует (или `false`).
   */
  isCustom?: boolean;
  /**
   * KS-1908 / ADR-029 §5.6: для custom puzzle первый ход в `moves` —
   * это ход ученика (а не setup, как у Lichess). При `true` runner
   * пропускает блок «применить setup-ход с задержкой 300 ms».
   */
  firstMoveIsUser?: boolean;
  /**
   * KS-2462 / ADR-044 §5.5. Режим решения пазла. См. `PuzzleSolutionMode`.
   * Все исторические пазлы получают `'forced-line'` (миграция KS-2463),
   * новые `play-vs-engine` пазлы заполняют опциональный блок ниже.
   */
  solutionMode: PuzzleSolutionMode;
  /**
   * KS-2462 / ADR-044 §5.5. Параметры режима `play-vs-engine`. Заполнен
   * только при `solutionMode === 'play-vs-engine'`; для `forced-line` —
   * отсутствует.
   *
   *  - `blunderMove` — UCI зевка из исходной партии (информативно, для
   *    подсветки на клиенте);
   *  - `wdlAfterBlunder` — WDL_signed для решающей сразу после зевка
   *    (от лица решателя, диапазон [-1..+1]; обычно > 0, иначе позиция
   *    не выигрывается);
   *  - `winThreshold` — нижний порог WDL, который решатель должен
   *    удерживать (default 0.5);
   *  - `failThreshold` — порог, ниже которого фейл сразу (default 0.0);
   *  - `halfMovesN` — сколько полуходов решатель играет против движка
   *    с удержанием порога (default 6).
   */
  playVsEngine?: {
    blunderMove: string;
    wdlAfterBlunder: number;
    winThreshold: number;
    failThreshold: number;
    halfMovesN: number;
  };
  /**
   * KS-2487. Источник позиции пазла — партия, из которой он сгенерирован.
   * Все поля опциональные: что-то находится в PGN headers, что-то в
   * `archive_games`, что-то — только URL. Frontend (KS-2487-FE) рендерит
   * блок «Из партии: White vs Black, Event, Date» если хотя бы White/
   * Black есть; иначе — кнопку «Открыть партию» по `pgnUrl`/
   * `archiveGameId`.
   *
   * Если о партии-источнике у нас нет ни одного поля — `sourceGame`
   * не выставляется (фронт не рисует блок).
   */
  sourceGame?: PuzzleSourceGame;
};

export interface PuzzleSourceGame {
  white?: string;
  black?: string;
  event?: string;
  /** ISO-строка или PGN-формат «YYYY.MM.DD». */
  date?: string;
  result?: '1-0' | '0-1' | '1/2-1/2' | '*';
  /** UUID `archive_games.id` для глубокой ссылки в архив. */
  archiveGameId?: string;
  /** Прямая ссылка/URL партии — Lichess `gameUrl` для пазлов lichess. */
  pgnUrl?: string;
}

/**
 * KS-2493 / ADR-046 §5.3. Метрики статистики пазлов в разрезе одного
 * `solutionMode` для блока «Modes breakdown» на странице stats.
 *
 *   - `attempts` — всего попыток в этом режиме.
 *   - `solved` — успешных.
 *   - `accuracy` — `solved / attempts * 100`, округлённый до целого
 *     (0..100). При `attempts === 0` — `0`.
 *   - `avgRating` — средний рейтинг пазлов, по которым пользователь
 *     делал попытки. `null` если попыток нет.
 *   - `avgTimeMs` — среднее время на попытку, мс. `0` если попыток нет.
 */
export interface PuzzleStatsByModeEntry {
  attempts: number;
  solved: number;
  accuracy: number;
  avgRating: number | null;
  avgTimeMs: number;
}

/**
 * KS-2493 / ADR-046 §5.3. Block `byMode` в ответе `GET /puzzles/stats/me`.
 * Гарантированно содержит обе ключа: даже если пользователь не делал
 * попыток в одном из режимов — `attempts=0`, `avgRating=null`.
 */
export interface PuzzleStatsByMode {
  'forced-line': PuzzleStatsByModeEntry;
  'play-vs-engine': PuzzleStatsByModeEntry;
}

export type PuzzleAttemptResult = 'solved' | 'failed';

export type PuzzleAttempt = {
  puzzleId: string;
  oldRating: number;
  result: PuzzleAttemptResult;
  newRating: number;
};
