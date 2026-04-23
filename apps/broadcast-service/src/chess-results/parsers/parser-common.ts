import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizePlayerName } from '../../crosstable/player-matcher';
import type { CrosstablePlayer } from '@kingside/shared';

/** Тип Cheerio-коллекции элементов (то, что возвращает `$('selector')`). */
export type CheerioCollection = cheerio.Cheerio<AnyNode>;
/** Тип Cheerio root API ($-функция, возвращаемая из `cheerio.load(...)`). */
export type CheerioRoot = cheerio.CheerioAPI;

/**
 * Общие утилиты для chess-results-парсеров (KS-1729/1730/1731).
 *
 * Парсеры art=0/1/2/5 разбирают разные таблицы, но имеют одинаковый каркас:
 *   1. Загрузить HTML через cheerio.
 *   2. Найти секцию `<div class="defaultDialog">` с нужным `<h2>`-маркером.
 *   3. Распарсить таблицу `class="CRs1"` внутри секции.
 *   4. Если h2-маркер не совпал — вернуть `{ ok: false, reason }` (sync-service
 *      получит сигнал «не та страница» и сделает fallback на legacy).
 */

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

/**
 * Загружает HTML в cheerio. Опции `decodeEntities: true` чтобы
 * `&frac12;` стало `½` (мы потом нормализуем в число 0.5).
 */
export function loadHtml(html: string): CheerioRoot {
  return cheerio.load(html, { xml: false });
}

/**
 * Находит первый `<div class="defaultDialog">` секции, у которого первый
 * `<h2>` совпадает с предикатом (по тексту). Возвращает `cheerio.Cheerio<...>`
 * с этим div'ом, либо `null` если не найдена.
 *
 * `<h2>` валидируется по тексту (тривиальный normalize: trim + collapse ws).
 * Сравнение через переданный `predicate` — может быть exact-match или
 * substring/regex.
 */
export function findSection(
  $: CheerioRoot,
  predicate: (h2Text: string) => boolean,
): CheerioCollection | null {
  let result: CheerioCollection | null = null;
  $('div.defaultDialog').each((_, el) => {
    if (result) return;
    const $div = $(el);
    const h2 = $div.find('h2').first();
    if (!h2.length) return;
    const text = h2.text().trim().replace(/\s+/g, ' ');
    if (predicate(text)) {
      result = $div;
    }
  });
  return result;
}

/**
 * Маппинг chess-results-cell в `result` для `CrosstableCell`.
 *
 * Значения которые встречаются (эмпирически в fixtures):
 *   - `*`         → диагональ (player vs player), result=null, opponentRank=undefined.
 *   - `1`         → win (1.0).
 *   - `0`         → loss (0.0).
 *   - `½` / `1/2` → draw (0.5).
 *   - `+`         → bye / forfeit-win (часто `+ - ½` обозначения).
 *   - `-`         → bye / forfeit-loss.
 *   - `K`         → kampflos (forfeit без игры).
 *   - `` (пусто)  → не сыграно (round ещё впереди).
 *
 * Возвращает {result, score} где score — float (0/0.5/1) для подсчёта Pts;
 * result — строковая категория для CrosstableCell.
 */
export interface ParsedCell {
  result: 'win' | 'loss' | 'draw' | 'bye' | 'forfeit' | null;
  score: 0 | 0.5 | 1 | null;
  /** Сырое содержимое, для отладки и edge-cases. */
  raw: string;
  /** true для диагонали круговика (`*`). */
  isDiagonal: boolean;
}

const CELL_DRAW_TEXTS = new Set(['½', '1/2', '0.5', '0,5']);

