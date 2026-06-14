/**
 * KS-3690 / ADR-108b §6.2 + KS-3693/KS-3690 follow-up (Gherkin §9 Q1
 * сценарий 2). Парсер ответа модели для
 * `POST /analyses/position/comment`.
 *
 * Алгоритм:
 *  1. Strip markdown-fences ```json … ``` / ``` … ```.
 *  2. JSON.parse; на любую ошибку — пустой шейп
 *     `{comment: '', highlights: [], arrows: []}` (см. ниже).
 *  3. Type-guard объекта; если `comment` отсутствует / не строка —
 *     тот же пустой шейп.
 *  4. Валидация `highlights[]`: regex клетки `/^[a-h][1-8]$/`, цвет
 *     из палитры. Дедуп по `square` (последний выигрывает). Срез ≤ 4.
 *  5. Валидация `arrows[]`: regex `from`/`to`, `from !== to`, цвет
 *     валидный. Дедуп по `(from, to)` (последний выигрывает). Срез ≤ 2.
 *
 * Поведение «фолбэк = пустой шейп» (вместо `comment: raw.trim()`)
 * приведено к Gherkin сценария 2 ADR-108b §9 Q1: при не-JSON
 * ответе в HTTP 200 фронт должен показать state=error, никакая
 * подсветка не появляется. Фронт детектирует error по пустому
 * `comment` (тот же шейп возвращает сервис при webhook 5xx /
 * таймауте — единый контракт). Сырой текст модели наружу не
 * утекает: гарантия для оверлеев и i18n (RU/EN), что в UI всегда
 * отрисовывается либо валидный JSON-комментарий, либо state=error.
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

/**
 * KS-3693 / Gherkin §9 Q1 сценарий 2. Пустой шейп — единый сигнал
 * «фронту показать state=error / не отрисовывать overlay» как при
 * non-JSON в HTTP 200, так и при webhook 5xx / таймауте. Сырой
 * текст модели наружу не отдаём, чтобы UI не уходил в фейковый
 * `state=success` с обрывками JSON / системного промпта.
 */
function fallback(): PositionCommentResponse {
  return { comment: '', highlights: [], arrows: [] };
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
    return fallback();
  }

  if (!isPlainObject(parsed) || typeof parsed.comment !== 'string') {
    return fallback();
  }

  return {
    comment: parsed.comment.trim(),
    highlights: parseHighlights(parsed.highlights),
    arrows: parseArrows(parsed.arrows, fen),
  };
}
