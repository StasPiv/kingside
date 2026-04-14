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
  rating: number;
  ratingDeviation: number;
  popularity: number;
  nbPlays: number;
  themes: PuzzleTheme[];
  gameUrl: string;
  openingTags: string;
  source?: string;
};

export type PuzzleAttemptResult = 'solved' | 'failed';

export type PuzzleAttempt = {
  puzzleId: string;
  oldRating: number;
  result: PuzzleAttemptResult;
  newRating: number;
};
