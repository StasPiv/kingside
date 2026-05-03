import type { AnnotationColor, NodeAnnotations, VariationColor } from '../types';

/**
 * KS-2152: соответствие однобуквенного кода в PGN-макросах [%csl/%cal] и
 * нашего AnnotationColor. Совпадает с de-facto стандартом lichess/chess.com.
 */
const COLOR_LETTER_TO_NAME: Record<string, AnnotationColor> = {
  R: 'red',
  G: 'green',
  B: 'blue',
  Y: 'yellow',
};
const COLOR_NAME_TO_LETTER: Record<AnnotationColor, string> = {
  red: 'R',
  green: 'G',
  blue: 'B',
  yellow: 'Y',
};

const SQUARE_RE = /^[a-h][1-8]$/;

/** Распарсить CSL-список вида `Gd4,Re5,Yc1` в массив выделений. */
function parseCsl(raw: string): NodeAnnotations['highlights'] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const highlights: NonNullable<NodeAnnotations['highlights']> = [];
  for (const item of items) {
    const letter = item[0]?.toUpperCase();
    const square = item.slice(1).toLowerCase();
    const color = COLOR_LETTER_TO_NAME[letter];
    if (color && SQUARE_RE.test(square)) {
      highlights.push({ square, color });
    }
  }
  return highlights.length > 0 ? highlights : undefined;
}

/** Распарсить CAL-список вида `Re2e4,Gc4f7` в массив стрелок. */
function parseCal(raw: string): NodeAnnotations['arrows'] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const arrows: NonNullable<NodeAnnotations['arrows']> = [];
  for (const item of items) {
    const letter = item[0]?.toUpperCase();
    const from = item.slice(1, 3).toLowerCase();
    const to = item.slice(3, 5).toLowerCase();
    const color = COLOR_LETTER_TO_NAME[letter];
    if (color && SQUARE_RE.test(from) && SQUARE_RE.test(to)) {
      arrows.push({ from, to, color });
    }
  }
  return arrows.length > 0 ? arrows : undefined;
}

/**
 * Parse PGN comment macros [%eval ...], [%clk ...], [%csl ...], [%cal ...]
 * + KS-2286: [%cvc X] (variation-color, X = G|B|Y|R) — из comment первого
 * хода варианта. Симметрично с [%csl]/[%cal] по нотации цвета.
 *
 * Returns extracted values and the remaining human-readable comment.
 */
export function parseCommentMacros(raw: string): {
  eval?: number;
  clock?: string;
  comment?: string;
  annotations?: NodeAnnotations;
  /**
   * KS-2286 (ADR-038 §4): user-variation-color, если в comment был
   * макрос `[%cvc X]`. Хост (PgnDeserializer) кладёт это в
   * `move.variationColor`.
   */
  variationColor?: VariationColor;
} {
  let text = raw;
  let evalValue: number | undefined;
  let clockValue: string | undefined;

  // Extract [%eval X.XX] or [%eval #N] (mate in N)
  const evalMatch = text.match(/\[%eval\s+([^\]]+)\]/);
  if (evalMatch) {
    const val = evalMatch[1].trim();
    if (val.startsWith('#')) {
      // Mate score: #5 means mate in 5 for white, #-3 means mate in 3 for black
      const mateNum = parseInt(val.slice(1), 10);
      // Represent mate as a large number: +/-100 * sign
      evalValue = mateNum > 0 ? 100 : mateNum < 0 ? -100 : 0;
    } else {
      evalValue = parseFloat(val);
      if (isNaN(evalValue)) evalValue = undefined;
    }
    text = text.replace(/\[%eval\s+[^\]]+\]/g, '');
  }

  // Extract [%clk H:MM:SS]
  const clkMatch = text.match(/\[%clk\s+([^\]]+)\]/);
  if (clkMatch) {
    clockValue = clkMatch[1].trim();
    text = text.replace(/\[%clk\s+[^\]]+\]/g, '');
  }

  // KS-2152: [%csl Gd4,Re5] — выделения клеток.
  let highlights: NodeAnnotations['highlights'];
  const cslMatch = text.match(/\[%csl\s+([^\]]+)\]/);
  if (cslMatch) {
    highlights = parseCsl(cslMatch[1]);
    text = text.replace(/\[%csl\s+[^\]]+\]/g, '');
  }

  // KS-2152: [%cal Re2e4,Yc4f7] — стрелки.
  let arrows: NodeAnnotations['arrows'];
  const calMatch = text.match(/\[%cal\s+([^\]]+)\]/);
  if (calMatch) {
    arrows = parseCal(calMatch[1]);
    text = text.replace(/\[%cal\s+[^\]]+\]/g, '');
  }

  // KS-2286: [%cvc X] — variation-color, X = G|B|Y|R.
  // Первый валидный match выигрывает. ВСЕ макросы (валидные и
  // невалидные) удаляем из текста, чтобы они не утекли в comment.
  let variationColor: VariationColor | undefined;
  const cvcMatch = text.match(/\[%cvc\s+([GBYRgbyr])\s*\]/);
  if (cvcMatch) {
    const letter = cvcMatch[1].toUpperCase();
    variationColor = COLOR_LETTER_TO_NAME[letter];
  }
  // Чистим в любом случае — невалидный макрос (`[%cvc X]`) тоже не
  // должен оставаться в человеко-читаемом comment.
  text = text.replace(/\[%cvc\s+[^\]]+\]/g, '');

  // Clean up remaining text
  const comment = text.trim() || undefined;

  const annotations: NodeAnnotations | undefined =
    highlights || arrows ? { ...(highlights && { highlights }), ...(arrows && { arrows }) } : undefined;

  return { eval: evalValue, clock: clockValue, comment, annotations, variationColor };
}