export function parseCellResult(rawCellText: string): ParsedCell {
  const t = rawCellText.trim();
  if (t === '' || t === '\u00a0') {
    return { result: null, score: null, raw: t, isDiagonal: false };
  }
  if (t === '*') {
    return { result: null, score: null, raw: t, isDiagonal: true };
  }
  if (t === '1') {
    return { result: 'win', score: 1, raw: t, isDiagonal: false };
  }
  if (t === '0') {
    return { result: 'loss', score: 0, raw: t, isDiagonal: false };
  }
  if (CELL_DRAW_TEXTS.has(t)) {
    return { result: 'draw', score: 0.5, raw: t, isDiagonal: false };
  }
  // Forfeit / bye notation. Chess-results варианты:
  //   "+ / - / K" — kampflos (forfeit без игры).
  //   "1F / 0F"   — выиграл / проиграл по форфайту (есть ряд).
  if (t === '+' || t === '1F' || t.toUpperCase() === '1K') {
    return { result: 'forfeit', score: 1, raw: t, isDiagonal: false };
  }
  if (t === '-' || t === '0F' || t.toUpperCase() === '0K' || t === 'K') {
    return { result: 'forfeit', score: 0, raw: t, isDiagonal: false };
  }
  if (t.toLowerCase() === 'bye') {
    return { result: 'bye', score: 0.5, raw: t, isDiagonal: false };
  }
  // Неизвестное значение — возвращаем как null с raw для логирования.
  return { result: null, score: null, raw: t, isDiagonal: false };
}

/**
 * Парсит число с разными десятичными разделителями (en: `4.5`, de/fr: `4,5`).
 * `null` если не парсится.
 */
