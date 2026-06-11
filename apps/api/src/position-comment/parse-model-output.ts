/**
 * KS-3690 / ADR-108b §6.2. Парсер ответа модели для
 * `POST /analyses/position/comment`.
 *
 * Алгоритм:
 *  1. Strip markdown-fences ```json … ``` / ``` … ```.
 *  2. JSON.parse; на любую ошибку — фолбэк `{comment: raw.trim(),
 *     highlights: [], arrows: []}`.
 *  3. Type-guard объекта; если `comment` отсутствует / не строка —
 *     фолбэк (т.к. ответ должен содержать текст; пустой ответ модели —
 *     отдельный сценарий, см. тест «пустой ответ»).
 *  4. Валидация `highlights[]`: regex клетки `/^[a-h][1-8]$/`, цвет
 *     из палитры. Дедуп по `square` (последний выигрывает). Срез ≤ 4.
 *  5. Валидация `arrows[]`: regex `from`/`to`, `from !== to`, цвет
 *     валидный. Дедуп по `(from, to)` (последний выигрывает). Срез ≤ 2.
 *
 * Чисто-функция. Не бросает. Не зависит от Nest / Redis / fetch.
 */
import type {
  AiArrow,
  AiHighlight,
  AiOverlayColor,
  PositionCommentResponse,
} from '@kingside/shared';
import { isArrowGeometryValid } from './validate-arrow-geometry';

const SQUARE_RE = /^[a-h][1-8]$/;
const COLORS: ReadonlySet<AiOverlayColor> = new Set<AiOverlayColor>([
  'red',
  'green',
  'yellow',
  'blue',
]);

const MAX_HIGHLIGHTS = 4;
const MAX_ARROWS = 2;

function isColor(value: unknown): value is AiOverlayColor {
  return typeof value === 'string' && COLORS.has(value as AiOverlayColor);
}

function isSquare(value: unknown): value is string {
  return typeof value === 'string' && SQUARE_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fallback(raw: string): PositionCommentResponse {
  return { comment: raw.trim(), highlights: [], arrows: [] };
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseHighlights(input: unknown): AiHighlight[] {
  if (!Array.isArray(input)) return [];
  // KS-3690 / ADR-108b §6.2 п.4: дедуп по `square` — «последний
  // выигрывает». Идём по входу слева направо, пишем в Map, потом
  // берём первые `MAX_HIGHLIGHTS` значений в исходном порядке вставки.
  const bySquare = new Map<string, AiHighlight>();
  for (const item of input) {
    if (!isPlainObject(item)) continue;
    if (!isSquare(item.square) || !isColor(item.color)) continue;
    // `Map.set` уже даёт «последний выигрывает» по ключу; но `Map`
    // сохраняет порядок ПЕРВОЙ вставки. Чтобы свежая запись после
    // дубля шла в конец и срезалась корректно, удаляем перед вставкой.
    bySquare.delete(item.square);
    bySquare.set(item.square, { square: item.square, color: item.color });
  }
  return Array.from(bySquare.values()).slice(0, MAX_HIGHLIGHTS);
}

/**
 * KS-4069: если передан `fen`, кроме базовой проверки регулярки клеток
 * и цвета — отбрасываем стрелки, у которых фигура на `from` не атакует
 * `to` в текущей позиции (включая блок собственными/чужими фигурами,
 * тип фигуры и её дальность). Без `fen` валидация пропускается ради
 * обратной совместимости с unit-тестами разбора (parse-model-output.spec.ts).
 */
function parseArrows(input: unknown, fen?: string): AiArrow[] {
  if (!Array.isArray(input)) return [];
  const byPair = new Map<string, AiArrow>();
  for (const item of input) {
    if (!isPlainObject(item)) continue;
    if (
      !isSquare(item.from) ||
      !isSquare(item.to) ||
      !isColor(item.color) ||
      item.from === item.to
    ) {
      continue;
    }
    if (fen && !isArrowGeometryValid(item.from, item.to, fen)) {
      continue;
    }
    const key = `${item.from}->${item.to}`;
    byPair.delete(key);
    byPair.set(key, { from: item.from, to: item.to, color: item.color });
  }
  return Array.from(byPair.values()).slice(0, MAX_ARROWS);
}

export function parseModelOutput(
  raw: string,
  fen?: string,
): PositionCommentResponse {
  if (raw == null) return { comment: '', highlights: [], arrows: [] };

  const body = stripFences(raw);
  if (body === '') return { comment: '', highlights: [], arrows: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fallback(raw);
  }

  if (!isPlainObject(parsed) || typeof parsed.comment !== 'string') {
    return fallback(raw);
  }

  return {
    comment: parsed.comment.trim(),
    highlights: parseHighlights(parsed.highlights),
    arrows: parseArrows(parsed.arrows, fen),
  };
}