/** Сериализовать NodeAnnotations.highlights → "Gd4,Re5" (или undefined). */
function serializeCsl(highlights?: NodeAnnotations['highlights']): string | undefined {
  if (!highlights || highlights.length === 0) return undefined;
  return highlights
    .map((h) => `${COLOR_NAME_TO_LETTER[h.color]}${h.square}`)
    .join(',');
}

/** Сериализовать NodeAnnotations.arrows → "Re2e4,Yc4f7" (или undefined). */
function serializeCal(arrows?: NodeAnnotations['arrows']): string | undefined {
  if (!arrows || arrows.length === 0) return undefined;
  return arrows
    .map((a) => `${COLOR_NAME_TO_LETTER[a.color]}${a.from}${a.to}`)
    .join(',');
}

/**
 * Serialize eval/clock/annotations values back into PGN comment macro format.
 * Combines with human comment text if present.
 *
 * KS-2286: добавлен `variationColor` — сериализуется как `[%cvc X]`
 * после [%csl]/[%cal] (порядок по доменной близости — все «макросы
 * рендера» стоят группой в конце).
 */
export function serializeCommentWithMacros(
  comment?: string,
  evalValue?: number,
  clock?: string,
  annotations?: NodeAnnotations,
  variationColor?: VariationColor,
): string | undefined {
  const parts: string[] = [];

  if (evalValue !== undefined) {
    // Format eval: mate scores as #N, otherwise as decimal
    if (evalValue >= 100) {
      parts.push('[%eval #1]');
    } else if (evalValue <= -100) {
      parts.push('[%eval #-1]');
    } else {
      parts.push(`[%eval ${evalValue.toFixed(2)}]`);
    }
  }

  if (comment) {
    parts.push(comment);
  }

  if (clock) {
    parts.push(`[%clk ${clock}]`);
  }

  // KS-2152: аннотации идут в конец комментария — порядок [%csl] перед [%cal]
  // соответствует lichess-формату.
  const csl = serializeCsl(annotations?.highlights);
  if (csl) parts.push(`[%csl ${csl}]`);
  const cal = serializeCal(annotations?.arrows);
  if (cal) parts.push(`[%cal ${cal}]`);

  // KS-2286: [%cvc X] — variation-color, после [%csl]/[%cal].
  if (variationColor) {
    parts.push(`[%cvc ${COLOR_NAME_TO_LETTER[variationColor]}]`);
  }

  if (parts.length === 0) return undefined;
  return parts.join(' ');
}