export function parseNumberLoose(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (t === '' || t === '-') return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Парсит integer (rank, rating, games-played). null если не число.
 */
export function parseIntLoose(raw: string): number | null {
  const t = raw.trim();
  if (t === '' || t === '-') return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Возвращает все data-строки таблицы chess-results. Класс строки — `CRg1` /
 * `CRg2` (compact) ИЛИ `CRng1` / `CRng2` (расширенная разметка с federation-
 * подсветкой). Header строка — `CRg1b` / `CRng1b`, её исключаем.
 */
export function findDataRows(
  $: CheerioRoot,
  table: CheerioCollection,
): CheerioCollection {
  return table.find('tr').filter((_, el) => {
    const cls = $(el).attr('class') ?? '';
    if (/\bCR(n)?g1b\b/.test(cls)) return false; // header
    return /\bCR(n)?g[12]\b/.test(cls);
  });
}

/**
 * Helper для извлечения `CrosstablePlayer` из строки таблицы chess-results.
 *
 * Поскольку набор колонок до игроков-cell'ов одинаков по типам страниц
 * (No.|Title|Name|Rtg|FED|...), выделяем эту часть в общий парсер.
 *
 * `cells` — массив `<td>` строки. `nameColumnIndex` указывает где `Name`
 * (chess-results иногда вставляет колонку флага между title и name).
 *
 * Опциональные `gamesPlayed` / `points` / `title` берутся из колонок,
 * ссылка которых указана в `extra`.
 */
export interface PlayerColumnSpec {
  /** Индекс колонки с `<td>` rank (No.). */
  rankIdx: number;
  /** Индекс колонки `Title` (GM/IM/...). null если нет. */
  titleIdx: number | null;
  /** Индекс колонки `Name`. */
  nameIdx: number;
  /** Индекс колонки `Rtg`. null если нет. */
  ratingIdx: number | null;
  /** Индекс колонки `FED`. null если нет. */
  fedIdx: number | null;
  /** Индекс колонки `Pts.` итоговых очков. null если нет. */
  pointsIdx: number | null;
  /** Индекс колонки `Games`. null если нет. */
  gamesIdx: number | null;
  /** Индекс колонки `Team`. null если нет (используется в team-турнирах). */
  teamIdx: number | null;
}

/**
 * Извлекает `CrosstablePlayer` из строки таблицы по колоночному маппингу.
 * `gamesPlayed` если не указан явно — caller передаёт через override (часто
 * вычисляется по числу непустых cells в матрице).
 *
 * Returns `null` если строка пуста / без имени (служебная).
 */
export function extractPlayer(
  $: CheerioRoot,
  cells: CheerioCollection,
  spec: PlayerColumnSpec,
  override?: { gamesPlayed?: number; points?: number },
): CrosstablePlayer | null {
  const cellAt = (i: number): string => {
    const c = cells.eq(i);
    return c.length ? c.text().trim() : '';
  };

  const rank = parseIntLoose(cellAt(spec.rankIdx));
  if (rank === null) return null;

  const name = cellAt(spec.nameIdx);
  if (!name) return null;

  const rating =
    spec.ratingIdx !== null ? parseIntLoose(cellAt(spec.ratingIdx)) : null;
  const title = spec.titleIdx !== null ? cellAt(spec.titleIdx) || undefined : undefined;
  const federation =
    spec.fedIdx !== null ? cellAt(spec.fedIdx) || undefined : undefined;
  const team = spec.teamIdx !== null ? cellAt(spec.teamIdx) || undefined : undefined;

  let points = override?.points;
  if (points === undefined && spec.pointsIdx !== null) {
    const p = parseNumberLoose(cellAt(spec.pointsIdx));
    points = p ?? 0;
  }
  if (points === undefined) points = 0;

  let gamesPlayed = override?.gamesPlayed;
  if (gamesPlayed === undefined && spec.gamesIdx !== null) {
    const g = parseIntLoose(cellAt(spec.gamesIdx));
    gamesPlayed = g ?? 0;
  }
  if (gamesPlayed === undefined) gamesPlayed = 0;

  return {
    rank,
    name,
    normalizedName: normalizePlayerName(name),
    federation,
    elo: rating ?? undefined,
    title: title || undefined,
    points,
    gamesPlayed,
    team,
  };
}

/**
 * Определяет колоночный маппинг по header-строке `<th>` таблицы.
 *
 * Возвращает PlayerColumnSpec с найденными индексами. Если обязательные
 * колонки (Name) отсутствуют — `null`.
 *
 * Эвристика: ищем по имени-заголовку колонки (case-insensitive prefix-match).
 * Альтернатива — фиксированные индексы — хрупко: chess-results иногда
 * вставляет/убирает колонки.
 */
export function detectColumns(
  headerCells: CheerioCollection,
): PlayerColumnSpec | null {
  const labels: string[] = [];
  headerCells.each((_, el) => {
    labels.push(
      headerCells.eq(headerCells.index(el)).text().trim().toLowerCase(),
    );
  });

  const findIdx = (predicate: (s: string) => boolean): number | null => {
    for (let i = 0; i < labels.length; i++) {
      if (predicate(labels[i])) return i;
    }
    return null;
  };

  const rankIdx = findIdx((s) => s === 'no.' || s === 'no' || s === 'rk.' || s === 'rk');
  const nameIdx = findIdx((s) => s === 'name');
  // Rating: `Rtg`, `Rtg.`, `RtgI` (international), `RtgN` (national), `Rating`.
  const ratingIdx = findIdx((s) => /^(rtg|rating)/i.test(s));
  const fedIdx = findIdx((s) => s === 'fed' || s === 'fed.' || s === 'federation');
  const pointsIdx = findIdx((s) => s === 'pts.' || s === 'pts' || s === 'points');
  const gamesIdx = findIdx((s) => s === 'games' || s === 'gms' || s === 'g');
  const teamIdx = findIdx((s) => s === 'team' || s === 'club' || s === 'club/city');

  if (rankIdx === null || nameIdx === null) return null;

  // Title-колонка — обычно сразу перед Name (chess-results вставляет пустой
  // <th></th> для title между rank и name). Эвристика: если есть пустой <th>
  // прямо перед name, считаем его title-колонкой.
  let titleIdx: number | null = null;
  if (nameIdx > 0 && labels[nameIdx - 1] === '') {
    titleIdx = nameIdx - 1;
  }

  return {
    rankIdx,
    titleIdx,
    nameIdx,
    ratingIdx,
    fedIdx,
    pointsIdx,
    gamesIdx,
    teamIdx,
  };
}
