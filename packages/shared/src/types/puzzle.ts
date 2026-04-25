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
};

export type PuzzleAttemptResult = 'solved' | 'failed';

export type PuzzleAttempt = {
  puzzleId: string;
  oldRating: number;
  result: PuzzleAttemptResult;
  newRating: number;
};
