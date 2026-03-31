export interface ChessMove {
  san: string;
  fen: string;
  from: string;
  to: string;
  piece: string;
  captured?: string;
  promotion?: string;
  flags: string;
  lan: string;
  before: string;
  after: string;
  next?: ChessMove | null;
  previous?: ChessMove | null;
  globalIndex: number;
  ply: number;
  moveIndex?: number;
  variation?: any[];
  variations?: ChessMove[][];
  nags?: number[];
  comment?: string;
  [key: string]: any;
}
