/**
 * KS-2152: цвета аннотаций (lichess-style: red, green, blue, yellow).
 * Совпадают с буквенными кодами PGN-расширения [%csl/%cal] (R/G/B/Y).
 */
export type AnnotationColor = 'red' | 'green' | 'blue' | 'yellow';

export interface SquareHighlight {
  square: string;
  color: AnnotationColor;
}

export interface ArrowAnnotation {
  from: string;
  to: string;
  color: AnnotationColor;
}

/**
 * Набор аннотаций, привязанный к узлу дерева анализа (ходу).
 * Хранится непосредственно в ChessMove и сериализуется в PGN-комментарий
 * через макросы [%csl Gd4,Re5][%cal Re2e4,Yc4f7].
 */
export interface NodeAnnotations {
  highlights?: SquareHighlight[];
  arrows?: ArrowAnnotation[];
}

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
  eval?: number;
  clock?: string;
  /** KS-2152: аннотации (выделения клеток + стрелки), привязанные к этому узлу. */
  annotations?: NodeAnnotations;
  [key: string]: any;
}
