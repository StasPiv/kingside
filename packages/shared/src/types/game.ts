export type PieceColor = 'white' | 'black';

export type GameStatus = 'waiting' | 'active' | 'finished';

export type GameResult = 'white' | 'black' | 'draw';

export type TimeControl = {
  initialTime: number;
  increment: number;
};

export type Game = {
  id: string;
  whitePlayerId: string;
  blackPlayerId: string;
  status: GameStatus;
  result: GameResult | null;
  fen: string;
  moves: string[];
  timeControl: TimeControl;
  createdAt: string;
};
