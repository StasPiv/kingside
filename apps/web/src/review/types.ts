/**
 * KS-2152: цвета аннотаций (lichess-style: red, green, blue, yellow).
 * Совпадают с буквенными кодами PGN-расширения [%csl/%cal] (R/G/B/Y).
 */
export type AnnotationColor = 'red' | 'green' | 'blue' | 'yellow';

/**
 * KS-2285 (ADR-038 §6, E1) — цвет варианта в дереве анализа.
 * Пользователь может вручную выкрасить ветку (ChessMove.variationColor)
 * в один из 4 цветов, которые потом отображаются на доске и в нотации.
 *
 * Сейчас тип = AnnotationColor (тот же набор), переиспользуется ради
 * единства палитры с подсветкой клеток / стрелок (KS-2152). Если в
 * будущем понадобится отдельная палитра вариаций — здесь же ввести
 * самостоятельный union, чтобы изменение AnnotationColor не задевало
 * variation-color семантику.
 */
export type VariationColor = AnnotationColor;

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
  /**
   * KS-2285 (ADR-038 §6, E1) — пользовательский цвет варианта.
   * Применяется к ходу-«голове» вариации (первому ходу варианта в
   * дереве `move.variations[k][0]`); потомки наследуют визуальный
   * цвет через CSS-уровень (`getMoveClasses`/`getBracketClasses`).
   *
   * `undefined` — цвет варианта не задан, используется default-цвет
   * по уровню (`--c-subline-N` из ADR-037 / KS-2275). Сериализуется
   * в PGN-комментарий через макрос `[%cvc <color>]` (KS-2286).
   *
   * Field optional: legacy-PGN без макроса даст `undefined`, что
   * совместимо с текущим рендером.
   */
  variationColor?: VariationColor;
  [key: string]: any;
}
